import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import { parseDate } from "../../src/reports/time-window.js";
import { buildProjection } from "../../src/reports/projection.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-proj-")), "test.db");
}

/** Use store.append() so content_gz is populated and the hash chain stays
 *  consistent, then update created_at on the row so we can write tests
 *  against historical / future windows without wall-clock waiting. */
function insertWithContent(
  store: AuditStore,
  dbPath: string,
  params: {
    createdAt: string;
    eventType: string;
    category: string;
    metadata: Record<string, unknown>;
    content?: string;
    sessionId?: string;
  },
): { id: string; sequence: number } {
  const ev = store.append({
    sessionId: params.sessionId ?? "sess-1",
    eventType: params.eventType as any,
    category: params.category as any,
    description: `${params.eventType} event`,
    metadata: params.metadata,
    content: params.content,
  })!;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(params.createdAt, ev.id);
  db.close();
  return { id: ev.id, sequence: ev.sequence };
}

describe("buildProjection: PRD acceptance — duplicate outbound", () => {
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

  it("flags the 20:57Z duplicate-outbound pair from a 50-event window (PRD sample replay)", () => {
    // Pad the window with noise so the dedup detector has to find the pair.
    // Sequence numbers conceptually correspond to PRD events #182..#231.
    for (let i = 182; i <= 231; i++) {
      if (i === 211 || i === 212) continue; // reserved for the duplicate pair
      insertWithContent(store, dbPath, {
        createdAt: `2026-05-18T${String(10 + (i % 10)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        eventType: "tool.invoked",
        category: "tool",
        metadata: { toolName: i % 3 === 0 ? "bash" : "read", args: { i } },
      });
    }
    // The duplicate pair: same content, same channel, same recipient, 30s apart at 20:57Z.
    const a = insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T20:57:00.000Z",
      eventType: "message.sent",
      category: "message",
      metadata: { direction: "out", channel: "slack", recipient: "#ops" },
      content: "Deploy completed successfully",
    });
    const b = insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T20:57:30.000Z",
      eventType: "message.sent",
      category: "message",
      metadata: { direction: "out", channel: "slack", recipient: "#ops" },
      content: "Deploy completed successfully",
    });

    const window = parseDate("2026-05-18", "utc");
    const projection = buildProjection(store, window);

    assert.equal(projection.anomalies.duplicateOutbound.length, 1);
    const finding = projection.anomalies.duplicateOutbound[0];
    assert.equal(finding.channel, "slack");
    assert.equal(finding.recipient, "#ops");
    assert.equal(finding.events.length, 2);
    const seqs = finding.events.map((e) => e.sequence).sort((x, y) => x - y);
    assert.deepEqual(seqs, [a.sequence, b.sequence].sort((x, y) => x - y));
    assert.ok(finding.deltaSeconds === 30);
  });
});

describe("buildProjection: PRD acceptance — first-seen tools", () => {
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

  it("does not flag 'exec' when 30 days of prior exec invocations exist", () => {
    // Seed exec across the trailing 30 days (one per day).
    const today = new Date("2026-05-18T12:00:00.000Z");
    for (let daysAgo = 1; daysAgo <= 30; daysAgo++) {
      const d = new Date(today.getTime() - daysAgo * 86_400_000);
      insertWithContent(store, dbPath, {
        createdAt: d.toISOString(),
        eventType: "tool.invoked",
        category: "tool",
        metadata: { toolName: "exec" },
      });
    }
    // Today: an exec, and a brand-new "git" tool.
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T08:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "exec" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T09:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "git" },
    });

    const window = parseDate("2026-05-18", "utc");
    const projection = buildProjection(store, window);

    assert.ok(!projection.anomalies.firstSeenTools.includes("exec"), "exec should not fire as first-seen");
    assert.ok(projection.anomalies.firstSeenTools.includes("git"), "git should fire as first-seen");
  });
});

describe("buildProjection: aggregations", () => {
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

  it("counts activity by category, top tools, LLM spend, outbound channels", () => {
    const day = "2026-05-18";
    insertWithContent(store, dbPath, {
      createdAt: `${day}T01:00:00.000Z`,
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "bash" },
    });
    insertWithContent(store, dbPath, {
      createdAt: `${day}T02:00:00.000Z`,
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "bash" },
    });
    insertWithContent(store, dbPath, {
      createdAt: `${day}T03:00:00.000Z`,
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "read" },
    });
    insertWithContent(store, dbPath, {
      createdAt: `${day}T04:00:00.000Z`,
      eventType: "prompt.response",
      category: "prompt",
      metadata: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.15,
      },
    });
    insertWithContent(store, dbPath, {
      createdAt: `${day}T05:00:00.000Z`,
      eventType: "prompt.response",
      category: "prompt",
      metadata: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        inputTokens: 2000,
        outputTokens: 600,
        costUsd: 0.25,
      },
    });
    insertWithContent(store, dbPath, {
      createdAt: `${day}T06:00:00.000Z`,
      eventType: "message.sent",
      category: "message",
      metadata: { direction: "out", channel: "slack", recipient: "#ops" },
    });
    insertWithContent(store, dbPath, {
      createdAt: `${day}T07:00:00.000Z`,
      eventType: "cron.executed",
      category: "cron",
      metadata: { jobId: "nightly" },
    });
    insertWithContent(store, dbPath, {
      createdAt: `${day}T08:00:00.000Z`,
      eventType: "cron.failed",
      category: "cron",
      metadata: { jobId: "broken" },
    });

    const window = parseDate(day, "utc");
    const p = buildProjection(store, window);

    assert.equal(p.activity.totalEvents, 8);
    assert.equal(p.topTools[0].toolName, "bash");
    assert.equal(p.topTools[0].invocations, 2);
    assert.equal(p.llmSpend.totalCalls, 2);
    assert.ok(Math.abs(p.llmSpend.totalCostUsd - 0.4) < 1e-9);
    assert.equal(p.llmSpend.byModel[0].model, "claude-opus-4-7");
    assert.equal(p.llmSpend.byModel[0].inputTokens, 3000);
    assert.equal(p.outboundMessaging.totalSent, 1);
    assert.equal(p.outboundMessaging.byChannel[0].channel, "slack");
    assert.equal(p.cron.executed, 1);
    assert.equal(p.cron.failed, 1);
  });

  it("excludes events outside the half-open [from, to) window", () => {
    // Sentinel just before midnight and just at the toIso boundary.
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-17T23:59:59.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "before" },
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T00:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "boundary-start" }, // inclusive lower bound — counted
    });
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-19T00:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "boundary-end" }, // exclusive upper bound — NOT counted
    });

    const window = parseDate("2026-05-18", "utc");
    const p = buildProjection(store, window);
    const names = p.topTools.map((t) => t.toolName);
    assert.ok(names.includes("boundary-start"));
    assert.ok(!names.includes("before"));
    assert.ok(!names.includes("boundary-end"));
  });

  it("populates the integrity footer with the last event and last checkpoint", () => {
    insertWithContent(store, dbPath, {
      createdAt: "2026-05-18T01:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "bash" },
    });
    store.insertCheckpoint("cp-1", 1, 1, "smt-root-1", 1, "de-tx-abc");

    const window = parseDate("2026-05-18", "utc");
    const p = buildProjection(store, window);
    assert.equal(p.integrity.lastSequence, 1);
    assert.ok(p.integrity.lastEventContentHash);
    assert.equal(p.integrity.lastCheckpoint?.checkpointId, "cp-1");
    assert.equal(p.integrity.lastCheckpoint?.deTxHash, "de-tx-abc");
    assert.equal(p.integrity.lastCheckpoint?.smtRoot, "smt-root-1");
  });
});
