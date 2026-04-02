import type { AuditStore, QueryOptions } from "./store/audit-store.js";
import type { AuditEvent } from "./types/events.js";

export interface AuditListOptions {
  last?: string;
  type?: string;
  category?: string;
  session?: string;
  limit?: string;
  offset?: string;
}

export interface AuditExportOptions {
  type?: string;
  category?: string;
  session?: string;
  limit?: string;
}

function formatEvent(event: AuditEvent): string {
  const time = event.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const session = event.sessionId ? ` [${event.sessionId.slice(0, 8)}]` : "";
  return `#${event.sequence} ${time}${session} ${event.eventType} — ${event.description}`;
}

function toJsonLines(events: AuditEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

function toCsv(events: AuditEvent[]): string {
  const headers = [
    "id",
    "sequence",
    "source",
    "machineId",
    "sessionId",
    "eventType",
    "category",
    "description",
    "metadata",
    "createdAt",
  ];
  const rows = events.map((e) =>
    headers.map((h) => {
      let val = e[h as keyof AuditEvent];
      if (h === "metadata") val = JSON.stringify(val);
      const str = val === undefined || val === null ? "" : String(val);
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(","),
  );
  return [headers.join(","), ...rows].join("\n");
}

function buildQueryOpts(opts: { type?: string; category?: string; session?: string; limit?: string }): QueryOptions {
  const q: QueryOptions = {};
  if (opts.type) q.eventType = opts.type;
  if (opts.category) q.category = opts.category;
  if (opts.session) q.sessionId = opts.session;
  if (opts.limit) q.limit = parseInt(opts.limit, 10) || undefined;
  return q;
}

export function cliAuditHandler(store: AuditStore, opts: AuditListOptions): void {
  if (store.isDegraded()) {
    console.error("WARNING: Audit store is in degraded mode. Some events may be missing.\n");
  }

  const q = buildQueryOpts(opts);
  if (opts.last) q.limit = parseInt(opts.last, 10) || 50;
  if (opts.offset) q.offset = parseInt(opts.offset, 10) || 0;

  const events = store.query(q);

  if (events.length === 0) {
    console.log("No audit events found.");
    return;
  }

  const total = store.count();
  console.log(`Showing ${events.length} of ${total} events:\n`);

  for (const event of events.reverse()) {
    console.log(formatEvent(event));
  }
}

export function cliVerifyHandler(store: AuditStore): void {
  console.log("Verifying audit trail integrity...\n");

  const result = store.verify();

  if (result.valid) {
    console.log(`OK — ${result.eventsChecked} events verified, chain is intact.`);
  } else {
    console.error(`INTEGRITY VIOLATION at sequence #${result.brokenAt}`);
    console.error(`  ${result.error}`);
    console.error(`  Checked ${result.eventsChecked} events before failure.`);
    process.exitCode = 1;
  }
}

export function cliExportHandler(store: AuditStore, format?: string, opts: AuditExportOptions = {}): void {
  const q = buildQueryOpts(opts);
  if (!q.limit) q.limit = 10_000;

  const events = store.query(q).reverse();
  const fmt = format ?? "json";

  if (fmt === "csv") {
    console.log(toCsv(events));
  } else {
    console.log(toJsonLines(events));
  }
}
