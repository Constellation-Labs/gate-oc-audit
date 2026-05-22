import type { AuditStore } from "../store/audit-store.js";
import { subtractCalendarDays, type DailyWindow, type WeeklyWindow } from "./time-window.js";
import { detectDuplicateOutbound, detectFirstSeenTools, type DuplicateOutboundFinding, type MessageSentRow } from "./detectors.js";
import { listConfiguredCrons, type ConfiguredCron } from "../services/cron-manifests.js";

/**
 * Bumped on any incompatible shape change. The JSON Schema published at
 * schemas/audit-projection.schema.json tracks this value — consumers that
 * import the schema can pin against `schemaVersion === 1` and refuse newer
 * versions until they're updated.
 */
export const PROJECTION_SCHEMA_VERSION = 1 as const;

export const DEFAULT_DUP_OUTBOUND_WINDOW_SEC = 60;
export const DEFAULT_FIRST_SEEN_LOOKBACK_DAYS = 30;

export interface ProjectionPeriod {
  kind: "daily" | "weekly";
  fromIso: string;
  toIso: string;
  label: string;
  tz: "local" | "utc";
}

export interface ActivitySection {
  totalEvents: number;
  byCategory: Array<{ category: string; count: number }>;
}

export interface CronSection {
  executed: number;
  failed: number;
  byEventType: Array<{ eventType: string; count: number }>;
  /** Openclaw cron jobs configured on the machine the report was generated
   *  on. Primary source is `<openclawDir>/cron/jobs.json` (openclaw's canonical
   *  store); legacy `<jobId>.cron.*.json` per-file manifests are merged in as
   *  a fallback. Empty when no `openclawDir` is supplied or nothing exists. */
  configured: ConfiguredCron[];
}

export interface TopTool {
  toolName: string;
  invocations: number;
}

