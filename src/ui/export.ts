/**
 * Streaming audit export — JSON Lines (NDJSON) or CSV.
 *
 * Pulls events from the audit store via a sequence cursor (not offset) so
 * concurrent DELETEs from `RetentionService.prune()` can't shift the
 * pagination window and silently skip rows. Each batch is written
 * directly to the output stream, so a multi-million-row export never
 * materializes a full result set in memory. The DE anchor for each
 * event's containing interval (when one exists) is included inline so a
 * downstream compliance reviewer can correlate the event with its
 * tamper-evident Digital Evidence reference without a second lookup.
 *
 * The plugin's local export is the operator-side complement to the
 * gateway-side workspace export described in PRD A12 — same on-the-wire
 * shape, but scoped to the events this plugin actually persisted.
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
 * lookup is fast. Only checkpoints with a DE tx hash count — a checkpoint
 * without one carries no externally verifiable anchor and would be
 * misleading on the wire.
 */
function indexAnchors(store: AuditStore): CheckpointRecord[] {
  return store
    .getCheckpoints()
    .filter((cp) => cp.deTxHash !== null)
    .sort((a, b) => a.sequenceStart - b.sequenceStart);
}

/**
 * Find the anchored checkpoint whose [sequenceStart, sequenceEnd] covers
 * `sequence`. Binary-searches for the rightmost candidate with
 * sequenceStart <= sequence, then scans backwards through earlier
 * candidates so an overlapping wider anchor still wins when a later
 * narrow anchor's range doesn't cover. The de-anchor allocator produces
 * non-overlapping monotone ranges today (see services/de-anchor.ts), but
 * the schema doesn't enforce that and tests / future backfill features
 * can introduce overlaps.
 */
function findAnchor(anchors: ReadonlyArray<CheckpointRecord>, sequence: number): CheckpointRecord | null {
  let lo = 0;
  let hi = anchors.length - 1;
  let rightmost = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (anchors[mid]!.sequenceStart <= sequence) {
      rightmost = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = rightmost; i >= 0; i--) {
    const cp = anchors[i]!;
    if (cp.sequenceEnd >= sequence) return cp;
  }
  return null;
}

function anchorRefFor(event: AuditEvent, anchors: ReadonlyArray<CheckpointRecord>): ExportedEvent["anchor"] {
  const cp = findAnchor(anchors, event.sequence);
  if (!cp) return null;
  // indexAnchors already filtered nulls; the deTxHash! is the contract.
  return {
    checkpointId: cp.id,
    deTxHash: cp.deTxHash!,
    smtRoot: cp.smtRoot,
    sequenceStart: cp.sequenceStart,
    sequenceEnd: cp.sequenceEnd,
    createdAt: cp.createdAt,
  };
}

type AnchorColumn =
  | "anchor_checkpoint_id"
  | "anchor_de_tx_hash"
  | "anchor_smt_root"
  | "anchor_sequence_start"
  | "anchor_sequence_end"
  | "anchor_created_at";
type CsvColumn = keyof AuditEvent | AnchorColumn | "metadata_json";

/**
 * Stable CSV column order. Anything new appended at the end so downstream
 * spreadsheet templates with positional columns don't break.
 */
