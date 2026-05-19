import type { AuditStore } from "../store/audit-store.js";
import type { SmtService } from "../services/smt-service.js";
import type { AuditEvent } from "../types/events.js";
import { subtractCalendarDays, type TimeWindow } from "./time-window.js";
import {
  detectDuplicateOutbound,
  detectFirstSeenTools,
  detectGatewayDropSpike,
  detectDenialSpike,
  detectInstallEvents,
  type DuplicateOutboundFinding,
  type GatewayDropSpikeFinding,
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
export const DEFAULT_DROP_WINDOW_SEC = 300;
export const DEFAULT_DROP_THRESHOLD = 3;

export type AnomalyViewPeriod = TimeWindow;

export interface AnomalyDetectorConfig {
  dupWindowSec: number;
  lookbackDays: number;
  denialWindowSec: number;
  denialThreshold: number;
  dropWindowSec: number;
  dropThreshold: number;
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
    gatewayDropSpikes: GatewayDropSpikeFinding[];
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
  dropWindowSec?: number;
  dropThreshold?: number;
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
    dropWindowSec: opts.dropWindowSec ?? DEFAULT_DROP_WINDOW_SEC,
    dropThreshold: opts.dropThreshold ?? DEFAULT_DROP_THRESHOLD,
  };

  const { fromIso, toIso } = window;

  // One ranged scan feeds every detector. `createdBefore` in AuditStore.query
  // is inclusive on the lower edge but we want a half-open window, so
  // re-tighten with the post-filter.
  const rawEvents = store
    .query({
      createdAfter: fromIso,
      createdBefore: toIso,
      includeContent: true,
      order: "asc",
      limit: FETCH_CAP,
    })
    .filter((e) => e.createdAt >= fromIso && e.createdAt < toIso);
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
  const priorFromIso = subtractCalendarDays(fromIso, detectorConfig.lookbackDays, window.tz);
  const priorTools = store.distinctToolNamesInWindow(priorFromIso, fromIso);
  const firstSeenTools = detectFirstSeenTools(todayTools, priorTools);

  const detectorEvents: DetectorEvent[] = rawEvents.map(toDetectorEvent);
  const gatewayDropSpikes = detectGatewayDropSpike(
    detectorEvents,
    detectorConfig.dropWindowSec,
    detectorConfig.dropThreshold,
  );
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
      gatewayDropSpikes,
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
  const smtLastSeq = smtService.getLastCheckpointedSequence();
  const unverifiedAnchored: UnverifiedAnchoredCheckpoint[] = store
    .getUnverifiedCheckpoints()
    .filter((cp) => cp.createdAt >= fromIso && cp.createdAt < toIso)
    .map((cp) => ({
      checkpointId: cp.id,
      sequenceStart: cp.sequenceStart,
      sequenceEnd: cp.sequenceEnd,
      smtRoot: cp.smtRoot,
      deTxHash: cp.deTxHash,
      createdAt: cp.createdAt,
    }));
  const tamperedEvents: TamperedEventRef[] = [];
  // smtLastSeq === 0 means the SMT hasn't checkpointed anything yet — every
  // event is "untracked" by classifyEvent's rules, so we can't say whether
  // any leaf was tampered. Surface that as a note instead of silently
  // returning an empty list.
  const smtCheckpointed = smtLastSeq > 0;
  if (smtCheckpointed) {
    for (const e of rawEvents) {
      // Events past smtLastSeq are "untracked" (not yet replayed) — not
      // evidence of tampering. Mirrors src/ui/routes.ts:classifyEvent.
      if (e.sequence > smtLastSeq) continue;
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
    unverifiedAnchored,
    tamperedEvents,
    note,
  };
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