export interface LlmModelUsage {
  model: string;
  provider: string | null;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface LlmSpendSection {
  totalCalls: number;
  totalCostUsd: number;
  byModel: LlmModelUsage[];
}

export interface OutboundChannel {
  channel: string;
  count: number;
}

export interface OutboundMessagingSection {
  totalSent: number;
  byChannel: OutboundChannel[];
}

export interface AnomaliesSection {
  duplicateOutbound: DuplicateOutboundFinding[];
  /**
   * True when the dedup detector hit DUP_FETCH_CAP and the underlying
   * message-set was truncated. A subsequent window with even more outbound
   * traffic could harbour duplicates this report did not see.
   */
  duplicateOutboundTruncated: boolean;
  firstSeenTools: string[];
}

export interface IntegrityCheckpointRef {
  checkpointId: string;
  deTxHash: string | null;
  smtRoot: string;
  sequenceStart: number;
  sequenceEnd: number;
  createdAt: string;
}

export interface IntegrityFooter {
  lastSequence: number | null;
  lastEventId: string | null;
  lastEventCreatedAt: string | null;
  lastEventContentHash: string | null;
  lastCheckpoint: IntegrityCheckpointRef | null;
}

export interface AuditProjection {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION;
  generatedAt: string;
  period: ProjectionPeriod;
  /** Echo of the detector knobs so the JSON output is self-describing. */
  detectorConfig: {
    duplicateOutboundWindowSec: number;
    firstSeenLookbackDays: number;
  };
  activity: ActivitySection;
  cron: CronSection;
  topTools: TopTool[];
  llmSpend: LlmSpendSection;
  outboundMessaging: OutboundMessagingSection;
  anomalies: AnomaliesSection;
  integrity: IntegrityFooter;
}

export interface BuildProjectionOptions {
  duplicateOutboundWindowSec?: number;
  firstSeenLookbackDays?: number;
  /** Cap for the top-N tools section. Default 10. */
  topToolsLimit?: number;
  /** When supplied, the openclaw root whose `cron/jobs.json` (and legacy
   *  `<jobId>.cron.*.json` per-file manifests) populate `cron.configured`.
   *  Omit to render an empty configured list. */
  openclawDir?: string;
}

export function buildProjection(
  store: AuditStore,
  window: DailyWindow | WeeklyWindow,
  opts: BuildProjectionOptions = {},
): AuditProjection {
  const dupWindowSec = opts.duplicateOutboundWindowSec ?? DEFAULT_DUP_OUTBOUND_WINDOW_SEC;
  const lookbackDays = opts.firstSeenLookbackDays ?? DEFAULT_FIRST_SEEN_LOOKBACK_DAYS;
  const topToolsLimit = opts.topToolsLimit ?? 10;

  const { fromIso, toIso } = window;

  // --- Activity --------------------------------------------------------
  const byCategory = store.aggregateActivityByCategoryInWindow(fromIso, toIso);
  const totalEvents = byCategory.reduce((sum, r) => sum + r.count, 0);

  // --- Cron ------------------------------------------------------------
  const cronByType = store.aggregateCronByEventTypeInWindow(fromIso, toIso);
  const executed = cronByType.find((r) => r.eventType === "cron.executed")?.count ?? 0;
  const failed = cronByType.find((r) => r.eventType === "cron.failed")?.count ?? 0;
  const configuredCrons = opts.openclawDir ? listConfiguredCrons(opts.openclawDir) : [];

  // --- Top tools -------------------------------------------------------
  const allTools = store.aggregateToolInvocationsInWindow(fromIso, toIso);
  const topTools = allTools.slice(0, topToolsLimit);

  // --- LLM spend -------------------------------------------------------
  const llmRows = store.aggregateLlmUsageInWindow(fromIso, toIso);
  const totalCalls = llmRows.reduce((s, r) => s + r.callCount, 0);
  const totalCostUsd = llmRows.reduce((s, r) => s + r.costUsd, 0);

  // --- Outbound messaging ---------------------------------------------
  const byChannel = store.aggregateMessageSentByChannelInWindow(fromIso, toIso);
  const totalSent = byChannel.reduce((s, r) => s + r.count, 0);

  // --- Anomaly R5a: duplicate outbound --------------------------------
  // We pull every message.sent in the window with content. Aggregate counts
  // above only need the count, but the dedup detector needs the raw body to
  // hash. Cap at 100k to keep memory bounded on pathological days; if a
  // future operator has more outbound traffic than that, raise the cap rather
  // than silently dropping events. Filter to strict < toIso so the boundary
  // event (if any) attributes to the next day's report and not both.
  const DUP_FETCH_CAP = 100_000;
  const messages = store
    .query({
      eventType: "message.sent",
      createdAfter: fromIso,
      createdBefore: toIso,
      includeContent: true,
      order: "asc",
      limit: DUP_FETCH_CAP,
    })
    .filter((e) => e.createdAt >= fromIso && e.createdAt < toIso);
  const duplicateOutboundTruncated = messages.length >= DUP_FETCH_CAP;
  const messageRows: MessageSentRow[] = messages.map((e) => ({
    id: e.id,
    sequence: e.sequence,
    createdAt: e.createdAt,
    sessionId: e.sessionId,
    channel: typeof e.metadata.channel === "string" ? e.metadata.channel : "<unknown>",
    recipient: typeof e.metadata.recipient === "string" ? e.metadata.recipient : "<unknown>",
    content: e.content,
  }));
  const duplicateOutbound = detectDuplicateOutbound(messageRows, dupWindowSec);

  // --- Anomaly R5b: first-seen tools ----------------------------------
  // "First-seen today" = present in the window's tool.invoked set but absent
  // from the trailing lookbackDays ending at the window's start.
  const todayTools = store
    .aggregateToolInvocationsInWindow(fromIso, toIso)
    .map((r) => r.toolName);
  // Calendar-day arithmetic in the window's tz so a 30-day lookback across
  // a DST transition still aligns on local midnight on both sides.
  const priorFromIso = subtractCalendarDays(fromIso, lookbackDays, window.tz);
  const priorTools = store.distinctToolNamesInWindow(priorFromIso, fromIso);
  const firstSeenTools = detectFirstSeenTools(todayTools, priorTools);

  // --- Integrity footer ----------------------------------------------
  const lastEvent = store.getReportLastEvent();
  const lastCp = store.getLastCheckpoint();
  const integrity: IntegrityFooter = {
    lastSequence: lastEvent?.sequence ?? null,
    lastEventId: lastEvent?.id ?? null,
    lastEventCreatedAt: lastEvent?.createdAt ?? null,
    lastEventContentHash: lastEvent?.contentHash ?? null,
    lastCheckpoint: lastCp
      ? {
          checkpointId: lastCp.id,
          deTxHash: lastCp.deTxHash,
          smtRoot: lastCp.smtRoot,
          sequenceStart: lastCp.sequenceStart,
          sequenceEnd: lastCp.sequenceEnd,
          createdAt: lastCp.createdAt,
        }
      : null,
  };

  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    period: {
      kind: window.kind,
      fromIso: window.fromIso,
      toIso: window.toIso,
      label: window.label,
      tz: window.tz,
    },
    detectorConfig: {
      duplicateOutboundWindowSec: dupWindowSec,
      firstSeenLookbackDays: lookbackDays,
    },
    activity: { totalEvents, byCategory },
    cron: { executed, failed, byEventType: cronByType, configured: configuredCrons },
    topTools,
    llmSpend: { totalCalls, totalCostUsd, byModel: llmRows },
    outboundMessaging: { totalSent, byChannel },
    anomalies: { duplicateOutbound, duplicateOutboundTruncated, firstSeenTools },
    integrity,
  };
}
