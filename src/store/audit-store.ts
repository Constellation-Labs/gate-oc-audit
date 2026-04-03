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

  private pendingPruneStmt: Database.Statement;
  private clearPruneStmt: Database.Statement;

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

    this.pendingPruneStmt = this.db.prepare(
      "SELECT value FROM sync_state WHERE key = 'pending_prune_checkpoint'",
    );
    this.clearPruneStmt = this.db.prepare(
      "DELETE FROM sync_state WHERE key = 'pending_prune_checkpoint'",
    );

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

      // If a prune happened since the last append, bake the checkpoint into this
      // event's metadata so it becomes part of the hash chain and can't be forged.
      const pendingPrune = this.pendingPruneStmt.get() as { value: string } | undefined;
      const metadata = pendingPrune
        ? { ...insert.metadata, _pruneCheckpoint: JSON.parse(pendingPrune.value) }
        : insert.metadata;

      let metadataCanonical: string;
      try {
        metadataCanonical = canonicalize(metadata);
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
        contentHash,
        previousHash,
        createdAt,
      });

      if (pendingPrune) {
        this.clearPruneStmt.run();
      }

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
        metadata,
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
        `SELECT id, sequence, source, machine_id, session_id, org_id, user_id,
                event_type, category, description, metadata, content_hash,
                previous_hash, created_at, received_at, synced_at
         FROM audit_events ${where} ORDER BY sequence DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as EventRow[];

    return rows.map(rowToEvent);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM audit_events").get() as { c: number }).c;
  }

  verify(): VerifyResult {
    const iter = this.db
      .prepare(
        "SELECT id, sequence, source, session_id, org_id, user_id, event_type, category, description, metadata, content_hash, previous_hash FROM audit_events ORDER BY sequence ASC",
      )
      .iterate() as IterableIterator<{
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

    // Soft checkpoint in sync_state (covers the window between prune and next append)
    const softCheckpoint = this.db
      .prepare("SELECT value FROM sync_state WHERE key = 'last_prune_before_seq'")
      .get() as { value: string } | undefined;
    const softPruneSeq = softCheckpoint ? parseInt(softCheckpoint.value, 10) : undefined;

    let i = 0;
    let prevContentHash: string | undefined;

    for (const row of iter) {
      if (i === 0 && row.previous_hash !== GENESIS_HASH) {
        // Chain doesn't start at GENESIS — check for prune evidence.
        // Hard proof: _pruneCheckpoint baked into this event's metadata (tamper-evident).
        // Soft proof: last_prune_before_seq in sync_state (covers pre-append window).
        const meta = JSON.parse(row.metadata);
        const hardCheckpoint = meta._pruneCheckpoint?.prunedBeforeSeq;
        const hasProof =
          (hardCheckpoint != null && hardCheckpoint <= row.sequence) ||
          (softPruneSeq != null && softPruneSeq === row.sequence);

        if (!hasProof) {
          return {
            valid: false,
            eventsChecked: 1,
            brokenAt: row.sequence,
            error: `First event does not link to GENESIS and no matching prune checkpoint found`,
          };
        }
      }

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

      if (prevContentHash !== undefined && row.previous_hash !== prevContentHash) {
        return {
          valid: false,
          eventsChecked: i + 1,
          brokenAt: row.sequence,
          error: `Chain link broken at sequence ${row.sequence}`,
        };
      }

      prevContentHash = row.content_hash;
      i++;
    }

    return { valid: true, eventsChecked: i };
  }

  prune(maxAgeDays: number, maxSizeMb: number): number {
    let totalDeleted = 0;

    const doPrune = this.db.transaction(() => {
      // Age-based pruning
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const ageResult = this.db
        .prepare("DELETE FROM audit_events WHERE created_at < @cutoff")
        .run({ cutoff });
      totalDeleted += ageResult.changes;

      // Size-based pruning — delete oldest events until under limit
      if (this.getDbSizeMb() > maxSizeMb) {
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
      }

      // Write a pending prune checkpoint — the next append() will bake it into
      // the hash chain, making it tamper-evident.
      if (totalDeleted > 0) {
        const minAfter = this.db
          .prepare("SELECT MIN(sequence) as seq FROM audit_events")
          .get() as { seq: number | null } | undefined;

        // If all events were pruned, the next append will be at sequence + 1
        const nextExpectedSeq = minAfter?.seq ?? this.sequence + 1;
        const checkpoint = {
          prunedBeforeSeq: nextExpectedSeq,
          prunedAt: new Date().toISOString(),
          eventsDeleted: totalDeleted,
        };
        this.db.prepare(
          "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('pending_prune_checkpoint', ?)",
        ).run(JSON.stringify(checkpoint));

        // Also keep the seq for verify() to use before the next append lands
        this.db.prepare(
          "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_prune_before_seq', ?)",
        ).run(String(nextExpectedSeq));
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

  isDegraded(): boolean {
    return this.degraded;
  }

  close(): void {
    this.db.close();
  }
}
