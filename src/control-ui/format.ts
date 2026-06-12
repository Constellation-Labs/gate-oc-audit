/**
 * Canonical client-side formatters for the control-ui Lit components.
 *
 * These were previously copy-pasted (with subtly divergent null/NaN handling)
 * across nearly every component. This module is the single source of truth;
 * components import from here rather than redefining locals. See
 * docs/review-full-codebase-code-round2.md ("Duplication").
 */

import type { ConfiguredCron } from "./api.ts";

/**
 * Extract the query string from a `location.hash` and return it as
 * `URLSearchParams`. The portion after the first `?` is parsed; a hash with no
 * `?` yields an empty `URLSearchParams` (every `.get()` returns `null`).
 * Defaults to `window.location.hash` when no argument is supplied. Replaces the
 * per-component `hash.indexOf("?")` + `new URLSearchParams(hash.slice(...))`
 * reimplementations.
 */
export function hashQuery(hash: string = window.location.hash): URLSearchParams {
  const qIdx = hash.indexOf("?");
  return new URLSearchParams(qIdx < 0 ? "" : hash.slice(qIdx + 1));
}

/**
 * Format a count for display. Adopts the SAFE contract: `null`/`undefined`/
 * non-finite all render as the em-dash placeholder, unifying the previously
 * divergent guards (some copies only checked `Number.isFinite`, others also
 * guarded null/undefined).
 */
export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

/** Format a USD cost with 4 decimal places so per-call costs don't round to $0.00. */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(4)}`;
}

/**
 * Trim an ISO 8601 timestamp for display: drop subsecond precision (keep the
 * `Z` marker) and replace the `T` separator with a space. Nullish renders as
 * the em-dash placeholder.
 */
export function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.replace(/\.\d+Z$/, "Z").replace("T", " ");
}

/** Format a duration in ms on a `ms`/`s`/`m`/`h` ladder. Nullish renders as the em-dash placeholder. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Render a parsed cron schedule as a one-line human string. Null renders as the em-dash placeholder. */
export function fmtCronSchedule(c: ConfiguredCron | null): string {
  if (!c) return "—";
  const s = c.schedule;
  switch (s.kind) {
    case "at": return `at ${s.at}`;
    case "every": return `every ${s.everyMs} ms`;
    case "cron": return `cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
    case "unknown": return `unknown (${s.raw})`;
  }
}

/**
 * Truncate a long hash to a head…tail form for compact display. Hashes of 18
 * chars or fewer are returned unchanged. Canonical form: first 10 + `…` +
 * last 6 (replaces the divergent `...`/last-4 and `…`/last-6 copies).
 */
export function shortHash(h: string): string {
  if (h.length <= 18) return h;
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

/**
 * Build a DE explorer fingerprint URL for an anchored transaction hash.
 * Returns null when no base URL is configured. Trailing slashes on the base
 * are normalized away.
 */
export function explorerFingerprintUrl(deTxHash: string, deBaseUrl: string | null | undefined): string | null {
  if (!deBaseUrl) return null;
  const base = deBaseUrl.replace(/\/+$/, "");
  return `${base}/explorer/fingerprint/${encodeURIComponent(deTxHash)}`;
}
