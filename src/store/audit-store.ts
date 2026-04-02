import Database from "better-sqlite3";
import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { uuidv7 } from "uuidv7";

import type { AuditEvent, AuditEventInsert } from "../types/events.js";
import { initializeSchema } from "./schema.js";
import { computeEventHash, canonicalize } from "../util/hash.js";
import { getMachineId } from "../util/machine-id.js";

const GENESIS_HASH = "GENESIS";
const MAX_METADATA_SIZE = 1024 * 1024; // 1MB
const DB_FILE_MODE = 0o600;

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
         event_type, category, description, metadata, content_hash, previous_hash, created_at)
      VALUES
        (@id, @sequence, @source, @machineId, @sessionId, @orgId, @userId,
         @eventType, @category, @description, @metadata, @contentHash, @previousHash, @createdAt)
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
        contentHash,
        previousHash,
        createdAt,
      });

      // Only update in-memory state after successful INSERT
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

  isDegraded(): boolean {
    return this.degraded;
  }

  close(): void {
    this.db.close();
  }
}
