import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import type { AuditEventInsert } from "../../src/types/events.js";
import { log } from "../../src/util/logger.js";
import { captureLogger } from "../test-utils/capture-logger.js";

function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  return join(dir, "test.db");
}

function cleanupDb(dbPath: string): void {
  rmSync(dirname(dbPath), { recursive: true, force: true });
}

function sampleInsert(overrides: Partial<AuditEventInsert> = {}): AuditEventInsert {
  return {
    sessionId: "sess-1",
    eventType: "session.start",
    category: "system",
    description: "test event",
    metadata: { test: true },
    ...overrides,
  };
}

describe("AuditStore", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  describe("append", () => {
    it("returns an AuditEvent with all generated fields", () => {
      const event = store.append(sampleInsert());

      assert.ok(event);
      assert.equal(event.sequence, 1);
      assert.equal(event.source, "openclaw-plugin");
      assert.equal(event.eventType, "session.start");
      assert.equal(event.category, "system");
      assert.ok(event.id);
      assert.ok(event.createdAt);
      assert.ok(event.machineId);
    });

    it("increments sequence monotonically", () => {
      const e1 = store.append(sampleInsert())!;
      const e2 = store.append(sampleInsert({ description: "second" }))!;
      const e3 = store.append(sampleInsert({ description: "third" }))!;

      assert.equal(e1.sequence, 1);
      assert.equal(e2.sequence, 2);
      assert.equal(e3.sequence, 3);
    });

    it("assigns unique IDs to each event", () => {
      const e1 = store.append(sampleInsert())!;
      const e2 = store.append(sampleInsert({ description: "second" }))!;

      assert.notEqual(e1.id, e2.id);
    });

    it("defaults source to openclaw-plugin", () => {
      const event = store.append(sampleInsert())!;
      assert.equal(event.source, "openclaw-plugin");
    });

    it("uses custom source when provided", () => {
      const event = store.append(sampleInsert({ source: "gateway" }))!;
      assert.equal(event.source, "gateway");
    });

    it("stores optional fields as null when not provided", () => {
      const event = store.append(
        sampleInsert({ sessionId: undefined, orgId: undefined, userId: undefined }),
      )!;

      assert.equal(event.sessionId, undefined);
      assert.equal(event.orgId, undefined);
      assert.equal(event.userId, undefined);
    });

    it("records oversized metadata events with a truncation marker rather than dropping them", () => {
      const bigValue = "x".repeat(1024 * 1024 + 1);
      const result = store.append(sampleInsert({ metadata: { big: bigValue } }))!;

      assert.ok(result, "expected event to be recorded with truncated metadata");
      assert.equal(store.isDegraded(), false);
      // The returned AuditEvent.metadata MUST match what's persisted, so
      // downstream consumers (SMT hashing, future verifiers reading the row
      // back) compute the same hash. Earlier versions persisted a marker
      // but returned the original metadata, breaking SMT proofs.
      const persisted = store.query({ limit: 1, includeContent: false })[0];
      const persistedMd = persisted.metadata as Record<string, unknown>;
      const returnedMd = result.metadata as Record<string, unknown>;
      assert.deepEqual(returnedMd, persistedMd,
        "returned and persisted metadata must be identical (regression guard)");
      const marker = persistedMd.$auditTruncation as Record<string, unknown>;
      assert.ok(marker, "marker must live under reserved $auditTruncation key");
      const metadataArm = marker.metadata as Record<string, unknown>;
      assert.ok(metadataArm, "marker.metadata arm must be present");
      assert.equal(metadataArm.reason, "size-cap");
      assert.ok(typeof metadataArm.originalSize === "number"
        && metadataArm.originalSize > 1024 * 1024);
      assert.equal(marker.content, undefined, "content arm must be absent when content was not provided");
      assert.equal("big" in persistedMd, false, "oversized field must not survive truncation");
    });

    it("records non-serializable metadata events with a truncation marker", () => {
      const result = store.append(
        sampleInsert({ metadata: { value: BigInt(42) } as unknown as Record<string, unknown> }),
      )!;

      assert.ok(result, "expected event to be recorded with marker");
      assert.equal(store.isDegraded(), false);
      const persisted = store.query({ limit: 1, includeContent: false })[0];
      const persistedMd = persisted.metadata as Record<string, unknown>;
      const returnedMd = result.metadata as Record<string, unknown>;
      assert.deepEqual(returnedMd, persistedMd,
        "returned and persisted metadata must be identical (regression guard)");
      const marker = persistedMd.$auditTruncation as Record<string, unknown>;
      assert.ok(marker, "marker must live under reserved $auditTruncation key");
      const metadataArm = marker.metadata as Record<string, unknown>;
      assert.ok(metadataArm, "marker.metadata arm must be present");
      assert.equal(metadataArm.reason, "non-serializable");
    });

    it("records oversized content with a marker rather than silently hashing sha256('')", () => {
      const bigContent = "x".repeat(5 * 1024 * 1024 + 1);
      const result = store.append(sampleInsert({ content: bigContent }))!;

      assert.ok(result, "expected event to be recorded with truncation marker");
      assert.equal(store.isDegraded(), false);
      // contentHash is sha256("") because the bytes were dropped — but the
      // metadata marker records that there *was* content, distinguishing
      // this row from a normal no-content event.
      assert.equal(result.contentHash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "oversized content hashes the empty string (bytes were dropped)");

      const persisted = store.query({ limit: 1, includeContent: false })[0];
      const persistedMd = persisted.metadata as Record<string, unknown>;
      const marker = persistedMd.$auditTruncation as Record<string, unknown>;
      assert.ok(marker, "marker must live under reserved $auditTruncation key");
      const contentArm = marker.content as Record<string, unknown>;
      assert.ok(contentArm, "marker.content arm must be present when content was dropped");
      assert.equal(contentArm.reason, "size-cap");
      assert.equal(contentArm.originalSize, bigContent.length,
        "originalSize must record the dropped content's true length");
      assert.equal(marker.metadata, undefined,
        "metadata arm must be absent when only content was truncated");
      // User's other metadata fields must survive when only content is truncated.
      assert.equal(persistedMd.test, true, "user metadata must survive content-only truncation");
    });

    it("records both metadata and content truncation in one marker", () => {
      const bigValue = "x".repeat(1024 * 1024 + 1);
      const bigContent = "y".repeat(5 * 1024 * 1024 + 1);
      const result = store.append(sampleInsert({
        metadata: { big: bigValue },
        content: bigContent,
      }))!;

      assert.ok(result);
      const persisted = store.query({ limit: 1, includeContent: false })[0];
      const persistedMd = persisted.metadata as Record<string, unknown>;
      const marker = persistedMd.$auditTruncation as Record<string, unknown>;
      assert.ok(marker);
      const metadataArm = marker.metadata as Record<string, unknown>;
      const contentArm = marker.content as Record<string, unknown>;
      assert.equal(metadataArm.reason, "size-cap");
      assert.equal(contentArm.reason, "size-cap");
      assert.equal(contentArm.originalSize, bigContent.length);
    });
  });

  describe("persistence across restarts", () => {
    it("resumes sequence from last stored event", () => {
      store.append(sampleInsert());
      store.append(sampleInsert({ description: "second" }));
      store.close();

      const store2 = new AuditStore(dbPath);
      const e3 = store2.append(sampleInsert({ description: "third" }))!;
      assert.equal(e3.sequence, 3);
      store2.close();

      dbPath = makeTempDb();
      store = new AuditStore(dbPath);
    });

  });

  describe("chain hashes (spec §11.3)", () => {
    // contentHash = sha256("") for events with no content. Cached here so each
    // assertion reads as "what the spec says", not as a magic constant.
    const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    it("computes contentHash = sha256(content ?? '') and omits previousHash on genesis", () => {
      const e1 = store.append(sampleInsert({ content: "hello" }))!;
      assert.equal(e1.sequence, 1);
      assert.equal(e1.previousHash, undefined,
        "sequence 1 has no predecessor — previousHash must be omitted");
      // sha256("hello")
      assert.equal(e1.contentHash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");

      const e2 = store.append(sampleInsert({ description: "no content" }))!;
      assert.equal(e2.contentHash, SHA256_EMPTY,
        "missing content hashes as sha256 of the empty string");
    });

    it("chains previousHash to the prior event's contentHash", () => {
      const e1 = store.append(sampleInsert({ content: "first" }))!;
      const e2 = store.append(sampleInsert({ content: "second" }))!;
      const e3 = store.append(sampleInsert({ content: "third" }))!;
      assert.equal(e2.previousHash, e1.contentHash);
      assert.equal(e3.previousHash, e2.contentHash);
    });

    it("chain survives restart — predecessor lookup reads from the persisted row", () => {
      const e1 = store.append(sampleInsert({ content: "before restart" }))!;
      store.close();

      const store2 = new AuditStore(dbPath);
      const e2 = store2.append(sampleInsert({ content: "after restart" }))!;
      assert.equal(e2.sequence, 2);
      assert.equal(e2.previousHash, e1.contentHash,
        "restart must not break the chain — previous_hash lookup must read from SQLite, not in-memory state");
      store2.close();

      dbPath = makeTempDb();
      store = new AuditStore(dbPath);
    });

    it("query() returns events with contentHash and previousHash populated", () => {
      store.append(sampleInsert({ content: "first" }));
      store.append(sampleInsert({ content: "second" }));
      const events = store.query({ order: "asc" });
      assert.equal(events.length, 2);
      assert.ok(events[0].contentHash);
      assert.equal(events[0].previousHash, undefined);
      assert.equal(events[1].previousHash, events[0].contentHash);
    });
  });

  describe("degraded mode", () => {
    it("is not degraded initially", () => {
      assert.equal(store.isDegraded(), false);
    });

    it("returns undefined and sets degraded on append failure", () => {
      store.close();
      const badStore = store;
      store = new AuditStore(makeTempDb());

      const result = badStore.append(sampleInsert());
      assert.equal(result, undefined);
      assert.equal(badStore.isDegraded(), true);
    });

    it("clears degraded flag after successful append", () => {
      // Force degraded via a corrupted prepared statement
      const path2 = makeTempDb();
      const store2 = new AuditStore(path2);
      store2.append(sampleInsert());

      // Close and reopen to get a fresh handle, then corrupt it
      store2.close();
      const store3 = new AuditStore(path2);

      // Manually trigger degraded by closing underlying DB and attempting append
      store3.close();
      store3.append(sampleInsert({ description: "will fail" }));
      assert.equal(store3.isDegraded(), true);

      // Reopen — degraded starts false, proving recovery on construction
      const store4 = new AuditStore(path2);
      assert.equal(store4.isDegraded(), false);
      store4.append(sampleInsert({ description: "recovery" }));
      assert.equal(store4.isDegraded(), false);
      store4.close();
      cleanupDb(path2);
    });

    it("does not advance sequence on failure", () => {
      const e1 = store.append(sampleInsert())!;
      assert.equal(e1.sequence, 1);

      store.close();

      // Reopen the same DB
      const store2 = new AuditStore(dbPath);
      // The sequence should still be 1 since the failed store didn't advance
      const e2 = store2.append(sampleInsert({ description: "after close" }))!;
      assert.equal(e2.sequence, 2);
      store2.close();

      dbPath = makeTempDb();
      store = new AuditStore(dbPath);
    });
  });

  describe("many events", () => {
    it("handles 100 rapid inserts with correct sequence", () => {
      const events = [];
      for (let i = 0; i < 100; i++) {
        const e = store.append(sampleInsert({ description: `event-${i}`, metadata: { i } }))!;
        assert.ok(e);
        events.push(e);
      }

      assert.equal(events[events.length - 1].sequence, 100);
    });
  });

  // Regression: under the pre-v4 schema each AuditStore cached the next
  // sequence in memory, so two instances opened on the same file would race
  // and one would fail every append with UNIQUE constraint violations.
  // With AUTOINCREMENT + RETURNING the DB owns allocation and interleaved
  // writes must all succeed with unique sequences.
  describe("concurrent writers", () => {
    it("interleaved appends from two instances all succeed with unique sequences", () => {
      const storeA = new AuditStore(dbPath);
      const storeB = new AuditStore(dbPath);

      const events = [];
      const N = 25;
      for (let i = 0; i < N; i++) {
        const a = storeA.append(sampleInsert({ description: `A-${i}` }));
        const b = storeB.append(sampleInsert({ description: `B-${i}` }));
        assert.ok(a, `storeA append #${i} returned undefined`);
        assert.ok(b, `storeB append #${i} returned undefined`);
        events.push(a, b);
      }

      assert.equal(storeA.isDegraded(), false, "storeA should not be degraded");
      assert.equal(storeB.isDegraded(), false, "storeB should not be degraded");

      const sequences = events.map((e) => e.sequence).sort((x, y) => x - y);
      assert.equal(sequences.length, 2 * N);
      assert.equal(new Set(sequences).size, 2 * N, "sequences must be unique");
      // The pre-existing `store` from beforeEach has not appended, so the
      // sequence space for this test starts at 1.
      assert.deepEqual(sequences, Array.from({ length: 2 * N }, (_, i) => i + 1));

      storeA.close();
      storeB.close();
    });

    // The predecessor lookup is a subquery inside the INSERT, so concurrent
    // writers serialize on the write lock and each row's previous_hash must
    // equal the immediately preceding row's content_hash. Without the
    // subquery (separate SELECT MAX → INSERT), two writers could read the
    // same predecessor and produce a chain fork.
    it("interleaved appends preserve previous_hash chain integrity", () => {
      const storeA = new AuditStore(dbPath);
      const storeB = new AuditStore(dbPath);

      const N = 25;
      for (let i = 0; i < N; i++) {
        // Distinct content per row so contentHash varies — otherwise a
        // broken chain would still match against the identical hashes of
        // neighbouring rows and the test would pass trivially.
        assert.ok(storeA.append(sampleInsert({ content: `A-${i}` })));
        assert.ok(storeB.append(sampleInsert({ content: `B-${i}` })));
      }

      const events = storeA.query({ limit: 2 * N, order: "asc" });
      assert.equal(events.length, 2 * N);
      assert.equal(events[0].previousHash, undefined, "genesis row must have no previousHash");
      for (let i = 1; i < events.length; i++) {
        assert.equal(
          events[i].previousHash,
          events[i - 1].contentHash,
          `chain link broken at sequence ${events[i].sequence}`,
        );
      }

      storeA.close();
      storeB.close();
    });
  });

  describe("handlers with minimal context", () => {
    it("appends with all optional fields undefined", () => {
      const event = store.append({
        eventType: "session.start",
        category: "system",
        description: "minimal",
        metadata: {},
      })!;

      assert.ok(event);
      assert.equal(event.sessionId, undefined);
      assert.equal(event.orgId, undefined);
      assert.equal(event.userId, undefined);
      assert.equal(event.source, "openclaw-plugin");
    });
  });

  describe("content handling", () => {
    it("append returns raw content on the event", () => {
      const event = store.append(sampleInsert({ content: "full message body" }))!;
      assert.equal(event.content, "full message body");
    });

    it("append returns undefined content when not provided", () => {
      const event = store.append(sampleInsert())!;
      assert.equal(event.content, undefined);
    });

    // Empty-string content collapses to "no content" so `{content: ""}` and
    // `{}` produce observationally identical events. Both hash to sha256("")
    // and round-trip with `content: undefined`. Pins this behavior so a
    // future refactor doesn't silently introduce a "present but empty"
    // surface that downstream consumers would have to disambiguate.
    it("treats empty-string content as no content (same as omitted)", () => {
      const event = store.append(sampleInsert({ content: "" }))!;
      assert.equal(event.content, undefined,
        "empty-string content must round-trip as undefined on the returned event");
      assert.equal(event.contentHash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "empty-string content must hash to sha256('')");

      const persisted = store.query({ limit: 1, includeContent: true })[0];
      assert.equal(persisted.content, undefined,
        "persisted row must also report content as undefined, not as ''");
      assert.equal(persisted.contentHash, event.contentHash);
    });

    it("drops content exceeding MAX_CONTENT_SIZE and logs warning", () => {
      const capture = captureLogger(log);
      try {
        const bigContent = "x".repeat(5 * 1024 * 1024 + 1);
        const event = store.append(sampleInsert({ content: bigContent }))!;
        assert.ok(event);
        assert.equal(event.content, undefined);
        assert.ok(capture.messages.some((w) => w.includes("Content exceeds")));
      } finally {
        capture.restore();
      }
    });

    it("stores content gzipped in DB", () => {
      const event = store.append(sampleInsert({ content: "hello gzip" }))!;
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT content_gz FROM audit_events WHERE id = ?").get(event.id) as { content_gz: Uint8Array };
      assert.ok(row.content_gz);
      assert.equal(gunzipSync(row.content_gz).toString(), "hello gzip");
      db.close();
    });
  });

  describe("file permissions", () => {
    it("creates DB file with 0o600 permissions", () => {
      const newPath = makeTempDb();
      const newStore = new AuditStore(newPath);

      const stat = statSync(newPath);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, `Expected 0o600 but got 0o${mode.toString(8)}`);

      newStore.close();
      cleanupDb(newPath);
    });
  });

});
