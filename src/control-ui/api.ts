export type EventStatus = "verified" | "pending" | "tampered" | "untracked";

export interface EventVerificationSummary {
  status: EventStatus;
  treeKey?: string;
}

export interface ApiEvent {
  id: string;
  sequence: number;
  source: string;
  machineId: string;
  sessionId?: string;
  orgId?: string;
  userId?: string;
  eventType: string;
  category: string;
  description: string;
  metadata: Record<string, unknown>;
  content?: string;
  createdAt: string;
  receivedAt?: string;
  syncedAt?: string;
  verification?: EventVerificationSummary;
}

export interface SmtProof {
  root: string;
  key: string;
  siblings: string[];
  membership: boolean;
}

export interface EventVerifyPayload {
  rawHash: string;
  censoredHash: string;
  treesContaining: Array<{ key: string; hasRaw: boolean; hasCensored: boolean }>;
  proof: SmtProof | null;
  verification: { status: "valid" | "invalid" | "unverifiable"; reason?: string };
  anchoredAt: {
    checkpointId: string;
    smtRoot: string;
    deTxHash: string;
    sequenceStart: number;
    sequenceEnd: number;
    createdAt: string;
    verifiedAt: string | null;
  } | null;
  deBaseUrl: string | null;
}

export interface EventsResponse {
  events: ApiEvent[];
  total: number;
  limit: number;
  offset: number;
  degraded: boolean;
}

export interface TreeInfo {
  key: string;
  root: string;
  entryCount: number;
  size: number;
}

export interface CheckpointRecord {
  id: string;
  sequenceStart: number;
  sequenceEnd: number;
  smtRoot: string;
  eventCount: number;
  deTxHash: string | null;
  createdAt: string;
}

const API_BASE = new URL("./api/", document.baseURI).toString();

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init);
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }
    const msg = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : `request failed: ${res.status}`;
    throw new Error(msg);
  }
  return await res.json() as T;
}

export interface EventsQuery {
  limit?: number;
  offset?: number;
  type?: string;
  category?: string;
  session?: string;
  /** Land on the page containing this sequence; server overrides `offset`. */
  focusSeq?: number;
}

export function listEvents(q: EventsQuery = {}): Promise<EventsResponse> {
  const params = new URLSearchParams();
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.offset !== undefined) params.set("offset", String(q.offset));
  if (q.type) params.set("type", q.type);
  if (q.category) params.set("category", q.category);
  if (q.session) params.set("session", q.session);
  if (q.focusSeq !== undefined) params.set("focusSeq", String(q.focusSeq));
  const qs = params.toString();
  return fetchJson<EventsResponse>(`events${qs ? "?" + qs : ""}`);
}

export function getEvent(id: string): Promise<{ event: ApiEvent }> {
  return fetchJson<{ event: ApiEvent }>(`events/${encodeURIComponent(id)}`);
}

export function verifyEvent(id: string): Promise<EventVerifyPayload> {
  return fetchJson<EventVerifyPayload>(`events/${encodeURIComponent(id)}/verify`);
}

export function listTrees(): Promise<{ trees: TreeInfo[] }> {
  return fetchJson<{ trees: TreeInfo[] }>("trees");
}

export function listCheckpoints(): Promise<{ checkpoints: CheckpointRecord[]; deBaseUrl: string | null }> {
  return fetchJson<{ checkpoints: CheckpointRecord[]; deBaseUrl: string | null }>("checkpoints");
}

export interface VerifyMismatch {
  checkpointId: string;
  sequenceStart: number;
  sequenceEnd: number;
  tamperedStart?: number;
  tamperedEnd?: number;
  expectedRoot: string;
  computedRoot: string;
  createdAt: string;
  inWindow: boolean;
  reason: "root-mismatch" | "events-missing";
}

export type VerifyResult =
  | {
      status: "verified";
      checkpointsChecked: number;
      lastAnchoredSequence: number;
      lastAnchoredCreatedAt: string;
      durationMs: number;
    }
  | {
      status: "mismatch-at-interval";
      mismatchAt: VerifyMismatch;
      checkpointsChecked: number;
      durationMs: number;
    }
  | {
      status: "anchor-pending";
      lastAnchoredSequence: number | null;
      lastAnchoredCreatedAt: string | null;
      checkpointsChecked: number;
      durationMs: number;
    };

