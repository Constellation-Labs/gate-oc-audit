import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { AuditStore } from "../../src/store/audit-store.js";
import { DeAnchorService, computeMerkleRoot } from "../../src/services/de-anchor.js";
import type { AuditEventInsert } from "../../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-deanchor-")), "test.db");
}

function insert(store: AuditStore, overrides: Partial<AuditEventInsert> = {}) {
  return store.append({
    sessionId: "sess-1",
    eventType: "session.start",
    category: "system",
    description: "test",
    metadata: { test: true },
    ...overrides,
  })!;
}

describe("computeMerkleRoot", () => {
  it("returns single hash for one element", () => {
    assert.equal(computeMerkleRoot(["abc123"]), "abc123");
  });

  it("computes root for two elements", () => {
    const root = computeMerkleRoot(["aaa", "bbb"]);
    assert.ok(root.length === 64);
    assert.notEqual(root, "aaa");
    assert.notEqual(root, "bbb");
  });

  it("is deterministic", () => {
    const hashes = ["hash1", "hash2", "hash3", "hash4"];
    assert.equal(computeMerkleRoot(hashes), computeMerkleRoot(hashes));
  });

  it("handles odd number of hashes by duplicating last", () => {
    const root = computeMerkleRoot(["a", "b", "c"]);
    assert.ok(root.length === 64);
  });

  it("returns empty string for empty input", () => {
    assert.equal(computeMerkleRoot([]), "");
  });

  it("uses separator to avoid prefix collisions", () => {
    // hash("ab" + ":" + "cd") should differ from hash("abc" + ":" + "d")
    const root1 = computeMerkleRoot(["ab", "cd"]);
    const root2 = computeMerkleRoot(["abc", "d"]);
    assert.notEqual(root1, root2);
  });
});

describe("DeAnchorService", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  describe("anchorIfNeeded", () => {
    it("does not anchor when below event threshold", async () => {
      for (let i = 0; i < 5; i++) insert(store);

      const service = new DeAnchorService(store, {
        deApiKey: "test-key",
        deEventThreshold: 100,
      });

      await service.anchorIfNeeded();
      assert.equal(store.getLastCheckpoint(), undefined);
    });

    it("anchors when threshold reached", async () => {
      let received = false;
      const server = createServer((req, res) => {
        received = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hash: "de-tx-hash-123" }));
      });

      await new Promise<void>((r) => server.listen(0, r));
      const port = (server.address() as { port: number }).port;

      try {
        for (let i = 0; i < 10; i++) insert(store, { metadata: { i } });

        const service = new DeAnchorService(store, {
          deApiKey: "test-key",
          deApiUrl: `http://localhost:${port}/v1`,
          deEventThreshold: 5,
        });

        await service.anchorIfNeeded();

        assert.ok(received, "DE API should have been called");

        const checkpoint = store.getLastCheckpoint();
        assert.ok(checkpoint);
        assert.equal(checkpoint!.eventCount, 10);
        assert.equal(checkpoint!.deTxHash, "de-tx-hash-123");
        assert.ok(checkpoint!.merkleRoot.length === 64);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it("respects circuit breaker after failures", async () => {
      let callCount = 0;
      const server = createServer((req, res) => {
        callCount++;
        res.writeHead(500);
        res.end("error");
      });

      await new Promise<void>((r) => server.listen(0, r));
      const port = (server.address() as { port: number }).port;

      try {
        for (let i = 0; i < 10; i++) insert(store, { metadata: { i } });

        const service = new DeAnchorService(store, {
          deApiKey: "test-key",
          deApiUrl: `http://localhost:${port}/v1`,
          deEventThreshold: 5,
        });

        for (let i = 0; i < 6; i++) {
          await service.anchorIfNeeded();
        }

        const callsAfterOpen = callCount;
        await service.anchorIfNeeded();
        assert.equal(callCount, callsAfterOpen);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  describe("verifyCheckpoints", () => {
    it("detects local Merkle root mismatch", async () => {
      for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

      store.insertCheckpoint("cp-1", 1, 5, "wrong-merkle-root", 5, null);

      const errors: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => errors.push(args.join(" "));

      try {
        const service = new DeAnchorService(store);
        await service.verifyCheckpoints();
        assert.ok(errors.some((e) => e.includes("Merkle root mismatch")));
      } finally {
        console.error = origError;
      }
    });
  });

  it("does not start when no credentials configured", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));

    try {
      const service = new DeAnchorService(store, {});
      await service.start();
      service.stop();
      assert.ok(errors.some((e) => e.includes("anchoring disabled")));
    } finally {
      console.error = origError;
    }
  });

  it("stop is idempotent", () => {
    const service = new DeAnchorService(store, {});
    service.stop();
    service.stop();
  });
});
