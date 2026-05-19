import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema, runInTransaction } from "../../src/store/schema.js";

// v3 shape — what an on-disk DB looked like before the v4 migration.
// Used to seed a "legacy" DB so we can verify migrateAuditEventsToV4
// reshapes it correctly.
const V3_AUDIT_EVENTS_DDL = `
  CREATE TABLE audit_events (
    id            TEXT PRIMARY KEY,
    sequence      INTEGER NOT NULL UNIQUE,
    source        TEXT NOT NULL DEFAULT 'openclaw-plugin',
    machine_id    TEXT NOT NULL,
    session_id    TEXT,
    org_id        TEXT,
    user_id       TEXT,
    event_type    TEXT NOT NULL,
    category      TEXT NOT NULL,
    description   TEXT NOT NULL,
    metadata      TEXT NOT NULL,
    content_gz    BLOB,
    created_at    TEXT NOT NULL,
    received_at   TEXT,
    synced_at     TEXT
  )
`;

// Pre-v3 shape, simulating a DB that pre-dates received_at / synced_at.
// Exercises the defensive NULL-substitution path in the migration.
const PRE_V3_AUDIT_EVENTS_DDL = `
  CREATE TABLE audit_events (
    id            TEXT PRIMARY KEY,
    sequence      INTEGER NOT NULL UNIQUE,
    source        TEXT NOT NULL DEFAULT 'openclaw-plugin',
    machine_id    TEXT NOT NULL,
    session_id    TEXT,
    org_id        TEXT,
    user_id       TEXT,
    event_type    TEXT NOT NULL,
    category      TEXT NOT NULL,
    description   TEXT NOT NULL,
    metadata      TEXT NOT NULL,
    content_gz    BLOB,
    created_at    TEXT NOT NULL
  )
`;

