/**
 * Status snapshot projection (Local Reporting PRD §R1).
 *
 * One-screen runtime-health view. Pure function over the running services'
 * health getters plus a handful of cheap SQL aggregates against the audit
 * store. Designed to render in well under 200ms on a 1M-row DB.
 */

import type { AuditStore } from "../store/audit-store.js";
import type { SmtService } from "../services/smt-service.js";
import type { AnchorHealth } from "../services/de-anchor.js";
import type { GatewayHealth } from "../services/gateway-publisher.js";
import type { RetentionHealth } from "../services/retention.js";
import type { CheckpointRecord } from "../store/audit-store.js";
import type { InventorySummary } from "../services/inventory.js";

export const STATUS_SCHEMA_VERSION = 1 as const;

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
  smtTreeKeys: string[];
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
  /**
   * Live conversation-access posture.
   *  - "enabled": config flag true AND at least one prompt.input observed in the last 24h
   *  - "enabled-but-silent": config flag true but no prompt.input in the last 24h (warn — likely missing opt-in)
   *  - "disabled": config flag missing or false
   */
  conversationAccess: "enabled" | "enabled-but-silent" | "disabled";
}

export interface AnchorSection {
  isActive: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  anchoredToday: number;
  lastAnchorAt: string | null;
  lastTxHash: string | null;
  pendingSinceLastCheckpoint: number;
}

export interface GatewaySection {
  isActive: boolean;
  url: string | null;
  buffered: number;
  droppedToday: number;
  circuitOpen: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
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
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  header: StatusHeader;
  storage: StorageSection;
  integrity: IntegritySection;
  anchor: AnchorSection;
  gateway: GatewaySection;
  fileWatch: FileWatchSection;
  inventory: InventorySection;
  securityScan: SecurityScanSection;
}

export interface StatusInputs {
  pluginName: string;
  pluginVersion: string;
  machineId: string;
  /** Wall-clock instant the snapshot was generated. Pass Date.now() at the call site. */
  now: Date;
  store: AuditStore;
  smtService: SmtService;
  anchorHealth: AnchorHealth | undefined;
  gatewayHealth: GatewayHealth | undefined;
  gatewayUrl: string | undefined;
  retentionHealth: RetentionHealth;
  filePatterns: { watched: number; ignored: number };
  inventorySummary: InventorySummary;
  /** True if the host-side config opts the plugin into conversation hooks. */
  allowConversationAccess: boolean;
}

