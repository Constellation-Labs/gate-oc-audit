import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { AuditStore } from "../../src/store/audit-store.js";
import type { AuditEventInsert } from "../../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-query-")), "test.db");
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

describe("AuditStore.query", () => {
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

  it("returns events in reverse chronological order by default", () => {
    insert(store, { description: "first" });
    insert(store, { description: "second" });
    insert(store, { description: "third" });

    const events = store.query();
    assert.equal(events.length, 3);
    assert.equal(events[0].description, "third");
    assert.equal(events[2].description, "first");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) insert(store, { metadata: { i } });
    const events = store.query({ limit: 3 });
    assert.equal(events.length, 3);
  });

  it("respects offset", () => {
    for (let i = 0; i < 10; i++) insert(store, { description: `e-${i}` });
    const events = store.query({ limit: 2, offset: 2 });
    assert.equal(events.length, 2);
    assert.equal(events[0].description, "e-7"); // offset 2 from desc order
  });

  it("filters by eventType", () => {
    insert(store, { eventType: "session.start" });
    insert(store, { eventType: "tool.invoked", category: "tool" });
    insert(store, { eventType: "session.end" });

    const events = store.query({ eventType: "tool.invoked" });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "tool.invoked");
  });

  it("filters by category", () => {
    insert(store, { category: "system" });
    insert(store, { eventType: "tool.invoked", category: "tool" });
    insert(store, { eventType: "prompt.sent", category: "prompt" });

    const events = store.query({ category: "tool" });
    assert.equal(events.length, 1);
    assert.equal(events[0].category, "tool");
  });

  it("filters by sessionId", () => {
    insert(store, { sessionId: "a" });
    insert(store, { sessionId: "b" });
    insert(store, { sessionId: "a" });

    const events = store.query({ sessionId: "a" });
    assert.equal(events.length, 2);
  });

  it("combines multiple filters", () => {
    insert(store, { sessionId: "a", eventType: "session.start", category: "system" });
    insert(store, { sessionId: "a", eventType: "tool.invoked", category: "tool" });
    insert(store, { sessionId: "b", eventType: "tool.invoked", category: "tool" });

    const events = store.query({ sessionId: "a", category: "tool" });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "tool.invoked");
    assert.equal(events[0].sessionId, "a");
  });

  it("returns empty array when no matches", () => {
    insert(store);
    const events = store.query({ eventType: "cron.executed" });
    assert.equal(events.length, 0);
  });

  it("parses metadata back to object", () => {
    insert(store, { metadata: { key: "value", nested: { a: 1 } } });
    const events = store.query();
    assert.deepEqual(events[0].metadata, { key: "value", nested: { a: 1 } });
  });
});

describe("AuditStore.count", () => {
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

  it("returns 0 for empty store", () => {
    assert.equal(store.count(), 0);
  });

  it("returns correct count", () => {
    for (let i = 0; i < 5; i++) insert(store);
    assert.equal(store.count(), 5);
  });
});

describe("AuditStore.verify", () => {
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

  it("returns valid for empty store", () => {
    const result = store.verify();
    assert.equal(result.valid, true);
    assert.equal(result.eventsChecked, 0);
  });

  it("returns valid for intact chain", () => {
    for (let i = 0; i < 10; i++) insert(store, { metadata: { i } });
    const result = store.verify();
    assert.equal(result.valid, true);
    assert.equal(result.eventsChecked, 10);
  });

  it("detects tampered content_hash", () => {
    for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

    // Tamper with the 3rd event's metadata directly in the DB
    const db = new Database(dbPath);
    db.prepare(
      "UPDATE audit_events SET metadata = '{\"tampered\":true}' WHERE sequence = 3",
    ).run();
    db.close();

    const result = store.verify();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 3);
  });

  it("detects broken chain link", () => {
    for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

    const db = new Database(dbPath);
    db.prepare(
      "UPDATE audit_events SET previous_hash = 'tampered', content_hash = 'tampered' WHERE sequence = 3",
    ).run();
    db.close();

    const result = store.verify();
    assert.equal(result.valid, false);
    assert.ok(result.brokenAt! <= 3);
  });
});

describe("AuditStore.prune", () => {
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

  it("deletes events older than maxAgeDays", () => {
    for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

    // Backdate the first 3 events to 2 years ago
    const db = new Database(dbPath);
    const old = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE audit_events SET created_at = @old WHERE sequence <= 3").run({ old });
    db.close();

    const deleted = store.prune(365, 500);
    assert.equal(deleted, 3);
    assert.equal(store.count(), 2);
  });

  it("does not delete recent events", () => {
    for (let i = 0; i < 5; i++) insert(store);
    const deleted = store.prune(365, 500);
    assert.equal(deleted, 0);
    assert.equal(store.count(), 5);
  });

  it("returns 0 for empty store", () => {
    const deleted = store.prune(365, 500);
    assert.equal(deleted, 0);
  });
});
