import type { AuditStore } from "../store/audit-store.js";
import { escapeHtml as escape, REPORT_BASE_CSS } from "./html-utils.js";
import { padRight as pad } from "./text-utils.js";

/**
 * Per-cron rollup (PRD R9). One row per `cron.executed` event for the
 * supplied jobId, bounded by `last`, newest first. Each row carries the
 * paired `agent.end` (when available) and counters for activity that
 * happened during the same session window.
 */

export const CRON_ROLLUP_SCHEMA_VERSION = 1 as const;

export const DEFAULT_LAST = 20;
export const MAX_LAST = 1000;

export type CronRunStatus = "ok" | "failed" | "incomplete";

export interface CronRollupRow {
  jobId: string;
  runId: string | null;
  sessionId: string | null;
  /** ISO 8601 timestamp of the cron.executed event. */
  startedAt: string;
  /** ISO 8601 timestamp of the matching agent.end, or null if none was found. */
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
  schemaVersion: typeof CRON_ROLLUP_SCHEMA_VERSION;
  generatedAt: string;
  jobId: string;
  /** True when the store holds more executions than fit in `last` — the
   *  oldest cron.executed beyond `last` was elided. */
  truncated: boolean;
  rows: CronRollupRow[];
}

export interface BuildCronRollupOptions {
  /** Cap the rollup to the N most recent executions. Default 20, max 1000. */
  last?: number;
}

export function buildCronRollup(
  store: AuditStore,
  jobId: string,
  opts: BuildCronRollupOptions = {},
): CronRollup {
  const last = opts.last ?? DEFAULT_LAST;
  // Over-fetch by 1 so we can detect that there's at least one older
  // execution beyond the requested window. Cheap and self-describing.
  const fetchLimit = last + 1;

  // Single round-trip — see AuditStore.queryCronRollupRows for the SQL
  // shape. Activity counters (tool/llm/message) are computed inside the
  // same query as correlated COUNT(*) subselects, attributing events to a
  // run by (sessionId, [startedAt, endedAt]) time window. Tool/llm/message
  // events don't carry runId, so this is correct for the common case where
  // each cron-triggered run gets its own sessionId, and for sequential
  // runs on a shared sessionId. It can mis-attribute when two runs overlap
  // concurrently on the SAME sessionId — that shouldn't happen with the
  // current openclaw runtime (cron triggers fire serially per agent), but
  // if a future runtime allows concurrent runs to share a session, the
  // counters here become best-effort. When the run has no agent.end yet
  // (ended_at IS NULL) the counters short-circuit to 0 in SQL: counting
  // against "now" would mix in events from a still-in-flight run and make
  // repeated rollups non-idempotent.
  const raw = store.queryCronRollupRows(jobId, fetchLimit);
  const truncated = raw.length > last;
  const slice = truncated ? raw.slice(0, last) : raw;

  const rows: CronRollupRow[] = slice.map((r) => {
    let status: CronRunStatus;
    if (r.endedAt === null) status = "incomplete";
    else if (r.success === 1) status = "ok";
    else if (r.success === 0) status = "failed";
    else status = "incomplete";

    return {
      jobId,
      runId: r.runId,
      sessionId: r.sessionId,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationMs: r.durationMs,
      status,
      error: r.error,
      events: {
        toolInvocations: r.toolCount,
        llmCalls: r.llmCount,
        messagesSent: r.msgCount,
      },
    };
  });

  return {
    schemaVersion: CRON_ROLLUP_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    jobId,
    truncated,
    rows,
  };
}

// --- Text formatter ---------------------------------------------------

const COLS = {
  started: 20,
  status: 10,
  duration: 12,
  tools: 6,
  llm: 6,
  msgs: 6,
} as const;