export function verifyRange(from: string, to: string): Promise<VerifyResult> {
  return fetchJson<VerifyResult>("verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
}

// ── Status snapshot ────────────────────────────────────────────────────────
// Wire-compatible mirror of `StatusSnapshot` (src/reports/status-snapshot.ts).
// Re-declared here so the SPA bundle has no node-side dependency.

export interface StatusHeader {
  pluginName: string;
  pluginVersion: string;
  machineId: string;
  generatedAt: string;
}

export interface StorageSection {
  dbSizeMb: number;
  maxSizeMb: number;
  eventCount: number;
  oldestEventAt: string | null;
  oldestEventAgeDays: number | null;
  retentionDays: number;
  nextPruneAt: string | null;
}

export interface IntegritySection {
  sequenceAtHead: number;
  smtTreeCount: number;
  smtTreeKeys: readonly string[];
  smtRoot: string | null;
  smtEntryCount: number;
  smtNodeCount: number;
  lastInsertedSequence: number;
  lastCheckpoint: {
    id: string;
    sequenceEnd: number;
    createdAt: string;
  } | null;
  pendingSinceLastCheckpoint: number;
  conversationAccess: "enabled" | "enabled-but-silent" | "disabled";
}

export interface AnchorSection {
  configured: boolean;
  isActive: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  anchoredToday: number;
  lastAnchorAt: string | null;
  lastTxHash: string | null;
  pendingSinceLastCheckpoint: number;
}

export interface FileWatchSection {
  patternsWatched: number;
  patternsIgnored: number;
  recentChanges24h: number;
}

export interface InventorySection {
  plugins: number;
  skills: number;
  tools: number;
  crons: number;
}

export interface SecurityScanSection {
  lastScanAt: string | null;
  highFindings: number;
  mediumFindings: number;
}

export interface StatusSnapshot {
  schemaVersion: number;
  header: StatusHeader;
  storage: StorageSection;
  integrity: IntegritySection;
  anchor: AnchorSection;
  fileWatch: FileWatchSection;
  inventory: InventorySection;
  securityScan: SecurityScanSection;
  /** Sticky flag echoed by every audit endpoint that touches the store. */
  degraded: boolean;
}

export function getStatus(): Promise<StatusSnapshot> {
  return fetchJson<StatusSnapshot>("status");
}

// ── Daily/weekly projection ───────────────────────────────────────────────
// Wire-compatible mirror of `AuditProjection` (src/reports/projection.ts).

export type ParsedCronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "unknown"; raw: string };

export interface ConfiguredCron {
  name: string;
  schedule: ParsedCronSchedule;
}

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

export interface DuplicateOutboundFinding {
  contentSha256: string;
  channel: string;
  recipient: string;
  events: Array<{ id: string; sequence: number; createdAt: string; sessionId?: string }>;
  deltaSeconds: number;
}

export interface AnomaliesSection {
  duplicateOutbound: DuplicateOutboundFinding[];
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
  schemaVersion: number;
  generatedAt: string;
  period: ProjectionPeriod;
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

export interface ReportQuery {
  period: "daily" | "weekly";
  date?: string;
  week?: string;
  tz?: "local" | "utc";
  dupWindowSec?: number;
  lookbackDays?: number;
  topTools?: number;
}

// ── Per-cron rollup ───────────────────────────────────────────────────────

export type CronRunStatus = "ok" | "failed" | "incomplete";

export interface CronRollupRow {
  jobId: string;
  runId: string | null;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: CronRunStatus;
  error: string | null;
  events: {
    toolInvocations: number;
    llmCalls: number;
    messagesSent: number;
  };
}

export interface CronRollup {
  schemaVersion: number;
  generatedAt: string;
  jobId: string;
  truncated: boolean;
  rows: CronRollupRow[];
  manifest: ConfiguredCron | null;
}

// ── SMT power tools ───────────────────────────────────────────────────────

export interface SmtProofObject {
  root: string;
  key: string;
  siblings: string[];
  membership: boolean;
  [k: string]: unknown;
}

export interface SmtProofResponse {
  proof: SmtProofObject;
}

export type SmtVerifyResult =
  | { status: "valid" }
  | { status: "invalid"; reason: string }
  | { status: "unverifiable"; reason: string };

export interface SmtChainEntry {
  rawHash: string;
  timestamp: number;
  seqNo: number;
  auditEventId: string;
}

export interface SmtChainResponse {
  tree: string;
  conversationId: string;
  chain: SmtChainEntry[];
}

export function smtCreateProof(hash: string, tree?: string): Promise<SmtProofResponse> {
  const params = new URLSearchParams({ hash });
  if (tree) params.set("tree", tree);
  return fetchJson<SmtProofResponse>(`smt/proof?${params.toString()}`);
}

export function smtVerifyProof(proof: SmtProofObject): Promise<SmtVerifyResult> {
  return fetchJson<SmtVerifyResult>("smt/verify-proof", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proof }),
  });
}

