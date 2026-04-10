import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SmtService } from "../../src/services/smt-service.js";
import type { AuditEvent } from "../../src/types/events.js";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: crypto.randomUUID(),
    sequence: 1,
    source: "openclaw-plugin",
    machineId: "test-machine",
    eventType: "session.start",
    category: "system",
    description: "test",
    metadata: { test: true },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SmtService", () => {
  let service: SmtService;

  beforeEach(() => {
    service = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        checkpointDir: `/tmp/smt-test-${process.pid}-${Date.now()}`,
      },
    });
  });

  it("has no trees initially", () => {
    assert.deepEqual(service.listTrees(), []);
    assert.equal(service.getCurrentSmtRoot(), null);
  });

  it("creates tree and inserts on event append", () => {
    const event = makeEvent();
    service.onEventAppended(event);

    const trees = service.listTrees();
    assert.equal(trees.length, 1);
    assert.ok(trees[0].entryCount >= 1);

    const root = service.getRoot();
    assert.ok(root);
    assert.ok(root.root);
    assert.ok(root.entryCount >= 1);
  });

  it("computes raw hash deterministically", () => {
    const event = makeEvent();
    const h1 = service.computeRawHash(event);
    const h2 = service.computeRawHash(event);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("generates inclusion proof after insert", () => {
    const event = makeEvent();
    service.onEventAppended(event);

    const rawHash = service.computeRawHash(event);
    const proof = service.createProof(rawHash);
    assert.ok(proof);
    assert.equal(proof!.membership, true);
  });

  it("generates exclusion proof for missing hash", () => {
    const event = makeEvent();
    service.onEventAppended(event);

    const proof = service.createProof("ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00");
    assert.ok(proof);
    assert.equal(proof!.membership, false);
  });

  it("verifies a valid proof", () => {
    const event = makeEvent();
    service.onEventAppended(event);

    const rawHash = service.computeRawHash(event);
    const proof = service.createProof(rawHash)!;
    assert.equal(service.verifyProof(proof), true);
  });

  it("dual-hash: inserts both raw and censored leaves", () => {
    const event = makeEvent();
    service.onEventAppended(event);

    const root = service.getRoot();
    assert.ok(root);
    // raw + censored = 2 entries
    assert.equal(root!.entryCount, 2);
  });

  it("tracks conversation chain via sessionId", () => {
    const e1 = makeEvent({ sessionId: "s1", sequence: 1 });
    const e2 = makeEvent({ sessionId: "s1", sequence: 2 });

    service.onEventAppended(e1);
    service.onEventAppended(e2);

    const trees = service.listTrees();
    const treeKey = trees[0].key;
    const chain = service.getChain(treeKey, "s1");
    assert.equal(chain.length, 2);
    assert.equal(chain[1].seqNo, 3); // seqNo increments: 1 (raw), 2 (censored), 3 (raw), 4 (censored)
  });

  it("getCurrentSmtRoot returns root after inserts", () => {
    service.onEventAppended(makeEvent());
    const root = service.getCurrentSmtRoot();
    assert.ok(root);
    assert.equal(root!.length, 64);
  });

  it("pruneEpoch returns error for missing tree", () => {
    const result = service.pruneEpoch("nonexistent", 0);
    assert.ok("error" in result);
  });

  it("getExportedProofs returns empty for unknown tree", () => {
    const result = service.getExportedProofs("nonexistent") as any;
    assert.ok(result.message);
  });

  it("createSnapshot returns error for missing tree", () => {
    const result = service.createSnapshot("nonexistent");
    assert.ok("error" in result);
  });

  it("restoreSnapshot returns error for bad data", () => {
    const result = service.restoreSnapshot("t1", {} as any);
    assert.ok("error" in result);
  });

  it("is fail-open: bad event doesn't throw", () => {
    // This shouldn't throw even with weird data
    assert.doesNotThrow(() => {
      service.onEventAppended({} as any);
    });
  });

  it("exportedProofs survive checkpoint/restore cycle", async () => {
    const checkpointDir = mkdtempSync(join(tmpdir(), "smt-export-test-"));

    try {
      const svc1 = new SmtService({
        smt: { checkpointIntervalMs: 0, pruneAfterEpochs: 0, checkpointDir },
      });
      await svc1.start();

      // Insert events so there's a tree with entries in an epoch
      for (let i = 0; i < 3; i++) {
        svc1.onEventAppended(makeEvent({ sequence: i + 1 }));
      }

      const treeKey = svc1.listTrees()[0].key;
      // Events land in the current epoch (hour-based: Date.now() / 3_600_000)
      const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));
      const result = svc1.pruneEpoch(treeKey, currentEpoch);
      assert.ok(!("error" in result) && result.pruned > 0, "should have pruned current epoch");
      const prunedEpoch = currentEpoch;

      // Verify proofs exist before shutdown
      const before = svc1.getExportedProofs(treeKey, prunedEpoch!) as any;
      assert.ok(before.proofCount > 0, "proofs should exist before shutdown");

      await svc1.stop();

      // Restore into a fresh service instance
      const svc2 = new SmtService({
        smt: { checkpointIntervalMs: 0, pruneAfterEpochs: 0, checkpointDir },
      });
      await svc2.start();

      const after = svc2.getExportedProofs(treeKey, prunedEpoch!) as any;
      assert.equal(after.proofCount, before.proofCount, "exportedProofs should survive restart");

      await svc2.stop();
    } finally {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  });

  it("replayEvents supports batched fetcher callback", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ sequence: i + 1 }),
    );

    const fetcher = (offset: number, limit: number) =>
      events.slice(offset, offset + limit);

    const replayed = service.replayEvents(fetcher, events.length);
    assert.equal(replayed, 5);

    const trees = service.listTrees();
    assert.equal(trees.length, 1);
    assert.ok(trees[0].entryCount >= 5);
  });

});
