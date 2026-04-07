import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SmtStore } from "../../src/store/smt-store.js";
import {
  encryptSnapshot,
  decryptSnapshot,
  getSnapshotBlob,
  serializeSmtState,
  deserializeSmtState,
} from "../../src/services/smt-snapshot.js";

describe("SMT Snapshot Crypto", () => {
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

  describe("encrypt/decrypt", () => {
    it("round-trips with correct passphrase", () => {
      const store = new SmtStore();
      store.add("aa01", "bb01");
      store.add("aa02", "bb02");

      const nodes = store.getNodes();
      const root = store.getRoot();
      const passphrase = "test-passphrase-123";

      const encrypted = encryptSnapshot(nodes, root, passphrase, {
        treeKey: "test-tree",
        entryCount: 2,
        nodeCount: nodes.size,
        root,
        createdAt: new Date().toISOString(),
      });

      assert.equal(encrypted.version, 1);
      assert.ok(encrypted.salt);
      assert.ok(encrypted.iv);
      assert.ok(encrypted.tag);
      assert.ok(encrypted.ciphertext);
      assert.ok(encrypted.contentHash);
      assert.equal(encrypted.meta.treeKey, "test-tree");
      assert.equal(encrypted.meta.entryCount, 2);

      const decrypted = decryptSnapshot(encrypted, passphrase);
      assert.equal(decrypted.root, root);
      assert.equal(decrypted.nodes.size, nodes.size);

      // Verify SMT can be restored from decrypted state
      const store2 = new SmtStore();
      store2.restoreFromState(decrypted.nodes, decrypted.root);
      assert.equal(store2.getRoot(), root);
      assert.equal(store2.get("aa01"), "bb01");
    });

    it("fails with wrong passphrase", () => {
      const store = new SmtStore();
      store.add("aa01", "bb01");

      const encrypted = encryptSnapshot(
        store.getNodes(),
        store.getRoot(),
        "correct-passphrase",
        {
          treeKey: "t",
          entryCount: 1,
          nodeCount: 1,
          root: store.getRoot(),
          createdAt: new Date().toISOString(),
        },
      );

      assert.throws(() => {
        decryptSnapshot(encrypted, "wrong-passphrase");
      });
    });

    it("detects tampered ciphertext", () => {
      const store = new SmtStore();
      store.add("aa01", "bb01");

      const encrypted = encryptSnapshot(
        store.getNodes(),
        store.getRoot(),
        "pass",
        {
          treeKey: "t",
          entryCount: 1,
          nodeCount: 1,
          root: store.getRoot(),
          createdAt: new Date().toISOString(),
        },
      );

      // Tamper with contentHash
      const tampered = { ...encrypted, contentHash: "0".repeat(64) };
      assert.throws(
        () => decryptSnapshot(tampered, "pass"),
        /Content hash mismatch/,
      );
    });
  });

  describe("getSnapshotBlob", () => {
    it("returns a Buffer with content hash", () => {
      const store = new SmtStore();
      store.add("aa01", "bb01");

      const encrypted = encryptSnapshot(
        store.getNodes(),
        store.getRoot(),
        "pass",
        {
          treeKey: "t",
          entryCount: 1,
          nodeCount: 1,
          root: store.getRoot(),
          createdAt: new Date().toISOString(),
        },
      );

      const { blob, contentHash, mimeType } = getSnapshotBlob(encrypted);
      assert.ok(Buffer.isBuffer(blob));
      assert.ok(blob.length > 0);
      assert.equal(contentHash.length, 64);
      assert.equal(mimeType, "application/json");
    });
  });
});
