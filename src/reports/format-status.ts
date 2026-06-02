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
  const row = (label: string, value: string): void => {
    lines.push(`  ${pad(label, LABEL_WIDTH)}${value}`);
  };

  // Header
  const versionTag = `v${s.header.pluginVersion}`;
  lines.push(`${s.header.pluginName} ${versionTag}  •  Machine ${s.header.machineId}  •  ${formatInstant(s.header.generatedAt)}`);
  lines.push("");

  // Setup-incomplete banner — shown when DE anchoring has never published health
  // (i.e. no credentials configured). Local audit logging still works; only
  // anchoring is gated on the missing setup.
  if (!s.anchor.configured) {
    lines.push("⚠  Digital Evidence anchoring not configured. Run `openclaw audit setup` to enable tamper-evident anchoring.");
    lines.push("");
  }

  // Storage
  lines.push("Storage");
  const dbBar = renderBar(s.storage.dbSizeMb, s.storage.maxSizeMb);
  const dbPct = s.storage.maxSizeMb > 0 ? (s.storage.dbSizeMb / s.storage.maxSizeMb) * 100 : 0;
  row("DB", `${s.storage.dbSizeMb.toFixed(1)} MB of ${s.storage.maxSizeMb} MB cap     [${dbBar}] ${dbPct.toFixed(1)}%`);
  const ageStr = s.storage.oldestEventAt
    ? `(oldest ${s.storage.oldestEventAt.slice(0, 10)}, ${s.storage.oldestEventAgeDays ?? 0} days)`
    : "(no events)";
  row("Events", `${s.storage.eventCount.toLocaleString()}   ${ageStr}`);
  const nextPrune = s.storage.nextPruneAt
    ? `next prune ${formatRelative(s.storage.nextPruneAt, s.header.generatedAt)}`
    : "next prune not scheduled";
  row("Retention", `${s.storage.retentionDays} days  •  size cap ${s.storage.maxSizeMb} MB  •  ${nextPrune}`);
  lines.push("");

  // Integrity
  lines.push("Integrity");
  row("Sequence at HEAD", `#${s.integrity.sequenceAtHead}`);
  const treesLabel = s.integrity.smtTreeCount === 0
    ? "0"
    : `${s.integrity.smtTreeCount} active (${s.integrity.smtTreeKeys.join(", ")})`;
  row("SMT trees", treesLabel);
  if (s.integrity.smtRoot) {
    row("SMT root", `${shortHash(s.integrity.smtRoot)}   •   entries ${s.integrity.smtEntryCount.toLocaleString()}   •   nodes ${s.integrity.smtNodeCount.toLocaleString()}`);
  }
  if (s.integrity.lastCheckpoint) {
    const cp = s.integrity.lastCheckpoint;
    row("Last checkpoint", `${formatInstant(cp.createdAt)}   (#${cp.sequenceEnd}, ${formatRelative(cp.createdAt, s.header.generatedAt)})`);
  } else {
    row("Last checkpoint", "(none)");
  }
  row("Pending events", `${s.integrity.pendingSinceLastCheckpoint} since last checkpoint`);
  row("Conversation hook", formatConvAccess(s.integrity.conversationAccess));
  lines.push("");

  // Digital Evidence anchor
  lines.push("Digital Evidence anchor");
  row("Status", s.anchor.isActive ? "ACTIVE" : "INACTIVE");
  row("Anchors today", String(s.anchor.anchoredToday));
  if (s.anchor.lastAnchorAt) {
    const tx = s.anchor.lastTxHash ? `tx ${shortHash(s.anchor.lastTxHash)}` : "tx (none)";
    row("Last anchor", `${formatInstant(s.anchor.lastAnchorAt)}  •  ${tx}`);
  } else {
    row("Last anchor", "(none)");
  }
  const circuitState = s.anchor.circuitOpen ? "OPEN" : "closed";
  row("Circuit", `${circuitState}   •   ${s.anchor.consecutiveFailures} consecutive failures`);
  lines.push("");

  // File watching
  lines.push("File watching");
  row("Patterns watched", `${s.fileWatch.patternsWatched}   •   ignored ${s.fileWatch.patternsIgnored}`);
  row("Recent changes", `${s.fileWatch.recentChanges24h} in last 24h`);
  lines.push("");

  // Inventory
  lines.push("Inventory");
  row("Plugins installed", `${s.inventory.plugins}    (run \`audit inventory plugins\` for detail)`);
  row("Skills installed", String(s.inventory.skills));
  row("Tools installed", String(s.inventory.tools));
  row("Cron jobs", `${s.inventory.crons} configured`);
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
