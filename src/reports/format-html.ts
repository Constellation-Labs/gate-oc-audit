import type { AuditProjection } from "./projection.js";
import { escapeHtml as escape, REPORT_BASE_CSS } from "./html-utils.js";
import { formatCronSchedule } from "../services/cron-manifests.js";

/**
 * Self-contained HTML rendering — no external assets, no scripts. The
 * print-to-PDF path goes through the browser, so the output is the only
 * artifact compliance needs to archive. Output is a complete HTML5
 * document, safe to redirect to a .html file or serve as-is.
 *
 * All projection-derived strings are HTML-escaped at render time to keep
 * channel names, tool names, recipients, and content hashes from breaking
 * the document (the projection doesn't pre-escape).
 */
export function formatProjectionHtml(p: AuditProjection): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Audit report — ${escape(p.period.label)}</title>
<style>${REPORT_BASE_CSS}
  .footer { margin-top: 2em; padding-top: 0.6em; border-top: 1px solid #ddd; font-size: 0.85em; color: #555; }
  .footer dt { font-weight: 600; }
  .footer dd { margin: 0 0 0.4em 0; }
</style>
</head>
<body>
<h1>Audit report — ${escape(p.period.label)}</h1>
<div class="meta">
  Window: <code>${escape(p.period.fromIso)}</code> → <code>${escape(p.period.toIso)}</code><br />
  Generated: <code>${escape(p.generatedAt)}</code>
</div>

${section("Activity", activitySection(p))}
${section("Cron schedule", cronSection(p))}
${section("Top tools", topToolsSection(p))}
${section("LLM spend", llmSection(p))}
${section("Outbound messaging", outboundSection(p))}
${section("Anomalies", anomaliesSection(p))}
${integritySection(p)}
</body>
</html>
`;
}

function section(title: string, body: string): string {
  return `<h2>${escape(title)}</h2>\n${body}`;
}

function activitySection(p: AuditProjection): string {
  const { totalEvents, byCategory } = p.activity;
  if (totalEvents === 0) return `<p class="empty">No events in window.</p>`;
  const rows = byCategory.map((r) => `<tr><td>${escape(r.category)}</td><td class="num">${r.count}</td></tr>`).join("");
  return `<p>Total events: <strong>${totalEvents}</strong></p>
<table><thead><tr><th>Category</th><th class="num">Count</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function cronSection(p: AuditProjection): string {
  const configured = p.cron.configured.length > 0
    ? `<p>Configured:</p><ul class="cron-configured">${p.cron.configured
        .map(
          (c) =>
            `<li><code>${escape(c.name)}</code> &mdash; <code>${escape(formatCronSchedule(c.schedule))}</code></li>`,
        )
        .join("")}</ul>`
    : `<p class="empty">No configured cron manifests found.</p>`;
  const activity = p.cron.byEventType.length === 0
    ? `<p class="empty">No cron activity in window.</p>`
    : `<p>Executed: <strong>${p.cron.executed}</strong>, failed: <strong>${p.cron.failed}</strong></p>`;
  return configured + activity;
}

function topToolsSection(p: AuditProjection): string {
  if (p.topTools.length === 0) return `<p class="empty">No tool invocations.</p>`;
  const rows = p.topTools
    .map((t) => `<tr><td>${escape(t.toolName)}</td><td class="num">${t.invocations}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Tool</th><th class="num">Invocations</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function llmSection(p: AuditProjection): string {
  const { totalCalls, totalCostUsd, byModel } = p.llmSpend;
  const head = `<p>Calls: <strong>${totalCalls}</strong>, total: <strong>${fmtUsd(totalCostUsd)}</strong></p>`;
  if (byModel.length === 0) return head + `<p class="empty">No LLM calls.</p>`;
  const rows = byModel
    .map(
      (m) => `<tr>
  <td>${escape((m.provider ? m.provider + "/" : "") + m.model)}</td>
  <td class="num">${m.callCount}</td>
  <td class="num">${m.inputTokens}</td>
  <td class="num">${m.outputTokens}</td>
  <td class="num">${m.cacheTokens}</td>
  <td class="num">${fmtUsd(m.costUsd)}</td>
</tr>`,
    )
    .join("");
  return (
    head +
    `<table>
<thead><tr><th>Model</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Cache</th><th class="num">Cost</th></tr></thead>
<tbody>${rows}</tbody>
</table>`
  );
}

function outboundSection(p: AuditProjection): string {
  if (p.outboundMessaging.totalSent === 0) return `<p class="empty">No outbound messages.</p>`;
  const rows = p.outboundMessaging.byChannel
    .map((r) => `<tr><td>${escape(r.channel)}</td><td class="num">${r.count}</td></tr>`)
    .join("");
  return `<p>Total sent: <strong>${p.outboundMessaging.totalSent}</strong></p>
<table><thead><tr><th>Channel</th><th class="num">Count</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function anomaliesSection(p: AuditProjection): string {
  const { duplicateOutbound, duplicateOutboundTruncated, firstSeenTools } = p.anomalies;
  if (duplicateOutbound.length === 0 && firstSeenTools.length === 0 && !duplicateOutboundTruncated) {
    return `<p class="empty">No anomalies detected.</p>`;
  }
  const out: string[] = [];
  if (duplicateOutboundTruncated) {
    out.push(
      `<div class="anomaly"><div class="anomaly-head">Detector capped</div>duplicate-outbound detector reached its internal cap; some duplicates may be missed.</div>`,
    );
  }
  if (duplicateOutbound.length > 0) {
    out.push(
      `<p><strong>Duplicate outbound</strong> (${duplicateOutbound.length}, window ${p.detectorConfig.duplicateOutboundWindowSec}s):</p>`,
    );
    for (const d of duplicateOutbound) {
      const events = d.events
        .map(
          (e) =>
            `<div class="anomaly-event">#${e.sequence} ${escape(e.createdAt)} id=${escape(e.id)}</div>`,
        )
        .join("");
      out.push(
        `<div class="anomaly">
  <div class="anomaly-head">channel=${escape(d.channel)} → recipient=${escape(d.recipient)}, Δ=${d.deltaSeconds.toFixed(1)}s</div>
  <div class="hash">sha256=${escape(d.contentSha256)}</div>
  ${events}
</div>`,
      );
    }
  }
  if (firstSeenTools.length > 0) {
    out.push(
      `<p><strong>First-seen tools</strong> (vs prior ${p.detectorConfig.firstSeenLookbackDays}d): ${firstSeenTools.map(escape).join(", ")}</p>`,
    );
  }
  return out.join("\n");
}

function integritySection(p: AuditProjection): string {
  const i = p.integrity;
  if (i.lastSequence === null) {
    return `<h2>Integrity</h2><p class="empty">No events in store.</p>`;
  }
  const cp = i.lastCheckpoint;
  return `<div class="footer">
  <h2>Integrity</h2>
  <dl>
    <dt>Last event</dt><dd><code>#${i.lastSequence}</code> at <code>${escape(i.lastEventCreatedAt ?? "")}</code></dd>
    <dt>Last content hash</dt><dd class="hash">${escape(i.lastEventContentHash ?? "")}</dd>
    ${
      cp
        ? `<dt>Last checkpoint</dt><dd>${escape(cp.checkpointId)} (seq ${cp.sequenceStart}..${cp.sequenceEnd})</dd>
    <dt>SMT root</dt><dd class="hash">${escape(cp.smtRoot)}</dd>
    <dt>DE tx</dt><dd class="hash">${cp.deTxHash ? escape(cp.deTxHash) : "(not anchored)"}</dd>`
        : `<dt>Last checkpoint</dt><dd class="empty">none yet</dd>`
    }
  </dl>
</div>`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
