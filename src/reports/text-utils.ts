/**
 * Shared text-formatting utilities for the report and rollup renderers.
 * Parallels `html-utils.ts` so any future formatter has one obvious place
 * to look for column-padding / truncation helpers.
 */

import type { IntegrityViolationFinding } from "./detectors.js";

/**
 * True when an integrity finding has anything worth rendering as a section:
 * a confirmed not-found checkpoint, a tampered event, or a scan-skipped note.
 * Pending verification is deliberately excluded — it is normal and only shown
 * for context inside an already-flagged section. The text and HTML anomaly
 * formatters share this predicate so their section-gating can't drift.
 */
export function hasIntegrityFindings(iv: IntegrityViolationFinding): boolean {
  return iv.notFoundOnDe.length > 0 || iv.tamperedEvents.length > 0 || iv.note !== null;
}

/**
 * Right-pads `s` with spaces to `width`, truncating with `.slice(0, width)`
 * when `s` is already longer. The truncating behavior keeps tabular output
 * aligned even when a single cell exceeds its budget — better than a ragged
 * row that breaks the column grid for everything after it.
 */
export function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

/**
 * Format a USD cost with 4 decimal places. The single home for the
 * `$${n.toFixed(4)}` idiom that the report/session/blocks/html formatters
 * otherwise re-declared. 4 dp so per-call costs don't round to $0.00.
 */
export function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
