import type Database from "better-sqlite3";

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
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
    content_hash  TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
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
    merkle_root     TEXT NOT NULL,
    event_count     INTEGER NOT NULL,
    de_tx_hash      TEXT,
    created_at      TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

export function initializeSchema(db: Database.Database): void {
  for (const pragma of PRAGMAS) {
    db.pragma(pragma.replace("PRAGMA ", ""));
  }

  const migrate = db.transaction(() => {
    for (const statement of DDL) {
      db.exec(statement);
    }
  });

  migrate();
}