function seedLegacyDb(db: DatabaseSync, auditEventsDdl: string, version: number, rows: { id: string; sequence: number; description: string }[]): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(auditEventsDdl);
  db.exec(`
    CREATE TABLE schema_version (
      version     INTEGER NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO audit_events
      (id, sequence, source, machine_id, event_type, category, description, metadata, created_at)
    VALUES
      (@id, @sequence, 'openclaw-plugin', 'machine-1', 'session.start', 'system', @description, '{}', '2026-01-01T00:00:00.000Z')
  `);
  for (const row of rows) {
    stmt.run({ id: row.id, sequence: row.sequence, description: row.description });
  }
  db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(version, "2026-01-01T00:00:00.000Z");
}

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
    for (const expected of [
      "audit_events",
      "config_manifests",
      "integrity_checkpoints",
      "checkpoint_archive",
      "service_health",
    ]) {
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
      "idx_events_type_created",
      "idx_events_category_created",
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

describe("migrateAuditEventsToV4", () => {
  let db: DatabaseSync;

  afterEach(() => {
    db?.close();
  });

  it("rebuilds a v3 audit_events table into the v4 shape", () => {
    db = new DatabaseSync(":memory:");
    seedLegacyDb(db, V3_AUDIT_EVENTS_DDL, 3, [
      { id: "id-1", sequence: 1, description: "first" },
      { id: "id-2", sequence: 2, description: "second" },
      { id: "id-3", sequence: 3, description: "third" },
    ]);

    initializeSchema(db);

    // sequence is now the INTEGER PRIMARY KEY (i.e., the rowid alias).
    const cols = db.prepare("PRAGMA table_info(audit_events)").all() as { name: string; pk: number }[];
    const seqCol = cols.find((c) => c.name === "sequence");
    const idCol = cols.find((c) => c.name === "id");
    assert.ok(seqCol);
    assert.equal(seqCol.pk, 1, "sequence should be the primary key");
    assert.ok(idCol);
    assert.equal(idCol.pk, 0, "id should no longer be the primary key");

    // Existing rows survived the rebuild.
    const rows = db
      .prepare("SELECT id, sequence, description FROM audit_events ORDER BY sequence")
      .all() as { id: string; sequence: number; description: string }[];
    assert.deepEqual(rows.map((r) => r.id), ["id-1", "id-2", "id-3"]);
    assert.deepEqual(rows.map((r) => r.sequence), [1, 2, 3]);

    // sqlite_sequence is seeded so the next auto-allocated sequence is MAX+1.
    const seqRow = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'")
      .get() as { seq: number } | undefined;
    assert.equal(seqRow?.seq, 3);

    // Next insert with no explicit sequence picks up at 4.
    db.prepare(`
      INSERT INTO audit_events (id, source, machine_id, event_type, category, description, metadata, created_at)
      VALUES ('id-4', 'openclaw-plugin', 'machine-1', 'session.start', 'system', 'fourth', '{}', '2026-01-01T00:00:00.000Z')
    `).run();
    const newRow = db.prepare("SELECT sequence FROM audit_events WHERE id = 'id-4'").get() as { sequence: number };
    assert.equal(newRow.sequence, 4);

    // schema_version is bumped to the current version.
    const versionRow = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    assert.equal(versionRow.v, 7);
  });

  it("substitutes NULL for missing nullable columns (pre-v3 DB)", () => {
    db = new DatabaseSync(":memory:");
    seedLegacyDb(db, PRE_V3_AUDIT_EVENTS_DDL, 2, [
      { id: "id-1", sequence: 1, description: "legacy" },
    ]);

    initializeSchema(db);

    // The new schema's nullable columns exist and contain NULL for the migrated row.
    const row = db
      .prepare("SELECT id, sequence, received_at, synced_at FROM audit_events")
      .get() as { id: string; sequence: number; received_at: string | null; synced_at: string | null };
    assert.equal(row.id, "id-1");
    assert.equal(row.sequence, 1);
    assert.equal(row.received_at, null);
    assert.equal(row.synced_at, null);
  });

  it("does not run on a freshly initialized DB", () => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);

    // Re-initialization is a no-op — schema_version stays at the current version with exactly one row.
    initializeSchema(db);

    const rows = db.prepare("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[];
    assert.deepEqual(rows.map((r) => r.version), [7]);
  });

  it("recreates indexes that were dropped with the old table", () => {
    db = new DatabaseSync(":memory:");
    seedLegacyDb(db, V3_AUDIT_EVENTS_DDL, 3, [{ id: "id-1", sequence: 1, description: "x" }]);

    initializeSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events' AND name LIKE 'idx_%'")
      .all() as { name: string }[];
    const names = new Set(indexes.map((i) => i.name));
    for (const expected of [
      "idx_events_category",
      "idx_events_type",
      "idx_events_created",
      "idx_events_session",
      "idx_events_unsynced",
      "idx_events_machine",
      "idx_events_user",
      "idx_events_org",
      "idx_events_type_created",
      "idx_events_category_created",
    ]) {
      assert.ok(names.has(expected), `Missing index after migration: ${expected}`);
    }
  });

  it("migrates a v4 DB to v5 (adds compound indexes and service_health table)", () => {
    db = new DatabaseSync(":memory:");
    // Seed a v4 DB by running the v3→v4 migration then stamping schema_version.
    seedLegacyDb(db, V3_AUDIT_EVENTS_DDL, 4, [{ id: "v4-1", sequence: 1, description: "v4 row" }]);

    initializeSchema(db);

    // v5 records exists alongside the prior v4 row.
    const versions = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as { version: number }[];
    assert.deepEqual(versions.map((r) => r.version), [4, 7]);

    // Compound indexes present.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events' AND name LIKE 'idx_%'")
      .all() as { name: string }[];
    const indexNames = new Set(indexes.map((i) => i.name));
    assert.ok(indexNames.has("idx_events_type_created"));
    assert.ok(indexNames.has("idx_events_category_created"));

    // service_health table present.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='service_health'")
      .all() as { name: string }[];
    assert.equal(tables.length, 1);
  });
});

describe("runInTransaction", () => {
  let db: DatabaseSync;

  afterEach(() => {
    db?.close();
  });

  function setupTable() {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (v INTEGER NOT NULL)");
  }

  function count(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
  }

  it("commits on success and propagates return value", () => {
    setupTable();
    const result = runInTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run(1);
      db.prepare("INSERT INTO t (v) VALUES (?)").run(2);
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(count(), 2);
  });

  it("rolls back on thrown error and re-throws", () => {
    setupTable();
    assert.throws(() => {
      runInTransaction(db, () => {
        db.prepare("INSERT INTO t (v) VALUES (?)").run(1);
        throw new Error("boom");
      });
    }, /boom/);
    assert.equal(count(), 0);
  });

  it("releases the lock after rollback (next call succeeds)", () => {
    setupTable();
    assert.throws(() => {
      runInTransaction(db, () => {
        throw new Error("first");
      });
    }, /first/);
    runInTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run(9);
    });
    assert.equal(count(), 1);
  });

});
