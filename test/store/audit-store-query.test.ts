import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
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
    insert(store, { eventType: "prompt.input", category: "prompt" });

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
    const events = store.query({ eventType: "gateway.stop" });
    assert.equal(events.length, 0);
  });

  it("parses metadata back to object", () => {
    insert(store, { metadata: { key: "value", nested: { a: 1 } } });
    const events = store.query();
    assert.deepEqual(events[0].metadata, { key: "value", nested: { a: 1 } });
  });
});

describe("AuditStore.query content options", () => {
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

  it("does not return content by default", () => {
    insert(store, { content: "full message" });
    const events = store.query();
    assert.equal(events[0].content, undefined);
  });

  it("returns full content with includeContent", () => {
    insert(store, { content: "full message" });
    const events = store.query({ includeContent: true });
    assert.equal(events[0].content, "full message");
  });

  it("returns truncated content with contentPreview", () => {
    const longContent = "a".repeat(5000);
    insert(store, { content: longContent });
    const events = store.query({ contentPreview: 100 });
    assert.ok(events[0].content);
    assert.ok(events[0].content!.length <= 100);
    assert.equal(events[0].content, "a".repeat(100));
  });

  it("includeContent takes precedence over contentPreview", () => {
    const longContent = "b".repeat(2000);
    insert(store, { content: longContent });
    const events = store.query({ includeContent: true, contentPreview: 100 });
    assert.equal(events[0].content, longContent);
  });

  it("contentPreview handles small content shorter than limit", () => {
    insert(store, { content: "tiny" });
    const events = store.query({ contentPreview: 500 });
    assert.equal(events[0].content, "tiny");
  });

  it("contentPreview handles unicode content", () => {
    const cjk = "こんにちは世界".repeat(100);
    insert(store, { content: cjk });
    const events = store.query({ contentPreview: 50 });
    assert.ok(events[0].content);
    assert.ok(events[0].content!.length <= 50);
    assert.equal(events[0].content, cjk.slice(0, 50));
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

  it("archives checkpoints whose events were pruned", () => {
    for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

    // Add a checkpoint covering sequences 1-3
    store.insertCheckpoint("cp-1", 1, 3, "root-abc", 3, null);
    // Add a checkpoint covering sequences 4-5
    store.insertCheckpoint("cp-2", 4, 5, "root-def", 2, null);

    // Backdate events 1-3 so they get pruned
    const db = new Database(dbPath);
    const old = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE audit_events SET created_at = @old WHERE sequence <= 3").run({ old });
    db.close();

    store.prune(365, 500);

    // cp-1 should be archived (sequence_end 3 < min remaining sequence 4)
    const remaining = store.getCheckpoints();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "cp-2");

    // cp-1 should be in the archive table
    const db2 = new Database(dbPath);
    const archived = db2.prepare("SELECT id FROM checkpoint_archive").all() as { id: string }[];
    assert.equal(archived.length, 1);
    assert.equal(archived[0].id, "cp-1");
    db2.close();
  });

  it("deletes both synced and unsynced old events", () => {
    for (let i = 0; i < 4; i++) insert(store, { metadata: { i } });

    // Backdate all events and mark some as synced
    const db = new Database(dbPath);
    const old = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE audit_events SET created_at = @old").run({ old });
    db.prepare("UPDATE audit_events SET synced_at = @old WHERE sequence <= 2").run({ old });
    db.close();

    // All 4 are old — synced and unsynced both get pruned
    const deleted = store.prune(365, 500);
    assert.equal(deleted, 4);
    assert.equal(store.count(), 0);
  });
});

describe("AuditStore.openOrRecover", () => {
  it("recovers from a corrupt database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-recover-"));
    const corruptPath = join(dir, "test.db");

    // Write garbage to simulate corruption
    writeFileSync(corruptPath, "this is not a valid sqlite database");

    const recovered = new AuditStore(corruptPath);

    // Should have created a fresh working database
    const event = insert(recovered);
    assert.ok(event);
    assert.equal(event.sequence, 1);

    // Corrupt file should be preserved with .corrupt. suffix
    const files = readdirSync(dir);
    assert.ok(
      files.some((f) => f.includes(".corrupt.")),
      `Expected a .corrupt backup file, found: ${files.join(", ")}`,
    );

    recovered.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
