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
    assert.equal(service.verifyProofWithRoots(proof, service.getKnownRoots()).status, "valid");
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
    // Both raw and censored leaves are tracked in the chain so getChain
    // callers don't silently miss half the leaves and pruneEpoch can sweep
    // censored entries from leafValues. seqNo increments:
    // 1 (raw e1), 2 (censored e1), 3 (raw e2), 4 (censored e2).
    assert.equal(chain.length, 4);
    assert.equal(chain[0].seqNo, 1);
    assert.equal(chain[1].seqNo, 2);
    assert.equal(chain[2].seqNo, 3);
    assert.equal(chain[3].seqNo, 4);
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
      assert.equal(service.verifyProofWithRoots(p, service.getKnownRoots()).status, "valid", "pre-freeze proof must still verify");
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
    assert.equal(service.verifyProofWithRoots(proofAfter, service.getKnownRoots()).status, "valid");
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

    // Get a valid proof from service B — internally consistent with root R_B
    const hashB = serviceB.computeRawHash(eventB);
    const proofB = serviceB.createProof(hashB)!;
    assert.ok(proofB);
    assert.equal(proofB.membership, true);

    // Service A rejects it — root R_B is not a known root
    const result = service.verifyProofWithRoots(proofB, service.getKnownRoots());
    assert.equal(result.status, "invalid");
  });

  it("verifyProofWithRoots rejects tampered proof with known root", () => {
    const event = makeEvent();
    service.onEventAppended(event);

    const rawHash = service.computeRawHash(event);
    const proof = service.createProof(rawHash)!;
    const knownRoots = service.getKnownRoots();

    // Valid proof passes
    assert.equal(service.verifyProofWithRoots(proof, knownRoots).status, "valid");

    // Tampered proof fails internal check even though root is known
    const tampered = { ...proof, siblings: [] };
    assert.equal(service.verifyProofWithRoots(tampered, knownRoots).status, "invalid");
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

/**
 * In-memory stand-in for the slice of AuditStore that SmtService uses for
 * skippedSeqs persistence. Lets us assert the audit-store path without
 * spinning up a real SQLite database in every skip test.
 */
function makeFakeStore() {
  const rows = new Map<string, { payload: unknown; updatedAt: string }>();
  return {
    rows,
    upsertServiceHealth(name: string, payload: unknown): void {
      rows.set(name, { payload, updatedAt: new Date().toISOString() });
    },
    getServiceHealth(name: string) {
      return rows.get(name);
    },
  };
}

describe("SmtService skippedSeqs", () => {
  let service: SmtService;
  let fakeStore: ReturnType<typeof makeFakeStore>;
  let checkpointDir: string;

  beforeEach(() => {
    checkpointDir = `/tmp/smt-skip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    service = new SmtService({
      smt: { checkpointIntervalMs: 0, pruneAfterEpochs: 0, checkpointDir },
    });
    fakeStore = makeFakeStore();
    service.setStore(fakeStore);
  });

  it("marks insertEntry-rejected events as skipped and persists to the store", () => {
    // Each event inserts a raw + censored leaf pair, so maxTreeSize=2 leaves
    // room for exactly one event; the second event's pair would push past the
    // cap, so insertEntry rejects it with an "error" result, hitting the
    // rejected-skip branch. Standalone SmtService skip-mechanism check.
    const tiny = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        maxTreeSize: 2,
        checkpointDir: `/tmp/smt-tiny-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    const tinyStore = makeFakeStore();
    tiny.setStore(tinyStore);

    tiny.onEventAppended(makeEvent({ sequence: 1 }));
    // Second insert exceeds maxTreeSize → rejected → seq=2 lands in
    // skippedSeqs and the audit-store row reflects it.
    tiny.onEventAppended(makeEvent({ sequence: 2 }));

    assert.equal(tiny.wasSkipped(2), true);
    const persisted = tinyStore.getServiceHealth("smt-skipped-seqs");
    assert.ok(persisted, "service_health row must exist after a skip");
    assert.deepEqual(persisted!.payload, [2]);
  });

  it("clears the skip when a later retry succeeds", async () => {
    const tiny = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        maxTreeSize: 2,
        checkpointDir: `/tmp/smt-tiny2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    const tinyStore = makeFakeStore();
    tiny.setStore(tinyStore);

    tiny.onEventAppended(makeEvent({ sequence: 1 }));
    tiny.onEventAppended(makeEvent({ sequence: 2 })); // skipped — second raw+censored pair exceeds maxTreeSize
    assert.equal(tiny.wasSkipped(2), true);

    // A successful insert at the same sequence clears the skip record.
    // Easiest path: lift maxTreeSize via a fresh service that reads the
    // same skip set, then insert with sequence=2.
    const room = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        maxTreeSize: 10,
        checkpointDir: `/tmp/smt-tiny2-room-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    room.setStore(tinyStore);
    // Pre-load the skip set as if we'd restarted with more headroom.
    // (ensureReady pulls from the same fakeStore row.) Must await so the
    // in-memory set is populated before the retry-insert runs.
    await room.ensureReady();
    room.onEventAppended(makeEvent({ sequence: 2, description: "retry-with-room" }));

    assert.equal(room.wasSkipped(2), false);
    const persisted = tinyStore.getServiceHealth("smt-skipped-seqs");
    assert.deepEqual(persisted!.payload, []);
  });

  it("restores skippedSeqs from the audit store on ensureReady", async () => {
    // Pre-seed the store with a skip set as if a prior process had
    // recorded one. Then construct a fresh SmtService pointed at the
    // same checkpoint dir and store.
    fakeStore.upsertServiceHealth("smt-skipped-seqs", [42, 100, 256]);

    const fresh = new SmtService({
      smt: { checkpointIntervalMs: 0, pruneAfterEpochs: 0, checkpointDir },
    });
    fresh.setStore(fakeStore);
    await fresh.ensureReady();

    assert.equal(fresh.wasSkipped(42), true);
    assert.equal(fresh.wasSkipped(100), true);
    assert.equal(fresh.wasSkipped(256), true);
    assert.equal(fresh.wasSkipped(7), false);
  });

  it("filters non-numeric payload entries on restore (defends against tampered rows)", async () => {
    // A malicious or corrupt service_health row could carry strings or
    // objects. The restore path must strip them, not crash.
    fakeStore.upsertServiceHealth("smt-skipped-seqs", [
      1,
      "evil",
      { drop: "table" },
      2,
      null,
    ]);
    const fresh = new SmtService({
      smt: { checkpointIntervalMs: 0, pruneAfterEpochs: 0, checkpointDir },
    });
    fresh.setStore(fakeStore);
    await fresh.ensureReady();

    assert.equal(fresh.wasSkipped(1), true);
    assert.equal(fresh.wasSkipped(2), true);
    // The non-numeric entries are silently dropped.
    assert.equal(fresh.wasSkipped(0), false);
  });

  it("ensureReady without a store does not crash and leaves skip set empty", async () => {
    // SmtService remains usable in unit tests that don't wire a store.
    const noStoreService = new SmtService({
      smt: { checkpointIntervalMs: 0, pruneAfterEpochs: 0, checkpointDir },
    });
    await noStoreService.ensureReady();
    assert.equal(noStoreService.wasSkipped(1), false);
  });
});
