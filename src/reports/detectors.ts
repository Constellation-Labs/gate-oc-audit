import { createHash } from "node:crypto";

/**
 * R5a — duplicate-outbound detector. Flags pairs of `message.sent` events
 * with byte-identical content, sent to the same channel+recipient within
 * `windowSec`. The "consecutive" wording in the PRD is per (channel,
 * recipient) ordered by createdAt — not global event order — because two
 * channels can interleave outbound replies in the same second without
 * implicating each other.
 *
 * Why not reuse SMT rawHash for equality? `computeRawHash` mixes in
 * event.id and event.sequence (src/services/smt-service.ts:262-275), so
 * two byte-identical sends always differ. We hash `content` (the
 * decompressed message body) directly here. content === undefined collapses
 * to sha256(""), which is fine — empty-content events are unlikely to
 * legitimately duplicate, but if they do the report should still flag them.
 */
export interface MessageSentRow {
  id: string;
  sequence: number;
  createdAt: string;
  sessionId?: string;
  channel: string;
  recipient: string;
  content?: string;
}

export interface DuplicateOutboundFinding {
  contentSha256: string;
  channel: string;
  recipient: string;
  /** Always 2+ events. The first entry is the "original", the rest are "duplicates within window". */
  events: Array<{ id: string; sequence: number; createdAt: string; sessionId?: string }>;
  deltaSeconds: number;
}

