/**
 * Shared text-formatting utilities for the report and rollup renderers.
 * Parallels `html-utils.ts` so any future formatter has one obvious place
 * to look for column-padding / truncation helpers.
 */

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
