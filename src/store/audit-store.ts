import Database from "better-sqlite3";
import { chmodSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { uuidv7 } from "uuidv7";

import { createRequire } from "module";
import type { AuditEvent, AuditEventInsert, EventType, EventCategory } from "../types/events.js";
import { initializeSchema } from "./schema.js";
import { getMachineId } from "../util/machine-id.js";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
};

const MAX_METADATA_SIZE = 1024 * 1024; // 1MB
const MAX_CONTENT_SIZE = 5 * 1024 * 1024; // 5MB
const DB_FILE_MODE = 0o600;
const PRUNE_BATCH_SIZE = 1000;

export interface QueryOptions {
  limit?: number;
  offset?: number;
  eventType?: string;
  category?: string;
  sessionId?: string;
  order?: "asc" | "desc";
}

interface EventRow {
  id: string;
  sequence: number;
  source: string;
  machine_id: string;
  session_id: string | null;
  org_id: string | null;
  user_id: string | null;
  event_type: string;
  category: string;
  description: string;
  metadata: string;
  created_at: string;
  received_at: string | null;
  synced_at: string | null;
}

function rowToEvent(row: EventRow): AuditEvent {
  return {
    id: row.id,
    sequence: row.sequence,
    source: row.source as AuditEvent["source"],
    machineId: row.machine_id,
    sessionId: row.session_id ?? undefined,
    orgId: row.org_id ?? undefined,
    userId: row.user_id ?? undefined,
    eventType: row.event_type as EventType,
    category: row.category as EventCategory,
    description: row.description,
    metadata: JSON.parse(row.metadata),
    createdAt: row.created_at,
    receivedAt: row.received_at ?? undefined,
    syncedAt: row.synced_at ?? undefined,
  };
}

interface CheckpointRow {
  id: string;
  sequence_start: number;
  sequence_end: number;
  smt_root: string;
  event_count: number;
  de_tx_hash: string | null;
  created_at: string;
}

export interface CheckpointRecord {
  id: string;
  sequenceStart: number;
  sequenceEnd: number;
  smtRoot: string;
  eventCount: number;
  deTxHash: string | null;
  createdAt: string;
}

function rowToCheckpoint(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    sequenceStart: row.sequence_start,
    sequenceEnd: row.sequence_end,
    smtRoot: row.smt_root,
    eventCount: row.event_count,
    deTxHash: row.de_tx_hash,
    createdAt: row.created_at,
  };
}

export class AuditStore {
  private db: Database.Database;
  private sequence: number;
  private machineId: string;
  private degraded = false;
  private insertStmt: Database.Statement;

  private stmts: {
    getManifests: Database.Statement;
    upsertManifest: Database.Statement;
    deleteManifest: Database.Statement;
    getCheckpoints: Database.Statement;
    getLastCheckpoint: Database.Statement;
    insertCheckpoint: Database.Statement;
    countSince: Database.Statement;
  };

