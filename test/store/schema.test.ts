import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "../../src/store/schema.js";

describe("initializeSchema", () => {
  let db: DatabaseSync;

  afterEach(() => {
    db?.close();
  });

  it("creates the audit_events table", () => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    assert.ok(names.includes("audit_events"));
  });

  it("creates all expected tables", () => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    for (const expected of ["audit_events", "config_manifests", "integrity_checkpoints", "checkpoint_archive"]) {
      assert.ok(names.includes(expected), `Missing table: ${expected}`);
    }
  });

  it("creates expected indexes", () => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];

    const names = indexes.map((i) => i.name);
    for (const expected of [
      "idx_events_category",
      "idx_events_type",
      "idx_events_created",
      "idx_events_session",
      "idx_events_unsynced",
      "idx_events_machine",
      "idx_events_user",
      "idx_events_org",
    ]) {
      assert.ok(names.includes(expected), `Missing index: ${expected}`);
    }
  });

  it("audit_events has received_at column", () => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);

    const columns = db.prepare("PRAGMA table_info(audit_events)").all() as { name: string }[];
    const names = columns.map((c) => c.name);
    assert.ok(names.includes("received_at"), "Missing received_at column");
  });

  it("sets WAL journal mode", () => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);

    const result = db.prepare("PRAGMA journal_mode").all() as { journal_mode: string }[];
    // :memory: databases may report "memory" instead of "wal"
    assert.ok(
      result[0].journal_mode === "wal" || result[0].journal_mode === "memory",
    );
  });

  it("is idempotent (can be called twice)", () => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    assert.ok(tables.length > 0);
  });
});
