import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import {
  buildSpendRollup,
  formatSpendRollupText,
  SPEND_ROLLUP_SCHEMA_VERSION,
} from "../../src/reports/spend-rollup.js";
import { cliSpendHandler } from "../../src/cli.js";
import { parseSince } from "../../src/reports/time-window.js";

const require2 = createRequire(import.meta.url);
const Ajv2020 = require2("ajv/dist/2020").default;

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-spend-")), "test.db");
}

function backdate(dbPath: string, eventId: string, createdAt: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(createdAt, eventId);
  db.close();
}

// Anchor every test event at a fixed in-window timestamp so we don't race
// the parseSince() snapshot. Tests query [now-365d, now), which always
// covers this anchor.
const TEST_ANCHOR_ISO = "2026-05-20T10:00:00.000Z";

function appendResponse(
  store: AuditStore,
  dbPath: string,
  meta: { provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheTokens?: number },
  opts: { sessionId?: string; createdAt?: string } = {},
): string {
  const ev = store.append({
    eventType: "prompt.response",
    category: "prompt",
    description: "llm call",
    sessionId: opts.sessionId,
    metadata: meta,
  })!;
  backdate(dbPath, ev.id, opts.createdAt ?? TEST_ANCHOR_ISO);
  return ev.id;
}

const WIDE_WINDOW = () => parseSince("365d", undefined, "utc");

