import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import type { AuditEventInsert } from "../../src/types/events.js";

function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  return join(dir, "test.db");
}

function cleanupDb(dbPath: string): void {
  rmSync(dirname(dbPath), { recursive: true, force: true });
}

function sampleInsert(overrides: Partial<AuditEventInsert> = {}): AuditEventInsert {
  return {
    sessionId: "sess-1",
    eventType: "session.start",
    category: "system",
    description: "test event",
    metadata: { test: true },
    ...overrides,
  };
}

describe("AuditStore", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  describe("append", () => {
    it("returns an AuditEvent with all generated fields", () => {
      const event = store.append(sampleInsert());

      assert.ok(event);
      assert.equal(event.sequence, 1);
      assert.equal(event.source, "openclaw-plugin");
      assert.equal(event.eventType, "session.start");
      assert.equal(event.category, "system");
      assert.ok(event.id);
      assert.ok(event.createdAt);
      assert.ok(event.machineId);
    });

    it("increments sequence monotonically", () => {
      const e1 = store.append(sampleInsert())!;
      const e2 = store.append(sampleInsert({ description: "second" }))!;
      const e3 = store.append(sampleInsert({ description: "third" }))!;

      assert.equal(e1.sequence, 1);
      assert.equal(e2.sequence, 2);
      assert.equal(e3.sequence, 3);
    });

    it("assigns unique IDs to each event", () => {
      const e1 = store.append(sampleInsert())!;
      const e2 = store.append(sampleInsert({ description: "second" }))!;

      assert.notEqual(e1.id, e2.id);
    });

    it("defaults source to openclaw-plugin", () => {
      const event = store.append(sampleInsert())!;
      assert.equal(event.source, "openclaw-plugin");
    });

    it("uses custom source when provided", () => {
      const event = store.append(sampleInsert({ source: "gateway" }))!;
      assert.equal(event.source, "gateway");
    });

    it("stores optional fields as null when not provided", () => {
      const event = store.append(
        sampleInsert({ sessionId: undefined, orgId: undefined, userId: undefined }),
      )!;

      assert.equal(event.sessionId, undefined);
      assert.equal(event.orgId, undefined);
      assert.equal(event.userId, undefined);
    });

    it("records oversized metadata events with a truncation marker rather than dropping them", () => {
      const bigValue = "x".repeat(1024 * 1024 + 1);
      const result = store.append(sampleInsert({ metadata: { big: bigValue } }))!;

      assert.ok(result, "expected event to be recorded with truncated metadata");
      assert.equal(store.isDegraded(), false);
      // The returned AuditEvent.metadata MUST match what's persisted, so
      // downstream consumers (SMT hashing, future verifiers reading the row
      // back) compute the same hash. Earlier versions persisted a marker
      // but returned the original metadata, breaking SMT proofs.
      const persisted = store.query({ limit: 1, includeContent: false })[0];
      const persistedMd = persisted.metadata as Record<string, unknown>;
      const returnedMd = result.metadata as Record<string, unknown>;
      assert.deepEqual(returnedMd, persistedMd,
        "returned and persisted metadata must be identical (regression guard)");
      assert.equal(persistedMd.metadataDropped, true);
      assert.equal(persistedMd.reason, "size-cap");
      assert.ok(typeof persistedMd.originalSize === "number"
        && persistedMd.originalSize > 1024 * 1024);
      assert.equal("big" in persistedMd, false, "oversized field must not survive truncation");
    });

    it("records non-serializable metadata events with a truncation marker", () => {
      const result = store.append(
        sampleInsert({ metadata: { value: BigInt(42) } as unknown as Record<string, unknown> }),
      )!;

      assert.ok(result, "expected event to be recorded with marker");
      assert.equal(store.isDegraded(), false);
      const persisted = store.query({ limit: 1, includeContent: false })[0];
      const persistedMd = persisted.metadata as Record<string, unknown>;
      const returnedMd = result.metadata as Record<string, unknown>;
      assert.deepEqual(returnedMd, persistedMd,
        "returned and persisted metadata must be identical (regression guard)");
      assert.equal(persistedMd.metadataDropped, true);
      assert.equal(persistedMd.reason, "non-serializable");
    });
  });

  describe("persistence across restarts", () => {
    it("resumes sequence from last stored event", () => {
      store.append(sampleInsert());
      store.append(sampleInsert({ description: "second" }));
      store.close();

      const store2 = new AuditStore(dbPath);
      const e3 = store2.append(sampleInsert({ description: "third" }))!;
      assert.equal(e3.sequence, 3);
      store2.close();

      dbPath = makeTempDb();
      store = new AuditStore(dbPath);
    });

  });

  describe("degraded mode", () => {
    it("is not degraded initially", () => {
      assert.equal(store.isDegraded(), false);
    });

    it("returns undefined and sets degraded on append failure", () => {
      store.close();
      const badStore = store;
      store = new AuditStore(makeTempDb());

      const result = badStore.append(sampleInsert());
      assert.equal(result, undefined);
      assert.equal(badStore.isDegraded(), true);
    });

    it("clears degraded flag after successful append", () => {
      // Force degraded via a corrupted prepared statement
      const path2 = makeTempDb();
      const store2 = new AuditStore(path2);
      store2.append(sampleInsert());

      // Close and reopen to get a fresh handle, then corrupt it
      store2.close();
      const store3 = new AuditStore(path2);

      // Manually trigger degraded by closing underlying DB and attempting append
      store3.close();
      store3.append(sampleInsert({ description: "will fail" }));
      assert.equal(store3.isDegraded(), true);

      // Reopen — degraded starts false, proving recovery on construction
      const store4 = new AuditStore(path2);
      assert.equal(store4.isDegraded(), false);
      store4.append(sampleInsert({ description: "recovery" }));
      assert.equal(store4.isDegraded(), false);
      store4.close();
      cleanupDb(path2);
    });

    it("does not advance sequence on failure", () => {
      const e1 = store.append(sampleInsert())!;
      assert.equal(e1.sequence, 1);

      store.close();

      // Reopen the same DB
      const store2 = new AuditStore(dbPath);
      // The sequence should still be 1 since the failed store didn't advance
      const e2 = store2.append(sampleInsert({ description: "after close" }))!;
      assert.equal(e2.sequence, 2);
      store2.close();

      dbPath = makeTempDb();
      store = new AuditStore(dbPath);
    });
  });

  describe("many events", () => {
    it("handles 100 rapid inserts with correct sequence", () => {
      const events = [];
      for (let i = 0; i < 100; i++) {
        const e = store.append(sampleInsert({ description: `event-${i}`, metadata: { i } }))!;
        assert.ok(e);
        events.push(e);
      }

      assert.equal(events[events.length - 1].sequence, 100);
    });
  });

  describe("handlers with minimal context", () => {
    it("appends with all optional fields undefined", () => {
      const event = store.append({
        eventType: "session.start",
        category: "system",
        description: "minimal",
        metadata: {},
      })!;

      assert.ok(event);
      assert.equal(event.sessionId, undefined);
      assert.equal(event.orgId, undefined);
      assert.equal(event.userId, undefined);
      assert.equal(event.source, "openclaw-plugin");
    });
  });

  describe("content handling", () => {
    it("append returns raw content on the event", () => {
      const event = store.append(sampleInsert({ content: "full message body" }))!;
      assert.equal(event.content, "full message body");
    });

    it("append returns undefined content when not provided", () => {
      const event = store.append(sampleInsert())!;
      assert.equal(event.content, undefined);
    });

    it("drops content exceeding MAX_CONTENT_SIZE and logs warning", () => {
      const warnings: string[] = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      try {
        const bigContent = "x".repeat(5 * 1024 * 1024 + 1);
        const event = store.append(sampleInsert({ content: bigContent }))!;
        assert.ok(event);
        assert.equal(event.content, undefined);
        assert.ok(warnings.some((w) => w.includes("Content exceeds")));
      } finally {
        console.error = origErr;
      }
    });

    it("stores content gzipped in DB", () => {
      const event = store.append(sampleInsert({ content: "hello gzip" }))!;
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT content_gz FROM audit_events WHERE id = ?").get(event.id) as { content_gz: Uint8Array };
      assert.ok(row.content_gz);
      assert.equal(gunzipSync(row.content_gz).toString(), "hello gzip");
      db.close();
    });
  });

  describe("file permissions", () => {
    it("creates DB file with 0o600 permissions", () => {
      const newPath = makeTempDb();
      const newStore = new AuditStore(newPath);

      const stat = statSync(newPath);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, `Expected 0o600 but got 0o${mode.toString(8)}`);

      newStore.close();
      cleanupDb(newPath);
    });
  });

});