export function smtGetChain(tree: string, conversationId: string): Promise<SmtChainResponse> {
  const params = new URLSearchParams({ tree, conversationId });
  return fetchJson<SmtChainResponse>(`smt/chain?${params.toString()}`);
}

// ── Inventory ─────────────────────────────────────────────────────────────

export type InventoryKind = "plugins" | "skills" | "tools" | "workspace" | "crons";
export const INVENTORY_KINDS: readonly InventoryKind[] = ["plugins", "skills", "tools", "workspace", "crons"];

export interface InventoryItem {
  id: string;
  kind: InventoryKind;
  name: string;
  version?: string;
  path: string;
  source: string;
  contentHash?: string;
  capturedAt?: string;
  filesystemMtime?: string;
  capturedInManifests: boolean;
}

export interface InventorySummary {
  plugins: number;
  skills: number;
  tools: number;
  workspace: number;
  crons: number;
}

export interface InventoryReport {
  summary: InventorySummary;
  plugins?: InventoryItem[];
  skills?: InventoryItem[];
  tools?: InventoryItem[];
  workspace?: InventoryItem[];
  crons?: InventoryItem[];
  degraded: boolean;
}

export function getInventory(kind: InventoryKind | "summary" = "summary"): Promise<InventoryReport> {
  return fetchJson<InventoryReport>(`inventory?kind=${kind}`);
}

// ── Spend rollup ──────────────────────────────────────────────────────────

export type SpendGroupBy = "provider" | "model" | "day" | "session";

export interface SpendRollupRow {
  bucket: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface SpendRollupTotals {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface SpendRollup {
  schemaVersion: number;
  generatedAt: string;
  groupBy: SpendGroupBy;
  limit: number;
  truncated: boolean;
  window: { fromIso: string; toIso: string; label: string; tz: "local" | "utc" };
  rows: SpendRollupRow[];
  totals: SpendRollupTotals;
  degraded: boolean;
}

export interface SpendQuery {
  by?: SpendGroupBy;
  since?: string;
  until?: string;
  tz?: "local" | "utc";
  limit?: number;
}

export function getSpend(q: SpendQuery = {}): Promise<SpendRollup> {
  const params = new URLSearchParams();
  if (q.by) params.set("by", q.by);
  if (q.since) params.set("since", q.since);
  if (q.until) params.set("until", q.until);
  if (q.tz) params.set("tz", q.tz);
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const qs = params.toString();
  return fetchJson<SpendRollup>(`spend${qs ? "?" + qs : ""}`);
}

// ── Anomalies view ────────────────────────────────────────────────────────
// Wire-compatible mirror of `AnomalyView` (src/reports/anomalies-view.ts).

export interface EventRef {
  id: string;
  sequence: number;
  createdAt: string;
}

export interface DenialSpikeFinding {
  firstAt: string;
  lastAt: string;
  count: number;
  byTool: Array<{ toolName: string; count: number }>;
  topReason: string | null;
  events: EventRef[];
}

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
  elevated: boolean;
}

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
  /** Anchored checkpoints confirmed missing on DE (404) — a genuine violation. */
  notFoundOnDe: UnverifiedAnchoredCheckpoint[];
  /** Anchored checkpoints awaiting DE confirmation — normal, not a violation. */
  pendingVerification: UnverifiedAnchoredCheckpoint[];
  tamperedEvents: TamperedEventRef[];
  note: string | null;
}

