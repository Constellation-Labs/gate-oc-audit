/**
 * Human-readable rendering of a StatusSnapshot — the one-screen runtime
 * health view mocked in the Local Reporting PRD (§R1). Returned as a single
 * string so the caller controls where it's written.
 */

import type { StatusSnapshot } from "./status-snapshot.js";
import { padRight as pad } from "./text-utils.js";

const LABEL_WIDTH = 18;

export function formatStatusText(s: StatusSnapshot): string {
  const lines: string[] = [];

  // Header
  const versionTag = `v${s.header.pluginVersion}`;
  lines.push(`${s.header.pluginName} ${versionTag}  •  Machine ${s.header.machineId}  •  ${formatInstant(s.header.generatedAt)}`);
  lines.push("");

  // Storage
  lines.push("Storage");
  const dbBar = renderBar(s.storage.dbSizeMb, s.storage.maxSizeMb);
  const dbPct = s.storage.maxSizeMb > 0 ? (s.storage.dbSizeMb / s.storage.maxSizeMb) * 100 : 0;
  lines.push(
    `  ${pad("DB", LABEL_WIDTH)}` +
      `${s.storage.dbSizeMb.toFixed(1)} MB of ${s.storage.maxSizeMb} MB cap     [${dbBar}] ${dbPct.toFixed(1)}%`,
  );
  const ageStr = s.storage.oldestEventAt
    ? `(oldest ${s.storage.oldestEventAt.slice(0, 10)}, ${s.storage.oldestEventAgeDays ?? 0} days)`
    : "(no events)";
  lines.push(`  ${pad("Events", LABEL_WIDTH)}${s.storage.eventCount.toLocaleString()}   ${ageStr}`);
  const nextPrune = s.storage.nextPruneAt
    ? `next prune ${formatRelative(s.storage.nextPruneAt, s.header.generatedAt)}`
    : "next prune not scheduled";
  lines.push(
    `  ${pad("Retention", LABEL_WIDTH)}${s.storage.retentionDays} days  •  size cap ${s.storage.maxSizeMb} MB  •  ${nextPrune}`,
  );
  lines.push("");

  // Integrity
  lines.push("Integrity");
  lines.push(`  ${pad("Sequence at HEAD", LABEL_WIDTH)}#${s.integrity.sequenceAtHead}`);
  const treesLabel = s.integrity.smtTreeCount === 0
    ? "0"
    : `${s.integrity.smtTreeCount} active (${s.integrity.smtTreeKeys.join(", ")})`;
  lines.push(`  ${pad("SMT trees", LABEL_WIDTH)}${treesLabel}`);
  if (s.integrity.smtRoot) {
    lines.push(
      `  ${pad("SMT root", LABEL_WIDTH)}${shortHash(s.integrity.smtRoot)}   •   entries ${s.integrity.smtEntryCount.toLocaleString()}   •   nodes ${s.integrity.smtNodeCount.toLocaleString()}`,
    );
  }
  if (s.integrity.lastCheckpoint) {
    const cp = s.integrity.lastCheckpoint;
    lines.push(
      `  ${pad("Last checkpoint", LABEL_WIDTH)}${formatInstant(cp.createdAt)}   (#${cp.sequenceEnd}, ${formatRelative(cp.createdAt, s.header.generatedAt)})`,
    );
  } else {
    lines.push(`  ${pad("Last checkpoint", LABEL_WIDTH)}(none)`);
  }
  lines.push(`  ${pad("Pending events", LABEL_WIDTH)}${s.integrity.pendingSinceLastCheckpoint} since last checkpoint`);
  lines.push(`  ${pad("Conversation hook", LABEL_WIDTH)}${formatConvAccess(s.integrity.conversationAccess)}`);
  lines.push("");

  // Digital Evidence anchor
  lines.push("Digital Evidence anchor");
  lines.push(`  ${pad("Status", LABEL_WIDTH)}${s.anchor.isActive ? "ACTIVE" : "INACTIVE"}`);
  lines.push(`  ${pad("Anchors today", LABEL_WIDTH)}${s.anchor.anchoredToday}`);
  if (s.anchor.lastAnchorAt) {
    const tx = s.anchor.lastTxHash ? `tx ${shortHash(s.anchor.lastTxHash)}` : "tx (none)";
    lines.push(`  ${pad("Last anchor", LABEL_WIDTH)}${formatInstant(s.anchor.lastAnchorAt)}  •  ${tx}`);
  } else {
    lines.push(`  ${pad("Last anchor", LABEL_WIDTH)}(none)`);
  }
  const circuitState = s.anchor.circuitOpen ? "OPEN" : "closed";
  lines.push(
    `  ${pad("Circuit", LABEL_WIDTH)}${circuitState}   •   ${s.anchor.consecutiveFailures} consecutive failures`,
  );
  lines.push("");

  // Gateway publisher
  lines.push("Gateway publisher");
  const gwStatus = s.gateway.isActive ? "ACTIVE" : "INACTIVE";
  const gwSuffix = s.gateway.url ? `  •  ${s.gateway.url}` : "";
  lines.push(`  ${pad("Status", LABEL_WIDTH)}${gwStatus}${gwSuffix}`);
  lines.push(
    `  ${pad("Buffered", LABEL_WIDTH)}${s.gateway.buffered}   •   dropped today ${s.gateway.droppedToday}   •   circuit ${s.gateway.circuitOpen ? "OPEN" : "closed"}`,
  );
  if (s.gateway.lastSuccessAt) {
    lines.push(`  ${pad("Last successful", LABEL_WIDTH)}${formatInstant(s.gateway.lastSuccessAt)}`);
  } else if (s.gateway.lastErrorAt) {
    lines.push(`  ${pad("Last error", LABEL_WIDTH)}${formatInstant(s.gateway.lastErrorAt)}`);
  } else {
    lines.push(`  ${pad("Last successful", LABEL_WIDTH)}(none this process)`);
  }
  lines.push("");

  // File watching
  lines.push("File watching");
  lines.push(`  ${pad("Patterns watched", LABEL_WIDTH)}${s.fileWatch.patternsWatched}   •   ignored ${s.fileWatch.patternsIgnored}`);
  lines.push(`  ${pad("Recent changes", LABEL_WIDTH)}${s.fileWatch.recentChanges24h} in last 24h`);
  lines.push("");

  // Inventory
  lines.push("Inventory");
  lines.push(`  ${pad("Plugins installed", LABEL_WIDTH)}${s.inventory.plugins}    (run \`audit inventory plugins\` for detail)`);
  lines.push(`  ${pad("Skills installed", LABEL_WIDTH)}${s.inventory.skills}`);
  lines.push(`  ${pad("Tools installed", LABEL_WIDTH)}${s.inventory.tools}`);
  lines.push(`  ${pad("Cron jobs", LABEL_WIDTH)}${s.inventory.crons} configured`);
  lines.push("");

  // Last security scan
  if (s.securityScan.lastScanAt) {
    lines.push(
      `Last security scan  ${formatInstant(s.securityScan.lastScanAt)}   •   ${s.securityScan.highFindings} high, ${s.securityScan.mediumFindings} medium findings`,
    );
  } else {
    lines.push("Last security scan  (none)");
  }

  return lines.join("\n");
}

function shortHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-4)}`;
}

function formatInstant(iso: string): string {
  // Trim subsecond precision for readability. Keep zone marker.
  return iso.replace(/\.\d+Z$/, "Z").replace("T", " ");
}

function formatRelative(targetIso: string, nowIso: string): string {
  const target = Date.parse(targetIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(target) || Number.isNaN(now)) return "unknown";
  const deltaMs = target - now;
  const abs = Math.abs(deltaMs);
  const past = deltaMs < 0;
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  let phrase: string;
  if (days >= 1) phrase = `${days}d ${hours % 24}h`;
  else if (hours >= 1) phrase = `${hours}h ${minutes % 60}m`;
  else phrase = `${minutes}m`;
  return past ? `${phrase} ago` : `in ${phrase}`;
}

function formatConvAccess(state: StatusSnapshot["integrity"]["conversationAccess"]): string {
  switch (state) {
    case "enabled":
      return "ENABLED (allowConversationAccess=true)";
    case "enabled-but-silent":
      return "ENABLED but no prompt.input observed in 24h — verify host opt-in";
    case "disabled":
      return "DISABLED (allowConversationAccess=false)";
  }
}

function renderBar(value: number, max: number, width: number = 18): string {
  if (max <= 0) return "?".repeat(width);
  const filled = Math.min(width, Math.max(0, Math.floor((value / max) * width)));
  return "#".repeat(filled) + ".".repeat(width - filled);
}
