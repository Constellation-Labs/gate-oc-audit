/**
 * Multi-Tree Manager
 *
 * Manages multiple SmtStore instances keyed by string identifier.
 * Persistence via node:sqlite — one DB file per tree at `<dir>/<treeKey>.db`.
 */

import { SmtStore } from "./smt-store.js";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import {smtTreeManagerLog} from "../util/logger.js";
import { join } from "node:path";

const DB_SUFFIX = ".db";

export interface TreeInfo {
  key: string;
  root: string;
  size: number;
  entryCount: number;
  frozenCount: number;
}

export class TreeManager {
  private trees: Map<string, SmtStore> = new Map();
  // Per-tree cursor read from kv on restore. Lets the SmtService derive the
  // authoritative lastInsertedSeq from the trees themselves rather than from
  // a sibling JSON file that can drift if the tree DBs are rebuilt/wiped.
  private restoredCursors: Map<string, number> = new Map();

  getOrCreate(treeKey: string): SmtStore {
    let store = this.trees.get(treeKey);
    if (!store) {
      store = new SmtStore();
      this.trees.set(treeKey, store);
    }
    return store;
  }

  get(treeKey: string): SmtStore | undefined {
    return this.trees.get(treeKey);
  }

  totalNodeCount(): number {
    let total = 0;
    for (const store of this.trees.values()) {
      total += store.getSize();
    }
    return total;
  }

  /**
   * Replay cursor recovered from the tree DBs (key `meta:lastInsertedSeq`).
   *
   * - **No trees on disk** → `{ hasCursor: true, cursor: 0 }`. The SMT is
   *   empty; the caller must replay every audit event regardless of what a
   *   sibling JSON says. This is precisely the desync this coupling exists
   *   to defeat (operator deletes .db files but leaves _metadata.json).
   * - **Trees on disk but none carry the key** → `{ hasCursor: false }`.
   *   Legacy DBs that predate this key. The caller should defer to the JSON
   *   for this one boot; the next checkpoint populates the key and locks in
   *   the coupling.
   * - **At least one tree carries the key** → min across trees. A
   *   half-failed checkpoint that updated some trees but not others should
   *   cause over-replay (safe — `onEventAppended` short-circuits via
   *   `isFrozen`, and re-inserting an existing leaf is a set-semantics
   *   no-op) rather than under-replay (silent leaf gap).
   */
  getRestoredCursor(): { hasCursor: false } | { hasCursor: true; cursor: number } {
    if (this.trees.size === 0) return { hasCursor: true, cursor: 0 };
    if (this.restoredCursors.size === 0) return { hasCursor: false };
    let min = Infinity;
    for (const v of this.restoredCursors.values()) {
      if (v < min) min = v;
    }
    return { hasCursor: true, cursor: min };
  }

  listTrees(): TreeInfo[] {
    const result: TreeInfo[] = [];
    for (const [key, store] of this.trees) {
      result.push({
        key,
        root: store.getRoot(),
        size: store.getSize(),
        entryCount: store.getEntryCount(),
        frozenCount: store.getFrozenCount(),
      });
    }
    return result;
  }