  constructor(dbPath = "~/.openclaw/audit.db") {
    const resolvedPath = dbPath.replace(/^~/, process.env.HOME ?? ".");
    mkdirSync(dirname(resolvedPath), { recursive: true });

    this.db = this.openOrRecover(resolvedPath);
    this.machineId = getMachineId();

    const lastRow = this.db
      .prepare("SELECT sequence FROM audit_events ORDER BY sequence DESC LIMIT 1")
      .get() as { sequence: number } | undefined;

    this.sequence = lastRow?.sequence ?? 0;

    this.insertStmt = this.db.prepare(`
      INSERT INTO audit_events
        (id, sequence, source, machine_id, session_id, org_id, user_id,
         event_type, category, description, metadata, content_gz, created_at)
      VALUES
        (@id, @sequence, @source, @machineId, @sessionId, @orgId, @userId,
         @eventType, @category, @description, @metadata, @contentGz, @createdAt)
    `);

    const CP_COLS = "id, sequence_start, sequence_end, smt_root, event_count, de_tx_hash, created_at";

    this.stmts = {
      getManifests: this.db.prepare("SELECT id, content_hash, file_path FROM config_manifests"),
      upsertManifest: this.db.prepare(
        `INSERT INTO config_manifests (id, manifest_type, content_hash, file_path, captured_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content_hash = excluded.content_hash, captured_at = excluded.captured_at`,
      ),
      deleteManifest: this.db.prepare("DELETE FROM config_manifests WHERE id = ?"),
      getCheckpoints: this.db.prepare(`SELECT ${CP_COLS} FROM integrity_checkpoints ORDER BY sequence_start ASC`),
      getLastCheckpoint: this.db.prepare(`SELECT ${CP_COLS} FROM integrity_checkpoints ORDER BY sequence_end DESC LIMIT 1`),
      insertCheckpoint: this.db.prepare(
        `INSERT INTO integrity_checkpoints (${CP_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      countSince: this.db.prepare("SELECT COUNT(*) as c FROM audit_events WHERE sequence >= ?"),
    };
  }

  private openOrRecover(resolvedPath: string): Database.Database {
    const isNew = !existsSync(resolvedPath);
    try {
      const db = new Database(resolvedPath);
      if (isNew) chmodSync(resolvedPath, DB_FILE_MODE);
      initializeSchema(db);
      // Smoke test: verify the DB is readable
      db.prepare("SELECT COUNT(*) FROM audit_events").get();
      return db;
    } catch (err) {
      if (isNew) throw err; // Fresh DB failed — nothing to recover
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[audit-plugin] Database corrupt or unreadable: ${message}`);
      console.error("[audit-plugin] Preserving old DB and creating fresh database");

      // Preserve the old DB for forensic recovery
      const backupPath = `${resolvedPath}.corrupt.${Date.now()}`;
      try {
        renameSync(resolvedPath, backupPath);
        // Also move WAL/SHM files if they exist
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(resolvedPath + suffix)) {
            renameSync(resolvedPath + suffix, backupPath + suffix);
          }
        }
        console.error(`[audit-plugin] Old database preserved at ${backupPath}`);
      } catch {
        console.error("[audit-plugin] Failed to rename corrupt DB, overwriting");
      }

