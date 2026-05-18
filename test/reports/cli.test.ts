import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../../src/store/audit-store.js";
import { cliReportHandler } from "../../src/cli.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-report-cli-")), "test.db");
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

describe("CLI: audit report daily", () => {
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

  it("default output is human text with all section headers", () => {
    const out = captureStdout(() => cliReportHandler(store, "daily", { date: "2026-05-18", tz: "utc" }));
    for (const heading of ["Activity", "Cron schedule", "Top tools", "LLM spend", "Outbound messaging", "Anomalies", "Integrity"]) {
      assert.ok(out.includes(heading), `missing section: ${heading}`);
    }
  });

  it("--json emits a single line of parseable JSON with schemaVersion 1", () => {
    const out = captureStdout(() =>
      cliReportHandler(store, "daily", { date: "2026-05-18", tz: "utc", json: true }),
    );
    const lines = out.trim().split("\n");
    assert.equal(lines.length, 1);
    const projection = JSON.parse(lines[0]);
    assert.equal(projection.schemaVersion, 1);
    assert.equal(projection.period.kind, "daily");
    assert.equal(projection.period.tz, "utc");
  });

  it("--html emits a full HTML document", () => {
    const out = captureStdout(() =>
      cliReportHandler(store, "daily", { date: "2026-05-18", tz: "utc", html: true }),
    );
    assert.ok(out.startsWith("<!doctype html>"));
    assert.ok(out.includes("<title>Audit report"));
    assert.ok(out.includes("</html>"));
  });

  it("--top-tools rejects non-positive integers", () => {
    assert.throws(
      () => cliReportHandler(store, "daily", { date: "2026-05-18", topTools: "0" }),
      /positive integer/,
    );
    assert.throws(
      () => cliReportHandler(store, "daily", { date: "2026-05-18", topTools: "abc" }),
      /positive integer/,
    );
  });

  it("enforces upper bounds on detector parameters", () => {
    assert.throws(
      () => cliReportHandler(store, "daily", { date: "2026-05-18", lookbackDays: "1000000" }),
      /must not exceed 365/,
    );
    assert.throws(
      () => cliReportHandler(store, "daily", { date: "2026-05-18", dupWindowSec: "999999" }),
      /must not exceed 3600/,
    );
    assert.throws(
      () => cliReportHandler(store, "daily", { date: "2026-05-18", topTools: "99999" }),
      /must not exceed 1000/,
    );
  });

  it("weekly period parses --week and reports schemaVersion 1", () => {
    const out = captureStdout(() =>
      cliReportHandler(store, "weekly", { week: "2026-W21", tz: "utc", json: true }),
    );
    const projection = JSON.parse(out.trim());
    assert.equal(projection.period.kind, "weekly");
    assert.match(projection.period.label, /2026-W21/);
  });
});