export interface AnomalyView {
  schemaVersion: number;
  generatedAt: string;
  period: { fromIso: string; toIso: string; label: string; tz: "local" | "utc" };
  detectorConfig: {
    dupWindowSec: number;
    lookbackDays: number;
    denialWindowSec: number;
    denialThreshold: number;
  };
  counts: {
    totalEventsInWindow: number;
    capped: boolean;
  };
  anomalies: {
    duplicateOutbound: DuplicateOutboundFinding[];
    firstSeenTools: string[];
    denialSpikes: DenialSpikeFinding[];
    installEvents: InstallEventFinding[];
    integrityViolations: IntegrityViolationFinding;
  };
  degraded: boolean;
}

export interface AnomaliesQuery {
  since?: string;
  until?: string;
  tz?: "local" | "utc";
  dupWindowSec?: number;
  lookbackDays?: number;
  denialWindowSec?: number;
  denialThreshold?: number;
}

export function getAnomalies(q: AnomaliesQuery = {}): Promise<AnomalyView> {
  const params = new URLSearchParams();
  if (q.since) params.set("since", q.since);
  if (q.until) params.set("until", q.until);
  if (q.tz) params.set("tz", q.tz);
  if (q.dupWindowSec !== undefined) params.set("dupWindowSec", String(q.dupWindowSec));
  if (q.lookbackDays !== undefined) params.set("lookbackDays", String(q.lookbackDays));
  if (q.denialWindowSec !== undefined) params.set("denialWindowSec", String(q.denialWindowSec));
  if (q.denialThreshold !== undefined) params.set("denialThreshold", String(q.denialThreshold));
  const qs = params.toString();
  return fetchJson<AnomalyView>(`anomalies${qs ? "?" + qs : ""}`);
}

// ── Per-session rollup ────────────────────────────────────────────────────

export interface SessionTimelineEntry {
  sequence: number;
  id: string;
  createdAt: string;
  eventType: string;
  category: string;
  description: string;
  contentHash: string;
  contentPreview?: string;
  metadata?: Record<string, unknown>;
  collapsedCount?: number;
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
  proofsVerified: number;
  proofsFailed: number;
  proofsUnavailable: number;
  smtRoot: string | null;
}

export interface SessionProjection {
  schemaVersion: number;
  generatedAt: string;
  sessionId: string;
  jobId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  raw: boolean;
  timeline: SessionTimelineEntry[];
  toolsUsed: SessionToolUsage[];
  llmCost: SessionLlmCost;
  outboundMessages: SessionOutboundMessage[];
  integrity: SessionIntegrity;
  truncated: boolean;
  degraded: boolean;
}

export interface SessionQuery {
  raw?: boolean;
  limit?: number;
  includeMetadata?: boolean;
}

export function getSessionRollup(sessionId: string, q: SessionQuery = {}): Promise<SessionProjection> {
  const params = new URLSearchParams();
  if (q.raw) params.set("raw", "true");
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.includeMetadata) params.set("includeMetadata", "true");
  const qs = params.toString();
  return fetchJson<SessionProjection>(`report/session/${encodeURIComponent(sessionId)}${qs ? "?" + qs : ""}`);
}

export function getCronRollup(jobId: string, last?: number): Promise<CronRollup> {
  const params = new URLSearchParams();
  params.set("format", "json");
  if (last !== undefined) params.set("last", String(last));
  return fetchJson<CronRollup>(`report/cron/${encodeURIComponent(jobId)}?${params.toString()}`);
}

export function getReport(q: ReportQuery): Promise<AuditProjection> {
  const params = new URLSearchParams();
  params.set("period", q.period);
  params.set("format", "json");
  if (q.date) params.set("date", q.date);
  if (q.week) params.set("week", q.week);
  if (q.tz) params.set("tz", q.tz);
  if (q.dupWindowSec !== undefined) params.set("dupWindowSec", String(q.dupWindowSec));
  if (q.lookbackDays !== undefined) params.set("lookbackDays", String(q.lookbackDays));
  if (q.topTools !== undefined) params.set("topTools", String(q.topTools));
  return fetchJson<AuditProjection>(`report?${params.toString()}`);
}
