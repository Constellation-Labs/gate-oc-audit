import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import { RetentionService, RETENTION_HEALTH_NAME } from "../../src/services/retention.js";
import type { AuditEventInsert } from "../../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-retention-")), "test.db");
}

function insert(store: AuditStore, overrides: Partial<AuditEventInsert> = {}) {
  return store.append({
    sessionId: "sess-1",
    eventType: "session.start",
    category: "system",
    description: "test",
    metadata: { test: true },
    ...overrides,
  })!;
}

describe("RetentionService", () => {
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

  it("prunes old events on start", async () => {
    for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

    // Backdate all events to 2 years ago
    const db = new DatabaseSync(dbPath);
    const old = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE audit_events SET created_at = @old").run({ old });
    db.close();

    const service = new RetentionService(store, { localRetentionDays: 365 });
    service.start();
    service.stop();

    assert.equal(store.count(), 0);
  });

  it("uses default config when not provided", () => {
    for (let i = 0; i < 3; i++) insert(store);

    const service = new RetentionService(store);
    service.start();
    service.stop();

    // Recent events should not be pruned with default 365 days
    assert.equal(store.count(), 3);
  });

  it("respects custom retention days", async () => {
    for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

    // Backdate to 10 days ago
    const db = new DatabaseSync(dbPath);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE audit_events SET created_at = @old").run({ old });
    db.close();

    const service = new RetentionService(store, { localRetentionDays: 7 });
    service.start();
    service.stop();

    assert.equal(store.count(), 0);
  });

  it("stop is idempotent", () => {
    const service = new RetentionService(store);
    service.start();
    service.stop();
    service.stop(); // should not throw
  });

  describe("nextPruneAt + persistence (R6)", () => {
    it("nextPruneAt is undefined before start", () => {
      const service = new RetentionService(store);
      assert.equal(service.nextPruneAt(), undefined);
    });

    it("nextPruneAt is set after start and reflects an hourly cadence", () => {
      const service = new RetentionService(store);
      const before = Date.now();
      service.start();
      service.stop();
      const next = service.nextPruneAt();
      assert.ok(next, "expected nextPruneAt to be set after start");
      const nextMs = Date.parse(next);
      const delta = nextMs - before;
      // PRUNE_INTERVAL_MS is one hour; allow some slack for test timing.
      assert.ok(delta >= 60 * 60 * 1000 - 1000, `expected ~1h ahead, got ${delta}ms`);
      assert.ok(delta <= 60 * 60 * 1000 + 5000, `expected ~1h ahead, got ${delta}ms`);
    });

    it("persists health to service_health on each prune tick", () => {
      const service = new RetentionService(store);
      service.start();
      service.stop();
      const persisted = store.getServiceHealth(RETENTION_HEALTH_NAME);
      assert.ok(persisted, "service_health row should exist after start");
      const payload = persisted.payload as { nextPruneAt: string };
      assert.equal(payload.nextPruneAt, service.nextPruneAt());
    });
  });
});
