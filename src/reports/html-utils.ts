/**
 * Shared HTML utilities for the report and anomaly renderers. Keeping these
 * here prevents the two self-contained-HTML files (`format-html.ts`,
 * `format-anomalies-html.ts`) from drifting when the visual conventions
 * (orange anomaly stripe, monospace hash classes) get tweaked in one place.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Base stylesheet used by both report and anomaly HTML outputs. Anything that
 * affects both (typography, the `.anomaly` stripe, the `.hash` monospace
 * class) belongs here; renderer-specific styles can be appended at the call
 * site if needed.
 */
export const REPORT_BASE_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 2em auto; padding: 0 1em; color: #222; }
  h1 { font-size: 1.4em; margin-bottom: 0.2em; }
  h2 { font-size: 1.1em; margin-top: 1.6em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  .meta { color: #666; font-size: 0.9em; margin-bottom: 1em; }
  table { border-collapse: collapse; margin: 0.4em 0 1em 0; min-width: 50%; }
  th, td { text-align: left; padding: 0.2em 0.8em 0.2em 0; font-size: 0.95em; vertical-align: top; }
  th { color: #555; font-weight: 600; border-bottom: 1px solid #ccc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #888; font-style: italic; }
  .hash { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; color: #444; }
  .anomaly { background: #fff7e6; border-left: 3px solid #f5a623; padding: 0.6em 0.8em; margin: 0.5em 0; }
  .anomaly.bad { background: #fdecea; border-left-color: #d93025; }
  .anomaly-head { font-weight: 600; }
  .anomaly-event { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; color: #555; padding-left: 1em; }
  @media print { body { margin: 0.5em; max-width: 100%; } }
`;