const CSV_COLUMNS: ReadonlyArray<CsvColumn> = [
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

const CSV_COLUMNS_WITH_CONTENT: ReadonlyArray<CsvColumn> = CSV_COLUMNS;
const CSV_COLUMNS_NO_CONTENT: ReadonlyArray<CsvColumn> = CSV_COLUMNS.filter((c) => c !== "content");

function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return "";
  const str = typeof value === "string" ? value : String(value);
  if (str.length === 0) return "";
  // RFC 4180 quoting for delimiters, plus OWASP CSV-injection neutralisation:
  // a field starting with `=`, `+`, `-`, `@`, TAB, or CR triggers formula
  // evaluation in Excel / Google Sheets / LibreOffice — attacker-controlled
  // inputs (descriptions, message bodies, tool outputs, names) reach the
  // export, so we prefix a leading `'` to neutralise them.
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(str);
  const needsQuote = needsFormulaGuard || /[",\r\n]/.test(str);
  if (!needsQuote) return str;
  const prefixed = needsFormulaGuard ? `'${str}` : str;
  return `"${prefixed.replace(/"/g, '""')}"`;
}

function csvColumnsFor(includeContent: boolean): ReadonlyArray<CsvColumn> {
  return includeContent ? CSV_COLUMNS_WITH_CONTENT : CSV_COLUMNS_NO_CONTENT;
}

function csvHeaderLine(includeContent: boolean): string {
  return csvColumnsFor(includeContent).join(",") + "\n";
}

function csvFieldFor(event: ExportedEvent, col: CsvColumn): string {
  switch (col) {
    case "metadata_json":
      return csvEscape(JSON.stringify(event.metadata ?? {}));
    case "anchor_checkpoint_id":
      return csvEscape(event.anchor?.checkpointId);
    case "anchor_de_tx_hash":
      return csvEscape(event.anchor?.deTxHash);
    case "anchor_smt_root":
      return csvEscape(event.anchor?.smtRoot);
    case "anchor_sequence_start":
      return csvEscape(event.anchor?.sequenceStart);
    case "anchor_sequence_end":
      return csvEscape(event.anchor?.sequenceEnd);
    case "anchor_created_at":
      return csvEscape(event.anchor?.createdAt);
    default:
      // `col` is now a `keyof AuditEvent` by elimination — typed indexer,
      // no `as Record<…>` cast required.
      return csvEscape(event[col]);
  }
}

function csvLineFor(event: ExportedEvent, includeContent: boolean): string {
  const cols = csvColumnsFor(includeContent);
  const out: string[] = new Array(cols.length);
  for (let i = 0; i < cols.length; i++) out[i] = csvFieldFor(event, cols[i]!);
  return out.join(",") + "\n";
}

function ndjsonLineFor(event: ExportedEvent): string {
  return JSON.stringify(event) + "\n";
}

export interface StreamExportArgs {
  store: AuditStore;
  filters: ExportFilters;
  format: ExportFormat;
  /** Optional cap on rows written. Cuts the stream short once reached. */
  limitRows?: number;
  /** Write callback. Resolves when the chunk is queued (back-pressure aware via caller). */
  write: (chunk: string) => boolean;
  /** Called once the writer signals "drain" — caller resolves the next write. */
  waitForDrain: () => Promise<void>;
  /**
   * Called between rows. Returning true short-circuits the stream — used
   * by the HTTP pipeline so a client disconnect doesn't leave the loop
   * awaiting a drain that will never come.
   */
  isCancelled?: () => boolean;
}

/**
 * Stream the export to a writer. Pages through the audit store via a
 * sequence cursor (`afterSequence`) so concurrent retention DELETEs
 * behind the cursor can't make us skip rows. One line per event. Respects
 * HTTP back-pressure: if `write` returns false the loop awaits drain
 * before pulling the next batch.
 */
export async function streamExport(args: StreamExportArgs): Promise<{ rowsWritten: number }> {
  const { store, filters, format, write, waitForDrain, limitRows, isCancelled } = args;
  const queryBase = buildQueryOptions(filters);
  const anchors = indexAnchors(store);
  const includeContent = filters.includeContent === true;
  const cap = limitRows !== undefined && limitRows > 0 ? limitRows : Infinity;

  if (format === "csv") {
    if (!write(csvHeaderLine(includeContent))) await waitForDrain();
  }

  let lastSeq = 0;
  let rowsWritten = 0;
  while (rowsWritten < cap) {
    if (isCancelled?.()) break;
    const remaining = cap - rowsWritten;
    const pageSize = Math.min(BATCH_SIZE, remaining);
    const batch = store.query({ ...queryBase, afterSequence: lastSeq, limit: pageSize });
    if (batch.length === 0) break;
    for (const event of batch) {
      if (isCancelled?.()) return { rowsWritten };
      const enriched: ExportedEvent = { ...event, anchor: anchorRefFor(event, anchors) };
      const line = format === "csv" ? csvLineFor(enriched, includeContent) : ndjsonLineFor(enriched);
      if (!write(line)) await waitForDrain();
      rowsWritten++;
      lastSeq = event.sequence;
      if (rowsWritten >= cap) break;
    }
    if (batch.length < pageSize) break;
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
 * Pipe streamExport into an http ServerResponse. Headers are flushed
 * before the first chunk; mid-stream failures become a forced
 * `res.destroy(err)` so the client sees a TCP-level abort instead of a
 * clean EOF on a truncated stream. Client disconnects flip the
 * cancellation flag so the loop tears down promptly.
 */
export async function pipeExportToResponse(
  res: ServerResponse,
  args: { store: AuditStore; filters: ExportFilters; format: ExportFormat; limitRows?: number },
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", contentTypeFor(args.format));
  res.setHeader("content-disposition", `attachment; filename="${dispositionFilenameFor(args.format)}"`);
  res.setHeader("cache-control", "no-store");

  let cancelled = false;
  const onClose = () => { cancelled = true; };
  res.on("close", onClose);

  try {
    await streamExport({
      store: args.store,
      filters: args.filters,
      format: args.format,
      limitRows: args.limitRows,
      isCancelled: () => cancelled,
      write: (chunk) => res.write(chunk),
      // Race drain against close so a disconnected client doesn't wedge
      // the loop on an event that will never fire.
      waitForDrain: () => new Promise<void>((resolve) => {
        if (cancelled) return resolve();
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.once("drain", done);
        res.once("close", done);
      }),
    });
    if (!cancelled && !res.writableEnded) res.end();
  } catch (err) {
    // Headers are already flushed, so an in-band JSON error is impossible.
    // A forced destroy raises a TCP RST and the client's HTTP layer
    // surfaces the truncation instead of treating it as a normal EOF.
    if (!res.destroyed) res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    res.off("close", onClose);
  }
}
