/**
 * LLM-spend rollup (Local Reporting PRD §R11). One row per bucket
 * (provider / model / day / session) summarizing token usage and cost
 * across the requested window. Backed entirely by SQL aggregates on
 * `prompt.response` metadata — no decompression, no decode.
 */

import type { AuditStore } from "../store/audit-store.js";
import type { TimeWindow } from "./time-window.js";
import { padRight as pad } from "./text-utils.js";

export const SPEND_ROLLUP_SCHEMA_VERSION = 1 as const;

export type SpendGroupBy = "provider" | "model" | "day" | "session";

export const SPEND_GROUP_BY_VALUES: ReadonlyArray<SpendGroupBy> = [
  "provider",
  "model",
  "day",
  "session",
];

export interface SpendRollupRow {
  /** Bucket label. The interpretation depends on `groupBy`. */
  bucket: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface SpendRollupTotals {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface SpendRollup {
  schemaVersion: typeof SPEND_ROLLUP_SCHEMA_VERSION;
  generatedAt: string;
  groupBy: SpendGroupBy;
  window: {
    fromIso: string;
    toIso: string;
    label: string;
    tz: "local" | "utc";
  };
  rows: SpendRollupRow[];
  totals: SpendRollupTotals;
}

export function buildSpendRollup(
  store: AuditStore,
  window: TimeWindow,
  groupBy: SpendGroupBy,
): SpendRollup {
  const raw = store.aggregateLlmSpendByInWindow(window.fromIso, window.toIso, groupBy);
  const rows: SpendRollupRow[] = raw.map((r) => ({
    bucket: r.bucket,
    callCount: r.callCount,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    costUsd: r.costUsd,
  }));

  const totals: SpendRollupTotals = rows.reduce(
    (acc, r) => ({
      callCount: acc.callCount + r.callCount,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    {
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
  );

  return {
    schemaVersion: SPEND_ROLLUP_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    groupBy,
    window: {
      fromIso: window.fromIso,
      toIso: window.toIso,
      label: window.label,
      tz: window.tz,
    },
    rows,
    totals,
  };
}

const BUCKET_HEADER: Record<SpendGroupBy, string> = {
  provider: "Provider",
  model: "Model",
  day: "Day",
  session: "Session",
};

export function formatSpendRollupText(r: SpendRollup): string {
  const lines: string[] = [];
  lines.push(`LLM spend by ${r.groupBy} — ${r.window.label} (${r.window.tz.toUpperCase()})`);
  lines.push(`Window: ${r.window.fromIso} → ${r.window.toIso}`);
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push("");

  if (r.rows.length === 0) {
    lines.push("(no LLM activity in window)");
    return lines.join("\n") + "\n";
  }

  // Choose bucket-column width based on data so long session IDs don't push
  // the cost column off the right edge. Capped to keep the layout sane.
  const minBucketWidth = BUCKET_HEADER[r.groupBy].length;
  const widest = r.rows.reduce((w, row) => Math.max(w, row.bucket.length), minBucketWidth);
  const bucketWidth = Math.min(Math.max(widest, minBucketWidth), 40);

  const header = [
    pad(BUCKET_HEADER[r.groupBy], bucketWidth),
    pad("Calls", 8),
    pad("In tok", 12),
    pad("Out tok", 12),
    pad("Cache in", 12),
    pad("Cache out", 12),
    "Cost",
  ].join("  ");
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const row of r.rows) {
    lines.push(
      [
        pad(row.bucket, bucketWidth),
        pad(row.callCount.toLocaleString(), 8),
        pad(row.inputTokens.toLocaleString(), 12),
        pad(row.outputTokens.toLocaleString(), 12),
        pad(row.cacheReadTokens.toLocaleString(), 12),
        pad(row.cacheWriteTokens.toLocaleString(), 12),
        formatCost(row.costUsd),
      ].join("  "),
    );
  }

  lines.push("-".repeat(header.length));
  lines.push(
    [
      pad("Total", bucketWidth),
      pad(r.totals.callCount.toLocaleString(), 8),
      pad(r.totals.inputTokens.toLocaleString(), 12),
      pad(r.totals.outputTokens.toLocaleString(), 12),
      pad(r.totals.cacheReadTokens.toLocaleString(), 12),
      pad(r.totals.cacheWriteTokens.toLocaleString(), 12),
      formatCost(r.totals.costUsd),
    ].join("  "),
  );

  return lines.join("\n") + "\n";
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}
