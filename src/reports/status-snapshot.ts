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
import type { RetentionHealth } from "../services/retention.js";
import type { InventorySummary } from "../services/inventory.js";

export const STATUS_SCHEMA_VERSION = 3 as const;

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
  /**
   * Live conversation-access posture.
   *  - "enabled": config flag true AND at least one prompt.input observed in the last 24h
   *  - "enabled-but-silent": config flag true but no prompt.input in the last 24h (warn — likely missing opt-in)
   *  - "disabled": config flag missing or false
   */
  conversationAccess: "enabled" | "enabled-but-silent" | "disabled";
}

export interface AnchorSection {
  /**
   * False when the DE anchor service has never published a health row — i.e.
   * the plugin loaded without any DE credentials. Distinct from `isActive`,
   * which can be false even on a configured-but-currently-down service. Used
   * by `formatStatusText` to surface a "run audit setup" banner.
   */
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
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  header: StatusHeader;
  storage: StorageSection;
  integrity: IntegritySection;
  anchor: AnchorSection;
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

  // Integrity. Tree ordering: sort by key so `smtRoot = trees[0]` is
  // deterministic across restarts (TreeManager's internal Map insertion
  // order follows filesystem readdir, which isn't alphabetical on every
  // FS).
  const trees = smtService.listTrees().slice().sort((a, b) => a.key.localeCompare(b.key));
  const lastInsertedSeq = smtService.getLastInsertedSequence();
  // Use the single-row "latest by sequence_end" fetch so an overlapping or
  // backfilled checkpoint with a smaller sequence_start but larger
  // sequence_end is honored. getCheckpoints() is ORDER BY sequence_start
  // ASC and would pick the wrong row in that case.
  const lastCp = store.getLastCheckpoint();
  const sequenceAtHead = computeHeadSequence(store);
  // SMT-centric "pending": events the SMT has accepted but the latest
  // DE-anchored checkpoint doesn't cover yet. Clamp negative diffs to 0
  // so a forensic copy with newer checkpoints than tree state isn't
  // reported as negative.
  const smtPending = lastCp ? Math.max(0, lastInsertedSeq - lastCp.sequenceEnd) : lastInsertedSeq;
  // Fall back to the anchor-health value when SMT has nothing to say
  // (no checkpoints yet, or the SMT cursor sits at/behind the
  // checkpoint cursor) so the row still surfaces an anchor backlog.
  const pendingSinceLastCheckpoint = smtPending > 0 || anchorHealth === undefined
    ? smtPending
    : anchorHealth.pendingSinceLastCheckpoint;
  // Conversation-access posture. "enabled-but-silent" is only meaningful
  // when the store has been running long enough that 24h of silence is
  // surprising. Suppress the warning state on fresh installs (oldest
  // event < 24h ago) to avoid false alarms — the operator hasn't had a
  // chance to produce traffic yet.
  const promptInput24h = store.count({ eventType: "prompt.input", createdAfter: oneDayAgoIso });
  const storeAgeSufficient = oldestEventAt !== null
    && Date.parse(oldestEventAt) <= now.getTime() - 24 * 60 * 60 * 1000;
  const conversationAccess = computeConvAccessPosture(
    allowConversationAccess,
    promptInput24h,
    storeAgeSufficient,
  );

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
      pendingSinceLastCheckpoint,
      conversationAccess,
    },
    anchor: {
      configured: anchorHealth !== undefined,
      isActive: anchorHealth?.isActive ?? false,
      circuitOpen: anchorHealth ? anchorHealth.circuitOpenUntil > now.getTime() : false,
      consecutiveFailures: anchorHealth?.consecutiveFailures ?? 0,
      anchoredToday: anchorHealth?.anchoredToday ?? 0,
      lastAnchorAt: anchorHealth?.lastAnchorAt ?? null,
      lastTxHash: anchorHealth?.lastTxHash ?? null,
      pendingSinceLastCheckpoint: anchorHealth?.pendingSinceLastCheckpoint ?? 0,
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
  storeAgeSufficient: boolean,
): IntegritySection["conversationAccess"] {
  if (!allow) return "disabled";
  if (promptInput24h > 0) return "enabled";
  // Silent-warning state requires enough store history to make 24h of
  // silence meaningful. On a fresh install we report "enabled" without
  // the warning — the operator will see traffic land normally once
  // their agent runs.
  return storeAgeSufficient ? "enabled-but-silent" : "enabled";
}

function readLastSecurityScan(store: AuditStore): SecurityScanSection {
  const recent = store.query({ eventType: "security.scan_result", limit: 1, order: "desc" });
  const last = recent[0];
  if (!last) {
    return { lastScanAt: null, highFindings: 0, mediumFindings: 0 };
  }
  // Severity counts live in the metadata JSON. The scanner writes
  // { findings: [{severity, ...}, ...] } — fall back to zero if absent.
  // Cap the scan at 1000 entries so a pathological event (e.g. a stuck
  // scanner that recorded a multi-million-finding result) can't pin the
  // status command on iteration.
  const MAX_FINDINGS_SCAN = 1000;
  let high = 0;
  let medium = 0;
  const meta = last.metadata as { findings?: ReadonlyArray<{ severity?: string }> } | undefined;
  const findings = Array.isArray(meta?.findings) ? meta.findings : [];
  const scanLength = Math.min(findings.length, MAX_FINDINGS_SCAN);
  for (let i = 0; i < scanLength; i++) {
    const f = findings[i]!;
    if (f.severity === "high") high++;
    else if (f.severity === "medium") medium++;
  }
  return { lastScanAt: last.createdAt, highFindings: high, mediumFindings: medium };
}
