import type { AnomalyView } from "./anomalies-view.js";

/**
 * Plain-text rendering of an AnomalyView. Each detector section is suppressed
 * when empty so an all-clean window shows just a single "no anomalies" line.
 */
export function formatAnomalyViewText(v: AnomalyView): string {
  const lines: string[] = [];
  const cfg = v.detectorConfig;

  lines.push(`Audit anomalies — ${v.period.label}`);
  lines.push(`Window: ${v.period.fromIso} → ${v.period.toIso}`);
  lines.push(`Generated: ${v.generatedAt}`);
  lines.push(
    `Events in window: ${v.counts.totalEventsInWindow}${v.counts.capped ? " (capped)" : ""}`,
  );
  lines.push("");

  const a = v.anomalies;
  const anyFinding =
    a.duplicateOutbound.length > 0 ||
    a.firstSeenTools.length > 0 ||
    a.denialSpikes.length > 0 ||
    a.installEvents.length > 0 ||
    a.integrityViolations.notFoundOnDe.length > 0 ||
    a.integrityViolations.tamperedEvents.length > 0 ||
    a.integrityViolations.note !== null ||
    v.counts.capped;

  if (!anyFinding) {
    lines.push("No anomalies detected.");
    return lines.join("\n") + "\n";
  }

  if (v.counts.capped) {
    lines.push(
      "WARNING: event fetch hit its cap — every detector below is operating on a truncated view.",
    );
    lines.push("");
  }

  if (a.duplicateOutbound.length > 0) {
    lines.push(`=== Duplicate outbound (${a.duplicateOutbound.length}, window=${cfg.dupWindowSec}s) ===`);
    for (const d of a.duplicateOutbound) {
      lines.push(
        `  channel=${d.channel} recipient=${d.recipient} sha256=${d.contentSha256.slice(0, 12)}… Δ=${d.deltaSeconds.toFixed(1)}s`,
      );
      for (const e of d.events) {
        lines.push(`    #${e.sequence} ${e.createdAt} id=${e.id}`);
      }
    }
    lines.push("");
  }

  if (a.denialSpikes.length > 0) {
    lines.push(
      `=== Denial spikes (${a.denialSpikes.length}, window=${cfg.denialWindowSec}s, threshold=${cfg.denialThreshold}) ===`,
    );
    for (const s of a.denialSpikes) {
      const byTool = s.byTool.map((t) => `${t.toolName}×${t.count}`).join(", ");
      const reason = s.topReason ? `  topReason="${s.topReason}"` : "";
      lines.push(`  ${s.firstAt} → ${s.lastAt}  count=${s.count}${reason}`);
      lines.push(`    tools: ${byTool}`);
      for (const e of s.events) {
        lines.push(`    #${e.sequence} ${e.createdAt} id=${e.id}`);
      }
    }
    lines.push("");
  }

  if (a.installEvents.length > 0) {
    lines.push(`=== Install events (${a.installEvents.length}) ===`);
    for (const i of a.installEvents) {
      const flag = i.elevated ? " [!]" : "";
      const version = i.version ? ` v${i.version}` : "";
      const mode = i.requestMode ? ` (${i.requestMode})` : "";
      const scan = i.scanStatus
        ? `  scan=${i.scanStatus} critical=${i.scanCritical} warn=${i.scanWarn}`
        : "";
      lines.push(
        `  #${i.sequence} ${i.createdAt}${flag}  ${i.targetType}:${i.targetName}${version}${mode}${scan}`,
      );
    }
    lines.push("");
  }

  if (a.firstSeenTools.length > 0) {
    lines.push(
      `=== First-seen tools (vs prior ${cfg.lookbackDays}d) ===`,
    );
    lines.push(`  ${a.firstSeenTools.join(", ")}`);
    lines.push("");
  }

  const iv = a.integrityViolations;
  if (iv.notFoundOnDe.length > 0 || iv.tamperedEvents.length > 0 || iv.note !== null) {
    lines.push("=== Integrity violations ===");
    if (iv.note !== null) {
      lines.push(`  NOTE: ${iv.note}`);
    }
    if (iv.notFoundOnDe.length > 0) {
      lines.push(`  Checkpoints not found on DE (${iv.notFoundOnDe.length}):`);
      for (const c of iv.notFoundOnDe) {
        lines.push(
          `    ${c.checkpointId}  seq=${c.sequenceStart}..${c.sequenceEnd}  smtRoot=${c.smtRoot.slice(0, 16)}…  deTx=${c.deTxHash ?? "(none)"}`,
        );
      }
    }
    if (iv.tamperedEvents.length > 0) {
      lines.push(`  Tampered events (${iv.tamperedEvents.length}):`);
      for (const e of iv.tamperedEvents) {
        lines.push(`    #${e.sequence} ${e.createdAt} ${e.eventType} id=${e.id}`);
      }
    }
    // Pending verification is normal — list it only as context within an
    // already-flagged section, never as a violation in its own right.
    if (iv.pendingVerification.length > 0) {
      lines.push(`  Pending DE verification (${iv.pendingVerification.length}, normal — awaiting confirmation):`);
      for (const c of iv.pendingVerification) {
        lines.push(
          `    ${c.checkpointId}  seq=${c.sequenceStart}..${c.sequenceEnd}  smtRoot=${c.smtRoot.slice(0, 16)}…  deTx=${c.deTxHash ?? "(none)"}`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}
