import type { AuditStore } from "../store/audit-store.js";
import type { SmtService } from "../services/smt-service.js";
import { ANCHOR_NOT_FOUND_HEALTH_NAME } from "../services/health-keys.js";
import type { AuditEvent } from "../types/events.js";
import { floorToTzDay, subtractCalendarDays, type TimeWindow } from "./time-window.js";
import {
  detectDuplicateOutbound,
  detectFirstSeenTools,
  detectDenialSpike,
  detectInstallEvents,
  type DuplicateOutboundFinding,
  type DenialSpikeFinding,
  type InstallEventFinding,
  type IntegrityViolationFinding,
  type MessageSentRow,
  type TamperedEventRef,
  type UnverifiedAnchoredCheckpoint,
  type DetectorEvent,
} from "./detectors.js";

export const ANOMALY_SCHEMA_VERSION = 1 as const;

/** Cap on per-query event fetches to keep memory bounded on busy windows. */
const FETCH_CAP = 100_000;

export const DEFAULT_DUP_WINDOW_SEC = 60;
export const DEFAULT_FIRST_SEEN_LOOKBACK_DAYS = 30;
export const DEFAULT_DENIAL_WINDOW_SEC = 300;
export const DEFAULT_DENIAL_THRESHOLD = 5;

export type AnomalyViewPeriod = TimeWindow;

export interface AnomalyDetectorConfig {
  dupWindowSec: number;
  lookbackDays: number;
  denialWindowSec: number;
  denialThreshold: number;
}

export interface AnomalyView {
  schemaVersion: typeof ANOMALY_SCHEMA_VERSION;
  generatedAt: string;
  period: AnomalyViewPeriod;
  detectorConfig: AnomalyDetectorConfig;
  counts: {
    totalEventsInWindow: number;
    /**
     * True when the in-window event fetch hit FETCH_CAP. When this is true,
     * every detector below is operating on a truncated view — not just
     * dedup-outbound — so treat any "no findings" answer as inconclusive.
     */
    capped: boolean;
  };
  anomalies: {
    duplicateOutbound: DuplicateOutboundFinding[];
    firstSeenTools: string[];
    denialSpikes: DenialSpikeFinding[];
    installEvents: InstallEventFinding[];
    integrityViolations: IntegrityViolationFinding;
  };
}

export interface BuildAnomalyViewOptions {
  dupWindowSec?: number;
  lookbackDays?: number;
  denialWindowSec?: number;
  denialThreshold?: number;
}

export function buildAnomalyView(
  store: AuditStore,
  smtService: SmtService,
  window: TimeWindow,
  opts: BuildAnomalyViewOptions = {},
): AnomalyView {
  const detectorConfig: AnomalyDetectorConfig = {
    dupWindowSec: opts.dupWindowSec ?? DEFAULT_DUP_WINDOW_SEC,
    lookbackDays: opts.lookbackDays ?? DEFAULT_FIRST_SEEN_LOOKBACK_DAYS,
    denialWindowSec: opts.denialWindowSec ?? DEFAULT_DENIAL_WINDOW_SEC,
    denialThreshold: opts.denialThreshold ?? DEFAULT_DENIAL_THRESHOLD,
  };

  const { fromIso, toIso } = window;

  // One ranged scan feeds every detector. AuditStore.query already applies a
  // half-open window (`created_at >= @createdAfter AND created_at < @createdBefore`),
  // so no post-filter is needed. `capped` is derived from the raw result length
  // so a busy window that truly hit the cap is always reported as truncated.
  const rawEvents = store.query({
    createdAfter: fromIso,
    createdBefore: toIso,
    includeContent: true,
    order: "asc",
    limit: FETCH_CAP,
  });
  const capped = rawEvents.length >= FETCH_CAP;

  const messages = rawEvents.filter((e) => e.eventType === "message.sent");
  const messageRows: MessageSentRow[] = messages.map((e) => ({
    id: e.id,
    sequence: e.sequence,
    createdAt: e.createdAt,
    sessionId: e.sessionId,
    channel: typeof e.metadata.channel === "string" ? e.metadata.channel : "<unknown>",
    recipient: typeof e.metadata.recipient === "string" ? e.metadata.recipient : "<unknown>",
    content: e.content,
  }));
  const duplicateOutbound = detectDuplicateOutbound(messageRows, detectorConfig.dupWindowSec);

  // Today vs. prior tool sets use the existing SQL aggregations rather than
  // counting in-memory so the answer stays consistent with `report daily`
  // (which also relies on the same json_extract path for tool names).
  const todayTools = store
    .aggregateToolInvocationsInWindow(fromIso, toIso)
    .map((r) => r.toolName);
  // Floor the window start to the tz day boundary before subtracting so a
  // non-midnight window (e.g. `--since 90m`) still produces a clean N-day
  // baseline rather than an oddly-offset one (corr-r2-M4). Daily/weekly
  // windows already start at midnight, so this is a no-op for them.
  const priorAnchorIso = floorToTzDay(fromIso, window.tz);
  const priorFromIso = subtractCalendarDays(priorAnchorIso, detectorConfig.lookbackDays, window.tz);
  const priorTools = store.distinctToolNamesInWindow(priorFromIso, fromIso);
  const firstSeenTools = detectFirstSeenTools(todayTools, priorTools);

  const detectorEvents: DetectorEvent[] = rawEvents.map(toDetectorEvent);
  const denialSpikes = detectDenialSpike(
    detectorEvents,
    detectorConfig.denialWindowSec,
    detectorConfig.denialThreshold,
  );
  const installEvents = detectInstallEvents(detectorEvents);

  const integrityViolations = collectIntegrityViolations(store, smtService, window, rawEvents);

  return {
    schemaVersion: ANOMALY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    period: window,
    detectorConfig,
    counts: {
      totalEventsInWindow: rawEvents.length,
      capped,
    },
    anomalies: {
      duplicateOutbound,
      firstSeenTools,
      denialSpikes,
      installEvents,
      integrityViolations,
    },
  };
}

