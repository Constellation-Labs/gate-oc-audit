import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import { buildSessionProjection } from "../../src/reports/session-projection.js";
import { serializeSessionProjectionJson } from "../../src/reports/format-session.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-session-proj-")), "test.db");
}

function insertEvent(
  store: AuditStore,
  dbPath: string,
  params: {
    sessionId: string;
    createdAt: string;
    eventType: string;
    category: string;
    metadata: Record<string, unknown>;
    content?: string;
    description?: string;
  },
): { id: string; sequence: number } {
  const ev = store.append({
    sessionId: params.sessionId,
    eventType: params.eventType as any,
    category: params.category as any,
    description: params.description ?? `${params.eventType} event`,
    metadata: params.metadata,
    content: params.content,
  })!;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(params.createdAt, ev.id);
  db.close();
  return { id: ev.id, sequence: ev.sequence };
}

/**
 * Seeds a 12-event session matching the PRD R4 timeline shape (one cron run
 * that resolves a model, builds a prompt, calls the LLM, runs a tool, and
 * sends one outbound message). The four content rows (prompt.response,
 * message.sending, message.sent ×2) all share the same body so dedup has
 * to collapse them.
 */
function seedTwelveEventSession(store: AuditStore, dbPath: string, sessionId: string): number[] {
  const t = (s: string) => `2026-05-11T12:57:${s}.000Z`;
  const body = "OpenPoker leaderboard report body";
  const sequences: number[] = [];
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("15.012"), eventType: "prompt.model_resolve", category: "prompt", metadata: { model: "gpt-5.5" } }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("15.018"), eventType: "cron.executed", category: "cron", metadata: { jobId: "2d52249e", promptLength: 612 } }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("15.024"), eventType: "prompt.build", category: "prompt", metadata: { promptLength: 612 } }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("15.041"), eventType: "prompt.input", category: "prompt", metadata: { provider: "openai-codex", model: "gpt-5.5" } }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("19.882"), eventType: "tool.invoked", category: "tool", metadata: { toolName: "exec", args: { cmd: "python openpoker_dag_update.py" } } }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("20.901"), eventType: "tool.result", category: "tool", metadata: { toolName: "exec", durationMs: 1020 } }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("23.412"), eventType: "agent.end", category: "agent", metadata: { success: true, durationMs: 8000 } }).sequence);
  // The four near-duplicate body rows: prompt.response, then message.sending → message.sent.
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("23.418"), eventType: "prompt.response", category: "prompt", metadata: { provider: "openai-codex", model: "gpt-5.5", inputTokens: 3847, outputTokens: 137, costUsd: 0.011 }, content: body }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("23.480"), eventType: "message.sending", category: "message", metadata: { direction: "out", channel: "whatsapp", recipient: "+17733192235" }, content: body }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("23.495"), eventType: "message.sending", category: "message", metadata: { direction: "out", channel: "whatsapp", recipient: "+17733192235" }, content: body }).sequence);
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("23.501"), eventType: "message.sent", category: "message", metadata: { direction: "out", channel: "whatsapp", recipient: "+17733192235", contentLength: 177, success: true }, content: body }).sequence);
  // One trailing session.end to round out to twelve.
  sequences.push(insertEvent(store, dbPath, { sessionId, createdAt: t("23.520"), eventType: "session.end", category: "agent" as any, metadata: { messageCount: 1, durationMs: 8508 } }).sequence);
  return sequences;
}

