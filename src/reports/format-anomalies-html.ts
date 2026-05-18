import type { AnomalyView } from "./anomalies-view.js";

/**
 * Self-contained HTML rendering of an AnomalyView. Same visual conventions
 * as the daily/weekly report (orange anomaly stripe) so operators reading
 * one already know how to read the other.
 */
export function formatAnomalyViewHtml(v: AnomalyView): string {
  const title = `Audit anomalies — ${escape(v.period.label)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 2em auto; padding: 0 1em; color: #222; }
  h1 { font-size: 1.4em; margin-bottom: 0.2em; }
  h2 { font-size: 1.1em; margin-top: 1.6em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  .meta { color: #666; font-size: 0.9em; margin-bottom: 1em; }
  .empty { color: #888; font-style: italic; }
  .hash { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; color: #444; }
  .anomaly { background: #fff7e6; border-left: 3px solid #f5a623; padding: 0.6em 0.8em; margin: 0.5em 0; }
  .anomaly.bad { background: #fdecea; border-left-color: #d93025; }
  .anomaly-head { font-weight: 600; }
  .anomaly-event { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; color: #555; padding-left: 1em; }
  @media print { body { margin: 0.5em; max-width: 100%; } }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">
  Window: <code>${escape(v.period.fromIso)}</code> → <code>${escape(v.period.toIso)}</code><br />
  Generated: <code>${escape(v.generatedAt)}</code><br />
  Events in window: <strong>${v.counts.totalEventsInWindow}</strong>${v.counts.capped ? " (capped)" : ""}
</div>
${renderBody(v)}
</body>
</html>
`;
}

function renderBody(v: AnomalyView): string {
  const a = v.anomalies;
  const cfg = v.detectorConfig;
  const sections: string[] = [];

  if (a.duplicateOutboundTruncated) {
    sections.push(
      `<div class="anomaly bad"><div class="anomaly-head">Detector capped</div>event fetch hit its cap; duplicate-outbound results may be incomplete.</div>`,
    );
  }

  if (a.duplicateOutbound.length > 0) {
    sections.push(`<h2>Duplicate outbound (${a.duplicateOutbound.length}, window ${cfg.dupWindowSec}s)</h2>`);
    for (const d of a.duplicateOutbound) {
      const events = d.events
        .map(
          (e) =>
            `<div class="anomaly-event">#${e.sequence} ${escape(e.createdAt)} id=${escape(e.id)}</div>`,
        )
        .join("");
      sections.push(
        `<div class="anomaly">
  <div class="anomaly-head">channel=${escape(d.channel)} → recipient=${escape(d.recipient)}, Δ=${d.deltaSeconds.toFixed(1)}s</div>
  <div class="hash">sha256=${escape(d.contentSha256)}</div>
  ${events}
</div>`,
      );
    }
  }

  if (a.gatewayDropSpikes.length > 0) {
    sections.push(
      `<h2>Gateway-drop spikes (${a.gatewayDropSpikes.length}, window ${cfg.dropWindowSec}s, threshold ${cfg.dropThreshold})</h2>`,
    );
    for (const s of a.gatewayDropSpikes) {
      const events = s.events
        .map(
          (e) =>
            `<div class="anomaly-event">#${e.sequence} ${escape(e.createdAt)} id=${escape(e.id)}</div>`,
        )
        .join("");
      sections.push(
        `<div class="anomaly bad">
  <div class="anomaly-head">${escape(s.firstAt)} → ${escape(s.lastAt)} — ${s.count} drop milestone(s), cumulativeDroppedΔ=${s.droppedDelta}</div>
  ${events}
</div>`,
      );
    }
  }

  if (a.denialSpikes.length > 0) {
    sections.push(
      `<h2>Denial spikes (${a.denialSpikes.length}, window ${cfg.denialWindowSec}s, threshold ${cfg.denialThreshold})</h2>`,
    );
    for (const s of a.denialSpikes) {
      const byTool = s.byTool
        .map((t) => `${escape(t.toolName)}×${t.count}`)
        .join(", ");
      const events = s.events
        .map(
          (e) =>
            `<div class="anomaly-event">#${e.sequence} ${escape(e.createdAt)} id=${escape(e.id)}</div>`,
        )
        .join("");
      const reason = s.topReason ? ` — top reason: ${escape(s.topReason)}` : "";
      sections.push(
        `<div class="anomaly bad">
  <div class="anomaly-head">${escape(s.firstAt)} → ${escape(s.lastAt)} — ${s.count} denial(s)${reason}</div>
  <div>tools: ${byTool}</div>
  ${events}
</div>`,
      );
    }
  }

  if (a.installEvents.length > 0) {
    sections.push(`<h2>Install events (${a.installEvents.length})</h2>`);
    for (const i of a.installEvents) {
      const cls = i.elevated ? "anomaly bad" : "anomaly";
      const version = i.version ? ` v${escape(i.version)}` : "";
      const mode = i.requestMode ? ` (${escape(i.requestMode)})` : "";
      const scan = i.scanStatus
        ? ` <span class="hash">scan=${escape(i.scanStatus)} critical=${i.scanCritical} warn=${i.scanWarn}</span>`
        : "";
      sections.push(
        `<div class="${cls}">
  <div class="anomaly-head">#${i.sequence} ${escape(i.createdAt)} ${escape(i.targetType)}:${escape(i.targetName)}${version}${mode}</div>
  ${scan}
</div>`,
      );
    }
  }

  if (a.firstSeenTools.length > 0) {
    sections.push(`<h2>First-seen tools (vs prior ${cfg.lookbackDays}d)</h2>`);
    sections.push(`<p>${a.firstSeenTools.map(escape).join(", ")}</p>`);
  }

  const iv = a.integrityViolations;
  if (iv.unverifiedAnchored.length > 0 || iv.tamperedEvents.length > 0) {
    sections.push(`<h2>Integrity violations</h2>`);
    if (iv.unverifiedAnchored.length > 0) {
      sections.push(`<p><strong>Unverified anchored checkpoints (${iv.unverifiedAnchored.length}):</strong></p>`);
      for (const c of iv.unverifiedAnchored) {
        sections.push(
          `<div class="anomaly bad">
  <div class="anomaly-head">${escape(c.checkpointId)}  seq=${c.sequenceStart}..${c.sequenceEnd}</div>
  <div class="hash">smtRoot=${escape(c.smtRoot)}</div>
  <div class="hash">deTx=${c.deTxHash ? escape(c.deTxHash) : "(none)"}</div>
</div>`,
        );
      }
    }
    if (iv.tamperedEvents.length > 0) {
      sections.push(`<p><strong>Tampered events (${iv.tamperedEvents.length}):</strong></p>`);
      for (const e of iv.tamperedEvents) {
        sections.push(
          `<div class="anomaly bad anomaly-event">#${e.sequence} ${escape(e.createdAt)} ${escape(e.eventType)} id=${escape(e.id)}</div>`,
        );
      }
    }
  }

  if (sections.length === 0) {
    return `<p class="empty">No anomalies detected.</p>`;
  }
  return sections.join("\n");
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