function collectIntegrityViolations(
  store: AuditStore,
  smtService: SmtService,
  window: TimeWindow,
  rawEvents: ReadonlyArray<AuditEvent>,
): IntegrityViolationFinding {
  const { fromIso, toIso } = window;
  const smtLastSeq = smtService.getLastInsertedSequence();
  // An unverified checkpoint is only a violation once DE has confirmed its
  // transaction is missing (a 404, recorded in the persisted not-found set).
  // Everything else is simply pending confirmation — normal, not an anomaly.
  const notFoundIds = readNotFoundCheckpointIds(store);
  const notFoundOnDe: UnverifiedAnchoredCheckpoint[] = [];
  const pendingVerification: UnverifiedAnchoredCheckpoint[] = [];
  for (const cp of store.getUnverifiedCheckpoints()) {
    if (!(cp.createdAt >= fromIso && cp.createdAt < toIso)) continue;
    const ref: UnverifiedAnchoredCheckpoint = {
      checkpointId: cp.id,
      sequenceStart: cp.sequenceStart,
      sequenceEnd: cp.sequenceEnd,
      smtRoot: cp.smtRoot,
      deTxHash: cp.deTxHash,
      createdAt: cp.createdAt,
    };
    (notFoundIds.has(cp.id) ? notFoundOnDe : pendingVerification).push(ref);
  }
  const tamperedEvents: TamperedEventRef[] = [];
  // smtLastSeq === 0 means the SMT hasn't checkpointed anything yet — every
  // event is "untracked" by classifyEvent's rules, so we can't say whether
  // any leaf was tampered. Surface that as a note instead of silently
  // returning an empty list.
  const smtCheckpointed = smtLastSeq > 0;
  if (smtCheckpointed) {
    for (const e of rawEvents) {
      // Events past smtLastSeq are "untracked" (not yet replayed) — not
      // evidence of tampering. Same for seqs the SMT skipped by policy
      // (frozen leaf, insert rejected). Mirrors src/ui/routes.ts:classifyEvent.
      if (e.sequence > smtLastSeq) continue;
      if (smtService.wasSkipped(e.sequence)) continue;
      const rawHash = smtService.computeRawHash(e);
      if (smtService.findContainingTreeKey(rawHash) === null) {
        tamperedEvents.push({
          id: e.id,
          sequence: e.sequence,
          createdAt: e.createdAt,
          eventType: e.eventType,
        });
      }
    }
  }
  let note: string | null = null;
  if (!smtCheckpointed) {
    // A restore failure and a never-checkpointed SMT both leave smtLastSeq
    // at 0; the operator-actionable distinction is whether the on-disk
    // state could not be loaded vs. simply doesn't exist yet.
    const restoreError = smtService.getRestoreError();
    note = restoreError
      ? `SMT restore failed (${restoreError}) — tamper scan skipped.`
      : "SMT has no checkpointed leaves yet — tamper scan skipped.";
  }
  return {
    notFoundOnDe,
    pendingVerification,
    tamperedEvents,
    note,
  };
}

/**
 * Read the persisted set of checkpoint IDs whose DE transaction was confirmed
 * missing (404). Mirrors ActiveAnchorService's not-found dedup set, which is
 * the authoritative signal for "anchored but truly absent from DE".
 */
function readNotFoundCheckpointIds(store: AuditStore): Set<string> {
  const row = store.getServiceHealth(ANCHOR_NOT_FOUND_HEALTH_NAME);
  if (!row || !Array.isArray(row.payload)) return new Set();
  return new Set(
    (row.payload as unknown[]).filter((id): id is string => typeof id === "string"),
  );
}

function toDetectorEvent(e: AuditEvent): DetectorEvent {
  return {
    id: e.id,
    sequence: e.sequence,
    createdAt: e.createdAt,
    eventType: e.eventType,
    sessionId: e.sessionId,
    metadata: e.metadata,
  };
}
