import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { AuditStore } from "../../src/store/audit-store.js";
import { parseDate } from "../../src/reports/time-window.js";
import { buildProjection } from "../../src/reports/projection.js";

/**
 * AG-117 acceptance criterion #1: `report daily` runs in under 5s on a
 * 1M-row DB. Gated behind OPENCLAW_PERF=1 because seeding a million rows
 * costs ~30-60s of wall time and shouldn't run on every `npm test`.
 *
 * Run with: OPENCLAW_PERF=1 node --import tsx --test test/reports/perf.test.ts
 */

const RUN = process.env.OPENCLAW_PERF === "1";
const TOTAL_ROWS = 1_000_000;
const DAYS = 30;
const ROWS_PER_DAY = TOTAL_ROWS / DAYS;

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-perf-")), "test.db");
}

describe("buildProjection: 1M-row perf bound (gated by OPENCLAW_PERF=1)", () => {
  it(
    "daily report completes in under 5s on a 1M-row DB",
    { skip: !RUN, timeout: 600_000 },
    () => {
      const dbPath = makeTempDb();
      try {
        // Initialise schema via the store, then close and bulk-load via a
        // raw handle. The store enforces hash chaining + gzip on every
        // append(); for perf seeding we skip both and write fixed values.
        new AuditStore(dbPath).close();
        bulkSeed(dbPath, TOTAL_ROWS, DAYS);

        const store = new AuditStore(dbPath, { readOnly: true });
        try {
          // Report on the most recent day in the seeded window.
          const anchor = new Date("2026-05-18T00:00:00.000Z");
          const window = parseDate(toDate(anchor), "utc");

          const t0 = performance.now();
          const projection = buildProjection(store, window);
          const elapsedMs = performance.now() - t0;

          console.log(`buildProjection over 1M rows: ${elapsedMs.toFixed(0)}ms`);
          assert.ok(projection.schemaVersion === 1, "projection is well-formed");
          // The PRD says <5s; we assert 5000ms with no fudge factor so a
          // regression shows up immediately.
          assert.ok(elapsedMs < 5000, `report took ${elapsedMs.toFixed(0)}ms (> 5000ms)`);

          // Sanity: aggregations should have non-trivial values on a busy day.
          assert.ok(projection.activity.totalEvents > 1000, "day window picked up events");
        } finally {
          store.close();
        }
      } finally {
        rmSync(dirname(dbPath), { recursive: true, force: true });
      }
    },
  );
});

/**
 * Seed `total` rows across `days` days ending at 2026-05-18 23:59:59Z. Uses
 * a single connection, prepared statement, and one transaction per 10k rows
 * so SQLite stays in WAL-buffered mode rather than fsync-per-row.
 *
 * Distribution per day (sums to ROWS_PER_DAY):
 *  - 70% tool.invoked   (toolNames cycled across 8 names)
 *  - 15% prompt.response (single model so cost aggregation has something)
 *  - 10% message.sent   (channel cycled across 4)
 *  -  5% other          (session.start / cron.executed / agent.end)
 */
function bulkSeed(dbPath: string, total: number, days: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF"); // perf seeding only — DB is throwaway
  // 8 placeholders. content_hash is hardcoded to '' and previous_hash to NULL
  // — the report path doesn't consume either for aggregations (and the
  // integrity footer just echoes whatever the last row has).
  const stmt = db.prepare(
    `INSERT INTO audit_events
       (id, source, machine_id, session_id, event_type, category, description,
        metadata, content_gz, content_hash, previous_hash, created_at)
     VALUES (?, 'openclaw-plugin', 'perf-machine', ?, ?, ?, ?, ?, ?, '', NULL, ?)`,
  );

  const TOOLS = ["bash", "read", "edit", "write", "grep", "ls", "exec", "task"];
  const CHANNELS = ["slack", "discord", "telegram", "email"];
  const dayEnd = new Date("2026-05-19T00:00:00.000Z").getTime();
  const dayMs = 86_400_000;
  const rowsPerDay = Math.floor(total / days);

  // Stable gzipped payloads — cheaper than gzipping per row, and the report
  // only decompresses message.sent content (10% of rows × 1 day in window).
  const msgContent = gzipSync(Buffer.from("perf-seed-msg-body"));

  const BATCH = 10_000;
  let inBatch = 0;
  db.exec("BEGIN");
  try {
    for (let d = 0; d < days; d++) {
      const dayStart = dayEnd - (d + 1) * dayMs;
      for (let i = 0; i < rowsPerDay; i++) {
        const offsetMs = Math.floor((i / rowsPerDay) * dayMs);
        const createdAt = new Date(dayStart + offsetMs).toISOString();
        const id = `perf-${d}-${i}`;
        const r = i % 100;
        let eventType: string;
        let category: string;
        let metadata: string;
        let contentGz: Buffer | null = null;
        if (r < 70) {
          eventType = "tool.invoked";
          category = "tool";
          metadata = `{"toolName":"${TOOLS[i % TOOLS.length]}"}`;
        } else if (r < 85) {
          eventType = "prompt.response";
          category = "prompt";
          metadata = `{"model":"claude-opus-4-7","provider":"anthropic","inputTokens":1000,"outputTokens":500,"costUsd":0.05}`;
        } else if (r < 95) {
          eventType = "message.sent";
          category = "message";
          metadata = `{"channel":"${CHANNELS[i % CHANNELS.length]}","recipient":"#bot","direction":"out"}`;
          contentGz = msgContent;
        } else {
          eventType = "session.start";
          category = "system";
          metadata = `{}`;
        }
        stmt.run(id, `sess-${d}`, eventType, category, `${eventType} perf`, metadata, contentGz, createdAt);
        if (++inBatch >= BATCH) {
          db.exec("COMMIT");
          db.exec("BEGIN");
          inBatch = 0;
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // ANALYZE so the query planner picks the (event_type, created_at) index
  // rather than (created_at) for the windowed aggregates.
  db.exec("ANALYZE");
  db.close();
}

function toDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
