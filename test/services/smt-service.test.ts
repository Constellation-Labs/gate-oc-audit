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

  it("raw hash covers content — different content produces different hash", () => {
    const base = makeEvent();
    const hashNoContent = service.computeRawHash(base);
    const hashA = service.computeRawHash({ ...base, content: "a" });
    const hashB = service.computeRawHash({ ...base, content: "b" });
    assert.notEqual(hashNoContent, hashA);
    assert.notEqual(hashNoContent, hashB);
    assert.notEqual(hashA, hashB);
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

    const proof = service.createProof(
      "ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00",
    );
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
      assert.ok(
        !("error" in result) && result.pruned > 0,
        "should have pruned current epoch",
      );
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
      assert.equal(
        after.proofCount,
        before.proofCount,
        "exportedProofs should survive restart",
      );

      await svc2.stop();
    } finally {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  });

  it("pruneEpoch preserves root hash", () => {
    for (let i = 0; i < 5; i++) {
      service.onEventAppended(makeEvent({ sequence: i + 1 }));
    }
    const treeKey = service.listTrees()[0].key;
    const rootBefore = service.getCurrentSmtRoot();
    assert.ok(rootBefore);

    const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));
    const result = service.pruneEpoch(treeKey, currentEpoch);
    assert.ok(!("error" in result));
    assert.ok(result.pruned > 0);

    const rootAfter = service.getCurrentSmtRoot();
    assert.equal(
      rootAfter,
      rootBefore,
      "root must not change after freeze-prune",
    );
    assert.equal(
      result.root,
      rootBefore,
      "returned root must match pre-freeze root",
    );
  });

  it("pruneEpoch exported proofs have frozen: true", () => {
    for (let i = 0; i < 3; i++) {
      service.onEventAppended(makeEvent({ sequence: i + 1 }));
    }
    const treeKey = service.listTrees()[0].key;
    const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));

    service.pruneEpoch(treeKey, currentEpoch);

    const exported = service.getExportedProofs(treeKey, currentEpoch) as any;
    assert.ok(exported.proofCount > 0);
    for (const proof of exported.proofs) {
      assert.equal(
        proof.frozen,
        true,
        "exported proofs should be annotated frozen",
      );
    }
  });

  it("pre-freeze proofs verify after pruneEpoch", () => {
    const events: ReturnType<typeof makeEvent>[] = [];
    for (let i = 0; i < 3; i++) {
      const e = makeEvent({ sequence: i + 1 });
      events.push(e);
      service.onEventAppended(e);
    }
    const treeKey = service.listTrees()[0].key;

    // Capture proofs before freezing
    const preFreezeProofs = events.map((e) => {
      const hash = service.computeRawHash(e);
      return service.createProof(hash, treeKey)!;
    });
    for (const p of preFreezeProofs) {
      assert.ok(p);
      assert.equal(p.membership, true);
    }

    const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));
    service.pruneEpoch(treeKey, currentEpoch);

    // Pre-freeze proofs still verify
    for (const p of preFreezeProofs) {
      assert.equal(
        service.verifyProof(p),
        true,
        "pre-freeze proof must still verify",
      );
    }
  });

  it("createProof annotates frozen leaves", () => {
    const event = makeEvent({ sequence: 1 });
    service.onEventAppended(event);
    const treeKey = service.listTrees()[0].key;
    const hash = service.computeRawHash(event);

    // Before freeze: no frozen flag
    const proofBefore = service.createProof(hash, treeKey)!;
    assert.equal(proofBefore.frozen, undefined);

    const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));
    service.pruneEpoch(treeKey, currentEpoch);

    // After freeze: frozen flag set
    const proofAfter = service.createProof(hash, treeKey)!;
    assert.equal(proofAfter.frozen, true);
    assert.equal(proofAfter.membership, true, "leaf is still in the tree");
    assert.equal(service.verifyProof(proofAfter), true);
  });

  it("pruneEpoch with empty epoch returns zero counts", () => {
    service.onEventAppended(makeEvent({ sequence: 1 }));
    const treeKey = service.listTrees()[0].key;

    const result = service.pruneEpoch(treeKey, 0); // epoch 0 has no entries
    assert.ok(!("error" in result));
    assert.equal(result.pruned, 0);
    assert.equal(result.proofsExported, 0);
  });

  it("listTrees includes frozenCount", () => {
    for (let i = 0; i < 3; i++) {
      service.onEventAppended(makeEvent({ sequence: i + 1 }));
    }
    const treeKey = service.listTrees()[0].key;
    assert.equal(service.listTrees()[0].frozenCount, 0);

    const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));
    service.pruneEpoch(treeKey, currentEpoch);

    assert.ok(service.listTrees()[0].frozenCount > 0);
  });

  it("re-appending a frozen event is a no-op", () => {
    const event = makeEvent({ sequence: 1 });
    service.onEventAppended(event);
    const treeKey = service.listTrees()[0].key;
    const rootBefore = service.getCurrentSmtRoot();
    const entryCountBefore = service.getRoot(treeKey)!.entryCount;

    const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));
    service.pruneEpoch(treeKey, currentEpoch);

    // Re-append the same event (simulates replay after restart)
    service.onEventAppended(event);

    // Tree should be unchanged — no throw, no duplicate entries
    assert.equal(service.getCurrentSmtRoot(), rootBefore);
    assert.equal(service.getRoot(treeKey)!.entryCount, entryCountBefore);
  });

  it("createSnapshot → restoreSnapshot preserves frozen keys", () => {
    const event = makeEvent({ sequence: 1 });
    service.onEventAppended(event);
    const treeKey = service.listTrees()[0].key;
    const rootBefore = service.getCurrentSmtRoot();

    const currentEpoch = Math.floor(Date.now() / (1000 * 60 * 60));
    const pruneResult = service.pruneEpoch(treeKey, currentEpoch);
    assert.ok(!("error" in pruneResult) && pruneResult.pruned > 0);

    const snapshot = service.createSnapshot(treeKey);
    assert.ok(!("error" in snapshot));

    // Restore into a fresh service
    const svc2 = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        checkpointDir: `/tmp/smt-test-${process.pid}-${Date.now()}`,
      },
    });
    const restoreResult = svc2.restoreSnapshot(treeKey, snapshot as any);
    assert.ok(!("error" in restoreResult));
    assert.equal(restoreResult.root, rootBefore);

    // Re-appending the frozen event should be a no-op
    svc2.onEventAppended(event);
    assert.equal(svc2.getCurrentSmtRoot(treeKey), rootBefore);
    assert.equal(
      svc2.getRoot(treeKey)!.entryCount,
      service.getRoot(treeKey)!.entryCount,
    );
  });

  it("replaying identical events produces the same root", () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      makeEvent({ id: `event-${i}`, sequence: i + 1 }),
    );

    const svc1 = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        checkpointDir: `/tmp/smt-test-${process.pid}-${Date.now()}-a`,
      },
    });
    const svc2 = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        checkpointDir: `/tmp/smt-test-${process.pid}-${Date.now()}-b`,
      },
    });

    for (const event of events) {
      svc1.onEventAppended(event);
    }
    for (const event of events) {
      svc2.onEventAppended(event);
    }

    const root1 = svc1.getCurrentSmtRoot();
    const root2 = svc2.getCurrentSmtRoot();

    assert.ok(root1, "svc1 should have a root");
    assert.ok(root2, "svc2 should have a root");
    assert.equal(
      root1,
      root2,
      "Two services receiving identical events must produce identical SMT roots",
    );
  });

  it("getKnownRoots returns current tree roots", () => {
    service.onEventAppended(makeEvent({ sequence: 1 }));
    const root = service.getCurrentSmtRoot()!;
    const knownRoots = service.getKnownRoots();
    assert.equal(knownRoots.size, 1);
    assert.ok(knownRoots.has(root));
  });

  it("getKnownRoots merges checkpointed roots", () => {
    service.onEventAppended(makeEvent({ sequence: 1 }));
    const root = service.getCurrentSmtRoot()!;
    const knownRoots = service.getKnownRoots(["checkpoint-root-1", "checkpoint-root-2"]);
    assert.equal(knownRoots.size, 3);
    assert.ok(knownRoots.has(root));
    assert.ok(knownRoots.has("checkpoint-root-1"));
    assert.ok(knownRoots.has("checkpoint-root-2"));
  });

  it("getKnownRoots returns empty set when no trees and no checkpoints", () => {
    const knownRoots = service.getKnownRoots();
    assert.equal(knownRoots.size, 0);
  });

  it("rejects fabricated proof with wrong root even if internally consistent", () => {
    // Service A: insert events, producing root R_A
    const eventA = makeEvent({ sequence: 1 });
    service.onEventAppended(eventA);
    const rootA = service.getCurrentSmtRoot()!;
    assert.ok(rootA);

    // Service B: insert different events, producing root R_B
    const serviceB = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        checkpointDir: `/tmp/smt-test-${process.pid}-${Date.now()}-b`,
      },
    });
    const eventB = makeEvent({ sequence: 2, description: "different event" });
    serviceB.onEventAppended(eventB);
    const rootB = serviceB.getCurrentSmtRoot()!;
    assert.ok(rootB);
    assert.notEqual(rootA, rootB);

    // Get a valid proof from service B — internally consistent with root R_B
    const hashB = serviceB.computeRawHash(eventB);
    const proofB = serviceB.createProof(hashB)!;
    assert.ok(proofB);
    assert.equal(proofB.membership, true);
    assert.equal(proofB.root, rootB);

    // Without expectedRoot: stateless check passes (the vulnerability)
    assert.equal(service.verifyProof(proofB), true);

    // With expectedRoot = R_A: rejected because proof.root !== R_A
    assert.equal(service.verifyProof(proofB, rootA), false);

    // With expectedRoot = R_B: passes (root matches + internally consistent)
    assert.equal(service.verifyProof(proofB, rootB), true);
  });

  it("verifyProof with matching expectedRoot still validates internal consistency", () => {
    const event = makeEvent();
    service.onEventAppended(event);
    const root = service.getCurrentSmtRoot()!;

    const rawHash = service.computeRawHash(event);
    const proof = service.createProof(rawHash)!;
    assert.equal(proof.root, root);

    // Valid proof with correct expectedRoot passes
    assert.equal(service.verifyProof(proof, root), true);

    // Tampered proof with correct expectedRoot fails internal check
    const tampered = { ...proof, siblings: [] };
    assert.equal(service.verifyProof(tampered, root), false);
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
