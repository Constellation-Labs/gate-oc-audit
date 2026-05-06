import { DatabaseSync, StatementSync } from "node:sqlite";
import { chmodSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { constants, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { uuidv7 } from "uuidv7";

import { createRequire } from "module";
import type { AuditEvent, AuditEventInsert, EventType, EventCategory } from "../types/events.js";
import { initializeSchema, runInTransaction } from "./schema.js";
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
  /** Only return events with sequence > this value. */
  afterSequence?: number;
  order?: "asc" | "desc";
  /** When true, decompress content_gz and populate event.content. Default: false. */
  includeContent?: boolean;
  /** Partially decompress content_gz up to N chars for preview. Cheaper than includeContent. */
  contentPreview?: number;
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
  content_gz?: Uint8Array | null;
  created_at: string;
  received_at: string | null;
  synced_at: string | null;
}

/** Strip gzip header (RFC 1952) and 8-byte trailer, returning the raw deflate stream. */
function stripGzipWrapper(u: Uint8Array): Buffer {
  const gz = Buffer.from(u.buffer, u.byteOffset, u.byteLength);
  if (gz.length < 18) throw new Error("gzip buffer too short (< 18 bytes)");
  let offset = 10; // fixed header
  const flags = gz[3];
  if (flags & 0x04) { offset += gz.readUInt16LE(offset) + 2; }     // FEXTRA
  if (flags & 0x08) { while (offset < gz.length && gz[offset] !== 0) offset++; offset++; } // FNAME
  if (flags & 0x10) { while (offset < gz.length && gz[offset] !== 0) offset++; offset++; } // FCOMMENT
  if (flags & 0x02) { offset += 2; }                                 // FHCRC
  const raw = gz.subarray(offset, gz.length - 8);
  if (raw.length === 0) throw new Error("gzip wrapper consumed entire buffer");
  return raw;
}

/** Partially inflate gzipped content, returning at most maxChars characters. */
function previewGunzip(gz: Uint8Array, maxChars: number): string | undefined {
  try {
    const raw = stripGzipWrapper(gz);
    const prefix = raw.subarray(0, (maxChars + 1) * 4); //worst case: incompressible text of 4 bytes unicode chars
    const buf = inflateRawSync(prefix, { finishFlush: constants.Z_SYNC_FLUSH });
    let str = buf.toString("utf-8").slice(0, maxChars);
    // Trim lone high surrogate left by slicing through an emoji
    const last = str.charCodeAt(str.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) str = str.slice(0, -1);
    return str;
  } catch {
    // Fallback: full decompress and trim
    try {
      return gunzipSync(gz).toString("utf-8").slice(0, maxChars);
    } catch {
      return undefined;
    }
  }
}

function decodeContent(row: EventRow, previewChars?: number): string | undefined {
  if (!row.content_gz) return undefined;
  if (previewChars !== undefined) return previewGunzip(row.content_gz, previewChars);
  return gunzipSync(row.content_gz).toString();
}

function rowToEvent(row: EventRow, contentPreview?: number): AuditEvent {
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
    content: decodeContent(row, contentPreview),
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

// Per-process counter so log lines can distinguish multiple AuditStore
// instances created within the same process (different IIFE evaluations
// in separate VM contexts each start at 0).
let _auditStoreInstances = 0;

export class AuditStore {
  private db: DatabaseSync;
  private sequence: number;
  private machineId: string;
  private degraded = false;
  private readOnly: boolean;
  private insertStmt: StatementSync;
  private instanceId: string;

  private stmts: {
    getManifestsByType: StatementSync;
    upsertManifest: StatementSync;
    deleteManifest: StatementSync;
    getCheckpoints: StatementSync;
    getLastCheckpoint: StatementSync;
    insertCheckpoint: StatementSync;
    countSince: StatementSync;
    maxSequenceSince: StatementSync;
  };

  constructor(dbPath = "~/.openclaw/audit.db", opts: { readOnly?: boolean } = {}) {
    this.readOnly = opts.readOnly === true;
    const resolvedPath = dbPath.replace(/^~/, process.env.HOME ?? ".");
    if (!this.readOnly) {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }

    this.db = this.readOnly
      ? this.openReadOnly(resolvedPath)
      : this.openOrRecover(resolvedPath);
    this.machineId = getMachineId();

    const lastRow = this.db
      .prepare("SELECT sequence FROM audit_events ORDER BY sequence DESC LIMIT 1")
      .get() as { sequence: number } | undefined;

    this.sequence = lastRow?.sequence ?? 0;

    // Diagnostic ID for tracing concurrent-instance issues.
    _auditStoreInstances++;
    this.instanceId = `${process.pid}.${_auditStoreInstances}.${Math.random().toString(36).slice(2, 8)}`;
    console.info(
      `[audit-plugin][store=${this.instanceId}] AuditStore created — readOnly=${this.readOnly}, path=${resolvedPath}, initialSequence=${this.sequence}`,
    );

    // Insert path is unused in read-only mode but the prepared statement is
    // a property; bind it to a no-op SELECT so the type stays satisfied
    // without opening write capabilities.
    this.insertStmt = this.readOnly
      ? this.db.prepare("SELECT 1 WHERE 0")
      : this.db.prepare(`
      INSERT INTO audit_events
        (id, sequence, source, machine_id, session_id, org_id, user_id,
         event_type, category, description, metadata, content_gz, created_at)
      VALUES
        (@id, @sequence, @source, @machineId, @sessionId, @orgId, @userId,
         @eventType, @category, @description, @metadata, @contentGz, @createdAt)
    `);

    const CP_COLS = "id, sequence_start, sequence_end, smt_root, event_count, de_tx_hash, created_at";

    this.stmts = {
      getManifestsByType: this.db.prepare("SELECT id, content_hash, file_path FROM config_manifests WHERE manifest_type = ?"),
      upsertManifest: this.db.prepare(
        `INSERT INTO config_manifests (id, manifest_type, content_hash, file_path, captured_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET manifest_type = excluded.manifest_type, content_hash = excluded.content_hash, captured_at = excluded.captured_at`,
      ),
      deleteManifest: this.db.prepare("DELETE FROM config_manifests WHERE id = ?"),
      getCheckpoints: this.db.prepare(`SELECT ${CP_COLS} FROM integrity_checkpoints ORDER BY sequence_start ASC`),
      getLastCheckpoint: this.db.prepare(`SELECT ${CP_COLS} FROM integrity_checkpoints ORDER BY sequence_end DESC LIMIT 1`),
      insertCheckpoint: this.db.prepare(
        `INSERT INTO integrity_checkpoints (${CP_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      countSince: this.db.prepare("SELECT COUNT(*) as c FROM audit_events WHERE sequence >= ?"),
      maxSequenceSince: this.db.prepare("SELECT MAX(sequence) as seq FROM audit_events WHERE sequence >= ?"),
    };
  }

  private openReadOnly(resolvedPath: string): DatabaseSync {
    if (!existsSync(resolvedPath)) {
      throw new Error(`Audit DB not found at ${resolvedPath} — read-only open requires an existing file`);
    }
    return new DatabaseSync(resolvedPath, { readOnly: true });
  }

  private openOrRecover(resolvedPath: string): DatabaseSync {
    const isNew = !existsSync(resolvedPath);
    try {
      const db = new DatabaseSync(resolvedPath);
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
      const db = new DatabaseSync(resolvedPath);
      chmodSync(resolvedPath, DB_FILE_MODE);
      initializeSchema(db);
      return db;
    }
  }

  append(insert: AuditEventInsert): AuditEvent | undefined {
    if (this.readOnly) {
      console.error("[audit-plugin] append() called on a read-only store; dropping event");
      return undefined;
    }
    let triedSeq: number | undefined;
    try {
      const id = uuidv7();
      const source = insert.source ?? "openclaw-plugin";

      // The "effective" metadata is what we both persist AND return on the
      // AuditEvent — they MUST be the same object so downstream consumers
      // (SMT hashing, future verifiers reading rows back from SQLite) all
      // compute the same hash. Earlier versions persisted a marker but
      // returned the original, which made SMT proofs fail for truncated rows.
      //
      // Truncation marker shape: a single reserved key `$auditTruncation`
      // namespaces the metadata-replacement payload so a real event whose
      // plugin happens to pick a name like `metadataDropped` cannot be
      // confused with the marker. Consumers detect truncation via
      // `"$auditTruncation" in metadata`.
      let effectiveMetadata: Record<string, unknown> = insert.metadata;
      let metadataCanonical: string;
      try {
        metadataCanonical = sdk.canonicalize(insert.metadata);
      } catch {
        console.error("[audit-plugin] Metadata is not serializable, recording marker");
        effectiveMetadata = { $auditTruncation: { reason: "non-serializable" } };
        metadataCanonical = sdk.canonicalize(effectiveMetadata);
      }

      if (metadataCanonical.length > MAX_METADATA_SIZE) {
        // Sender-controlled fields (messageId, sourcePath, requestedSpecifier,
        // etc.) could otherwise erase the very event that records the abuse.
        console.error(
          `[audit-plugin] Metadata exceeds ${MAX_METADATA_SIZE} bytes, recording event with truncated metadata`,
        );
        effectiveMetadata = {
          $auditTruncation: { reason: "size-cap", originalSize: metadataCanonical.length },
        };
        metadataCanonical = sdk.canonicalize(effectiveMetadata);
      }

      // Defensive: the marker payload is built from primitives only and
      // cannot in practice exceed the cap, but if a future change adds a
      // sender-controlled field to it, fail loud rather than silently
      // re-opening the size-evasion vector this branch was supposed to close.
      if (metadataCanonical.length > MAX_METADATA_SIZE) {
        throw new Error(
          `[audit-plugin] BUG: truncation marker itself exceeds ${MAX_METADATA_SIZE} bytes`,
        );
      }

      const nextSequence = this.sequence + 1;
      triedSeq = nextSequence;
      const createdAt = new Date().toISOString();

      const rawContent = insert.content && insert.content.length <= MAX_CONTENT_SIZE
        ? insert.content
        : undefined;
      if (insert.content && !rawContent) {
        console.error(`[audit-plugin] Content exceeds ${MAX_CONTENT_SIZE} bytes, storing event without content`);
      }
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
        metadata: effectiveMetadata,
        content: rawContent,
        createdAt,
      };
    } catch (err) {
      this.degraded = true;
      const message = err instanceof Error ? err.message : "Unknown error";

      // Diagnostic dump on UNIQUE/sequence collisions: what we tried, what's
      // currently in the DB, and what our cached counter thinks. If two
      // instances are racing, dbMax > our cached this.sequence and the next
      // attempt will collide again (the in-memory counter never advances on
      // failure). If dbMax == our cached this.sequence, the cache is in sync
      // and the bug is elsewhere.
      let diag = "";
      try {
        const row = this.db
          .prepare("SELECT MAX(sequence) AS m, COUNT(*) AS c FROM audit_events")
          .get() as { m: number | null; c: number };
        diag = ` triedSeq=${triedSeq ?? "N/A"} cachedSeq=${this.sequence} dbMax=${row.m ?? 0} dbCount=${row.c} eventType=${insert.eventType}`;
      } catch {
        // ignore — best-effort diagnostic
      }
      console.error(
        `[audit-plugin][store=${this.instanceId}] Failed to append event: ${message}${diag}`,
      );
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
    if (opts.afterSequence !== undefined) {
      conditions.push("sequence > @afterSequence");
      params.afterSequence = opts.afterSequence;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const order = opts.order === "asc" ? "ASC" : "DESC";

    const wantContent = opts.includeContent || opts.contentPreview !== undefined;
    const contentCol = wantContent ? ", content_gz" : "";
    const rows = this.db
      .prepare(
        `SELECT id, sequence, source, machine_id, session_id, org_id, user_id,
                event_type, category, description, metadata${contentCol},
                created_at, received_at, synced_at
         FROM audit_events ${where} ORDER BY sequence ${order} LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as unknown as EventRow[];

    const previewChars = opts.includeContent ? undefined : opts.contentPreview;
    return rows.map((row) => rowToEvent(row, previewChars));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM audit_events").get() as { c: number }).c;
  }

  prune(maxAgeDays: number, maxSizeMb: number): number {
    let totalDeleted = 0;

    runInTransaction(this.db, () => {
      // Age-based pruning — synced events first, then unsynced
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const syncedResult = this.db
        .prepare("DELETE FROM audit_events WHERE created_at < @cutoff AND synced_at IS NOT NULL")
        .run({ cutoff });
      totalDeleted += Number(syncedResult.changes);
      const unsyncedResult = this.db
        .prepare("DELETE FROM audit_events WHERE created_at < @cutoff")
        .run({ cutoff });
      totalDeleted += Number(unsyncedResult.changes);

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
          deleted = Number(result.changes);
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
            deleted = Number(result.changes);
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

    // Reclaim disk space outside the transaction
    if (totalDeleted > 0) {
      this.db.exec("PRAGMA incremental_vacuum");
    }

    return totalDeleted;
  }

  private getDbSizeMb(): number {
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    return (pageSize * pageCount) / (1024 * 1024);
  }

  // --- Config manifest operations (used by ConfigWatcher and FileWatcher) ---

  getManifestsByType(manifestType: string): Array<{ id: string; contentHash: string; filePath: string | null }> {
    return (this.stmts.getManifestsByType.all(manifestType) as Array<{ id: string; content_hash: string; file_path: string | null }>)
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
    return (this.stmts.getCheckpoints.all() as unknown as CheckpointRow[]).map(rowToCheckpoint);
  }

  getCheckpointedRoots(): string[] {
    return this.getCheckpoints().map((cp) => cp.smtRoot);
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

  /** Returns the highest sequence number at or after a given sequence, or undefined if none. */
  maxSequenceSince(seqStart: number): number | undefined {
    const row = this.stmts.maxSequenceSince.get(seqStart) as { seq: number | null };
    return row.seq ?? undefined;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  close(): void {
    this.db.close();
  }
}
