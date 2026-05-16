/**
 * Streaming audit export — JSON Lines (NDJSON) or CSV.
 *
 * Pulls events from the audit store in fixed-size batches and writes each
 * batch directly to the output stream, so a multi-million-row export never
 * materializes a full result set in memory. The DE anchor for each event's
 * containing interval (when one exists) is included inline so a downstream
 * compliance reviewer can correlate the event with its tamper-evident
 * Digital Evidence reference without a second lookup.
 *
 * The plugin's local export is the operator-side complement to the
 * gateway-side workspace export described in PRD A12 — same on-the-wire
 * shape, but scoped to the events this plugin actually persisted, with no
 * authorization step beyond the plugin's existing UI-route gate.
 */
import type { ServerResponse } from "node:http";
import type { AuditStore, QueryOptions, CheckpointRecord } from "../store/audit-store.js";
import type { AuditEvent } from "../types/events.js";

const BATCH_SIZE = 1000;

export type ExportFormat = "json" | "csv";

export interface ExportFilters {
  from?: string;
  to?: string;
  eventType?: string;
  category?: string;
  sessionId?: string;
  /**
   * When true, restrict the export to events whose category is one of the
   * operator-policy / supply-chain / scan categories. Mirrors the dashboard
   * "security-only" toggle.
   */
  securityOnly?: boolean;
  includeContent?: boolean;
}

/**
 * Categories that surface as the "security-only" view. Intentionally a
 * fixed list rather than a runtime-overridable config — this is what the
 * dashboard toggle binds to, and it stays in sync with the event taxonomy
 * defined in src/types/events.ts.
 */
const SECURITY_CATEGORIES = ["security", "config", "system"] as const;

/**
 * Audit row shape on the wire. `anchor` is null when no DE-anchored
 * checkpoint covers the event's sequence yet (anchor-pending).
 */
export interface ExportedEvent extends AuditEvent {
  anchor: {
    checkpointId: string;
    deTxHash: string;
    smtRoot: string;
    sequenceStart: number;
    sequenceEnd: number;
    createdAt: string;
  } | null;
}

function buildQueryOptions(filters: ExportFilters): QueryOptions {
  const opts: QueryOptions = {
    order: "asc",
    includeContent: filters.includeContent === true,
  };
  if (filters.from) opts.createdAfter = filters.from;
  if (filters.to) opts.createdBefore = filters.to;
  if (filters.eventType) opts.eventType = filters.eventType;
  if (filters.category) opts.category = filters.category;
  if (filters.sessionId) opts.sessionId = filters.sessionId;
  if (filters.securityOnly) opts.categoryIn = SECURITY_CATEGORIES;
  return opts;
}

/**
 * Index anchored checkpoints by ascending sequenceStart so the per-event
 * lookup is an O(log n) binary search instead of a linear scan. Only
 * checkpoints with a DE tx hash count — a checkpoint without one carries
 * no externally verifiable anchor and would be misleading on the wire.
 */
function indexAnchors(store: AuditStore): CheckpointRecord[] {
  return store
    .getCheckpoints()
    .filter((cp) => cp.deTxHash !== null)
    .sort((a, b) => a.sequenceStart - b.sequenceStart);
}

function findAnchor(anchors: ReadonlyArray<CheckpointRecord>, sequence: number): CheckpointRecord | null {
  // Binary search for the rightmost anchor with sequenceStart <= sequence,
  // then verify the event also falls below the anchor's sequenceEnd.
  let lo = 0;
  let hi = anchors.length - 1;
  let candidate: CheckpointRecord | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cp = anchors[mid]!;
    if (cp.sequenceStart <= sequence) {
      candidate = cp;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!candidate) return null;
  return candidate.sequenceEnd >= sequence ? candidate : null;
}

function anchorRefFor(event: AuditEvent, anchors: ReadonlyArray<CheckpointRecord>): ExportedEvent["anchor"] {
  const cp = findAnchor(anchors, event.sequence);
  if (!cp || cp.deTxHash === null) return null;
  return {
    checkpointId: cp.id,
    deTxHash: cp.deTxHash,
    smtRoot: cp.smtRoot,
    sequenceStart: cp.sequenceStart,
    sequenceEnd: cp.sequenceEnd,
    createdAt: cp.createdAt,
  };
}

/**
 * Stable CSV column order. Anything new appended at the end so downstream
 * spreadsheet templates with positional columns don't break.
 */