  async checkpointAll(dir: string, lastInsertedSeq?: number): Promise<void> {
    mkdirSync(dir, { recursive: true });

    for (const [treeKey, store] of this.trees) {
      const snapshot = store.checkpoint();
      const dbPath = join(dir, treeKey + DB_SUFFIX);

      const db = new DatabaseSync(dbPath);
      try {
        db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

        const upsert = db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
        const del = db.prepare("DELETE FROM kv WHERE key = ?");
        const deleteNodes = db.prepare("DELETE FROM kv WHERE key LIKE 'n:%'");

        // Single transaction so the snapshot replaces atomically — no torn
        // state where stale n:% rows coexist with new ones. The cursor is
        // written here too so the replay high-water mark can never outlive
        // the tree contents it claims to describe.
        db.exec("BEGIN IMMEDIATE");
        try {
          deleteNodes.run();

          upsert.run("meta:root", snapshot.root);
          upsert.run("meta:entryCount", String(store.getEntryCount()));

          if (typeof lastInsertedSeq === "number") {
            upsert.run("meta:lastInsertedSeq", String(lastInsertedSeq));
          }

          const frozenKeys = store.getFrozenKeys();
          if (frozenKeys.size > 0) {
            upsert.run("meta:frozenKeys", JSON.stringify(Array.from(frozenKeys)));
          } else {
            del.run("meta:frozenKeys");
          }

          for (const [nodeHash, children] of snapshot.nodes) {
            upsert.run(`n:${nodeHash}`, JSON.stringify(children));
          }

          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } finally {
        db.close();
      }

      if (typeof lastInsertedSeq === "number") {
        this.restoredCursors.set(treeKey, lastInsertedSeq);
      }
    }
  }

  async restoreAll(dir: string): Promise<void> {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Directories are the old LevelDB layout. The on-disk format changed
      // in v0.2.0 — operators must clear stale checkpoint dirs (or accept
      // that the tree rebuilds from events on next checkpoint).
      if (entry.isDirectory()) {
        smtTreeManagerLog.warn(
          `Skipping legacy LevelDB checkpoint at "${entry.name}"; ` +
            `rebuild required (sqlite layout introduced in v0.2.0). ` +
            `Delete the directory to silence this warning.`,
        );
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(DB_SUFFIX)) continue;

      const treeKey = entry.name.slice(0, -DB_SUFFIX.length);
      const dbPath = join(dir, entry.name);

      let db: DatabaseSync;
      try {
        // Restore only reads; opening read-only avoids creating the DB on a
        // read-only filesystem and keeps the audit-CLI path free of write
        // capabilities by construction.
        db = new DatabaseSync(dbPath, { readOnly: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        smtTreeManagerLog.error(`Failed to open sqlite checkpoint at ${dbPath}: ${msg}`);
        continue;
      }

      try {
        const rootRow = db.prepare("SELECT value FROM kv WHERE key = ?").get("meta:root") as
          | { value: string }
          | undefined;
        if (!rootRow) {
          smtTreeManagerLog.warn(`Tree "${treeKey}" missing meta:root, skipping`);
          continue;
        }
        const root = rootRow.value;

        const nodes = new Map<string, string[]>();
        const nodeRows = db
          .prepare("SELECT key, value FROM kv WHERE key LIKE 'n:%' ORDER BY key")
          .all() as Array<{ key: string; value: string }>;
        for (const row of nodeRows) {
          nodes.set(row.key.slice(2), JSON.parse(row.value));
        }

        const frozenRow = db.prepare("SELECT value FROM kv WHERE key = ?").get("meta:frozenKeys") as
          | { value: string }
          | undefined;
        const frozenKeys = frozenRow ? (JSON.parse(frozenRow.value) as string[]) : undefined;

        const cursorRow = db.prepare("SELECT value FROM kv WHERE key = ?").get("meta:lastInsertedSeq") as
          | { value: string }
          | undefined;
        if (cursorRow) {
          const parsed = Number(cursorRow.value);
          if (Number.isFinite(parsed)) {
            this.restoredCursors.set(treeKey, parsed);
          }
        }

        const store = new SmtStore();
        store.restore({ root, nodes, frozenKeys });
        const inconsistency = store.shallowConsistencyCheck();
        if (inconsistency) {
          smtTreeManagerLog.warn(
            `Tree "${treeKey}" restored but looks inconsistent: ${inconsistency}. ` +
              `Proof generation will fail until the tree is rebuilt.`,
          );
        }
        this.trees.set(treeKey, store);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        smtTreeManagerLog.error(`Failed to restore tree "${treeKey}": ${msg}`);
      } finally {
        db.close();
      }
    }
  }
}
