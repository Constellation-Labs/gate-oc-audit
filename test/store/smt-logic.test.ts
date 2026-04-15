import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SmtStore } from "../../src/store/smt-store.js";
import {
  insertEntry,
  getCurrentEpoch,
  getNextSeqNo,
  getChainPrev,
  recordChainEntry,
  trackEpochEntry,
  EPOCH_DURATION_MS,
} from "../../src/store/smt-logic.js";
import type {
  SeqNos,
  ConversationChains,
  EpochEntries,
  LeafValues,
} from "../../src/types/smt.js";

function makeState() {
  return {
    seqNos: new Map() as SeqNos,
    conversationChains: new Map() as ConversationChains,
    epochEntries: new Map() as EpochEntries,
    leafValues: new Map() as LeafValues,
  };
}

describe("SMT Logic", () => {
  describe("getCurrentEpoch", () => {
    it("returns a positive integer", () => {
      const epoch = getCurrentEpoch();
      assert.ok(epoch > 0);
      assert.equal(epoch, Math.floor(epoch));
    });
  });

  describe("getNextSeqNo", () => {
    it("increments monotonically per tree", () => {
      const seqNos: SeqNos = new Map();
      assert.equal(getNextSeqNo(seqNos, "t1"), 1);
      assert.equal(getNextSeqNo(seqNos, "t1"), 2);
      assert.equal(getNextSeqNo(seqNos, "t2"), 1);
    });
  });

  describe("getChainPrev", () => {
    it("returns null for empty chain", () => {
      const chains: ConversationChains = new Map();
      assert.equal(getChainPrev(chains, "t1", "c1"), null);
    });

    it("returns last rawHash after recording", () => {
      const chains: ConversationChains = new Map();
      recordChainEntry(chains, "t1", "c1", {
        rawHash: "hash1",
        timestamp: 1000,
        seqNo: 1,
        auditEventId: "id1",
      });
      assert.equal(getChainPrev(chains, "t1", "c1"), "hash1");
    });
  });

  describe("trackEpochEntry", () => {
    it("tracks entries by tree and epoch", () => {
      const epochs: EpochEntries = new Map();
      trackEpochEntry(epochs, "t1", 100, "ee0001");
      trackEpochEntry(epochs, "t1", 100, "ee0002");
      trackEpochEntry(epochs, "t1", 101, "h3");

      assert.deepEqual(epochs.get("t1")?.get(100), ["ee0001", "ee0002"]);
      assert.deepEqual(epochs.get("t1")?.get(101), ["h3"]);
    });
  });

  describe("insertEntry", () => {
    it("inserts a single raw leaf", () => {
      const store = new SmtStore();
      const state = makeState();

      const result = insertEntry(store, {
        eventId: "evt-001",
        treeKey: "t1",
        rawHash: "aa1122",
        censoredHash: null,
        conversationId: "conv1",
        timestamp: 1000,
        maxTreeSize: 100,
        ...state,
      });

      assert.ok(!("error" in result));
      assert.equal(result.rawKey, "aa1122");
      assert.equal(result.censoredKey, undefined);
      assert.equal(result.entryCount, 1);
      assert.equal(result.seqNo, 1);
      assert.equal(result.chainPrev, null);
      assert.ok(result.rawLeafValue);
    });

    it("inserts dual-hash (raw + censored)", () => {
      const store = new SmtStore();
      const state = makeState();

      const result = insertEntry(store, {
        eventId: "evt-002",
        treeKey: "t1",
        rawHash: "aa1122",
        censoredHash: "bb3344",
        conversationId: "conv1",
        timestamp: 1000,
        maxTreeSize: 100,
        ...state,
      });

      assert.ok(!("error" in result));
      assert.equal(result.rawKey, "aa1122");
      assert.equal(result.censoredKey, "bb3344");
      assert.equal(result.entryCount, 2);
      assert.ok(result.censoredLeafValue);
    });

    it("tracks conversation chain across inserts", () => {
      const store = new SmtStore();
      const state = makeState();

      const r1 = insertEntry(store, {
        eventId: "evt-003",
        treeKey: "t1",
        rawHash: "ee0001",
        censoredHash: null,
        conversationId: "conv1",
        timestamp: 1000,
        maxTreeSize: 100,
        ...state,
      });
      assert.ok(!("error" in r1));
      assert.equal(r1.chainPrev, null);

      const r2 = insertEntry(store, {
        eventId: "evt-004",
        treeKey: "t1",
        rawHash: "ee0002",
        censoredHash: null,
        conversationId: "conv1",
        timestamp: 1001,
        maxTreeSize: 100,
        ...state,
      });
      assert.ok(!("error" in r2));
      assert.equal(r2.chainPrev, "ee0001");
    });

    it("rejects when tree is at max size", () => {
      const store = new SmtStore();
      const state = makeState();

      // Insert one entry first
      insertEntry(store, {
        eventId: "evt-005",
        treeKey: "t1",
        rawHash: "ee0001",
        censoredHash: null,
        conversationId: "conv1",
        timestamp: 1000,
        maxTreeSize: 1,
        ...state,
      });

      const result = insertEntry(store, {
        eventId: "evt-006",
        treeKey: "t1",
        rawHash: "ee0002",
        censoredHash: null,
        conversationId: "conv1",
        timestamp: 1001,
        maxTreeSize: 1,
        ...state,
      });

      assert.ok("error" in result);
      assert.ok(result.error.includes("max size"));
    });

    it("stores leaf values when map provided", () => {
      const store = new SmtStore();
      const state = makeState();

      insertEntry(store, {
        eventId: "evt-007",
        treeKey: "t1",
        rawHash: "cc0011",
        censoredHash: "dd0022",
        conversationId: "conv1",
        timestamp: 1000,
        maxTreeSize: 100,
        ...state,
      });

      assert.ok(state.leafValues.has("cc0011"));
      assert.ok(state.leafValues.has("dd0022"));
    });

    it("increments seqNo for censored leaf", () => {
      const store = new SmtStore();
      const state = makeState();

      const result = insertEntry(store, {
        eventId: "evt-008",
        treeKey: "t1",
        rawHash: "cc0011",
        censoredHash: "dd0022",
        conversationId: "conv1",
        timestamp: 1000,
        maxTreeSize: 100,
        ...state,
      });

      assert.ok(!("error" in result));
      // raw gets seqNo 1, censored gets seqNo 2
      assert.equal(result.seqNo, 1);
      assert.equal(state.seqNos.get("t1"), 2);
    });
  });
});
