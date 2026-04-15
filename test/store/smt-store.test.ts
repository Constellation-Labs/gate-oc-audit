import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SmtStore } from "../../src/store/smt-store.js";

describe("SmtStore", () => {
  it("starts with a non-empty root", () => {
    const store = new SmtStore();
    assert.ok(store.getRoot());
    assert.equal(store.getEntryCount(), 0);
  });

  it("add and get a leaf", () => {
    const store = new SmtStore();
    store.add("aabb01", "cc11dd22");
    assert.equal(store.get("aabb01"), "cc11dd22");
    assert.equal(store.getEntryCount(), 1);
  });

  it("root changes on insert", () => {
    const store = new SmtStore();
    const root0 = store.getRoot();
    store.add("aabb01", "cc11dd22");
    const root1 = store.getRoot();
    assert.notEqual(root0, root1);
  });

  it("delete removes a leaf", () => {
    const store = new SmtStore();
    store.add("aabb01", "cc11dd22");
    assert.equal(store.getEntryCount(), 1);
    store.delete("aabb01");
    assert.equal(store.getEntryCount(), 0);
    assert.equal(store.get("aabb01"), undefined);
  });

  it("creates inclusion proof for existing key", () => {
    const store = new SmtStore();
    store.add("aabb01", "cc11dd22");
    const proof = store.createProof("aabb01");
    assert.equal(proof.membership, true);
    assert.ok(proof.root);
    assert.ok(proof.siblings);
  });

  it("creates exclusion proof for missing key", () => {
    const store = new SmtStore();
    store.add("aabb01", "cc11dd22");
    const proof = store.createProof("ff00ff00");
    assert.equal(proof.membership, false);
  });

  it("verifies valid proof", () => {
    const store = new SmtStore();
    store.add("aabb01", "cc11dd22");
    const proof = store.createProof("aabb01");
    assert.equal(store.verifyProof(proof), true);
  });

  it("checkpoint and restore preserves state", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.add("aa02", "bb02");
    const snapshot = store.checkpoint();

    const store2 = new SmtStore();
    store2.restore(snapshot);
    assert.equal(store2.getRoot(), store.getRoot());
    assert.equal(store2.get("aa01"), "bb01");
    assert.equal(store2.get("aa02"), "bb02");
    assert.equal(store2.getEntryCount(), 2);
  });

  it("restoreFromState works", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    const nodes = store.getNodes();
    const root = store.getRoot();

    const store2 = new SmtStore();
    store2.restoreFromState(nodes, root);
    assert.equal(store2.getRoot(), root);
    assert.equal(store2.get("aa01"), "bb01");
  });

  it("getSize reflects node count", () => {
    const store = new SmtStore();
    const size0 = store.getSize();
    store.add("aa01", "bb01");
    assert.ok(store.getSize() > size0);
  });

  it("proof is invalid after tree mutation", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    const proof = store.createProof("aa01");

    // Mutate tree
    store.add("aa02", "bb02");

    // Proof root no longer matches current root
    assert.notEqual(proof.root, store.getRoot());
  });

  it("freezeLeaf preserves root hash", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.add("aa02", "bb02");
    const rootBefore = store.getRoot();

    store.freezeLeaf("aa01");

    assert.equal(store.getRoot(), rootBefore, "root must not change after freeze");
    assert.equal(store.isFrozen("aa01"), true);
    assert.equal(store.isFrozen("aa02"), false);
    assert.equal(store.getFrozenCount(), 1);
  });

  it("frozen leaf still produces valid membership proof", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.add("aa02", "bb02");
    const proofBefore = store.createProof("aa01");

    store.freezeLeaf("aa01");

    const proofAfter = store.createProof("aa01");
    assert.equal(proofAfter.membership, true, "frozen leaf is still in the tree");
    assert.equal(proofAfter.root, proofBefore.root, "root is unchanged");
    assert.equal(store.verifyProof(proofAfter), true);
  });

  it("pre-freeze proof verifies after freeze", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.add("aa02", "bb02");
    const proofBefore = store.createProof("aa01");

    store.freezeLeaf("aa01");

    assert.equal(store.verifyProof(proofBefore), true, "pre-freeze proof still valid");
  });

  it("non-frozen leaves work normally after freeze", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.add("aa02", "bb02");
    store.freezeLeaf("aa01");

    // Non-frozen leaf still accessible
    assert.equal(store.get("aa02"), "bb02");
    const proof = store.createProof("aa02");
    assert.equal(proof.membership, true);
    assert.equal(store.verifyProof(proof), true);
  });

  it("new inserts work after freeze", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.freezeLeaf("aa01");
    const rootAfterFreeze = store.getRoot();

    store.add("aa03", "bb03");
    assert.notEqual(store.getRoot(), rootAfterFreeze, "root changes on new insert");
    assert.equal(store.get("aa03"), "bb03");
    assert.equal(store.isFrozen("aa01"), true);
    assert.equal(store.isFrozen("aa03"), false);
  });

  it("checkpoint/restore preserves frozen keys", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.add("aa02", "bb02");
    store.freezeLeaf("aa01");
    const snapshot = store.checkpoint();

    const store2 = new SmtStore();
    store2.restore(snapshot);
    assert.equal(store2.getRoot(), store.getRoot());
    assert.equal(store2.isFrozen("aa01"), true);
    assert.equal(store2.isFrozen("aa02"), false);
    assert.equal(store2.getFrozenCount(), 1);
  });

  it("restoreFromState with frozen keys", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.add("aa02", "bb02");
    store.freezeLeaf("aa01");
    const nodes = store.getNodes();
    const root = store.getRoot();
    const frozenKeys = store.getFrozenKeys();

    const store2 = new SmtStore();
    store2.restoreFromState(nodes, root, frozenKeys);
    assert.equal(store2.getRoot(), root);
    assert.equal(store2.isFrozen("aa01"), true);
    assert.equal(store2.isFrozen("aa02"), false);
  });

  it("restoreFromState without frozenKeys clears existing frozen set", () => {
    const store = new SmtStore();
    store.add("aa01", "bb01");
    store.freezeLeaf("aa01");
    assert.equal(store.isFrozen("aa01"), true);

    // Restore an old-format snapshot (no frozenKeys) onto a store that already has frozen keys
    const nodes = store.getNodes();
    const root = store.getRoot();
    store.restoreFromState(nodes, root);

    assert.equal(store.getFrozenCount(), 0);
    assert.equal(store.isFrozen("aa01"), false);
  });
});