const CSV_COLUMNS: ReadonlyArray<keyof ExportedEvent | "metadata_json" | "anchor_de_tx_hash" | "anchor_smt_root" | "anchor_sequence_start" | "anchor_sequence_end" | "anchor_created_at" | "anchor_checkpoint_id"> = [
  "id",
  "sequence",
  "source",
  "machineId",
  "sessionId",
  "orgId",
  "userId",
  "eventType",
  "category",
  "description",
  "contentHash",
  "previousHash",
  "createdAt",
  "receivedAt",
  "syncedAt",
  "anchor_checkpoint_id",
  "anchor_de_tx_hash",
  "anchor_smt_root",
  "anchor_sequence_start",
  "anchor_sequence_end",
  "anchor_created_at",
  "metadata_json",
  "content",
] as const;

function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return "";
  const str = typeof value === "string" ? value : String(value);
  if (str.length === 0) return "";
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvHeaderLine(includeContent: boolean): string {
  const cols = includeContent ? CSV_COLUMNS : CSV_COLUMNS.filter((c) => c !== "content");
  return cols.join(",") + "\n";
}

function csvLineFor(event: ExportedEvent, includeContent: boolean): string {
  const cols = includeContent ? CSV_COLUMNS : CSV_COLUMNS.filter((c) => c !== "content");
  const out: string[] = [];
  for (const col of cols) {
    switch (col) {
      case "metadata_json":
        out.push(csvEscape(JSON.stringify(event.metadata ?? {})));
        break;
      case "anchor_checkpoint_id":
        out.push(csvEscape(event.anchor?.checkpointId));
        break;
      case "anchor_de_tx_hash":
        out.push(csvEscape(event.anchor?.deTxHash));
        break;
      case "anchor_smt_root":
        out.push(csvEscape(event.anchor?.smtRoot));
        break;
      case "anchor_sequence_start":
        out.push(csvEscape(event.anchor?.sequenceStart));
        break;
      case "anchor_sequence_end":
        out.push(csvEscape(event.anchor?.sequenceEnd));
        break;
      case "anchor_created_at":
        out.push(csvEscape(event.anchor?.createdAt));
        break;
      default:
        out.push(csvEscape((event as unknown as Record<string, unknown>)[col]));
    }
  }
  return out.join(",") + "\n";
}

function ndjsonLineFor(event: ExportedEvent): string {
  return JSON.stringify(event) + "\n";
}

export interface StreamExportArgs {
  store: AuditStore;
  filters: ExportFilters;
  format: ExportFormat;
  /** Write callback. Resolves when the chunk is queued (back-pressure aware via caller). */
  write: (chunk: string) => boolean;
  /** Called once the writer signals "drain" — caller resolves the next write. */
  waitForDrain: () => Promise<void>;
}

/**
 * Stream the export to a writer. Pages through the audit store in fixed
 * batches and emits one line per event. Respects HTTP back-pressure: if
 * `write` returns false the loop awaits drain before pulling the next
 * batch.
 */
export async function streamExport(args: StreamExportArgs): Promise<{ rowsWritten: number }> {
  const { store, filters, format, write, waitForDrain } = args;
  const queryBase = buildQueryOptions(filters);
  const anchors = indexAnchors(store);
  const includeContent = filters.includeContent === true;

  if (format === "csv") {
    if (!write(csvHeaderLine(includeContent))) await waitForDrain();
  }

  let offset = 0;
  let rowsWritten = 0;
  while (true) {
    const batch = store.query({ ...queryBase, limit: BATCH_SIZE, offset });
    if (batch.length === 0) break;
    for (const event of batch) {
      const enriched: ExportedEvent = { ...event, anchor: anchorRefFor(event, anchors) };
      const line = format === "csv" ? csvLineFor(enriched, includeContent) : ndjsonLineFor(enriched);
      if (!write(line)) await waitForDrain();
      rowsWritten++;
    }
    offset += batch.length;
    if (batch.length < BATCH_SIZE) break;
  }

  return { rowsWritten };
}

export function contentTypeFor(format: ExportFormat): string {
  return format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8";
}

export function dispositionFilenameFor(format: ExportFormat, now: Date = new Date()): string {
  const ext = format === "csv" ? "csv" : "ndjson";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `audit-export-${stamp}.${ext}`;
}

/**
 * Pipe streamExport into an http ServerResponse. Sets headers before the
 * first chunk and translates Node's "write returned false" signal into an
 * awaitable drain.
 */
export async function pipeExportToResponse(
  res: ServerResponse,
  args: { store: AuditStore; filters: ExportFilters; format: ExportFormat },
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", contentTypeFor(args.format));
  res.setHeader("content-disposition", `attachment; filename="${dispositionFilenameFor(args.format)}"`);
  res.setHeader("cache-control", "no-store");

  await streamExport({
    store: args.store,
    filters: args.filters,
    format: args.format,
    write: (chunk) => res.write(chunk),
    waitForDrain: () => new Promise<void>((resolve) => res.once("drain", resolve)),
  });
  res.end();
}