describe("buildSessionProjection: PRD R4 acceptance — dedup", () => {
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

  it("collapses the four near-duplicate content rows into one timeline entry", () => {
    const sessionId = "session-96be15cb";
    seedTwelveEventSession(store, dbPath, sessionId);

    const p = buildSessionProjection(store, sessionId);

    // 12 raw rows minus 3 collapsed siblings = 9 entries in the deduped timeline.
    assert.equal(p.timeline.length, 9);

    const collapsedEntries = p.timeline.filter((e) => (e.collapsedCount ?? 1) > 1);
    assert.equal(collapsedEntries.length, 1, "exactly one timeline entry should collapse");
    const collapsed = collapsedEntries[0];
    assert.equal(collapsed.collapsedCount, 4);
    assert.equal(collapsed.collapsedSequences?.length, 4);
    // The collapsed entry is anchored on prompt.response (the first of the run).
    assert.equal(collapsed.eventType, "prompt.response");

    // Outbound section still sees one unique body (whatsapp send), reported once.
    assert.equal(p.outboundMessages.length, 1);
    const out = p.outboundMessages[0];
    assert.equal(out.sends.length, 1, "only message.sent rows count as outbound sends");
    assert.equal(out.sends[0].channel, "whatsapp");
    assert.equal(out.sends[0].recipient, "+17733192235");
  });

  it("--raw --limit N matches `audit list --session <id> --limit N` for sessions larger than the limit", () => {
    // Seed 75 events for one session so that `--limit 50` excludes the
    // earliest 25. `audit list --limit 50` shows the last 50 (DESC then
    // reverse → ASC); --raw --limit 50 must show the same window.
    const sessionId = "session-big";
    for (let i = 0; i < 75; i++) {
      insertEvent(store, dbPath, {
        sessionId,
        createdAt: `2026-05-11T12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        eventType: "tool.invoked",
        category: "tool",
        metadata: { toolName: "exec", args: { i } },
      });
    }

    const p = buildSessionProjection(store, sessionId, { raw: true, limit: 50 });
    assert.equal(p.timeline.length, 50);
    assert.equal(p.truncated, true, "session has more events than the limit");

    const listRows = store.query({ sessionId, limit: 50 }).reverse();
    assert.deepEqual(
      p.timeline.map((e) => e.sequence),
      listRows.map((e) => e.sequence),
      "--raw --limit 50 must equal audit list --limit 50 row-for-row",
    );
  });

  it("jobId is hoisted via a dedicated cron.executed lookup even when --limit excludes that row", () => {
    // Sequence: cron.executed first, then 30 noise events. --limit 10
    // selects only the noise tail, so the in-window scan would miss jobId;
    // the dedicated lookup must still surface it.
    const sessionId = "session-cron-out-of-window";
    insertEvent(store, dbPath, {
      sessionId,
      createdAt: "2026-05-11T12:00:00.000Z",
      eventType: "cron.executed",
      category: "cron",
      metadata: { jobId: "anchor-job-id", promptLength: 0 },
    });
    for (let i = 1; i <= 30; i++) {
      insertEvent(store, dbPath, {
        sessionId,
        createdAt: `2026-05-11T12:00:${String(i).padStart(2, "0")}.000Z`,
        eventType: "tool.invoked",
        category: "tool",
        metadata: { toolName: "exec" },
      });
    }

    const p = buildSessionProjection(store, sessionId, { limit: 10 });
    assert.equal(p.timeline.length, 10);
    assert.equal(p.truncated, true);
    assert.equal(p.jobId, "anchor-job-id", "jobId must survive a window that excludes cron.executed");
  });

  it("--raw matches `audit list --session <id> --limit 50` row order and count", () => {
    const sessionId = "session-96be15cb";
    const seededSequences = seedTwelveEventSession(store, dbPath, sessionId);

    const p = buildSessionProjection(store, sessionId, { raw: true });
    // No collapsing in raw mode.
    assert.equal(p.timeline.length, 12);
    for (const entry of p.timeline) {
      assert.equal(entry.collapsedCount, undefined);
    }

    // `audit list --session <id> --limit 50` runs store.query() with default
    // DESC order then reverses the result; the visible order is therefore
    // ASC by sequence. Match that here.
    const listRows = store.query({ sessionId, limit: 50 }).reverse();
    assert.deepEqual(
      p.timeline.map((e) => e.sequence),
      listRows.map((e) => e.sequence),
      "--raw timeline sequence order must equal audit list output order",
    );
    assert.deepEqual(p.timeline.map((e) => e.sequence), seededSequences);
  });
});

describe("buildSessionProjection: cost, tools, outbound aggregations", () => {
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

  it("sums LLM cost across prompt.response rows and tallies tools/outbound", () => {
    const sessionId = "session-cost";
    seedTwelveEventSession(store, dbPath, sessionId);

    const p = buildSessionProjection(store, sessionId);

    // One prompt.response: $0.011, 3847 in / 137 out.
    assert.equal(p.llmCost.totalCalls, 1);
    assert.ok(Math.abs(p.llmCost.totalCostUsd - 0.011) < 1e-9);
    assert.equal(p.llmCost.inputTokens, 3847);
    assert.equal(p.llmCost.outputTokens, 137);
    assert.equal(p.llmCost.byModel.length, 1);
    assert.equal(p.llmCost.byModel[0].model, "gpt-5.5");
    assert.equal(p.llmCost.byModel[0].provider, "openai-codex");

    // exec: 1 invocation + 1 result (1020ms, no error).
    assert.equal(p.toolsUsed.length, 1);
    assert.equal(p.toolsUsed[0].toolName, "exec");
    assert.equal(p.toolsUsed[0].calls, 1);
    assert.equal(p.toolsUsed[0].errors, 0);
    assert.equal(p.toolsUsed[0].totalDurationMs, 1020);

    // Outbound: one distinct body, one send.
    assert.equal(p.outboundMessages.length, 1);
    assert.equal(p.outboundMessages[0].sends.length, 1);

    // jobId is hoisted from the cron.executed row.
    assert.equal(p.jobId, "2d52249e");
  });

  it("groups duplicate outbound sends by identical body", () => {
    const sessionId = "session-dup-send";
    const body = "Deploy completed";
    insertEvent(store, dbPath, {
      sessionId,
      createdAt: "2026-05-11T20:57:00.000Z",
      eventType: "message.sent",
      category: "message",
      metadata: { direction: "out", channel: "slack", recipient: "#ops", contentLength: body.length, success: true },
      content: body,
    });
    insertEvent(store, dbPath, {
      sessionId,
      createdAt: "2026-05-11T20:57:30.000Z",
      eventType: "message.sent",
      category: "message",
      metadata: { direction: "out", channel: "slack", recipient: "#ops", contentLength: body.length, success: true },
      content: body,
    });

    const p = buildSessionProjection(store, sessionId);
    assert.equal(p.outboundMessages.length, 1, "same body collapses into one outbound group");
    assert.equal(p.outboundMessages[0].sends.length, 2, "both physical sends are listed under that group");
  });
});

describe("buildSessionProjection: latency", () => {
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

  it("PRD R4: completes under 1s for a typical (12-event) session", () => {
    const sessionId = "session-perf";
    seedTwelveEventSession(store, dbPath, sessionId);
    const t0 = process.hrtime.bigint();
    buildSessionProjection(store, sessionId);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(elapsedMs < 1000, `expected <1000ms, got ${elapsedMs.toFixed(1)}ms`);
  });
});

describe("serializeSessionProjectionJson: --json metadata gating (Security M1)", () => {
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

  // Shell command lines in tool args are exactly the leak vector Security M1
  // calls out; the test asserts both that the field is structurally absent
  // and that the secret literal doesn't appear anywhere in the JSON.
  function seedSecretArgs(sessionId: string): void {
    insertEvent(store, dbPath, {
      sessionId,
      createdAt: "2026-05-11T12:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "exec", args: { cmd: "python /secret.py --token=hunter2" } },
    });
  }

  it("strips timeline[].metadata by default", () => {
    const sessionId = "sess-strip";
    seedSecretArgs(sessionId);
    const projection = buildSessionProjection(store, sessionId);

    const json = serializeSessionProjectionJson(projection, false);
    const parsed = JSON.parse(json);
    assert.ok(parsed.timeline.length > 0);
    for (const entry of parsed.timeline) {
      assert.equal(entry.metadata, undefined, "metadata must be omitted by default");
    }
    assert.equal(json.includes("hunter2"), false, "secret literal must not appear in default JSON");
  });

  it("preserves timeline[].metadata when includeMetadata=true", () => {
    const sessionId = "sess-include";
    seedSecretArgs(sessionId);
    const projection = buildSessionProjection(store, sessionId);

    const json = serializeSessionProjectionJson(projection, true);
    const parsed = JSON.parse(json);
    assert.equal(parsed.timeline[0].metadata.toolName, "exec");
    assert.equal(parsed.timeline[0].metadata.args.cmd.includes("hunter2"), true);
  });

  it("strips metadata on the deduped (default) timeline too, not just --raw", () => {
    const sessionId = "sess-dedup-strip";
    seedTwelveEventSession(store, dbPath, sessionId);
    const projection = buildSessionProjection(store, sessionId);
    const json = serializeSessionProjectionJson(projection, false);
    const parsed = JSON.parse(json);
    for (const entry of parsed.timeline) {
      assert.equal(entry.metadata, undefined);
    }
    // collapsedCount / collapsedSequences must still be preserved on the
    // deduped entry — the strip only removes `metadata`.
    const collapsed = parsed.timeline.find((e: { collapsedCount?: number }) => (e.collapsedCount ?? 1) > 1);
    assert.ok(collapsed, "deduped entry should still be present after stripping");
    assert.equal(collapsed.collapsedCount, 4);
  });
});

describe("buildSessionProjection: empty / unknown session", () => {
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

  it("returns an empty projection without throwing when session has no events", () => {
    const p = buildSessionProjection(store, "no-such-session");
    assert.equal(p.timeline.length, 0);
    assert.equal(p.toolsUsed.length, 0);
    assert.equal(p.outboundMessages.length, 0);
    assert.equal(p.llmCost.totalCalls, 0);
    assert.equal(p.integrity.eventCount, 0);
    assert.equal(p.startedAt, null);
    assert.equal(p.endedAt, null);
    assert.equal(p.durationMs, null);
  });
});