describe("buildSpendRollup", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("returns an empty rollup with zero totals when no prompt.response events exist", () => {
    const window = WIDE_WINDOW();
    const r = buildSpendRollup(store, window, "model");
    assert.equal(r.schemaVersion, SPEND_ROLLUP_SCHEMA_VERSION);
    assert.equal(r.groupBy, "model");
    assert.equal(r.rows.length, 0);
    assert.equal(r.totals.callCount, 0);
    assert.equal(r.totals.costUsd, 0);
  });

  it("groups by model (provider/model label) and sums tokens + cost", () => {
    appendResponse(store, dbPath, { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50, costUsd: 0.02 });
    appendResponse(store, dbPath, { provider: "openai", model: "gpt-5", inputTokens: 200, outputTokens: 75, costUsd: 0.04 });
    appendResponse(store, dbPath, { provider: "anthropic", model: "opus-4-7", inputTokens: 500, outputTokens: 200, costUsd: 0.10 });

    const window = WIDE_WINDOW();
    const r = buildSpendRollup(store, window, "model");
    assert.equal(r.rows.length, 2);
    // Cost desc — opus first
    assert.equal(r.rows[0]!.bucket, "anthropic/opus-4-7");
    assert.equal(r.rows[0]!.callCount, 1);
    assert.equal(r.rows[0]!.costUsd, 0.10);
    assert.equal(r.rows[1]!.bucket, "openai/gpt-5");
    assert.equal(r.rows[1]!.callCount, 2);
    assert.equal(r.rows[1]!.inputTokens, 300);
    assert.equal(r.rows[1]!.outputTokens, 125);
    assert.ok(Math.abs(r.rows[1]!.costUsd - 0.06) < 1e-9);
    assert.equal(r.totals.callCount, 3);
    assert.ok(Math.abs(r.totals.costUsd - 0.16) < 1e-9);
  });

  it("does not merge same-model name across two providers", () => {
    // Two providers exposing the same model name should produce two
    // distinct buckets so totals match `audit report daily` per-row.
    appendResponse(store, dbPath, { provider: "openai", model: "opus", inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    appendResponse(store, dbPath, { provider: "anthropic", model: "opus", inputTokens: 10, outputTokens: 5, costUsd: 0.02 });
    const r = buildSpendRollup(store, WIDE_WINDOW(), "model");
    assert.equal(r.rows.length, 2);
    assert.ok(r.rows.find((x) => x.bucket === "openai/opus"));
    assert.ok(r.rows.find((x) => x.bucket === "anthropic/opus"));
  });

  it("groups by provider", () => {
    appendResponse(store, dbPath, { provider: "openai", model: "a", inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    appendResponse(store, dbPath, { provider: "openai", model: "b", inputTokens: 20, outputTokens: 5, costUsd: 0.02 });
    appendResponse(store, dbPath, { provider: "anthropic", model: "c", inputTokens: 30, outputTokens: 5, costUsd: 0.03 });

    const r = buildSpendRollup(store, WIDE_WINDOW(), "provider");
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows.find((x) => x.bucket === "openai")?.callCount, 2);
    assert.equal(r.rows.find((x) => x.bucket === "anthropic")?.callCount, 1);
  });

  it("groups by session", () => {
    appendResponse(store, dbPath, { provider: "openai", model: "a", inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, { sessionId: "sess-1" });
    appendResponse(store, dbPath, { provider: "openai", model: "a", inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, { sessionId: "sess-1" });
    appendResponse(store, dbPath, { provider: "openai", model: "a", inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, { sessionId: "sess-2" });
    // One with no session id — should bucket as <no-session>
    appendResponse(store, dbPath, { provider: "openai", model: "a", inputTokens: 10, outputTokens: 5, costUsd: 0.01 });

    const r = buildSpendRollup(store, WIDE_WINDOW(), "session");
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows.find((x) => x.bucket === "sess-1")?.callCount, 2);
    assert.equal(r.rows.find((x) => x.bucket === "sess-2")?.callCount, 1);
    assert.equal(r.rows.find((x) => x.bucket === "<no-session>")?.callCount, 1);
  });

  it("groups by day with backdated events", () => {
    const a = appendResponse(store, dbPath, { provider: "openai", model: "m", inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    const b = appendResponse(store, dbPath, { provider: "openai", model: "m", inputTokens: 100, outputTokens: 50, costUsd: 0.02 });
    backdate(dbPath, a, "2026-05-18T10:00:00.000Z");
    backdate(dbPath, b, "2026-05-19T10:00:00.000Z");

    const window = parseSince("7d", undefined, "utc");
    const r = buildSpendRollup(store, window, "day");
    assert.equal(r.rows.length, 2);
    // Day grouping is ordered ascending
    assert.equal(r.rows[0]!.bucket, "2026-05-18");
    assert.equal(r.rows[1]!.bucket, "2026-05-19");
  });

  it("excludes events outside the window", () => {
    const inside = appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    const outside = appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.99 });
    backdate(dbPath, outside, "2020-01-01T00:00:00.000Z");

    const r = buildSpendRollup(store, WIDE_WINDOW(), "provider");
    // Only the inside event should count
    assert.equal(r.totals.callCount, 1);
    assert.ok(Math.abs(r.totals.costUsd - 0.01) < 1e-9);
    // Sanity: the inside event id is the one captured
    assert.ok(inside.length > 0);
  });

  it("collapses cacheReadTokens and cacheTokens onto the same column", () => {
    // Older callers used cacheTokens (singular); newer use cacheReadTokens.
    // The SQL aggregator collapses them onto cacheReadTokens; verify here.
    appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: 5 });
    appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, cacheTokens: 7 });
    const r = buildSpendRollup(store, WIDE_WINDOW(), "model");
    assert.equal(r.rows[0]!.cacheReadTokens, 12);
  });

  it("prefers cacheReadTokens over cacheTokens when both are present on the same row", () => {
    // SQL COALESCE order is (cacheReadTokens, cacheTokens); the modern
    // field wins so callers can migrate forward without double-counting.
    appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: 5, cacheTokens: 999 });
    const r = buildSpendRollup(store, WIDE_WINDOW(), "model");
    assert.equal(r.rows[0]!.cacheReadTokens, 5);
  });

  it("respects --limit and surfaces truncated: true with sort-by-cost retention", () => {
    // Insert 5 distinct providers; cap at 3. The three highest-cost ones
    // should appear, the two cheapest should be elided.
    appendResponse(store, dbPath, { provider: "alpha",   model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.50 });
    appendResponse(store, dbPath, { provider: "beta",    model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.40 });
    appendResponse(store, dbPath, { provider: "gamma",   model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.30 });
    appendResponse(store, dbPath, { provider: "delta",   model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.20 });
    appendResponse(store, dbPath, { provider: "epsilon", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.10 });

    const r = buildSpendRollup(store, WIDE_WINDOW(), "provider", { limit: 3 });
    assert.equal(r.limit, 3);
    assert.equal(r.truncated, true);
    assert.equal(r.rows.length, 3);
    assert.deepEqual(r.rows.map((x) => x.bucket), ["alpha", "beta", "gamma"]);
    // Sanity: totals reflect what's displayed, not the full window.
    assert.ok(Math.abs(r.totals.costUsd - 1.20) < 1e-9);
  });

  it("truncated is false when result row count is at or below limit", () => {
    appendResponse(store, dbPath, { provider: "alpha", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    appendResponse(store, dbPath, { provider: "beta",  model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.02 });
    const r = buildSpendRollup(store, WIDE_WINDOW(), "provider", { limit: 10 });
    assert.equal(r.truncated, false);
    assert.equal(r.rows.length, 2);
  });

  it("--by day breaks ties on bucket ASC (oldest first)", () => {
    // All three rows have identical costUsd; the day bucket must be
    // stably sorted ascending. Regression for the L-5/L-6 nit: day
    // grouping uses `bucket ASC`, the other groupings use cost DESC.
    const a = appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    const b = appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    const c = appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    backdate(dbPath, a, "2026-05-17T10:00:00.000Z");
    backdate(dbPath, b, "2026-05-19T10:00:00.000Z");
    backdate(dbPath, c, "2026-05-18T10:00:00.000Z");
    const r = buildSpendRollup(store, parseSince("365d", undefined, "utc"), "day");
    assert.deepEqual(r.rows.map((x) => x.bucket), ["2026-05-17", "2026-05-18", "2026-05-19"]);
  });
});

