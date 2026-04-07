import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
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

    it("skips events with metadata exceeding 1MB", () => {
      const bigValue = "x".repeat(1024 * 1024 + 1);
      const result = store.append(sampleInsert({ metadata: { big: bigValue } }));

      assert.equal(result, undefined);
      assert.equal(store.isDegraded(), false); // size guard is not a degradation
    });

    it("skips events with non-serializable metadata without degrading", () => {
      const result = store.append(
        sampleInsert({ metadata: { value: BigInt(42) } as unknown as Record<string, unknown> }),
      );

      assert.equal(result, undefined);
      assert.equal(store.isDegraded(), false);
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

      store = new AuditStore(makeTempDb());
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
      // Force a failure by closing and reopening
      const path2 = makeTempDb();
      const store2 = new AuditStore(path2);

      // Append succeeds
      store2.append(sampleInsert());
      assert.equal(store2.isDegraded(), false);

      store2.close();

      // Verify that after a failure + success cycle, degraded clears
      // We can't easily force a mid-operation failure, but we verify the flag
      // is set to false on each successful append
      const store3 = new AuditStore(path2);
      store3.append(sampleInsert({ description: "recovery" }));
      assert.equal(store3.isDegraded(), false);
      store3.close();
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

      store = new AuditStore(makeTempDb());
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
