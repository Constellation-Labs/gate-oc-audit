import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TreeManager } from "../../src/store/smt-tree-manager.js";

describe("TreeManager", () => {
  it("checkpoint and restore round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-test-"));
    try {
      const tm1 = new TreeManager();
      const store = tm1.getOrCreate("test-tree");
      store.add("aabb01", "cc11dd22");
      const rootBefore = store.getRoot();

      await tm1.checkpointAll(dir);

      const tm2 = new TreeManager();
      await tm2.restoreAll(dir);

      const restored = tm2.get("test-tree");
      assert.ok(restored, "tree should be restored");
      assert.equal(restored!.getRoot(), rootBefore);
      assert.equal(restored!.get("aabb01"), "cc11dd22");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists and recovers lastInsertedSeq inside the tree DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-cursor-"));
    try {
      const tm1 = new TreeManager();
      tm1.getOrCreate("t").add("aabb01", "cc11dd22");
      await tm1.checkpointAll(dir, 42);

      const tm2 = new TreeManager();
      await tm2.restoreAll(dir);
      assert.deepEqual(tm2.getRestoredCursor(), { hasCursor: true, cursor: 42 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no cursor when checkpointed without one (legacy DB)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-cursor-legacy-"));
    try {
      const tm1 = new TreeManager();
      tm1.getOrCreate("t").add("aabb01", "cc11dd22");
      await tm1.checkpointAll(dir); // no cursor passed

      const tm2 = new TreeManager();
      await tm2.restoreAll(dir);
      assert.deepEqual(tm2.getRestoredCursor(), { hasCursor: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forces cursor=0 when no trees were on disk", async () => {
    // Operator deleted the .db files but a sibling _metadata.json may still
    // claim a high lastInsertedSeq. The SMT is in fact empty, so the caller
    // must replay from the start; reporting hasCursor: true with cursor 0
    // overrides whatever the JSON says.
    const dir = mkdtempSync(join(tmpdir(), "tm-cursor-empty-"));
    try {
      const tm = new TreeManager();
      await tm.restoreAll(dir);
      assert.deepEqual(tm.getRestoredCursor(), { hasCursor: true, cursor: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forces cursor=0 when the checkpoint directory does not exist", async () => {
    const tm = new TreeManager();
    await tm.restoreAll(join(tmpdir(), "tm-cursor-missing-" + Date.now()));
    assert.deepEqual(tm.getRestoredCursor(), { hasCursor: true, cursor: 0 });
  });

  it("takes the min cursor across trees when checkpoints disagree", async () => {
    // Simulate a half-failed checkpoint: tree A advanced to seq 50, tree B
    // still records seq 30. The conservative choice is 30 so the next boot
    // re-replays the events tree B missed; re-inserting an existing leaf is
    // a set-semantics no-op so over-replay is safe.
    const dir = mkdtempSync(join(tmpdir(), "tm-cursor-disagree-"));
    try {
      const tmStale = new TreeManager();
      tmStale.getOrCreate("a").add("aabb01", "cc11dd22");
      tmStale.getOrCreate("b").add("aabb02", "cc11dd33");
      await tmStale.checkpointAll(dir, 30);

      // Re-checkpoint only tree "a" with a newer cursor by isolating it.
      const tmA = new TreeManager();
      tmA.getOrCreate("a").add("aabb01", "cc11dd22");
      await tmA.checkpointAll(dir, 50);

      const tmRestore = new TreeManager();
      await tmRestore.restoreAll(dir);
      assert.deepEqual(tmRestore.getRestoredCursor(), { hasCursor: true, cursor: 30 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
