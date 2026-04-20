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
});