export function formatCronRollupText(r: CronRollup): string {
  const lines: string[] = [];
  lines.push(`Per-cron rollup — jobId=${r.jobId}`);
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`Rows: ${r.rows.length}${r.truncated ? "  (truncated — more executions exist beyond --last)" : ""}`);
  lines.push("");

  if (r.rows.length === 0) {
    lines.push("  (no executions recorded for this job)");
    return lines.join("\n") + "\n";
  }

  const header =
    pad("Started", COLS.started) + "  " +
    pad("Status", COLS.status) + "  " +
    pad("Duration", COLS.duration) + "  " +
    pad("Tools", COLS.tools) + "  " +
    pad("LLM", COLS.llm) + "  " +
    pad("Msgs", COLS.msgs) + "  " +
    "RunId";
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const row of r.rows) {
    lines.push(
      pad(shortTime(row.startedAt), COLS.started) + "  " +
        pad(row.status, COLS.status) + "  " +
        pad(fmtDuration(row.durationMs), COLS.duration) + "  " +
        pad(String(row.events.toolInvocations), COLS.tools) + "  " +
        pad(String(row.events.llmCalls), COLS.llm) + "  " +
        pad(String(row.events.messagesSent), COLS.msgs) + "  " +
        (row.runId ?? "<no-runId>"),
    );
    if (row.error) {
      lines.push(`    error: ${row.error}`);
    }
  }

  return lines.join("\n") + "\n";
}

function shortTime(iso: string): string {
  // 2026-05-18T07:00:00.123Z → 2026-05-18 07:00:00Z
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m${rem.toFixed(1)}s`;
}

// --- HTML formatter ---------------------------------------------------

/**
 * Self-contained HTML rendering of a cron rollup — no external assets, no
 * scripts. Mirrors the style conventions used by `formatProjectionHtml` and
 * `formatAnomalyViewHtml` so all three reports look consistent when archived
 * or printed-to-PDF.
 */
export function formatCronRollupHtml(r: CronRollup): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Per-cron rollup — ${escape(r.jobId)}</title>
<style>${REPORT_BASE_CSS}
  .status-ok { color: #137333; font-weight: 600; }
  .status-failed { color: #d93025; font-weight: 600; }
  .status-incomplete { color: #b06000; font-weight: 600; }
  .error-row td { padding-top: 0; padding-bottom: 0.6em; color: #d93025; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; }
  .truncated { background: #fff7e6; border-left: 3px solid #f5a623; padding: 0.6em 0.8em; margin: 0.5em 0; font-size: 0.9em; }
</style>
</head>
<body>
<h1>Per-cron rollup — <code>${escape(r.jobId)}</code></h1>
<div class="meta">
  Generated: <code>${escape(r.generatedAt)}</code><br />
  Rows: <strong>${r.rows.length}</strong>${r.truncated ? " (truncated)" : ""}
</div>
${r.truncated ? `<div class="truncated">More executions exist beyond <code>--last</code>; only the most recent ${r.rows.length} are shown.</div>` : ""}
${rowsSection(r)}
</body>
</html>
`;
}

function rowsSection(r: CronRollup): string {
  if (r.rows.length === 0) {
    return `<p class="empty">No executions recorded for this job.</p>`;
  }
  const body = r.rows
    .map((row) => {
      const main = `<tr>
  <td><code>${escape(row.startedAt)}</code></td>
  <td><span class="status-${row.status}">${row.status}</span></td>
  <td class="num">${escape(fmtDuration(row.durationMs))}</td>
  <td class="num">${row.events.toolInvocations}</td>
  <td class="num">${row.events.llmCalls}</td>
  <td class="num">${row.events.messagesSent}</td>
  <td><code>${escape(row.runId ?? "<no-runId>")}</code></td>
</tr>`;
      const err = row.error
        ? `<tr class="error-row"><td colspan="7">error: ${escape(row.error)}</td></tr>`
        : "";
      return main + err;
    })
    .join("\n");
  return `<table>
<thead><tr>
  <th>Started</th>
  <th>Status</th>
  <th class="num">Duration</th>
  <th class="num">Tools</th>
  <th class="num">LLM</th>
  <th class="num">Msgs</th>
  <th>RunId</th>
</tr></thead>
<tbody>${body}</tbody>
</table>`;
}