      // Create fresh DB
      const db = new Database(resolvedPath);
      chmodSync(resolvedPath, DB_FILE_MODE);
      initializeSchema(db);
      return db;
    }
  }

  append(insert: AuditEventInsert): AuditEvent | undefined {
    try {
      const id = uuidv7();
      const source = insert.source ?? "openclaw-plugin";

      let metadataCanonical: string;
      try {
        metadataCanonical = sdk.canonicalize(insert.metadata);
      } catch {
        console.error("[audit-plugin] Metadata is not serializable, skipping event");
        return undefined;
      }

      if (metadataCanonical.length > MAX_METADATA_SIZE) {
        console.error(
          `[audit-plugin] Metadata exceeds ${MAX_METADATA_SIZE} bytes, skipping event`,
        );
        return undefined;
      }

      const nextSequence = this.sequence + 1;
      const createdAt = new Date().toISOString();

      const rawContent = insert.content && insert.content.length <= MAX_CONTENT_SIZE
        ? insert.content
        : undefined;
      const contentGz = rawContent ? gzipSync(Buffer.from(rawContent), { level: 1 }) : null;

      this.insertStmt.run({
        id,
        sequence: nextSequence,
        source,
        machineId: this.machineId,
        sessionId: insert.sessionId ?? null,
        orgId: insert.orgId ?? null,
        userId: insert.userId ?? null,
        eventType: insert.eventType,
        category: insert.category,
        description: insert.description,
        metadata: metadataCanonical,
        contentGz,
        createdAt,
      });

      this.sequence = nextSequence;
      this.degraded = false;

      return {
        id,
        sequence: nextSequence,
        source,
        machineId: this.machineId,
        sessionId: insert.sessionId,
        orgId: insert.orgId,
        userId: insert.userId,
        eventType: insert.eventType,
        category: insert.category,
        description: insert.description,
        metadata: insert.metadata,
        createdAt,
      };
    } catch (err) {
      this.degraded = true;
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] Failed to append event:", message);
      return undefined;
    }
  }

  query(opts: QueryOptions = {}): AuditEvent[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.eventType) {
      conditions.push("event_type = @eventType");
      params.eventType = opts.eventType;
    }
    if (opts.category) {
      conditions.push("category = @category");
      params.category = opts.category;
    }
    if (opts.sessionId) {
      conditions.push("session_id = @sessionId");
      params.sessionId = opts.sessionId;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const order = opts.order === "asc" ? "ASC" : "DESC";

    const rows = this.db
      .prepare(
        `SELECT id, sequence, source, machine_id, session_id, org_id, user_id,
                event_type, category, description, metadata,
                created_at, received_at, synced_at
         FROM audit_events ${where} ORDER BY sequence ${order} LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as EventRow[];

    return rows.map(rowToEvent);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM audit_events").get() as { c: number }).c;
  }

  prune(maxAgeDays: number, maxSizeMb: number): number {
    let totalDeleted = 0;

    const doPrune = this.db.transaction(() => {
      // Age-based pruning — synced events first, then unsynced
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const syncedResult = this.db
        .prepare("DELETE FROM audit_events WHERE created_at < @cutoff AND synced_at IS NOT NULL")
        .run({ cutoff });
      totalDeleted += syncedResult.changes;
      const unsyncedResult = this.db
        .prepare("DELETE FROM audit_events WHERE created_at < @cutoff")
        .run({ cutoff });
      totalDeleted += unsyncedResult.changes;

      // Size-based pruning — prefer synced events, then oldest overall
      if (this.getDbSizeMb() > maxSizeMb) {
        let deleted = 0;
        do {
          const result = this.db
            .prepare(
              `DELETE FROM audit_events WHERE id IN (
                SELECT id FROM audit_events WHERE synced_at IS NOT NULL ORDER BY sequence ASC LIMIT @batchSize
              )`,
            )
            .run({ batchSize: PRUNE_BATCH_SIZE });
          deleted = result.changes;
          totalDeleted += deleted;
        } while (deleted > 0 && this.getDbSizeMb() > maxSizeMb);

        if (this.getDbSizeMb() > maxSizeMb) {
          do {
            const result = this.db
              .prepare(
                `DELETE FROM audit_events WHERE id IN (
                  SELECT id FROM audit_events ORDER BY sequence ASC LIMIT @batchSize
                )`,
              )
              .run({ batchSize: PRUNE_BATCH_SIZE });
            deleted = result.changes;
            totalDeleted += deleted;
          } while (deleted > 0 && this.getDbSizeMb() > maxSizeMb);
        }
      }

      // Archive orphaned checkpoints whose events have been pruned
      if (totalDeleted > 0) {
        const minAfter = this.db
          .prepare("SELECT MIN(sequence) as seq FROM audit_events")
          .get() as { seq: number | null } | undefined;
        const nextExpectedSeq = minAfter?.seq ?? this.sequence + 1;

        this.db.prepare(`
          INSERT OR IGNORE INTO checkpoint_archive
            (id, sequence_start, sequence_end, smt_root, event_count, de_tx_hash, created_at, archived_at)
          SELECT id, sequence_start, sequence_end, smt_root, event_count, de_tx_hash, created_at, ?
          FROM integrity_checkpoints
          WHERE sequence_end < ?
        `).run(new Date().toISOString(), nextExpectedSeq);
        this.db.prepare(
          "DELETE FROM integrity_checkpoints WHERE sequence_end < ?",
        ).run(nextExpectedSeq);
      }
    });

    doPrune();

    // Reclaim disk space outside the transaction
    if (totalDeleted > 0) {
      this.db.pragma("incremental_vacuum");
    }

    return totalDeleted;
  }

  private getDbSizeMb(): number {
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    return (pageSize * pageCount) / (1024 * 1024);
  }

  // --- Config manifest operations (used by ConfigWatcher) ---

  getManifests(): Array<{ id: string; contentHash: string; filePath: string | null }> {
    return (this.stmts.getManifests.all() as Array<{ id: string; content_hash: string; file_path: string | null }>)
      .map((r) => ({ id: r.id, contentHash: r.content_hash, filePath: r.file_path }));
  }

  upsertManifest(id: string, manifestType: string, contentHash: string, filePath: string): void {
    this.stmts.upsertManifest.run(id, manifestType, contentHash, filePath, new Date().toISOString());
  }

  deleteManifest(id: string): void {
    this.stmts.deleteManifest.run(id);
  }

  // --- Integrity checkpoint operations (used by DeAnchorService) ---

  getCheckpoints(): CheckpointRecord[] {
    return (this.stmts.getCheckpoints.all() as CheckpointRow[]).map(rowToCheckpoint);
  }

  getLastCheckpoint(): CheckpointRecord | undefined {
    const row = this.stmts.getLastCheckpoint.get() as CheckpointRow | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }

  insertCheckpoint(id: string, seqStart: number, seqEnd: number, smtRoot: string, eventCount: number, deTxHash: string | null): void {
    this.stmts.insertCheckpoint.run(id, seqStart, seqEnd, smtRoot, eventCount, deTxHash, new Date().toISOString());
  }

  /** Returns the count of events at or after a given sequence. */
  countSince(seqStart: number): number {
    return (this.stmts.countSince.get(seqStart) as { c: number }).c;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  close(): void {
    this.db.close();
  }
}