export function detectDuplicateOutbound(
  rows: ReadonlyArray<MessageSentRow>,
  windowSec: number,
): DuplicateOutboundFinding[] {
  if (rows.length < 2) return [];
  if (windowSec <= 0) return [];

  // Bucket by (channel, recipient, contentSha256). Within each bucket, walk
  // events in createdAt order and emit a finding whenever the gap between
  // consecutive sends is ≤ windowSec. We don't collapse all duplicates in a
  // bucket into a single finding because two pairs separated by a long gap
  // are independent incidents.
  type Bucket = MessageSentRow & { contentSha256: string };
  const buckets = new Map<string, Bucket[]>();
  for (const row of rows) {
    const sha = sha256(row.content ?? "");
    const key = `${row.channel}\x00${row.recipient}\x00${sha}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push({ ...row, contentSha256: sha });
  }

  const findings: DuplicateOutboundFinding[] = [];
  const windowMs = windowSec * 1000;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    let runStart = 0;
    for (let i = 1; i <= bucket.length; i++) {
      const prevTime = Date.parse(bucket[i - 1].createdAt);
      const curTime = i < bucket.length ? Date.parse(bucket[i].createdAt) : Number.POSITIVE_INFINITY;
      const inRun = curTime - prevTime <= windowMs;
      if (!inRun) {
        // Close the current run if it contains ≥ 2 events.
        if (i - runStart >= 2) {
          const slice = bucket.slice(runStart, i);
          const first = Date.parse(slice[0].createdAt);
          const last = Date.parse(slice[slice.length - 1].createdAt);
          findings.push({
            contentSha256: slice[0].contentSha256,
            channel: slice[0].channel,
            recipient: slice[0].recipient,
            events: slice.map((r) => ({
              id: r.id,
              sequence: r.sequence,
              createdAt: r.createdAt,
              sessionId: r.sessionId,
            })),
            deltaSeconds: (last - first) / 1000,
          });
        }
        runStart = i;
      }
    }
  }
  // Stable sort by first-event sequence so the report listing is deterministic.
  findings.sort((a, b) => a.events[0].sequence - b.events[0].sequence);
  return findings;
}

/**
 * R5b — first-seen tool detector. Returns tool names invoked inside `today`
 * that were not present in `prior`. Set semantics; ordering of the result
 * follows insertion order from the today list so heavy-usage names surface
 * first when the caller passes a count-sorted array.
 */
export function detectFirstSeenTools(today: ReadonlyArray<string>, prior: ReadonlyArray<string>): string[] {
  const priorSet = new Set(prior);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of today) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!priorSet.has(name)) out.push(name);
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Minimal event shape consumed by the new R12 detectors. We only need a few
 * fields and we want callers (tests, the orchestrator) to be able to pass
 * synthetic rows without constructing a full AuditEvent.
 */
export interface DetectorEvent {
  id: string;
  sequence: number;
  createdAt: string;
  eventType: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface EventRef {
  id: string;
  sequence: number;
  createdAt: string;
}

function toRef(e: DetectorEvent): EventRef {
  return { id: e.id, sequence: e.sequence, createdAt: e.createdAt };
}

// ---------------------------------------------------------------------------
// Gateway-drop spike
// ---------------------------------------------------------------------------

export interface GatewayDropSpikeFinding {
  /** First event in the cluster. */
  firstAt: string;
  /** Last event in the cluster. */
  lastAt: string;
  /** Number of `gateway.dropped` milestone events in the cluster. */
  count: number;
  /** `cumulativeDropped` delta across the cluster (lastDropped − firstDropped). */
  droppedDelta: number;
  events: EventRef[];
}

/**
 * Slide over `gateway.dropped` events ordered by createdAt; emit one finding
 * per maximal run where ≥ `threshold` milestone events fall inside `windowSec`.
 * Milestones are emitted on exponential thresholds by gateway-publisher, so
 * even a small count usually signifies a large absolute drop count — the
 * `droppedDelta` field surfaces the magnitude.
 */
export function detectGatewayDropSpike(
  events: ReadonlyArray<DetectorEvent>,
  windowSec: number,
  threshold: number,
): GatewayDropSpikeFinding[] {
  if (events.length === 0 || threshold < 1 || windowSec <= 0) return [];
  const sorted = [...events]
    .filter((e) => e.eventType === "gateway.dropped")
    .sort(byCreatedAt);
  if (sorted.length < threshold) return [];

  const windowMs = windowSec * 1000;
  const findings: GatewayDropSpikeFinding[] = [];
  let i = 0;
  while (i < sorted.length) {
    // Bound the cluster by both the gap to the next event AND the total span
    // from the cluster's first event. Without the span check, a slow drip of
    // events spaced just-under-windowSec apart collapses into one cluster
    // labelled "N drops in windowSec" that actually spans many windowSecs —
    // misleading the operator about the burst rate.
    const startMs = Date.parse(sorted[i].createdAt);
    let j = i + 1;
    while (
      j < sorted.length &&
      Date.parse(sorted[j].createdAt) - Date.parse(sorted[j - 1].createdAt) <= windowMs &&
      Date.parse(sorted[j].createdAt) - startMs <= windowMs
    ) {
      j++;
    }
    const count = j - i;
    if (count >= threshold) {
      const cluster = sorted.slice(i, j);
      const firstDropped = cumulativeDropped(cluster[0]);
      const lastDropped = cumulativeDropped(cluster[cluster.length - 1]);
      findings.push({
        firstAt: cluster[0].createdAt,
        lastAt: cluster[cluster.length - 1].createdAt,
        count,
        droppedDelta: Math.max(0, lastDropped - firstDropped),
        events: cluster.map(toRef),
      });
    }
    i = j;
  }
  return findings;
}

function cumulativeDropped(e: DetectorEvent): number {
  const v = e.metadata?.cumulativeDropped;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Denial spike
// ---------------------------------------------------------------------------

export interface DenialSpikeFinding {
  firstAt: string;
  lastAt: string;
  count: number;
  byTool: Array<{ toolName: string; count: number }>;
  topReason: string | null;
  events: EventRef[];
}

/**
 * Slide over `tool.denied` events ordered by createdAt; emit one finding per
 * maximal run where ≥ `threshold` denials fall inside `windowSec`.
 */
export function detectDenialSpike(
  events: ReadonlyArray<DetectorEvent>,
  windowSec: number,
  threshold: number,
): DenialSpikeFinding[] {
  if (events.length === 0 || threshold < 1 || windowSec <= 0) return [];
  const sorted = [...events]
    .filter((e) => e.eventType === "tool.denied")
    .sort(byCreatedAt);
  if (sorted.length < threshold) return [];

  const windowMs = windowSec * 1000;
  const findings: DenialSpikeFinding[] = [];
  let i = 0;
  while (i < sorted.length) {
    // See detectGatewayDropSpike for the dual gap+span bound rationale.
    const startMs = Date.parse(sorted[i].createdAt);
    let j = i + 1;
    while (
      j < sorted.length &&
      Date.parse(sorted[j].createdAt) - Date.parse(sorted[j - 1].createdAt) <= windowMs &&
      Date.parse(sorted[j].createdAt) - startMs <= windowMs
    ) {
      j++;
    }
    const count = j - i;
    if (count >= threshold) {
      const cluster = sorted.slice(i, j);
      const toolCounts = new Map<string, number>();
      const reasonCounts = new Map<string, number>();
      for (const e of cluster) {
        const toolName = typeof e.metadata?.toolName === "string" ? e.metadata.toolName : "<unknown>";
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        const reason = typeof e.metadata?.reason === "string" ? e.metadata.reason : null;
        if (reason !== null) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
      const byTool = [...toolCounts.entries()]
        .map(([toolName, c]) => ({ toolName, count: c }))
        .sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName));
      let topReason: string | null = null;
      let topCount = 0;
      for (const [reason, c] of reasonCounts) {
        if (c > topCount) {
          topCount = c;
          topReason = reason;
        }
      }
      findings.push({
        firstAt: cluster[0].createdAt,
        lastAt: cluster[cluster.length - 1].createdAt,
        count,
        byTool,
        topReason,
        events: cluster.map(toRef),
      });
    }
    i = j;
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Install events
// ---------------------------------------------------------------------------

export interface InstallEventFinding {
  id: string;
  sequence: number;
  createdAt: string;
  targetType: string;
  targetName: string;
  version: string | null;
  requestMode: string | null;
  scanStatus: string | null;
  scanCritical: number;
  scanWarn: number;
  /** True if the scan flagged something or the scan didn't pass cleanly. */
  elevated: boolean;
}

/**
 * Pass-through view: every `system.install` in the window surfaces as a
 * finding. The `elevated` flag is true when the security scan reported any
 * critical findings or finished in a non-"ok" status — the operator should
 * eyeball these first.
 */
export function detectInstallEvents(events: ReadonlyArray<DetectorEvent>): InstallEventFinding[] {
  return events
    .filter((e) => e.eventType === "system.install")
    .sort(byCreatedAt)
    .map((e) => {
      const md = e.metadata ?? {};
      const scanStatus = typeof md.scanStatus === "string" ? md.scanStatus : null;
      const scanCritical = numberOr(md.scanCritical, 0);
      const scanWarn = numberOr(md.scanWarn, 0);
      return {
        id: e.id,
        sequence: e.sequence,
        createdAt: e.createdAt,
        targetType: typeof md.targetType === "string" ? md.targetType : "<unknown>",
        targetName: typeof md.targetName === "string" ? md.targetName : "<unknown>",
        version: typeof md.version === "string" ? md.version : null,
        requestMode: typeof md.requestMode === "string" ? md.requestMode : null,
        scanStatus,
        scanCritical,
        scanWarn,
        elevated: scanCritical > 0 || (scanStatus !== null && scanStatus !== "ok"),
      };
    });
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Integrity violations
// ---------------------------------------------------------------------------

export interface UnverifiedAnchoredCheckpoint {
  checkpointId: string;
  sequenceStart: number;
  sequenceEnd: number;
  smtRoot: string;
  deTxHash: string | null;
  createdAt: string;
}

export interface TamperedEventRef extends EventRef {
  eventType: string;
}

export interface IntegrityViolationFinding {
  unverifiedAnchored: UnverifiedAnchoredCheckpoint[];
  tamperedEvents: TamperedEventRef[];
}

/**
 * Aggregate integrity signals. Both inputs are already filtered to the
 * caller's window — the orchestrator pulls unverified checkpoints whose
 * `createdAt` falls in window, and runs the SMT-leaf check (mirrors
 * `src/ui/routes.ts:classifyEvent`) per event before passing them here.
 *
 * Pure on its inputs so it stays trivially testable.
 */
export function detectIntegrityViolations(
  unverifiedAnchored: ReadonlyArray<UnverifiedAnchoredCheckpoint>,
  tamperedEvents: ReadonlyArray<TamperedEventRef>,
): IntegrityViolationFinding {
  return {
    unverifiedAnchored: [...unverifiedAnchored],
    tamperedEvents: [...tamperedEvents],
  };
}

function byCreatedAt(a: DetectorEvent, b: DetectorEvent): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sequence - b.sequence;
}
