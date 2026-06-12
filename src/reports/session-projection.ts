import type { AuditStore } from "../store/audit-store.js";
import type { AuditEvent, EventType } from "../types/events.js";
import type { SmtService } from "../services/smt-service.js";

export const SESSION_PROJECTION_SCHEMA_VERSION = 1 as const;

/**
 * Event types whose body is duplicated across the canonical "one outbound
 * round-trip" pattern: an LLM responds (prompt.response), the gateway is
 * asked to send (message.sending), and the gateway confirms send
 * (message.sent). All three rows carry the same body and produce four
 * near-identical entries per cron run in `audit list` (the duplicate at
 * 20:57Z in the PRD sample makes it five). Default-mode collapses any
 * consecutive run of these whose contentHash matches.
 */
const DEDUP_EVENT_TYPES = new Set<EventType>([
  "prompt.response",
  "message.sending",
  "message.sent",
]);

const DEFAULT_CONTENT_PREVIEW_CHARS = 500;
/** Bounded — a single session over 50k events is forensic territory; --raw still works. */
const SESSION_FETCH_CAP = 50_000;

export interface SessionTimelineEntry {
  sequence: number;
  id: string;
  createdAt: string;
  eventType: EventType;
  category: string;
  description: string;
  contentHash: string;
  contentPreview?: string;
  metadata: Record<string, unknown>;
  /** When >1 this entry collapsed N consecutive identical-content rows. */
  collapsedCount?: number;
  /** Sequence numbers of every row folded into this entry, in order. */
  collapsedSequences?: number[];
}

export interface SessionToolUsage {
  toolName: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
}

