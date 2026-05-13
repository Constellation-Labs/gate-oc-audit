import type { DatabaseSync } from "node:sqlite";
import {log} from "../util/logger.js";

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA auto_vacuum = INCREMENTAL",
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS audit_events (
    sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
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
  )`,

  "CREATE INDEX IF NOT EXISTS idx_events_category ON audit_events(category)",
  "CREATE INDEX IF NOT EXISTS idx_events_type ON audit_events(event_type)",
  "CREATE INDEX IF NOT EXISTS idx_events_created ON audit_events(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_events_session ON audit_events(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_unsynced ON audit_events(synced_at) WHERE synced_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_machine ON audit_events(machine_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_user ON audit_events(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_org ON audit_events(org_id, created_at)",

  `CREATE TABLE IF NOT EXISTS config_manifests (
    id            TEXT PRIMARY KEY,
    manifest_type TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    file_path     TEXT,
    captured_at   TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS integrity_checkpoints (
    id              TEXT PRIMARY KEY,
    sequence_start  INTEGER NOT NULL,
    sequence_end    INTEGER NOT NULL,
    smt_root        TEXT NOT NULL,
    event_count     INTEGER NOT NULL,
    de_tx_hash      TEXT,
    created_at      TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS checkpoint_archive (
    id              TEXT PRIMARY KEY,
    sequence_start  INTEGER NOT NULL,
    sequence_end    INTEGER NOT NULL,
    smt_root        TEXT NOT NULL,
    event_count     INTEGER NOT NULL,
    de_tx_hash      TEXT,
    created_at      TEXT NOT NULL,
    archived_at     TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER NOT NULL,
    applied_at  TEXT NOT NULL
  )`,
];

const CURRENT_SCHEMA_VERSION = 4;

export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErr) {
      log.error(`ROLLBACK failed: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`);
    }
    throw err;
  }
}

export function initializeSchema(db: DatabaseSync): void {
  for (const pragma of PRAGMAS) {
    db.exec(pragma);
  }

  const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  if (mode !== "wal" && mode !== "memory") {
    log.warn(`journal_mode fell back to '${mode}' (expected 'wal'); durability/concurrency guarantees are reduced`);
  }

  runInTransaction(db, () => {
    // Pre-DDL migrations: must run before CREATE TABLE IF NOT EXISTS, which is
    // a no-op for an existing table and therefore cannot reshape it.
    const auditEventsExists = !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'")
      .get();
    if (auditEventsExists) {
      const versionRow = db
        .prepare("SELECT MAX(version) as v FROM schema_version")
        .get() as { v: number | null } | undefined;
      const existingVersion = versionRow?.v ?? 0;
      if (existingVersion < 4) {
        migrateAuditEventsToV4(db);
      }
    }

    for (const statement of DDL) {
      db.exec(statement);
    }

    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null } | undefined;
    const current = row?.v ?? 0;

    if (current < CURRENT_SCHEMA_VERSION) {
      // v2: Added checkpoint_archive table (CREATE IF NOT EXISTS handles it).

      // v3: Removed hash chain (content_hash, previous_hash columns),
      //     renamed merkle_root to smt_root, removed sync_state table.

      // v4: audit_events.sequence is now INTEGER PRIMARY KEY AUTOINCREMENT and
      //     id moved to UNIQUE — see migrateAuditEventsToV4.

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(CURRENT_SCHEMA_VERSION, new Date().toISOString());
    }
  });
}

// Rebuild audit_events so SQLite owns sequence allocation via
// INTEGER PRIMARY KEY AUTOINCREMENT. Prior versions cached the next sequence
// in process memory and lost coherence when multiple writers raced.
//
// The migration handles older DBs that may pre-date some currently-nullable
// columns (received_at, synced_at): if the old table is missing them,
// SELECT NULL into the new row. Required columns must be present — if any
// are missing the migration aborts loudly rather than fabricating data.
function migrateAuditEventsToV4(db: DatabaseSync): void {
  // Rename the existing table out of the way and create the v4 shape.
  db.exec(`
    ALTER TABLE audit_events RENAME TO audit_events_v3;

    CREATE TABLE audit_events (
      sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
      id            TEXT NOT NULL UNIQUE,
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
    );
  `);

  const oldCols = new Set(
    (db.prepare("PRAGMA table_info(audit_events_v3)").all() as { name: string }[])
      .map((r) => r.name),
  );

  // Column order here is the order rows will be inserted.
  // `nullable: true` columns substitute NULL when missing; missing required
  // columns abort the migration.
  const targetCols: { name: string; nullable: boolean }[] = [
    { name: "sequence", nullable: false },
    { name: "id", nullable: false },
    { name: "source", nullable: false },
    { name: "machine_id", nullable: false },
    { name: "session_id", nullable: true },
    { name: "org_id", nullable: true },
    { name: "user_id", nullable: true },
    { name: "event_type", nullable: false },
    { name: "category", nullable: false },
    { name: "description", nullable: false },
    { name: "metadata", nullable: false },
    { name: "content_gz", nullable: true },
    { name: "created_at", nullable: false },
    { name: "received_at", nullable: true },
    { name: "synced_at", nullable: true },
  ];

  const insertCols: string[] = [];
  const selectExprs: string[] = [];
  for (const col of targetCols) {
    if (oldCols.has(col.name)) {
      insertCols.push(col.name);
      selectExprs.push(col.name);
    } else if (col.nullable) {
      insertCols.push(col.name);
      selectExprs.push(`NULL AS ${col.name}`);
    } else {
      throw new Error(
        `[audit-plugin] cannot migrate audit_events to v4: required column '${col.name}' missing from existing table`,
      );
    }
  }

  db.exec(`
    INSERT INTO audit_events (${insertCols.join(", ")})
    SELECT ${selectExprs.join(", ")}
    FROM audit_events_v3;

    DROP TABLE audit_events_v3;

    INSERT OR REPLACE INTO sqlite_sequence (name, seq)
      VALUES ('audit_events', (SELECT COALESCE(MAX(sequence), 0) FROM audit_events));
  `);
}
