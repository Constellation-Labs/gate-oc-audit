import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../src/store/audit-store.js";
import { RateLimiter } from "../src/rate-limiter.js";
import type { AuditEventInsert } from "../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-ratelimit-")), "test.db");
}

function makeInsert(overrides: Partial<AuditEventInsert> = {}): AuditEventInsert {
  return {
    sessionId: "sess-1",
    eventType: "tool.result",
    category: "tool",
    description: "test",
    metadata: { test: true },
    ...overrides,
  };
}

describe("RateLimiter", () => {
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

  it("passes events through when under threshold", () => {
    const limiter = new RateLimiter(store, { rateLimitPerSec: 100 });

    for (let i = 0; i < 10; i++) {
      const result = limiter.append(makeInsert({ metadata: { i } }));
      assert.ok(result, `Event ${i} should be written directly`);
    }

    assert.equal(store.count(), 10);
    assert.equal(limiter.bufferedCount, 0);
  });

  it("buffers events when over threshold", () => {
    const limiter = new RateLimiter(store, { rateLimitPerSec: 5 });

    for (let i = 0; i < 10; i++) {
      limiter.append(makeInsert({ metadata: { i } }));
    }

    // First 5 should be written directly, rest buffered
    assert.equal(store.count(), 5);
    assert.equal(limiter.bufferedCount, 5);
  });

  it("flush writes all buffered events", () => {
    const limiter = new RateLimiter(store, { rateLimitPerSec: 3 });

    for (let i = 0; i < 10; i++) {
      limiter.append(makeInsert({ metadata: { i } }));
    }

    assert.equal(store.count(), 3);
    limiter.flush();
    assert.equal(store.count(), 10);
    assert.equal(limiter.bufferedCount, 0);
  });

  it("preserves full-fidelity categories during coalescing", () => {
    const limiter = new RateLimiter(store, { rateLimitPerSec: 2, rateLimitBufferSize: 5 });

    // Fill past threshold
    for (let i = 0; i < 2; i++) {
      limiter.append(makeInsert());
    }

    // These should go to buffer
    // Add a config event (full-fidelity) among tool events
    limiter.append(makeInsert({ eventType: "tool.result", category: "tool", description: "tool-1" }));
    limiter.append(makeInsert({ eventType: "config.skill_changed", category: "config", description: "config-1" }));
    limiter.append(makeInsert({ eventType: "tool.result", category: "tool", description: "tool-2" }));

    // Flush to drain buffer
    limiter.flush();

    const events = store.query({ limit: 100 });
    // Config event should be preserved with its original description
    const configEvents = events.filter((e) => e.category === "config");
    assert.equal(configEvents.length, 1);
    assert.equal(configEvents[0].description, "config-1");
  });

  it("coalesces consecutive tool events when buffer is full", () => {
    const limiter = new RateLimiter(store, { rateLimitPerSec: 1, rateLimitBufferSize: 5 });

    // Write 1 event directly
    limiter.append(makeInsert());

    // Buffer 5 tool events (fills buffer)
    for (let i = 0; i < 5; i++) {
      limiter.append(makeInsert({
        eventType: "tool.result",
        category: "tool",
        description: `tool-${i}`,
        metadata: { durationMs: 100 },
      }));
    }

    // This triggers coalescing since buffer is full
    limiter.append(makeInsert({ description: "one-more" }));

    limiter.flush();

    // Should have coalesced the 5 tool events into 1 summary
    const events = store.query({ limit: 100 });
    const coalesced = events.filter((e) => (e.metadata as Record<string, unknown>).coalesced === true);
    assert.ok(coalesced.length >= 1, "Should have at least one coalesced event");

    const summary = coalesced[0];
    assert.ok(summary.description.includes("tool.result events"));
    assert.ok((summary.metadata as Record<string, unknown>).eventCount as number >= 2);
  });

  it("resets window after 1 second", async () => {
    const limiter = new RateLimiter(store, { rateLimitPerSec: 3 });

    for (let i = 0; i < 3; i++) {
      limiter.append(makeInsert());
    }
    assert.equal(store.count(), 3);

    // Wait for window reset
    await new Promise((r) => setTimeout(r, 1100));

    // Should be able to write directly again
    const result = limiter.append(makeInsert());
    assert.ok(result, "Should write directly after window reset");
    assert.equal(store.count(), 4);

    limiter.flush();
  });
});
