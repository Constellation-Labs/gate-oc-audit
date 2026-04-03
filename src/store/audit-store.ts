import Database from "better-sqlite3";
import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { uuidv7 } from "uuidv7";

import type { AuditEvent, AuditEventInsert, EventType, EventCategory } from "../types/events.js";
import { initializeSchema } from "./schema.js";
import { computeEventHash, canonicalize } from "../util/hash.js";
import { getMachineId } from "../util/machine-id.js";

const GENESIS_HASH = "GENESIS";
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
}

export interface VerifyResult {
  valid: boolean;
  eventsChecked: number;
  brokenAt?: number;
  error?: string;
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
  content_gz: Buffer | null;
  content_hash: string;
  previous_hash: string;
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
    contentGz: row.content_gz ?? undefined,
    contentHash: row.content_hash,
    previousHash: row.previous_hash,
    createdAt: row.created_at,
    receivedAt: row.received_at ?? undefined,
    syncedAt: row.synced_at ?? undefined,
  };
}

export class AuditStore {
  private db: Database.Database;
  private sequence: number;
  private previousHash: string;
  private machineId: string;
  private degraded = false;
  private insertStmt: Database.Statement;

  constructor(dbPath = "~/.openclaw/audit.db") {
    const resolvedPath = dbPath.replace(/^~/, process.env.HOME ?? ".");
    mkdirSync(dirname(resolvedPath), { recursive: true });

    const isNew = !existsSync(resolvedPath);
    this.db = new Database(resolvedPath);
    if (isNew) chmodSync(resolvedPath, DB_FILE_MODE);

    initializeSchema(this.db);
    this.machineId = getMachineId();

    const lastRow = this.db
      .prepare("SELECT sequence, content_hash FROM audit_events ORDER BY sequence DESC LIMIT 1")
      .get() as { sequence: number; content_hash: string } | undefined;

    this.sequence = lastRow?.sequence ?? 0;
    this.previousHash = lastRow?.content_hash ?? GENESIS_HASH;

    this.insertStmt = this.db.prepare(`
      INSERT INTO audit_events
        (id, sequence, source, machine_id, session_id, org_id, user_id,
         event_type, category, description, metadata, content_gz, content_hash, previous_hash, created_at)
      VALUES
        (@id, @sequence, @source, @machineId, @sessionId, @orgId, @userId,
         @eventType, @category, @description, @metadata, @contentGz, @contentHash, @previousHash, @createdAt)
    `);
  }

  append(insert: AuditEventInsert): AuditEvent | undefined {
    try {
      const id = uuidv7();
      const source = insert.source ?? "openclaw-plugin";

      let metadataCanonical: string;
      try {
        metadataCanonical = canonicalize(insert.metadata);
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

      const previousHash = this.previousHash;
      const nextSequence = this.sequence + 1;
      const createdAt = new Date().toISOString();

      const contentHash = computeEventHash({
        id,
        sequence: nextSequence,
        previousHash,
        source,
        sessionId: insert.sessionId,
        orgId: insert.orgId,
        userId: insert.userId,
        eventType: insert.eventType,
        category: insert.category,
        description: insert.description,
        metadataCanonical,
      });

      const rawContent = insert.content && insert.content.length <= MAX_CONTENT_SIZE
        ? insert.content
        : undefined;
      const contentGz = rawContent ? gzipSync(Buffer.from(rawContent)) : null;

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
        contentHash,
        previousHash,
        createdAt,
      });

      this.sequence = nextSequence;
      this.previousHash = contentHash;
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
        contentHash,
        previousHash,
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

    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events ${where} ORDER BY sequence DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as EventRow[];

    return rows.map(rowToEvent);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM audit_events").get() as { c: number }).c;
  }

  verify(): VerifyResult {
    const rows = this.db
      .prepare(
        "SELECT id, sequence, source, session_id, org_id, user_id, event_type, category, description, metadata, content_hash, previous_hash FROM audit_events ORDER BY sequence ASC",
      )
      .all() as Array<{
      id: string;
      sequence: number;
      source: string;
      session_id: string | null;
      org_id: string | null;
      user_id: string | null;
      event_type: string;
      category: string;
      description: string;
      metadata: string;
      content_hash: string;
      previous_hash: string;
    }>;

    if (rows.length === 0) return { valid: true, eventsChecked: 0 };

    // First event must link to GENESIS
    if (rows[0].previous_hash !== GENESIS_HASH) {
      return { valid: false, eventsChecked: 1, brokenAt: rows[0].sequence, error: "First event does not link to GENESIS" };
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const expectedHash = computeEventHash({
        id: row.id,
        sequence: row.sequence,
        previousHash: row.previous_hash,
        source: row.source,
        sessionId: row.session_id ?? undefined,
        orgId: row.org_id ?? undefined,
        userId: row.user_id ?? undefined,
        eventType: row.event_type,
        category: row.category,
        description: row.description,
        metadataCanonical: row.metadata,
      });

      if (row.content_hash !== expectedHash) {
        return {
          valid: false,
          eventsChecked: i + 1,
          brokenAt: row.sequence,
          error: `Content hash mismatch at sequence ${row.sequence}`,
        };
      }

      if (i > 0 && row.previous_hash !== rows[i - 1].content_hash) {
        return {
          valid: false,
          eventsChecked: i + 1,
          brokenAt: row.sequence,
          error: `Chain link broken at sequence ${row.sequence}`,
        };
      }
    }

    return { valid: true, eventsChecked: rows.length };
  }

  prune(maxAgeDays: number, maxSizeMb: number): number {
    let totalDeleted = 0;

    // Age-based pruning
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const ageResult = this.db
      .prepare("DELETE FROM audit_events WHERE created_at < @cutoff")
      .run({ cutoff });
    totalDeleted += ageResult.changes;

    // Size-based pruning — delete oldest events until under limit
    const sizeMb = this.getDbSizeMb();

    if (sizeMb > maxSizeMb) {
      let deleted = 0;
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

      // Reclaim disk space from deleted pages
      this.db.pragma("incremental_vacuum");
    }

    return totalDeleted;
  }

  private getDbSizeMb(): number {
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    return (pageSize * pageCount) / (1024 * 1024);
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  close(): void {
    this.db.close();
  }
}
