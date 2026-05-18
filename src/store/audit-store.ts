import { DatabaseSync, StatementSync } from "node:sqlite";
import { chmodSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { constants, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";

import { createRequire } from "module";
import type { AuditEvent, AuditEventInsert, EventType, EventCategory } from "../types/events.js";
import { initializeSchema, runInTransaction } from "./schema.js";
import { getMachineId } from "../util/machine-id.js";
import {log} from "../util/logger.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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
  categoryIn?: ReadonlyArray<string>;
  sessionId?: string;
  /** Only return events with sequence > this value. */
  afterSequence?: number;
  /** ISO 8601 lower bound (inclusive) compared against created_at. */
  createdAfter?: string;
  /** ISO 8601 upper bound (inclusive) compared against created_at. */
  createdBefore?: string;
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
  content_hash: string;
  previous_hash: string | null;
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
    contentHash: row.content_hash,
    previousHash: row.previous_hash ?? undefined,
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
  verified_at: string | null;
}

export interface CheckpointRecord {
  id: string;
  sequenceStart: number;
  sequenceEnd: number;
  smtRoot: string;
  eventCount: number;
  deTxHash: string | null;
  createdAt: string;
  verifiedAt: string | null;
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
    verifiedAt: row.verified_at,
  };
}

// Per-process counter so log lines can distinguish multiple AuditStore
// instances created within the same process (different IIFE evaluations
// in separate VM contexts each start at 0).
let _auditStoreInstances = 0;

export class AuditStore {
  private db: DatabaseSync;
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
    getUnverifiedCheckpoints: StatementSync;
    markCheckpointVerified: StatementSync;
    insertCheckpoint: StatementSync;
    countSince: StatementSync;
    maxSequenceSince: StatementSync;
    getOldestCreatedAt: StatementSync;
    getServiceHealth: StatementSync;
    upsertServiceHealth: StatementSync;
    countCheckpointsSince: StatementSync;
    aggActivityByCategory: StatementSync;
    aggCronByEventType: StatementSync;
    aggToolInvocations: StatementSync;
    aggLlmUsage: StatementSync;
    aggMessageSentByChannel: StatementSync;
    distinctToolNames: StatementSync;
    reportFooterLastEvent: StatementSync;
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

    // Diagnostic ID for tracing concurrent-instance issues.
    _auditStoreInstances++;
    this.instanceId = `${process.pid}.${_auditStoreInstances}.${Math.random().toString(36).slice(2, 8)}`;
    process.stderr.write(
      `[audit-plugin][store=${this.instanceId}] AuditStore created — readOnly=${this.readOnly}, path=${resolvedPath}\n`,
    );

    // Insert path is unused in read-only mode but the prepared statement is
    // a property; bind it to a no-op SELECT so the type stays satisfied
    // without opening write capabilities.
    //
    // sequence is omitted from the column list so that the table's
    // INTEGER PRIMARY KEY AUTOINCREMENT assigns the next value atomically.
    // previous_hash is computed inline as a scalar subquery against the
    // committed table state, so concurrent writers serialize on the write
    // lock and each insert chains to the row the prior writer just
    // committed — no race window between a separate SELECT and INSERT.
    // RETURNING reads back both the assigned sequence and the linked
    // previous_hash so the caller sees exactly what was persisted.
    this.insertStmt = this.readOnly
      ? this.db.prepare("SELECT 1 WHERE 0")
      : this.db.prepare(`
      INSERT INTO audit_events
        (id, source, machine_id, session_id, org_id, user_id,
         event_type, category, description, metadata, content_gz,
         content_hash, previous_hash, created_at)
      VALUES
        (@id, @source, @machineId, @sessionId, @orgId, @userId,
         @eventType, @category, @description, @metadata, @contentGz,
         @contentHash,
         (SELECT content_hash FROM audit_events ORDER BY sequence DESC LIMIT 1),
         @createdAt)
      RETURNING sequence, previous_hash
    `);

    const CP_COLS = "id, sequence_start, sequence_end, smt_root, event_count, de_tx_hash, created_at, verified_at";
    const CP_INSERT_COLS = "id, sequence_start, sequence_end, smt_root, event_count, de_tx_hash, created_at";

