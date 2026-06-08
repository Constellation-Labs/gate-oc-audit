import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import { SmtService } from "../../src/services/smt-service.js";
import { buildAnomalyView } from "../../src/reports/anomalies-view.js";
import { formatAnomalyViewHtml } from "../../src/reports/format-anomalies-html.js";
import { formatAnomalyViewText } from "../../src/reports/format-anomalies-text.js";
import { parseSince } from "../../src/reports/time-window.js";
import { ANCHOR_NOT_FOUND_HEALTH_NAME } from "../../src/services/health-keys.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-anom-")), "test.db");
}

function makeSmtService(): SmtService {
  return new SmtService({
    smt: {
      checkpointIntervalMs: 0,
      pruneAfterEpochs: 0,
      checkpointDir: `/tmp/smt-anom-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

function insertAt(
  store: AuditStore,
  dbPath: string,
  params: {
    createdAt: string;
    eventType: string;
    category: string;
    metadata: Record<string, unknown>;
    content?: string;
  },
): { id: string; sequence: number } {
  const ev = store.append({
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

describe("buildAnomalyView orchestrator", () => {
  let dbPath: string;
  let store: AuditStore;
  let smt: SmtService;

  beforeEach(async () => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    smt = makeSmtService();
    await smt.start();
  });

  afterEach(async () => {
    await smt.stop();
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("surfaces an SMT-empty note instead of silently skipping the tamper scan", () => {
    insertAt(store, dbPath, {
      createdAt: "2026-05-18T12:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "exec" },
    });
    const window = parseSince(
      "2026-05-18T00:00:00.000Z",
      "2026-05-19T00:00:00.000Z",
      "utc",
      new Date("2026-05-19T00:00:00.000Z"),
    );
    const view = buildAnomalyView(store, smt, window);
    assert.equal(view.anomalies.integrityViolations.note !== null, true);
    assert.match(view.anomalies.integrityViolations.note!, /SMT/i);
    assert.equal(view.anomalies.integrityViolations.tamperedEvents.length, 0);
  });

  it("splits unverified checkpoints into not-found-on-DE (violation) vs pending (normal)", () => {
    // Two anchored-but-unverified checkpoints. Only the one recorded in the
    // persisted not-found set (a confirmed 404) is a violation; the other is
    // merely awaiting DE confirmation and must NOT read as an anomaly.
    const inWindow = "2026-05-18T12:00:00.000Z";
    store.insertCheckpoint("cp-notfound", 1, 10, "a".repeat(64), 10, "detx-missing");
    store.insertCheckpoint("cp-pending", 11, 20, "b".repeat(64), 10, "detx-pending");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE integrity_checkpoints SET created_at = ? WHERE id IN ('cp-notfound', 'cp-pending')").run(inWindow);
    db.close();
    store.upsertServiceHealth(ANCHOR_NOT_FOUND_HEALTH_NAME, ["cp-notfound"]);

    const window = parseSince(
      "2026-05-18T00:00:00.000Z",
      "2026-05-19T00:00:00.000Z",
      "utc",
      new Date("2026-05-19T00:00:00.000Z"),
    );
    const iv = buildAnomalyView(store, smt, window).anomalies.integrityViolations;
    assert.deepEqual(iv.notFoundOnDe.map((c) => c.checkpointId), ["cp-notfound"]);
    assert.deepEqual(iv.pendingVerification.map((c) => c.checkpointId), ["cp-pending"]);
  });

  it("does not report a pending-only window as an anomaly (text formatter)", () => {
    // A checkpoint anchored and awaiting DE confirmation is normal. With no
    // tampering, no 404s, and no scan note, the report must read clean — this
    // is the whole point of the pending/not-found split. Built directly so the
    // SMT-empty note can't confound the assertion.
    const pendingCp = {
      checkpointId: "cp-pending",
      sequenceStart: 1,
      sequenceEnd: 10,
      smtRoot: "b".repeat(64),
      deTxHash: "detx-pending",
      createdAt: "2026-05-18T12:00:00.000Z",
    };
    const view = {
      schemaVersion: 1 as const,
      generatedAt: "2026-05-19T00:00:00.000Z",
      period: parseSince("2026-05-18T00:00:00.000Z", "2026-05-19T00:00:00.000Z", "utc", new Date("2026-05-19T00:00:00.000Z")),
      detectorConfig: { dupWindowSec: 60, lookbackDays: 30, denialWindowSec: 300, denialThreshold: 5 },
      counts: { totalEventsInWindow: 0, capped: false },
      anomalies: {
        duplicateOutbound: [],
        firstSeenTools: [],
        denialSpikes: [],
        installEvents: [],
        integrityViolations: {
          notFoundOnDe: [],
          pendingVerification: [pendingCp],
          tamperedEvents: [],
          note: null,
        },
      },
    };
    assert.match(formatAnomalyViewText(view), /No anomalies detected\./);
  });

  it("excludes invocations whose metadata.toolName is missing from first-seen", () => {
    // The aggregation SQL filters json_extract(metadata, '$.toolName') IS NOT
    // NULL to avoid bogus "<unknown>" first-seen findings. Lock that in.
    insertAt(store, dbPath, {
      createdAt: "2026-05-18T01:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { /* no toolName */ },
    });
    insertAt(store, dbPath, {
      createdAt: "2026-05-18T02:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "exec" },
    });
    const window = parseSince(
      "2026-05-18T00:00:00.000Z",
      "2026-05-19T00:00:00.000Z",
      "utc",
      new Date("2026-05-19T00:00:00.000Z"),
    );
    const view = buildAnomalyView(store, smt, window);
    assert.deepEqual(view.anomalies.firstSeenTools, ["exec"]);
  });

  it("HTML output escapes script tags in metadata-derived fields", () => {
    // Seed a tool.denied with a malicious toolName + reason, plus a system.install
    // with HTML in the targetName/version. None of these strings should appear
    // raw in the rendered HTML — they must all be entity-escaped.
    for (let i = 0; i < 5; i++) {
      insertAt(store, dbPath, {
        createdAt: `2026-05-18T12:00:0${i}.000Z`,
        eventType: "tool.denied",
        category: "tool",
        metadata: {
          toolName: '<script>alert("xss")</script>',
          reason: "<img onerror=alert(1)>",
        },
      });
    }
    insertAt(store, dbPath, {
      createdAt: "2026-05-18T13:00:00.000Z",
      eventType: "system.install",
      category: "system",
      metadata: {
        targetType: "plugin",
        targetName: "<b>evil</b>",
        version: "1.0.0<script>",
        scanStatus: "critical",
        scanCritical: 1,
      },
    });

    const window = parseSince(
      "2026-05-18T00:00:00.000Z",
      "2026-05-19T00:00:00.000Z",
      "utc",
      new Date("2026-05-19T00:00:00.000Z"),
    );
    const view = buildAnomalyView(store, smt, window, { denialThreshold: 3, denialWindowSec: 60 });
    const html = formatAnomalyViewHtml(view);

    assert.equal(html.includes("<script>alert"), false);
    assert.equal(html.includes("<img onerror"), false);
    assert.equal(html.includes("<b>evil</b>"), false);
    assert.equal(html.includes("1.0.0<script>"), false);
    assert.ok(html.includes("&lt;script&gt;alert"));
    assert.ok(html.includes("&lt;img onerror"));
    assert.ok(html.includes("&lt;b&gt;evil&lt;/b&gt;"));
  });

  it("filters tool.invoked events past the window's toIso (half-open boundary)", () => {
    // Seed an event at exactly the toIso boundary; it must NOT be counted.
    insertAt(store, dbPath, {
      createdAt: "2026-05-18T12:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "in-window" },
    });
    insertAt(store, dbPath, {
      createdAt: "2026-05-19T00:00:00.000Z",
      eventType: "tool.invoked",
      category: "tool",
      metadata: { toolName: "at-boundary" },
    });
    const window = parseSince(
      "2026-05-18T00:00:00.000Z",
      "2026-05-19T00:00:00.000Z",
      "utc",
      new Date("2026-05-19T00:00:00.000Z"),
    );
    const view = buildAnomalyView(store, smt, window);
    // Only the in-window event counts toward the totals. The boundary event
    // attributes to the next window.
    assert.equal(view.counts.totalEventsInWindow, 1);
  });
});
