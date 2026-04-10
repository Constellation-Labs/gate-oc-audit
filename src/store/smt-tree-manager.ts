/**
 * Multi-Tree Manager
 *
 * Manages multiple SmtStore instances keyed by string identifier.
 * Persistence via LevelDB — one sublevel per tree.
 */

import { SmtStore } from "./smt-store.js";
import { Level } from "level";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface TreeInfo {
  key: string;
  root: string;
  size: number;
  entryCount: number;
}

export class TreeManager {
  private trees: Map<string, SmtStore> = new Map();

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

  listTrees(): TreeInfo[] {
    const result: TreeInfo[] = [];
    for (const [key, store] of this.trees) {
      result.push({
        key,
        root: store.getRoot(),
        size: store.getSize(),
        entryCount: store.getEntryCount(),
      });
    }
    return result;
  }

  async checkpointAll(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });

    for (const [treeKey, store] of this.trees) {
      const snapshot = store.checkpoint();
      const dbPath = join(dir, treeKey);

      const db = new Level<string, string>(dbPath);
      try {
        // Clear stale node keys before writing the new snapshot.
        // Without this, pruned nodes would persist and corrupt state on restore.
        const batch = db.batch();
        for await (const key of db.keys()) {
          if (key.startsWith("n:")) {
            batch.del(key);
          }
        }

        batch.put("meta:root", snapshot.root);
        batch.put("meta:entryCount", String(store.getEntryCount()));

        for (const [nodeHash, children] of snapshot.nodes) {
          batch.put(`n:${nodeHash}`, JSON.stringify(children));
        }

        await batch.write();
      } finally {
        await db.close();
      }
    }
  }

  async restoreAll(dir: string): Promise<void> {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const treeKey = entry.name;
      const dbPath = join(dir, treeKey);

      let db: Level<string, string>;
      try {
        db = new Level<string, string>(dbPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[smt-tree-manager] Failed to open LevelDB at ${dbPath}: ${msg}`);
        continue;
      }

      try {
        const store = new SmtStore();
        const root = await db.get("meta:root");

        const nodes = new Map<string, string[]>();
        for await (const [key, value] of db.iterator()) {
          if (key.startsWith("n:")) {
            nodes.set(key.slice(2), JSON.parse(value));
          }
        }

        store.restore({ root, nodes });
        this.trees.set(treeKey, store);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[smt-tree-manager] Failed to restore tree "${treeKey}": ${msg}`);
      } finally {
        await db.close();
      }
    }
  }
}
