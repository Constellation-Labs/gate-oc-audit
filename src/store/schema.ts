import type { DatabaseSync } from "node:sqlite";

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA auto_vacuum = INCREMENTAL",
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS audit_events (
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

const CURRENT_SCHEMA_VERSION = 3;

export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

export function initializeSchema(db: DatabaseSync): void {
  for (const pragma of PRAGMAS) {
    db.exec(pragma);
  }

  runInTransaction(db, () => {
    for (const statement of DDL) {
      db.exec(statement);
    }

    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null } | undefined;
    const current = row?.v ?? 0;

    if (current < CURRENT_SCHEMA_VERSION) {
      // v2: Added checkpoint_archive table (CREATE IF NOT EXISTS handles it).

      // v3: Removed hash chain (content_hash, previous_hash columns),
      //     renamed merkle_root to smt_root, removed sync_state table.

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(CURRENT_SCHEMA_VERSION, new Date().toISOString());
    }
  });
}
