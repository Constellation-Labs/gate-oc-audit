import type { AuditProjection } from "./projection.js";
import { padRight as pad } from "./text-utils.js";

/**
 * Human-readable rendering of an AuditProjection — one screen worth of
 * sections matching the PRD R3 layout. Returned as a single string so the
 * caller controls where it's written (stdout for CLI, file for archives).
 */
export function formatProjectionText(p: AuditProjection): string {
  const lines: string[] = [];

  lines.push(`Audit report — ${p.period.label}`);
  lines.push(`Window: ${p.period.fromIso} → ${p.period.toIso}`);
  lines.push(`Generated: ${p.generatedAt}`);
  lines.push("");

  lines.push("=== Activity ===");
  lines.push(`Total events: ${p.activity.totalEvents}`);
  if (p.activity.byCategory.length > 0) {
    lines.push("By category:");
    for (const r of p.activity.byCategory) {
      lines.push(`  ${pad(r.category, 12)}  ${r.count}`);
    }
  } else {
    lines.push("  (no events)");
  }
  lines.push("");

  lines.push("=== Cron schedule ===");
  lines.push(`Executed: ${p.cron.executed}    Failed: ${p.cron.failed}`);
  if (p.cron.byEventType.length === 0) lines.push("  (no cron activity)");
  lines.push("");

  lines.push("=== Top tools ===");
  if (p.topTools.length === 0) {
    lines.push("  (no tool invocations)");
  } else {
    for (const t of p.topTools) {
      lines.push(`  ${pad(t.toolName, 24)}  ${t.invocations}`);
    }
  }
  lines.push("");

  lines.push("=== LLM spend ===");
  lines.push(`Calls: ${p.llmSpend.totalCalls}    Total: ${fmtUsd(p.llmSpend.totalCostUsd)}`);
  if (p.llmSpend.byModel.length > 0) {
    lines.push("By model:");
    for (const m of p.llmSpend.byModel) {
      const provider = m.provider ? `${m.provider}/` : "";
      lines.push(
        `  ${pad(provider + m.model, 32)}  calls=${m.callCount}  ` +
          `in=${m.inputTokens}  out=${m.outputTokens}  cache=${m.cacheTokens}  ${fmtUsd(m.costUsd)}`,
      );
    }
  }
  lines.push("");

  lines.push("=== Outbound messaging ===");
  lines.push(`Total sent: ${p.outboundMessaging.totalSent}`);
  if (p.outboundMessaging.byChannel.length > 0) {
    lines.push("By channel:");
    for (const r of p.outboundMessaging.byChannel) {
      lines.push(`  ${pad(r.channel, 24)}  ${r.count}`);
    }
  }
  lines.push("");

  lines.push("=== Anomalies ===");
  const { duplicateOutbound, duplicateOutboundTruncated, firstSeenTools } = p.anomalies;
  if (duplicateOutbound.length === 0 && firstSeenTools.length === 0 && !duplicateOutboundTruncated) {
    lines.push("  (none)");
  }
  if (duplicateOutboundTruncated) {
    lines.push("WARNING: duplicate-outbound detector reached its internal cap — some duplicates may be missed.");
  }
  if (duplicateOutbound.length > 0) {
    lines.push(
      `Duplicate outbound (${duplicateOutbound.length}, window=${p.detectorConfig.duplicateOutboundWindowSec}s):`,
    );
    for (const d of duplicateOutbound) {
      lines.push(
        `  channel=${d.channel} recipient=${d.recipient} sha256=${d.contentSha256.slice(0, 12)}… Δ=${d.deltaSeconds.toFixed(1)}s`,
      );
      for (const e of d.events) {
        lines.push(`    #${e.sequence} ${e.createdAt} id=${e.id}`);
      }
    }
  }
  if (firstSeenTools.length > 0) {
    lines.push(
      `First-seen tools (vs prior ${p.detectorConfig.firstSeenLookbackDays}d): ${firstSeenTools.join(", ")}`,
    );
  }
  lines.push("");

  lines.push("=== Integrity ===");
  if (p.integrity.lastSequence === null) {
    lines.push("  (no events in store)");
  } else {
    lines.push(`Last event:      #${p.integrity.lastSequence}  ${p.integrity.lastEventCreatedAt}`);
    lines.push(`Last content hash: ${p.integrity.lastEventContentHash}`);
  }
  if (p.integrity.lastCheckpoint) {
    const cp = p.integrity.lastCheckpoint;
    lines.push(`Last checkpoint: ${cp.checkpointId}  seq=${cp.sequenceStart}..${cp.sequenceEnd}  smtRoot=${cp.smtRoot.slice(0, 16)}…`);
    lines.push(`DE tx:           ${cp.deTxHash ?? "(not anchored)"}`);
  } else {
    lines.push("Last checkpoint: (none yet)");
  }

  return lines.join("\n") + "\n";
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
