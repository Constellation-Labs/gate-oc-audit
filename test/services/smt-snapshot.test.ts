import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SmtStore } from "../../src/store/smt-store.js";
import {
  createSnapshot,
  restoreSnapshot,
  getSnapshotBlob,
  serializeSmtState,
  deserializeSmtState,
} from "../../src/services/smt-snapshot.js";

describe("SMT Snapshot", () => {
  describe("serialize/deserialize", () => {
    it("round-trips SMT state", () => {
      const nodes = new Map<string, string[]>();
      nodes.set("abc", ["left", "right"]);
      nodes.set("def", ["key", "val", "1"]);
      const root = "root-hash";

      const serialized = serializeSmtState(nodes, root);
      const { root: restoredRoot, nodes: restoredNodes } = deserializeSmtState(serialized);

      assert.equal(restoredRoot, root);
      assert.deepEqual(restoredNodes.get("abc"), ["left", "right"]);
      assert.deepEqual(restoredNodes.get("def"), ["key", "val", "1"]);
    });
  });

  describe("create/restore", () => {
    it("round-trips SMT state", () => {
      const store = new SmtStore();
      store.add("aa01", "bb01");
      store.add("aa02", "bb02");

      const nodes = store.getNodes();
      const root = store.getRoot();

      const snapshot = createSnapshot(nodes, root, {
        treeKey: "test-tree",
        entryCount: 2,
        nodeCount: nodes.size,
        root,
        createdAt: new Date().toISOString(),
      });

      assert.equal(snapshot.version, 1);
      assert.ok(snapshot.data);
      assert.ok(snapshot.contentHash);
      assert.equal(snapshot.meta.treeKey, "test-tree");
      assert.equal(snapshot.meta.entryCount, 2);

      const restored = restoreSnapshot(snapshot);
      assert.equal(restored.root, root);
      assert.equal(restored.nodes.size, nodes.size);

      // Verify SMT can be restored from snapshot state
      const store2 = new SmtStore();
      store2.restoreFromState(restored.nodes, restored.root);
      assert.equal(store2.getRoot(), root);
      assert.equal(store2.get("aa01"), "bb01");
    });

    it("detects tampered data", () => {
      const store = new SmtStore();
      store.add("aa01", "bb01");

      const snapshot = createSnapshot(
        store.getNodes(),
        store.getRoot(),
        {
          treeKey: "t",
          entryCount: 1,
          nodeCount: 1,
          root: store.getRoot(),
          createdAt: new Date().toISOString(),
        },
      );

      const tampered = { ...snapshot, contentHash: "0".repeat(64) };
      assert.throws(
        () => restoreSnapshot(tampered),
        /Content hash mismatch/,
      );
    });
  });

  describe("getSnapshotBlob", () => {
    it("returns a Buffer with content hash", () => {
      const store = new SmtStore();
      store.add("aa01", "bb01");

      const snapshot = createSnapshot(
        store.getNodes(),
        store.getRoot(),
        {
          treeKey: "t",
          entryCount: 1,
          nodeCount: 1,
          root: store.getRoot(),
          createdAt: new Date().toISOString(),
        },
      );

      const { blob, contentHash, mimeType } = getSnapshotBlob(snapshot);
      assert.ok(Buffer.isBuffer(blob));
      assert.ok(blob.length > 0);
      assert.equal(contentHash.length, 64);
      assert.equal(mimeType, "application/json");
    });
  });
});