describe("formatSpendRollupText", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("renders a header, table, and totals row when there's data", () => {
    appendResponse(store, dbPath, { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50, costUsd: 0.02 });
    const r = buildSpendRollup(store, WIDE_WINDOW(), "model");
    const text = formatSpendRollupText(r);
    assert.match(text, /^LLM spend by model/);
    assert.match(text, /\nModel/);
    assert.match(text, /\nTotal\s/);
    assert.match(text, /\$0\.02/);
  });

  it("renders an empty-window message", () => {
    const r = buildSpendRollup(store, WIDE_WINDOW(), "model");
    const text = formatSpendRollupText(r);
    assert.match(text, /no LLM activity in window/);
  });

  it("notes that --by day buckets are UTC dates", () => {
    appendResponse(store, dbPath, { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    const r = buildSpendRollup(store, parseSince("365d", undefined, "local"), "day");
    const text = formatSpendRollupText(r);
    assert.match(text, /day buckets are UTC dates/);
  });

  it("notes truncation when --limit trims the result", () => {
    appendResponse(store, dbPath, { provider: "a", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.02 });
    appendResponse(store, dbPath, { provider: "b", model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    const r = buildSpendRollup(store, WIDE_WINDOW(), "provider", { limit: 1 });
    const text = formatSpendRollupText(r);
    assert.match(text, /truncated to 1 buckets/);
  });
});

describe("cliSpendHandler --by validation", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("rejects an unknown --by value with a descriptive error", () => {
    assert.throws(
      () => cliSpendHandler(store, { by: "team" }),
      /--by must be one of provider\|model\|day\|session/,
    );
  });

  it("rejects --limit values outside the cap", () => {
    assert.throws(
      () => cliSpendHandler(store, { limit: "999999999" }),
      /--limit/,
    );
  });
});

describe("audit-spend.schema.json roundtrip", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("validates a populated rollup against the published schema", () => {
    appendResponse(store, dbPath, { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 50, costUsd: 0.02 });
    appendResponse(store, dbPath, { provider: "anthropic", model: "opus", inputTokens: 200, outputTokens: 75, costUsd: 0.10 });

    const r = buildSpendRollup(store, WIDE_WINDOW(), "model");

    const schemaPath = join(
      dirname(dirname(dirname(new URL(import.meta.url).pathname))),
      "schemas",
      "audit-spend.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    const ajv = new Ajv2020({ strict: false, logger: false });
    const validate = ajv.compile(schema);
    const wireForm = JSON.parse(JSON.stringify(r));
    const ok = validate(wireForm);
    if (!ok) console.error("spend schema errors:", validate.errors);
    assert.ok(ok, "spend rollup must validate against published schema");
  });

  it("schema and rollup agree on schemaVersion", () => {
    const schemaPath = join(
      dirname(dirname(dirname(new URL(import.meta.url).pathname))),
      "schemas",
      "audit-spend.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    assert.equal(schema.properties.schemaVersion.const, SPEND_ROLLUP_SCHEMA_VERSION);
  });
});
