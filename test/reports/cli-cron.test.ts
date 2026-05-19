import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import { cliReportCronHandler } from "../../src/cli.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-cron-cli-")), "test.db");
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

function insertWithContent(
  store: AuditStore,
  dbPath: string,
  params: {
    createdAt: string;
    eventType: string;
    category: string;
    metadata: Record<string, unknown>;
    sessionId?: string;
  },
): { id: string; sequence: number } {
  const ev = store.append({
    sessionId: params.sessionId ?? "sess-1",
    eventType: params.eventType as any,
    category: params.category as any,
    description: `${params.eventType} event`,
    metadata: params.metadata,
  })!;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(params.createdAt, ev.id);
  db.close();
  return { id: ev.id, sequence: ev.sequence };
}

describe("CLI: audit report cron", () => {
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

  it("rejects an empty or missing job-id", () => {
    assert.throws(() => cliReportCronHandler(store, undefined, {}), /requires a <job-id>/);
    assert.throws(() => cliReportCronHandler(store, "", {}), /requires a <job-id>/);
  });

  it("default output is a human text table with the rollup header", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "nightly", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:05.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-1", success: true, durationMs: 5000 },
    });

    const out = captureStdout(() => cliReportCronHandler(store, "nightly", {}));
    assert.ok(out.includes("Per-cron rollup — jobId=nightly"));
    assert.ok(out.includes("Started"));
    assert.ok(out.includes("Status"));
    assert.ok(out.includes("RunId"));
    assert.ok(out.includes("ok"));
    assert.ok(out.includes("run-1"));
  });

  it("empty-result text output mentions there are no executions", () => {
    const out = captureStdout(() => cliReportCronHandler(store, "missing", {}));
    assert.match(out, /no executions recorded/);
  });

  it("--json emits a single line of parseable JSON with schemaVersion 1", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "nightly", runId: "run-1" },
    });
    const out = captureStdout(() => cliReportCronHandler(store, "nightly", { json: true }));
    const lines = out.trim().split("\n");
    assert.equal(lines.length, 1);
    const rollup = JSON.parse(lines[0]);
    assert.equal(rollup.schemaVersion, 1);
    assert.equal(rollup.jobId, "nightly");
    assert.equal(rollup.rows.length, 1);
    assert.equal(rollup.rows[0].runId, "run-1");
    assert.equal(rollup.truncated, false);
  });

  it("--html emits a self-contained HTML document for the rollup", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "nightly", runId: "run-1" },
    });
    const out = captureStdout(() => cliReportCronHandler(store, "nightly", { html: true }));
    assert.ok(out.startsWith("<!doctype html>"));
    assert.ok(out.includes("<title>Per-cron rollup"));
    assert.ok(out.includes("</html>"));
    assert.ok(out.includes("run-1"));
  });

  it("--last validates positive integer and upper bound", () => {
    assert.throws(
      () => cliReportCronHandler(store, "nightly", { last: "0" }),
      /positive integer/,
    );
    assert.throws(
      () => cliReportCronHandler(store, "nightly", { last: "abc" }),
      /positive integer/,
    );
    assert.throws(
      () => cliReportCronHandler(store, "nightly", { last: "9999" }),
      /must not exceed 1000/,
    );
  });

  it("--last bounds the rollup and surfaces truncation", () => {
    for (let i = 0; i < 5; i++) {
      insertWithContent(store, dbPath, {
        createdAt: `2026-05-18T${String(7 + i).padStart(2, "0")}:00:00.000Z`,
        eventType: "cron.executed",
        category: "cron",
        sessionId: `sess-${i}`,
        metadata: { jobId: "j", runId: `run-${i}` },
      });
    }
    const out = captureStdout(() => cliReportCronHandler(store, "j", { last: "2", json: true }));
    const rollup = JSON.parse(out.trim());
    assert.equal(rollup.rows.length, 2);
    assert.equal(rollup.truncated, true);
  });
});