export interface SessionLlmModelUsage {
  provider: string | null;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface SessionLlmCost {
  totalCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  byModel: SessionLlmModelUsage[];
}

export interface SessionOutboundSend {
  sequence: number;
  id: string;
  createdAt: string;
  channel: string;
  recipient: string;
  contentHash: string;
  contentLength: number | null;
  success: boolean | null;
}

export interface SessionOutboundMessage {
  contentHash: string;
  bodyPreview?: string;
  sends: SessionOutboundSend[];
}

export interface SessionIntegrity {
  eventCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
  /** Best-effort proof status: only populated when an SmtService is provided. */
  proofsVerified: number;
  proofsFailed: number;
  proofsUnavailable: number;
  /** SMT root that the verified proofs anchor against, if all share one. */
  smtRoot: string | null;
}

export interface SessionProjection {
  schemaVersion: typeof SESSION_PROJECTION_SCHEMA_VERSION;
  generatedAt: string;
  sessionId: string;
  jobId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** When true, timeline holds raw rows (no dedup); the other sections are still aggregated. */
  raw: boolean;
  timeline: SessionTimelineEntry[];
  toolsUsed: SessionToolUsage[];
  llmCost: SessionLlmCost;
  outboundMessages: SessionOutboundMessage[];
  integrity: SessionIntegrity;
  /** Set when the fetched event count hit SESSION_FETCH_CAP. */
  truncated: boolean;
}

export interface BuildSessionProjectionOptions {
  /** Skip dedup and return the raw event stream in the timeline. */
  raw?: boolean;
  /** How many chars of content to keep in previews. Default 500. */
  contentPreviewChars?: number;
  /**
   * Cap the number of events the projection operates on. The window is the
   * *last* N events of the session (by sequence), matching the semantics of
   * `audit list --session <id> --limit N`. All sections — timeline, tools,
   * LLM cost, outbound, integrity — honor this slice. Default
   * SESSION_FETCH_CAP.
   */
  limit?: number;
  /** Optional — when provided, integrity section attempts per-event proof lookups. */
  smtService?: SmtService;
  knownRoots?: Set<string>;
}

function numOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function toTimelineEntry(e: AuditEvent): SessionTimelineEntry {
  return {
    sequence: e.sequence,
    id: e.id,
    createdAt: e.createdAt,
    eventType: e.eventType,
    category: e.category,
    description: e.description,
    contentHash: e.contentHash,
    contentPreview: e.content,
    metadata: e.metadata,
  };
}

// sha256("") — used to skip dedup when both rows simply have no body, since
// "no body" is not the "same body repeated" pattern this collapse targets.
const EMPTY_CONTENT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function dedupTimeline(events: AuditEvent[]): SessionTimelineEntry[] {
  const out: SessionTimelineEntry[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    const canCollapse =
      last !== undefined &&
      DEDUP_EVENT_TYPES.has(e.eventType) &&
      DEDUP_EVENT_TYPES.has(last.eventType) &&
      e.contentHash === last.contentHash &&
      e.contentHash !== "" &&
      e.contentHash !== EMPTY_CONTENT_SHA256;
    if (canCollapse && last) {
      last.collapsedCount = (last.collapsedCount ?? 1) + 1;
      const seqs = last.collapsedSequences ?? [last.sequence];
      seqs.push(e.sequence);
      last.collapsedSequences = seqs;
      continue;
    }
    out.push(toTimelineEntry(e));
  }
  return out;
}

function aggregateTools(events: AuditEvent[]): SessionToolUsage[] {
  const byName = new Map<string, SessionToolUsage>();
  for (const e of events) {
    if (e.category !== "tool") continue;
    const toolName = stringOrNull(e.metadata.toolName) ?? "<unknown>";
    let entry = byName.get(toolName);
    if (!entry) {
      entry = { toolName, calls: 0, errors: 0, totalDurationMs: 0 };
      byName.set(toolName, entry);
    }
    if (e.eventType === "tool.invoked") entry.calls += 1;
    if (e.eventType === "tool.result") {
      entry.totalDurationMs += numOrZero(e.metadata.durationMs);
      if (typeof e.metadata.error === "string" && e.metadata.error.length > 0) {
        entry.errors += 1;
      }
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.calls - a.calls);
}

function aggregateLlmCost(events: AuditEvent[]): SessionLlmCost {
  const byKey = new Map<string, SessionLlmModelUsage>();
  let totalCalls = 0;
  let totalCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const e of events) {
    if (e.eventType !== "prompt.response") continue;
    const provider = stringOrNull(e.metadata.provider);
    const model = stringOrNull(e.metadata.model) ?? "<unknown>";
    const key = `${provider ?? ""}|${model}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        provider,
        model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      };
      byKey.set(key, entry);
    }
    entry.calls += 1;
    entry.inputTokens += numOrZero(e.metadata.inputTokens);
    entry.outputTokens += numOrZero(e.metadata.outputTokens);
    entry.cacheReadTokens += numOrZero(e.metadata.cacheReadTokens);
    entry.cacheWriteTokens += numOrZero(e.metadata.cacheWriteTokens);
    entry.costUsd += numOrZero(e.metadata.costUsd);

    totalCalls += 1;
    inputTokens += numOrZero(e.metadata.inputTokens);
    outputTokens += numOrZero(e.metadata.outputTokens);
    cacheReadTokens += numOrZero(e.metadata.cacheReadTokens);
    cacheWriteTokens += numOrZero(e.metadata.cacheWriteTokens);
    totalCostUsd += numOrZero(e.metadata.costUsd);
  }
  return {
    totalCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalCostUsd,
    byModel: Array.from(byKey.values()).sort((a, b) => b.costUsd - a.costUsd),
  };
}

function aggregateOutbound(events: AuditEvent[], previewChars: number): SessionOutboundMessage[] {
  const byHash = new Map<string, SessionOutboundMessage>();
  for (const e of events) {
    if (e.eventType !== "message.sent") continue;
    const channel = stringOrNull(e.metadata.channel) ?? "<unknown>";
    const recipient = stringOrNull(e.metadata.recipient) ?? "<unknown>";
    const contentLength = typeof e.metadata.contentLength === "number"
      ? e.metadata.contentLength
      : (e.content ? e.content.length : null);
    const success = typeof e.metadata.success === "boolean" ? e.metadata.success : null;
    let group = byHash.get(e.contentHash);
    if (!group) {
      group = {
        contentHash: e.contentHash,
        bodyPreview: e.content ? e.content.slice(0, previewChars) : undefined,
        sends: [],
      };
      byHash.set(e.contentHash, group);
    } else if (group.bodyPreview === undefined && e.content) {
      group.bodyPreview = e.content.slice(0, previewChars);
    }
    group.sends.push({
      sequence: e.sequence,
      id: e.id,
      createdAt: e.createdAt,
      channel,
      recipient,
      contentHash: e.contentHash,
      contentLength,
      success,
    });
  }
  return Array.from(byHash.values());
}

function findSessionJobId(
  store: AuditStore,
  sessionId: string,
  windowedEvents: AuditEvent[],
): string | null {
  // Fast path: the window already covers cron.executed (or a downstream row
  // that carries jobId). Avoid the extra query for the typical case.
  for (const e of windowedEvents) {
    const candidate = stringOrNull(e.metadata.jobId);
    if (candidate) return candidate;
  }
  // Fallback assumes one jobId per sessionId (the normal case). If a session
  // were to span multiple cron runs sharing the sessionId, this returns the
  // jobId of the *earliest* cron.executed (order: "asc", limit: 1), which may
  // differ from the run the caller windowed into.
  const cronRow = store.query({
    sessionId,
    eventType: "cron.executed",
    order: "asc",
    limit: 1,
  })[0];
  return cronRow ? stringOrNull(cronRow.metadata.jobId) : null;
}

function computeIntegrity(
  events: AuditEvent[],
  smtService: SmtService | undefined,
  knownRoots: Set<string> | undefined,
): SessionIntegrity {
  const eventCount = events.length;
  const firstSequence = events[0]?.sequence ?? null;
  const lastSequence = events[events.length - 1]?.sequence ?? null;

  if (!smtService || eventCount === 0) {
    return {
      eventCount,
      firstSequence,
      lastSequence,
      proofsVerified: 0,
      proofsFailed: 0,
      proofsUnavailable: eventCount,
      smtRoot: null,
    };
  }

  let verified = 0;
  let failed = 0;
  let unavailable = 0;
  const roots = new Set<string>();
  for (const e of events) {
    let leafHash: string;
    try {
      // Verify against the RAW hash (includes content/metadata), matching
      // verifier.ts and ui/routes.ts. The censored hash excludes content, so
      // looking up by it would count an event whose body was tampered with as
      // "verified" — defeating the integrity check.
      leafHash = smtService.computeRawHash(e);
    } catch {
      unavailable += 1;
      continue;
    }
    const treeKey = smtService.findContainingTreeKey(leafHash);
    if (!treeKey) {
      unavailable += 1;
      continue;
    }
    const proof = smtService.createProof(leafHash, treeKey);
    if (!proof) {
      unavailable += 1;
      continue;
    }
    if (knownRoots && knownRoots.size > 0) {
      const res = smtService.verifyProofWithRoots(proof, knownRoots);
      if (res.status === "valid") {
        verified += 1;
        roots.add(proof.root);
      } else if (res.status === "invalid") {
        failed += 1;
      } else {
        unavailable += 1;
      }
    } else {
      // No roots to compare against: count the proof existence as
      // "unavailable" rather than verified, so the report doesn't lie.
      unavailable += 1;
      roots.add(proof.root);
    }
  }
  return {
    eventCount,
    firstSequence,
    lastSequence,
    proofsVerified: verified,
    proofsFailed: failed,
    proofsUnavailable: unavailable,
    smtRoot: roots.size === 1 ? Array.from(roots)[0] : null,
  };
}

export function buildSessionProjection(
  store: AuditStore,
  sessionId: string,
  opts: BuildSessionProjectionOptions = {},
): SessionProjection {
  const previewChars = opts.contentPreviewChars ?? DEFAULT_CONTENT_PREVIEW_CHARS;
  const raw = opts.raw === true;
  // Upper bound only — protects against unbounded loads from programmatic
  // callers. CLI input is already validated by parsePositiveInt; non-CLI
  // callers passing 0/negative/NaN are trusted to know what they want.
  const limit = Math.min(opts.limit ?? SESSION_FETCH_CAP, SESSION_FETCH_CAP);

  // Pull the last `limit` events of the session via DESC + reverse so that
  // `report session --raw --limit N` matches `audit list --session <id>
  // --limit N` row-for-row at any session size. (`audit list` follows the
  // same DESC-then-reverse pattern; see cliAuditHandler in src/cli.ts.)
  // includeContent is needed because dedup keys off contentHash (cheap) but
  // the timeline preview and outbound body preview both read from content.
  const events = store
    .query({
      sessionId,
      order: "desc",
      limit,
      contentPreview: previewChars,
    })
    .reverse();
  // truncated reflects whether the windowing dropped session events. When
  // the caller didn't pass an explicit limit, this means the hard cap fired;
  // when they did, it means the session had more than they asked for. The
  // `&&` short-circuit is load-bearing: we only pay the extra count() trip
  // when the window is actually full.
  const truncated = events.length >= limit && store.count({ sessionId }) > events.length;

  const startedAt = events[0]?.createdAt ?? null;
  const endedAt = events[events.length - 1]?.createdAt ?? null;
  const durationMs = startedAt && endedAt
    ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
    : null;

  // jobId is anchored on the session's cron.executed row, which a small
  // --limit window may exclude. Pull it via a dedicated lookup so the
  // window-only semantic doesn't accidentally drop the cron context the
  // header line depends on.
  const jobId = findSessionJobId(store, sessionId, events);

  const timeline = raw ? events.map(toTimelineEntry) : dedupTimeline(events);
  const toolsUsed = aggregateTools(events);
  const llmCost = aggregateLlmCost(events);
  const outboundMessages = aggregateOutbound(events, previewChars);
  const integrity = computeIntegrity(events, opts.smtService, opts.knownRoots);

  return {
    schemaVersion: SESSION_PROJECTION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sessionId,
    jobId,
    startedAt,
    endedAt,
    durationMs,
    raw,
    timeline,
    toolsUsed,
    llmCost,
    outboundMessages,
    integrity,
    truncated,
  };
}
