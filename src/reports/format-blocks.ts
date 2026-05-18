import type { AuditProjection } from "./projection.js";

/**
 * Slack/Discord-compatible payload for an AuditProjection digest. Returns a
 * top-line `text` fallback (visible in notifications + non-Slack receivers)
 * plus mrkdwn `blocks` for chat rendering. The full projection is the
 * caller's job to attach — this helper is just the chat-pretty surface.
 */

export interface DigestPayload {
  text: string;
  blocks: Array<{
    type: "section";
    text: { type: "mrkdwn"; text: string };
  }>;
}

export function formatDigestBlocks(p: AuditProjection): DigestPayload {
  const kindCap = p.period.kind === "daily" ? "Daily" : "Weekly";
  const header = `${kindCap} audit report — ${p.period.label}`;

  const summary: string[] = [
    `*${header}*`,
    `Window: \`${p.period.fromIso}\` → \`${p.period.toIso}\``,
    `Events: ${p.activity.totalEvents}` +
      `  ·  Cron failed: ${p.cron.failed}` +
      `  ·  LLM calls: ${p.llmSpend.totalCalls}` +
      `  ·  LLM cost: ${fmtUsd(p.llmSpend.totalCostUsd)}` +
      `  ·  Outbound: ${p.outboundMessaging.totalSent}`,
  ];

  const blocks: DigestPayload["blocks"] = [
    { type: "section", text: { type: "mrkdwn", text: summary.join("\n") } },
  ];

  if (p.topTools.length > 0) {
    const top = p.topTools.slice(0, 5)
      .map((t) => `• \`${t.toolName}\` ×${t.invocations}`)
      .join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Top tools*\n${top}` } });
  }

  const anomalyLines = renderAnomalies(p);
  if (anomalyLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Anomalies*\n${anomalyLines.join("\n")}` },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: renderIntegrity(p) },
  });

  // Fallback `text` mirrors the headline so push notifications and
  // non-Slack receivers (Discord, generic webhook listeners) get something
  // useful without parsing blocks.
  const fallback =
    `${header} — ${p.activity.totalEvents} events, ` +
    `${p.cron.failed} cron failures, ` +
    `${fmtUsd(p.llmSpend.totalCostUsd)} LLM spend`;

  return { text: fallback, blocks };
}

function renderAnomalies(p: AuditProjection): string[] {
  const { duplicateOutbound, duplicateOutboundTruncated, firstSeenTools } = p.anomalies;
  const lines: string[] = [];

  if (duplicateOutbound.length > 0) {
    lines.push(
      `:warning: ${duplicateOutbound.length} duplicate outbound message(s) ` +
        `(window ${p.detectorConfig.duplicateOutboundWindowSec}s)`,
    );
  }
  if (duplicateOutboundTruncated) {
    lines.push(":warning: duplicate-outbound detector hit its row cap — some duplicates may be missed");
  }
  if (firstSeenTools.length > 0) {
    const shown = firstSeenTools.slice(0, 10).map((t) => `\`${t}\``).join(", ");
    const extra = firstSeenTools.length > 10 ? ` (+${firstSeenTools.length - 10} more)` : "";
    lines.push(
      `:sparkles: first-seen tool(s) vs prior ${p.detectorConfig.firstSeenLookbackDays}d: ${shown}${extra}`,
    );
  }

  return lines;
}

function renderIntegrity(p: AuditProjection): string {
  if (p.integrity.lastSequence === null) {
    return "*Integrity*\n_(no events in store)_";
  }
  const lines: string[] = ["*Integrity*"];
  lines.push(`Last event: #${p.integrity.lastSequence} at ${p.integrity.lastEventCreatedAt}`);
  if (p.integrity.lastCheckpoint) {
    const cp = p.integrity.lastCheckpoint;
    const anchored = cp.deTxHash ? `anchored (\`${cp.deTxHash.slice(0, 12)}…\`)` : "_not yet anchored_";
    lines.push(`Last checkpoint: seq ${cp.sequenceStart}–${cp.sequenceEnd}, ${anchored}`);
  } else {
    lines.push("Last checkpoint: _(none yet)_");
  }
  return lines.join("\n");
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
