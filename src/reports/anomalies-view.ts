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
  detectIntegrityViolations,
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

export interface AnomalyViewPeriod {
  kind: "since" | "daily" | "weekly";
  fromIso: string;
  toIso: string;
  label: string;
  tz: "local" | "utc";
}

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
    capped: boolean;
  };
  anomalies: {
    duplicateOutbound: DuplicateOutboundFinding[];
    duplicateOutboundTruncated: boolean;
    firstSeenTools: string[];
    gatewayDropSpikes: GatewayDropSpikeFinding[];
    denialSpikes: DenialSpikeFinding[];
    installEvents: InstallEventFinding[];
    integrityViolations: IntegrityViolationFinding;
  };
}

export interface BuildAnomalyViewOptions {
  duplicateOutboundWindowSec?: number;
  firstSeenLookbackDays?: number;
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
    dupWindowSec: opts.duplicateOutboundWindowSec ?? DEFAULT_DUP_WINDOW_SEC,
    lookbackDays: opts.firstSeenLookbackDays ?? DEFAULT_FIRST_SEEN_LOOKBACK_DAYS,
    denialWindowSec: opts.denialWindowSec ?? DEFAULT_DENIAL_WINDOW_SEC,
    denialThreshold: opts.denialThreshold ?? DEFAULT_DENIAL_THRESHOLD,
    dropWindowSec: opts.dropWindowSec ?? DEFAULT_DROP_WINDOW_SEC,
    dropThreshold: opts.dropThreshold ?? DEFAULT_DROP_THRESHOLD,
  };

  const { fromIso, toIso } = window;

  // Pull every event in the window once. We need raw rows for the dedup detector
  // (which needs decompressed content) plus filtered subsets for the other
  // detectors. Doing a single ranged scan beats four separate eventType queries
  // when the window is sparse — and the FETCH_CAP keeps memory bounded.
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

  // First-seen tools: today's set comes from in-window aggregation (cheap; uses
  // the same SQL aggregation buildProjection uses), prior set from a
  // lookback-days window ending at fromIso. tool.invoked emissions in the
  // current window come from rawEvents but we trust the existing aggregate so
  // the answer is consistent with `report daily`.
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

  // Integrity: unverified anchored checkpoints whose createdAt falls in window,
  // plus events whose raw hash is no longer in any SMT tree (the same
  // "tampered" signal `src/ui/routes.ts:classifyEvent` uses).
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
  for (const e of rawEvents) {
    if (e.sequence > smtLastSeq) continue; // not yet replayed into SMT — see classifyEvent
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
  const integrityViolations = detectIntegrityViolations(unverifiedAnchored, tamperedEvents);

  return {
    schemaVersion: ANOMALY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    period: {
      kind: window.kind,
      fromIso: window.fromIso,
      toIso: window.toIso,
      label: window.label,
      tz: window.tz,
    },
    detectorConfig,
    counts: {
      totalEventsInWindow: rawEvents.length,
      capped,
    },
    anomalies: {
      duplicateOutbound,
      // `messages` is a subset of the already-capped `rawEvents`, so a
      // per-detector cap would only fire when 100% of fetched events are
      // message.sent. Reuse the global `capped` signal instead so the
      // truncation warning surfaces under realistic mixed traffic.
      duplicateOutboundTruncated: capped,
      firstSeenTools,
      gatewayDropSpikes,
      denialSpikes,
      installEvents,
      integrityViolations,
    },
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