    this.stmts = {
      getManifestsByType: this.db.prepare("SELECT id, content_hash, file_path, captured_at FROM config_manifests WHERE manifest_type = ?"),
      upsertManifest: this.db.prepare(
        `INSERT INTO config_manifests (id, manifest_type, content_hash, file_path, captured_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET manifest_type = excluded.manifest_type, content_hash = excluded.content_hash, captured_at = excluded.captured_at`,
      ),
      deleteManifest: this.db.prepare("DELETE FROM config_manifests WHERE id = ?"),
      getCheckpoints: this.db.prepare(`SELECT ${CP_COLS} FROM integrity_checkpoints ORDER BY sequence_start ASC`),
      getLastCheckpoint: this.db.prepare(`SELECT ${CP_COLS} FROM integrity_checkpoints ORDER BY sequence_end DESC LIMIT 1`),
      getUnverifiedCheckpoints: this.db.prepare(
        `SELECT ${CP_COLS} FROM integrity_checkpoints
         WHERE de_tx_hash IS NOT NULL AND verified_at IS NULL
         ORDER BY sequence_start ASC`,
      ),
      markCheckpointVerified: this.readOnly
        ? this.db.prepare("SELECT 1 WHERE 0")
        : this.db.prepare("UPDATE integrity_checkpoints SET verified_at = ? WHERE id = ?"),
      insertCheckpoint: this.db.prepare(
        `INSERT INTO integrity_checkpoints (${CP_INSERT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      countSince: this.db.prepare("SELECT COUNT(*) as c FROM audit_events WHERE sequence >= ?"),
      maxSequenceSince: this.db.prepare("SELECT MAX(sequence) as seq FROM audit_events WHERE sequence >= ?"),
      getOldestCreatedAt: this.db.prepare("SELECT MIN(created_at) AS t FROM audit_events"),
      getServiceHealth: this.db.prepare("SELECT payload, updated_at FROM service_health WHERE name = ?"),
      // Upsert is unused in read-only mode but the prepared statement is a
      // property; bind it to a no-op SELECT so the type stays satisfied
      // without opening write capabilities.
      upsertServiceHealth: this.readOnly
        ? this.db.prepare("SELECT 1 WHERE 0")
        : this.db.prepare(
            `INSERT INTO service_health (name, payload, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
          ),
      countCheckpointsSince: this.db.prepare("SELECT COUNT(*) AS c FROM integrity_checkpoints WHERE created_at >= ?"),

      // Report aggregations. All windowed on created_at and grouped on
      // json_extract paths; the (event_type, created_at) and (category,
      // created_at) compound indexes (schema v5) keep these as
      // index-range scans rather than full table scans.
      aggActivityByCategory: this.db.prepare(`
        SELECT category, COUNT(*) AS c
        FROM audit_events
        WHERE created_at >= @fromIso AND created_at < @toIso
        GROUP BY category
        ORDER BY c DESC
      `),
      aggCronByEventType: this.db.prepare(`
        SELECT event_type, COUNT(*) AS c
        FROM audit_events
        WHERE category = 'cron'
          AND created_at >= @fromIso AND created_at < @toIso
        GROUP BY event_type
      `),
      // Filter NULL tool names to match distinctToolNames below. Without this,
      // the first-seen-tool detector compares a today-set that contains a
      // synthetic "<unknown>" bucket against a prior-set that doesn't,
      // flagging `<unknown>` as first-seen on every report that has even one
      // tool.invoked event with missing metadata.toolName.
      aggToolInvocations: this.db.prepare(`
        SELECT json_extract(metadata, '$.toolName') AS tool_name,
               COUNT(*) AS invocations
        FROM audit_events
        WHERE event_type = 'tool.invoked'
          AND created_at >= @fromIso AND created_at < @toIso
          AND json_extract(metadata, '$.toolName') IS NOT NULL
        GROUP BY tool_name
        ORDER BY invocations DESC
      `),
      aggLlmUsage: this.db.prepare(`
        SELECT json_extract(metadata, '$.model')    AS model,
               json_extract(metadata, '$.provider') AS provider,
               COUNT(*) AS call_count,
               COALESCE(SUM(CAST(json_extract(metadata, '$.inputTokens')    AS INTEGER)), 0) AS input_tokens,
               COALESCE(SUM(CAST(json_extract(metadata, '$.outputTokens')   AS INTEGER)), 0) AS output_tokens,
               COALESCE(SUM(CAST(COALESCE(json_extract(metadata, '$.cacheReadTokens'),
                                          json_extract(metadata, '$.cacheTokens')) AS INTEGER)), 0) AS cache_tokens,
               COALESCE(SUM(CAST(json_extract(metadata, '$.cacheWriteTokens') AS INTEGER)), 0) AS cache_write_tokens,
               COALESCE(SUM(CAST(json_extract(metadata, '$.costUsd') AS REAL)), 0) AS cost_usd
        FROM audit_events
        WHERE event_type = 'prompt.response'
          AND created_at >= @fromIso AND created_at < @toIso
        GROUP BY model, provider
        ORDER BY cost_usd DESC
      `),
      aggMessageSentByChannel: this.db.prepare(`
        SELECT json_extract(metadata, '$.channel') AS channel,
               COUNT(*) AS c
        FROM audit_events
        WHERE event_type = 'message.sent'
          AND created_at >= @fromIso AND created_at < @toIso
        GROUP BY channel
        ORDER BY c DESC
      `),
      distinctToolNames: this.db.prepare(`
        SELECT DISTINCT json_extract(metadata, '$.toolName') AS tool_name
        FROM audit_events
        WHERE event_type = 'tool.invoked'
          AND created_at >= @fromIso AND created_at < @toIso
          AND json_extract(metadata, '$.toolName') IS NOT NULL
      `),
      reportFooterLastEvent: this.db.prepare(`
        SELECT id, sequence, content_hash, created_at
        FROM audit_events
        ORDER BY sequence DESC
        LIMIT 1
      `),
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
      log.error(`Database corrupt or unreadable: ${message}`);
      log.error("Preserving old DB and creating fresh database");

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
        log.warn(`Old database preserved at ${backupPath}`);
      } catch {
        log.error("Failed to rename corrupt DB, overwriting");
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
      log.warn("append() called on a read-only store; dropping event");
      return undefined;
    }
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
      // holds a structured object describing what was truncated:
      //   { metadata?: { reason, originalSize? }, content?: { reason, originalSize } }
      // Both arms are optional and independent — content truncation is
      // recorded inside the user's metadata, while metadata truncation
      // replaces the whole metadata blob. A future "both truncated" event
      // collapses to a marker-only metadata that still carries the content
      // arm. Consumers detect truncation via `"$auditTruncation" in metadata`
      // and read whichever arms are present.
      // Empty-string content collapses to "no content" (same as `undefined`)
      // so callers that explicitly clear content and callers that omit it
      // produce observationally identical events. Both hash to sha256("").
      const hasContent = !!insert.content;
      const contentOversize = hasContent && insert.content!.length > MAX_CONTENT_SIZE;
      const rawContent = hasContent && !contentOversize ? insert.content : undefined;
      if (contentOversize) {
        log.warn(
          `[audit-plugin] Content exceeds ${MAX_CONTENT_SIZE} bytes, storing event with truncation marker`,
        );
      }
      const contentTruncationArm: Record<string, unknown> | undefined = contentOversize
        ? { reason: "size-cap", originalSize: insert.content!.length }
        : undefined;

      // Fold the content-truncation arm (if any) into the user's metadata
      // before canonicalization, so a normal-sized metadata blob carries
      // evidence of the dropped content. If user metadata is itself
      // unserializable or oversize, both fallback branches below preserve
      // the content arm in the replacement marker.
      let effectiveMetadata: Record<string, unknown> = contentTruncationArm
        ? { ...insert.metadata, $auditTruncation: { content: contentTruncationArm } }
        : insert.metadata;
      let metadataCanonical: string;
      try {
        metadataCanonical = sdk.canonicalize(effectiveMetadata);
      } catch {
        log.warn("[audit-plugin] Metadata is not serializable, recording marker");
        effectiveMetadata = {
          $auditTruncation: {
            metadata: { reason: "non-serializable" },
            ...(contentTruncationArm ? { content: contentTruncationArm } : {}),
          },
        };
        metadataCanonical = sdk.canonicalize(effectiveMetadata);
      }

      if (metadataCanonical.length > MAX_METADATA_SIZE) {
        // Sender-controlled fields (messageId, sourcePath, requestedSpecifier,
        // etc.) could otherwise erase the very event that records the abuse.
        log.warn(
          `Metadata exceeds ${MAX_METADATA_SIZE} bytes, recording event with truncated metadata`,
        );
        effectiveMetadata = {
          $auditTruncation: {
            metadata: { reason: "size-cap", originalSize: metadataCanonical.length },
            ...(contentTruncationArm ? { content: contentTruncationArm } : {}),
          },
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

      const createdAt = new Date().toISOString();

      const contentGz = rawContent ? gzipSync(Buffer.from(rawContent), { level: 1 }) : null;

      // Chain integrity (Product Spec §11.3): contentHash hashes the stored
      // content; previousHash is the prior event's contentHash, looked up
      // by a scalar subquery inside the INSERT so that the read of the
      // predecessor and the write of the new row are atomic with respect
      // to other writers. RETURNING gives us back the value SQLite linked
      // to so we can populate the in-memory AuditEvent without a re-read.
      const contentHash = sha256(rawContent ?? "");

      const returned = this.insertStmt.get({
        id,
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
        contentHash,
        createdAt,
      }) as { sequence: number; previous_hash: string | null } | undefined;

      if (!returned) {
        throw new Error("INSERT ... RETURNING produced no row");
      }
      const sequence = returned.sequence;
      const previousHash = returned.previous_hash ?? undefined;

      this.degraded = false;

      return {
        id,
        sequence,
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
        contentHash,
        previousHash,
        createdAt,
      };
    } catch (err) {
      this.degraded = true;
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(
        `[audit-plugin][store=${this.instanceId}] Failed to append event (${insert.eventType}): ${message}`,
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
    if (opts.createdAfter !== undefined) {
      conditions.push("created_at >= @createdAfter");
      params.createdAfter = opts.createdAfter;
    }
    if (opts.createdBefore !== undefined) {
      conditions.push("created_at <= @createdBefore");
      params.createdBefore = opts.createdBefore;
    }
    // IN filters: bind each value to a numbered param so prepared statements
    // stay parameterised. Empty arrays produce a non-matching `1 = 0` so the
    // caller's "filter to nothing" intent is preserved (rather than silently
    // dropping the constraint).
    if (opts.categoryIn) {
      if (opts.categoryIn.length === 0) {
        conditions.push("1 = 0");
      } else {
        const placeholders = opts.categoryIn.map((_, i) => `@categoryIn${i}`);
        conditions.push(`category IN (${placeholders.join(", ")})`);
        opts.categoryIn.forEach((v, i) => { params[`categoryIn${i}`] = v; });
      }
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
                content_hash, previous_hash,
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

  getById(id: string, opts: { includeContent?: boolean } = {}): AuditEvent | undefined {
    const wantContent = opts.includeContent === true;
    const contentCol = wantContent ? ", content_gz" : "";
    const row = this.db
      .prepare(
        `SELECT id, sequence, source, machine_id, session_id, org_id, user_id,
                event_type, category, description, metadata${contentCol},
                created_at, received_at, synced_at
         FROM audit_events WHERE id = @id`,
      )
      .get({ id }) as unknown as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
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
        // When the table is empty after pruning, fall back to the
        // highest-ever-assigned sequence from sqlite_sequence so that every
        // remaining checkpoint is treated as orphaned.
        const seqRow = this.db
          .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'")
          .get() as { seq: number } | undefined;
        const nextExpectedSeq = minAfter?.seq ?? (seqRow?.seq ?? 0) + 1;

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

  getDbSizeMb(): number {
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    return (pageSize * pageCount) / (1024 * 1024);
  }

  getOldestCreatedAt(): string | undefined {
    const row = this.stmts.getOldestCreatedAt.get() as { t: string | null } | undefined;
    return row?.t ?? undefined;
  }

  upsertServiceHealth(name: string, payload: unknown): void {
    if (this.readOnly) return;
    this.stmts.upsertServiceHealth.run(name, JSON.stringify(payload), new Date().toISOString());
  }

  getServiceHealth(name: string): { payload: unknown; updatedAt: string } | undefined {
    const row = this.stmts.getServiceHealth.get(name) as { payload: string; updated_at: string } | undefined;
    if (!row) return undefined;
    // Defensive parse: a corrupt or tampered service_health row must not
    // crash the read-only CLI reader. Treat parse failure as "no snapshot."
    try {
      return { payload: JSON.parse(row.payload), updatedAt: row.updated_at };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log.warn(`service_health payload parse failed for '${name}': ${msg}`);
      return undefined;
    }
  }

  countCheckpointsSince(isoTime: string): number {
    return (this.stmts.countCheckpointsSince.get(isoTime) as { c: number }).c;
  }

  // --- Config manifest operations (used by ConfigWatcher and FileWatcher) ---

  getManifestsByType(manifestType: string): Array<{ id: string; contentHash: string; filePath: string | null; capturedAt: string }> {
    return (this.stmts.getManifestsByType.all(manifestType) as Array<{ id: string; content_hash: string; file_path: string | null; captured_at: string }>)
      .map((r) => ({ id: r.id, contentHash: r.content_hash, filePath: r.file_path, capturedAt: r.captured_at }));
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

  getUnverifiedCheckpoints(): CheckpointRecord[] {
    return (this.stmts.getUnverifiedCheckpoints.all() as unknown as CheckpointRow[]).map(rowToCheckpoint);
  }

  markCheckpointVerified(id: string): void {
    if (this.readOnly) return;
    this.stmts.markCheckpointVerified.run(new Date().toISOString(), id);
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

  // --- Report aggregations (used by `audit report daily|weekly`) ---

  aggregateActivityByCategoryInWindow(fromIso: string, toIso: string): Array<{ category: string; count: number }> {
    const rows = this.stmts.aggActivityByCategory.all({ fromIso, toIso }) as Array<{ category: string; c: number }>;
    return rows.map((r) => ({ category: r.category, count: r.c }));
  }

  aggregateCronByEventTypeInWindow(fromIso: string, toIso: string): Array<{ eventType: string; count: number }> {
    const rows = this.stmts.aggCronByEventType.all({ fromIso, toIso }) as Array<{ event_type: string; c: number }>;
    return rows.map((r) => ({ eventType: r.event_type, count: r.c }));
  }

  aggregateToolInvocationsInWindow(fromIso: string, toIso: string): Array<{ toolName: string; invocations: number }> {
    // SQL filters NULL toolNames; the result rows always have a string name.
    const rows = this.stmts.aggToolInvocations.all({ fromIso, toIso }) as Array<{ tool_name: string; invocations: number }>;
    return rows.map((r) => ({ toolName: r.tool_name, invocations: r.invocations }));
  }

  aggregateLlmUsageInWindow(fromIso: string, toIso: string): Array<{
    model: string;
    provider: string | null;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  }> {
    const rows = this.stmts.aggLlmUsage.all({ fromIso, toIso }) as Array<{
      model: string | null;
      provider: string | null;
      call_count: number;
      input_tokens: number;
      output_tokens: number;
      cache_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
    }>;
    return rows.map((r) => ({
      model: r.model ?? "<unknown>",
      provider: r.provider,
      callCount: r.call_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheTokens: r.cache_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      costUsd: r.cost_usd,
    }));
  }

  aggregateMessageSentByChannelInWindow(fromIso: string, toIso: string): Array<{ channel: string; count: number }> {
    const rows = this.stmts.aggMessageSentByChannel.all({ fromIso, toIso }) as Array<{ channel: string | null; c: number }>;
    return rows.map((r) => ({ channel: r.channel ?? "<unknown>", count: r.c }));
  }

  distinctToolNamesInWindow(fromIso: string, toIso: string): string[] {
    const rows = this.stmts.distinctToolNames.all({ fromIso, toIso }) as Array<{ tool_name: string }>;
    return rows.map((r) => r.tool_name);
  }

  getReportLastEvent(): { id: string; sequence: number; contentHash: string; createdAt: string } | undefined {
    const row = this.stmts.reportFooterLastEvent.get() as
      | { id: string; sequence: number; content_hash: string; created_at: string }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, sequence: row.sequence, contentHash: row.content_hash, createdAt: row.created_at };
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  close(): void {
    this.db.close();
  }
}
