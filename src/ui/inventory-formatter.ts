import type { InventoryItem, InventoryKind, InventoryReport } from "../services/inventory.js";

const HASH_PREVIEW = 12;

function shortHash(h?: string): string {
  if (!h) return "—";
  return h.length > HASH_PREVIEW ? `${h.slice(0, HASH_PREVIEW)}…` : h;
}

function captureLabel(item: InventoryItem): string {
  if (!item.capturedInManifests) return "uncaptured";
  if (!item.capturedAt) return "captured";
  return `captured ${item.capturedAt}`;
}

function formatItemLine(item: InventoryItem): string {
  const version = item.version ? ` ${item.version}` : "";
  const path = item.path || "<removed>";
  return `${item.kind.padEnd(7)} ${item.name}${version}  ${shortHash(item.contentHash)}  ${captureLabel(item)}  ${path}`;
}

export function formatInventoryHuman(report: InventoryReport, kind: InventoryKind | "summary"): string {
  if (kind === "summary") {
    const s = report.summary;
    return [
      "Inventory summary:",
      `  plugins: ${s.plugins}`,
      `  skills:  ${s.skills}`,
      `  tools:   ${s.tools}`,
      `  soul:    ${s.soul}`,
      `  crons:   ${s.crons}`,
    ].join("\n");
  }

  const items = report[kind];
  if (!items || items.length === 0) {
    return `No ${kind} found.`;
  }
  return [`${kind} (${items.length}):`, ...items.map(formatItemLine)].join("\n");
}

export function formatInventoryJson(report: InventoryReport): string {
  return JSON.stringify(report, null, 2);
}
