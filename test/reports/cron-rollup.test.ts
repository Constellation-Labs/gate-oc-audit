import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import { buildCronRollup, formatCronRollupHtml } from "../../src/reports/cron-rollup.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-cron-rollup-")), "test.db");
}

/** Mirror of the helper in projection.test.ts — uses store.append() so the
 *  hash chain stays consistent, then back-dates created_at so we can write
 *  deterministic time-ordering assertions. */
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

describe("buildCronRollup", () => {
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

  it("returns an empty rollup when there are no cron events for the jobId", () => {
    const r = buildCronRollup(store, "missing-job");
    assert.equal(r.schemaVersion, 1);
    assert.equal(r.jobId, "missing-job");
    assert.equal(r.rows.length, 0);
    assert.equal(r.truncated, false);
  });

  it("filters by jobId — only rows for the requested job appear", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-a",
      metadata: { jobId: "nightly", runId: "run-a" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:05:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-b",
      metadata: { jobId: "hourly", runId: "run-b" },
    });

    const r = buildCronRollup(store, "nightly");
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].runId, "run-a");
    assert.equal(r.rows[0].sessionId, "sess-a");
    assert.equal(r.rows[0].startedAt, "2026-05-18T07:00:00.000Z");
  });

  it("orders rows newest-first by sequence", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-2",
      metadata: { jobId: "j", runId: "run-2" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T09:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-3",
      metadata: { jobId: "j", runId: "run-3" },
    });

    const r = buildCronRollup(store, "j");
    assert.equal(r.rows.length, 3);
    assert.deepEqual(r.rows.map((row) => row.runId), ["run-3", "run-2", "run-1"]);
  });

  it("--last caps rows and surfaces truncated=true when more exist", () => {
    for (let i = 0; i < 5; i++) {
      insertWithContent(store, dbPath, {
        createdAt: `2026-05-18T${String(7 + i).padStart(2, "0")}:00:00.000Z`,
        eventType: "cron.executed",
        category: "cron",
        sessionId: `sess-${i}`,
        metadata: { jobId: "j", runId: `run-${i}` },
      });
    }
    const r = buildCronRollup(store, "j", { last: 2 });
    assert.equal(r.rows.length, 2);
    assert.equal(r.truncated, true);
    assert.deepEqual(r.rows.map((row) => row.runId), ["run-4", "run-3"]);
  });

  it("truncated=false when last >= total executions", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });
    const r = buildCronRollup(store, "j", { last: 10 });
    assert.equal(r.rows.length, 1);
    assert.equal(r.truncated, false);
  });

  it("pairs cron.executed with agent.end (success) and reports status=ok", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:05.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-1", success: true, durationMs: 5000 },
    });

    const r = buildCronRollup(store, "j");
    assert.equal(r.rows[0].status, "ok");
    assert.equal(r.rows[0].endedAt, "2026-05-18T07:00:05.000Z");
    assert.equal(r.rows[0].durationMs, 5000);
    assert.equal(r.rows[0].error, null);
  });

  it("pairs cron.executed with agent.end (failure) and reports status=failed with error", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:03.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-1", success: false, durationMs: 3000, error: "boom" },
    });

    const r = buildCronRollup(store, "j");
    assert.equal(r.rows[0].status, "failed");
    assert.equal(r.rows[0].error, "boom");
    assert.equal(r.rows[0].durationMs, 3000);
  });

  it("status=incomplete when no agent.end exists for the run", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });

    const r = buildCronRollup(store, "j");
    assert.equal(r.rows[0].status, "incomplete");
    assert.equal(r.rows[0].endedAt, null);
    assert.equal(r.rows[0].durationMs, null);
    assert.equal(r.rows[0].events.toolInvocations, 0);
    assert.equal(r.rows[0].events.llmCalls, 0);
    assert.equal(r.rows[0].events.messagesSent, 0);
  });

  it("counts tool.invoked / prompt.response / message.sent within the run's session window", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });
    // 2 tools, 1 llm call, 1 message during the run
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:01.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-1",
      metadata: { toolName: "bash" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:02.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-1",
      metadata: { toolName: "read" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:03.000Z",
      eventType: "prompt.response",
      category: "prompt",
      sessionId: "sess-1",
      metadata: { model: "claude-opus-4-7" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:04.000Z",
      eventType: "message.sent",
      category: "message",
      sessionId: "sess-1",
      metadata: { direction: "out", channel: "slack", recipient: "#ops" },
    });
    // Tool fired AFTER agent.end — must not be attributed to this run.
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:10.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-1",
      metadata: { toolName: "after-end" },
    });
    // Tool on a different session — must not be attributed.
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:02.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-other",
      metadata: { toolName: "other-session" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:05.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-1", success: true, durationMs: 5000 },
    });

    const r = buildCronRollup(store, "j");
    assert.equal(r.rows[0].events.toolInvocations, 2);
    assert.equal(r.rows[0].events.llmCalls, 1);
    assert.equal(r.rows[0].events.messagesSent, 1);
  });

  it("activity counters isolate sequential runs that share a sessionId", () => {
    // run-1 on sess-1: 2 tools, then agent.end
    // run-2 on the SAME sess-1: 1 tool, 1 message, then agent.end
    // The counters for each row must reflect only that run's window.
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:01.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-1",
      metadata: { toolName: "bash" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:02.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-1",
      metadata: { toolName: "read" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:05.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-1", success: true, durationMs: 5000 },
    });
    // Gap (no activity between runs) — these events must not be attributed
    // to either run.
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:30:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-1",
      metadata: { toolName: "between-runs" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-2" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:01.000Z",
      eventType: "tool.invoked",
      category: "tool",
      sessionId: "sess-1",
      metadata: { toolName: "ls" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:02.000Z",
      eventType: "message.sent",
      category: "message",
      sessionId: "sess-1",
      metadata: { direction: "out", channel: "slack", recipient: "#ops" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:05.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-2", success: true, durationMs: 5000 },
    });

    const r = buildCronRollup(store, "j");
    assert.equal(r.rows.length, 2);
    // Newest first
    assert.equal(r.rows[0].runId, "run-2");
    assert.equal(r.rows[0].events.toolInvocations, 1);
    assert.equal(r.rows[0].events.messagesSent, 1);
    assert.equal(r.rows[0].events.llmCalls, 0);
    assert.equal(r.rows[1].runId, "run-1");
    assert.equal(r.rows[1].events.toolInvocations, 2);
    assert.equal(r.rows[1].events.messagesSent, 0);
    assert.equal(r.rows[1].events.llmCalls, 0);
  });

  it("--last 1 returns exactly one row and surfaces truncation when more exist", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-a",
      metadata: { jobId: "j", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-b",
      metadata: { jobId: "j", runId: "run-2" },
    });

    const r = buildCronRollup(store, "j", { last: 1 });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].runId, "run-2");
    assert.equal(r.truncated, true);
  });

  it("formatCronRollupHtml produces a self-contained document and HTML-escapes job/run/error strings", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "evil<job>", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:03.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-1", success: false, durationMs: 3000, error: "<script>alert(1)</script>" },
    });

    const r = buildCronRollup(store, "evil<job>");
    const html = formatCronRollupHtml(r);

    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("<title>Per-cron rollup"));
    assert.ok(html.includes("</html>"));
    // jobId and error must be escaped — no raw < or > from user data should
    // leak into the rendered body.
    assert.ok(html.includes("evil&lt;job&gt;"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<script>alert(1)</script>"));
    // The status column is styled per status — failed run should carry the
    // status-failed class.
    assert.ok(html.includes("status-failed"));
  });

  it("formatCronRollupHtml surfaces the truncation banner when more rows exist", () => {
    for (let i = 0; i < 3; i++) {
      insertWithContent(store, dbPath, {
        createdAt: `2026-05-18T${String(7 + i).padStart(2, "0")}:00:00.000Z`,
        eventType: "cron.executed",
        category: "cron",
        sessionId: `sess-${i}`,
        metadata: { jobId: "j", runId: `run-${i}` },
      });
    }
    const r = buildCronRollup(store, "j", { last: 1 });
    const html = formatCronRollupHtml(r);
    assert.ok(html.includes("More executions exist beyond"));
    assert.ok(html.includes("truncated"));
  });

  it("formatCronRollupHtml renders an empty-state message when no executions match", () => {
    const r = buildCronRollup(store, "missing");
    const html = formatCronRollupHtml(r);
    assert.ok(html.includes("No executions recorded"));
    // No table should be rendered in the empty case.
    assert.ok(!html.includes("<tbody>"));
  });

  it("does not confuse agent.end events from a sibling run on the same session", () => {
    // Two cron executions on the same session (unusual, but possible if a
    // session is long-lived). Each run's agent.end must pair only with its
    // own runId.
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-1" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T07:00:05.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-1", success: true, durationMs: 5000 },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      sessionId: "sess-1",
      metadata: { jobId: "j", runId: "run-2" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:09.000Z",
      eventType: "agent.end",
      category: "agent",
      sessionId: "sess-1",
      metadata: { runId: "run-2", success: false, durationMs: 9000, error: "second run failed" },
    });

    const r = buildCronRollup(store, "j");
    assert.equal(r.rows.length, 2);
    // Newest first
    assert.equal(r.rows[0].runId, "run-2");
    assert.equal(r.rows[0].status, "failed");
    assert.equal(r.rows[0].error, "second run failed");
    assert.equal(r.rows[1].runId, "run-1");
    assert.equal(r.rows[1].status, "ok");
    assert.equal(r.rows[1].error, null);
  });
});