export function buildStatusSnapshot(inputs: StatusInputs): StatusSnapshot {
  const {
    pluginName,
    pluginVersion,
    machineId,
    now,
    store,
    smtService,
    anchorHealth,
    gatewayHealth,
    gatewayUrl,
    retentionHealth,
    filePatterns,
    inventorySummary,
    allowConversationAccess,
  } = inputs;

  const generatedAt = now.toISOString();
  const oneDayAgoIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Storage
  const dbSizeMb = store.getDbSizeMb();
  const oldestEventAtRaw = store.getOldestCreatedAt();
  const oldestEventAt = oldestEventAtRaw ?? null;
  const oldestEventAgeDays = oldestEventAt
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldestEventAt)) / (24 * 60 * 60 * 1000)))
    : null;
  const eventCount = store.count();

  // Integrity
  const trees = smtService.listTrees();
  const lastInsertedSeq = smtService.getLastInsertedSequence();
  const checkpoints: CheckpointRecord[] = store.getCheckpoints();
  const lastCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
  const sequenceAtHead = computeHeadSequence(store);
  const promptInput24h = store.count({ eventType: "prompt.input", createdAfter: oneDayAgoIso });
  const conversationAccess = computeConvAccessPosture(allowConversationAccess, promptInput24h);

  // File watch (recent changes = config.* + system.file_changed in last 24h)
  const recentChanges24h =
    store.count({ category: "config", createdAfter: oneDayAgoIso }) +
    store.count({ eventType: "system.file_changed", createdAfter: oneDayAgoIso });

  // Security scan
  const securityScan = readLastSecurityScan(store);

  // Sum across trees so the "entries / nodes" row matches what `audit smt
  // trees` reports collectively.
  let totalEntries = 0;
  let totalNodes = 0;
  for (const t of trees) {
    totalEntries += t.entryCount;
    totalNodes += t.size;
  }
  const smtRoot = trees.length > 0 ? trees[0]!.root : null;

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    header: { pluginName, pluginVersion, machineId, generatedAt },
    storage: {
      dbSizeMb,
      maxSizeMb: retentionHealth.maxSizeMb,
      eventCount,
      oldestEventAt,
      oldestEventAgeDays,
      retentionDays: retentionHealth.retentionDays,
      nextPruneAt: retentionHealth.nextPruneAt ?? null,
    },
    integrity: {
      sequenceAtHead,
      smtTreeCount: trees.length,
      smtTreeKeys: trees.map((t) => t.key),
      smtRoot,
      smtEntryCount: totalEntries,
      smtNodeCount: totalNodes,
      lastInsertedSequence: lastInsertedSeq,
      lastCheckpoint: lastCp
        ? { id: lastCp.id, sequenceEnd: lastCp.sequenceEnd, createdAt: lastCp.createdAt }
        : null,
      pendingSinceLastCheckpoint: anchorHealth?.pendingSinceLastCheckpoint ?? 0,
      conversationAccess,
    },
    anchor: {
      isActive: anchorHealth?.isActive ?? false,
      circuitOpen: anchorHealth ? anchorHealth.circuitOpenUntil > now.getTime() : false,
      consecutiveFailures: anchorHealth?.consecutiveFailures ?? 0,
      anchoredToday: anchorHealth?.anchoredToday ?? 0,
      lastAnchorAt: anchorHealth?.lastAnchorAt ?? null,
      lastTxHash: anchorHealth?.lastTxHash ?? null,
      pendingSinceLastCheckpoint: anchorHealth?.pendingSinceLastCheckpoint ?? 0,
    },
    gateway: {
      isActive: gatewayHealth?.isActive ?? false,
      url: gatewayUrl ?? null,
      buffered: gatewayHealth?.buffered ?? 0,
      droppedToday: gatewayHealth?.droppedToday ?? 0,
      circuitOpen: gatewayHealth?.circuitOpen ?? false,
      lastSuccessAt: gatewayHealth?.lastSuccessAt ?? null,
      lastErrorAt: gatewayHealth?.lastErrorAt ?? null,
    },
    fileWatch: {
      patternsWatched: filePatterns.watched,
      patternsIgnored: filePatterns.ignored,
      recentChanges24h,
    },
    inventory: {
      plugins: inventorySummary.plugins,
      skills: inventorySummary.skills,
      tools: inventorySummary.tools,
      crons: inventorySummary.crons,
    },
    securityScan,
  };
}

function computeHeadSequence(store: AuditStore): number {
  const tail = store.query({ limit: 1, order: "desc" });
  return tail.length > 0 ? tail[0]!.sequence : 0;
}

function computeConvAccessPosture(
  allow: boolean,
  promptInput24h: number,
): IntegritySection["conversationAccess"] {
  if (!allow) return "disabled";
  return promptInput24h > 0 ? "enabled" : "enabled-but-silent";
}

function readLastSecurityScan(store: AuditStore): SecurityScanSection {
  const recent = store.query({ eventType: "security.scan_result", limit: 1, order: "desc" });
  const last = recent[0];
  if (!last) {
    return { lastScanAt: null, highFindings: 0, mediumFindings: 0 };
  }
  // Severity counts live in the metadata JSON. The scanner writes
  // { findings: [{severity, ...}, ...] } — fall back to zero if absent.
  let high = 0;
  let medium = 0;
  const meta = last.metadata as { findings?: ReadonlyArray<{ severity?: string }> } | undefined;
  const findings = Array.isArray(meta?.findings) ? meta.findings : [];
  for (const f of findings) {
    if (f.severity === "high") high++;
    else if (f.severity === "medium") medium++;
  }
  return { lastScanAt: last.createdAt, highFindings: high, mediumFindings: medium };
}
