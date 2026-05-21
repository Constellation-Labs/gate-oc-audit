import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import {
  createGatewayPublisher as createPublisherInternal,
  drainForShutdown,
  selectAnchorCovering,
  type GatewayPublisher,
  type GatewayPublisherDeps,
  type SmtCheckpointPayload,
} from "../../src/services/gateway-publisher.js";
import { gatewayPublisherLog } from "../../src/util/logger.js";
import { captureLogger } from "../test-utils/capture-logger.js";
import type { AuditEvent } from "../../src/types/events.js";

// Wire events are not structurally tied to AuditEvent — the envelope-shape
// test (below) is the authority on which fields cross the boundary. The
// known fields are listed for ergonomic test access; everything else falls
// through `[k: string]: unknown` so a typo'd field reference still type-checks.
type WireEvent = {
  id: string;
  sequence: number;
  content?: string;
  rawHash: string;
  censoredHash: string;
  [k: string]: unknown;
};
interface ReceivedRequest {
  url: string;
  method: string;
  headers: NodeJS.Dict<string | string[]>;
  body: { machineId?: string; events: WireEvent[]; smtCheckpoint?: SmtCheckpointPayload };
}

const RAW_HASH = "a".repeat(64);
const CENSORED_HASH = "b".repeat(64);

/**
 * Thin wrapper around `createGatewayPublisher` that auto-supplies the
 * `computeHashes` dep so every active-path test gets a publisher whose
 * payloads satisfy the gateway's required fields. Callers can still
 * override deps (e.g. `onDropMilestone`, `latestAnchoredCheckpoint`).
 */
function createPub(
  config: Record<string, unknown>,
  deps: GatewayPublisherDeps = {},
): GatewayPublisher {
  return createPublisherInternal(config, {
    computeHashes: () => ({ rawHash: RAW_HASH, censoredHash: CENSORED_HASH }),
    ...deps,
  });
}

function makeEvent(seq: number, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `00000000-0000-0000-0000-${seq.toString().padStart(12, "0")}`,
    sequence: seq,
    source: "openclaw-plugin",
    machineId: "test-machine",
    eventType: "tool.invoked",
    category: "tool",
    description: `event ${seq}`,
    metadata: { tool: "echo", seq },
    contentHash: "",
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...overrides,
  };
}

describe("GatewayPublisher", () => {
  let server: Server;
  let port: number;
  let received: ReceivedRequest[];
  let respond: (req: IncomingMessage, body: string) => { status: number; body: string };

  beforeEach(async () => {
    received = [];
    respond = () => ({ status: 202, body: '{"accepted":1}' });
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          received.push({
            url: req.url ?? "",
            method: req.method ?? "",
            headers: req.headers,
            body: JSON.parse(raw),
          });
        } catch {
          received.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body: { events: [] } });
        }
        const { status, body } = respond(req, raw);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns no-op when gatewayUrl is missing", () => {
    const pub = createPub({});
    assert.equal(pub.isActive(), false);
  });

  it("returns no-op when gatewayApiKey is missing", () => {
    const pub = createPub({ gatewayUrl: `http://localhost:${port}` });
    assert.equal(pub.isActive(), false);
  });

  it("returns no-op when gatewayEnabled=false even if url+key are set", () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayEnabled: false,
    });
    assert.equal(pub.isActive(), false);
  });

  it("returns no-op when gatewayUrl protocol is unsafe", () => {
    const pub = createPub({
      gatewayUrl: "file:///etc/passwd",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects http:// to non-loopback host", () => {
    const pub = createPub({
      gatewayUrl: "http://gateway.example.com",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects http:// to AWS metadata service", () => {
    const pub = createPub({
      gatewayUrl: "http://169.254.169.254/latest/meta-data/",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("accepts http:// to loopback (localhost / 127.0.0.1 / [::1])", () => {
    for (const host of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      const pub = createPub({ gatewayUrl: host, gatewayApiKey: "sk-gw-test" });
      assert.equal(pub.isActive(), true, `expected ${host} to be accepted`);
    }
  });

  it("rejects https:// to private RFC1918 IP without allow opt-in", () => {
    const pub = createPub({
      gatewayUrl: "https://10.0.0.5",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("accepts https:// to private IP when gatewayAllowPrivateHost=true", () => {
    const pub = createPub({
      gatewayUrl: "https://10.0.0.5",
      gatewayApiKey: "sk-gw-test",
      gatewayAllowPrivateHost: true,
    });
    assert.equal(pub.isActive(), true);
  });

  it("rejects malformed URL", () => {
    const pub = createPub({
      gatewayUrl: "not a url",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects API key containing CR/LF (header injection footgun)", () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-bad\r\nX-Injected: 1",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects API key containing whitespace", () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw bad",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects empty API key", () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "",
    });
    assert.equal(pub.isActive(), false);
  });

  it("clamps batchSize/intervalMs/timeoutMs to safe minima (no infinite-loop on 0/0.5)", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 0.5,        // floor=0, but clamp pushes to >= 1
      gatewayIntervalMs: 0,          // would fire every tick — clamp to >= 1000
      gatewayTimeoutMs: 0,           // would always-abort — clamp to >= 1000
    });
    assert.equal(pub.isActive(), true);

    pub.notifyAppend(makeEvent(1));
    // notifyAppend kicks off a fire-and-forget flush (batchSize=1 crossed).
    // Awaiting flushNow returns when the in-flight POST completes — avoids
    // a hard sleep that flakes on slower VMs where the round-trip exceeds
    // an arbitrary timeout.
    await pub.flushNow();
    // batchSize clamped to 1 — single event flushes successfully (POST landed,
    // not an empty body re-firing endlessly).
    assert.equal(received.length, 1);
    assert.equal(received[0].body.events.length, 1);
  });

  it("forwards event.content to the gateway", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1, { content: "the prompt" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].body.events[0].content, "the prompt");
  });

  it("drops oversized batches rather than requeueing them forever", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
      gatewayMaxPayloadBytes: 1024,
    });
    // 4 KB content, batchSize=1, max=1024 → payload exceeds limit.
    pub.notifyAppend(makeEvent(1, { content: "x".repeat(4096) }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 0, "oversized batch should not be sent");
    assert.equal(pub.bufferedCount(), 0, "oversized batch should not be requeued");
  });

  it("records a drop milestone via callback when buffer is full", async () => {
    const milestones: number[] = [];
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 100,
      gatewayBufferCapacity: 2,
      gatewayIntervalMs: 60_000,
    }, {
      onDropMilestone: (n) => milestones.push(n),
    });
    pub.notifyAppend(makeEvent(1));
    pub.notifyAppend(makeEvent(2));
    // Buffer now full. The next 12 appends should hit the exponential cadence
    // at 1, 2, 3, ... 9, 10 (then 100, 1000, ...).
    for (let i = 0; i < 12; i++) pub.notifyAppend(makeEvent(100 + i));
    // Cadence: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 → 10 milestones from 12 drops.
    assert.deepEqual(milestones, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("re-opens the circuit after half-open retry fails", async () => {
    respond = () => ({ status: 500, body: "still down" });
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 10,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1));
    for (let i = 0; i < 5; i++) await pub.flushNow();
    assert.equal(pub.isCircuitOpen(), true);
    // Force half-open by rewinding circuitOpenUntil. We can't reach it
    // directly, but a flushNow after the breaker decay window would attempt
    // one retry; here we verify the publisher correctly stays open in the
    // immediate window (no extra POSTs slip through).
    const before = received.length;
    await pub.flushNow();
    assert.equal(received.length, before, "circuit-open must suppress further POSTs");
  });

  it("POSTs batch with X-Gateway-Api-Key header to /v1/audit/ingest", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 2,
      gatewayIntervalMs: 60_000,
    });
    assert.equal(pub.isActive(), true);

    pub.notifyAppend(makeEvent(1));
    pub.notifyAppend(makeEvent(2));

    // Wait for the in-flight POST triggered by hitting batch size
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received.length, 1);
    const req = received[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/audit/ingest");
    assert.equal(req.headers["x-gateway-api-key"], "sk-gw-test");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.body.events.length, 2);
    assert.equal(req.body.events[0].sequence, 1);
    assert.equal(req.body.events[1].sequence, 2);
  });

  it("strips trailing slash on gatewayUrl when building ingest URL", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}/`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });

    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received[0].url, "/v1/audit/ingest");
  });

  it("requeues events on failure and retries on next flush", async () => {
    let callCount = 0;
    respond = () => {
      callCount++;
      if (callCount === 1) return { status: 500, body: "server error" };
      return { status: 202, body: '{"accepted":1}' };
    };

    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });

    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);

    await pub.flushNow();

    assert.equal(received.length, 2);
    assert.equal(received[0].body.events[0].sequence, 1);
    assert.equal(received[1].body.events[0].sequence, 1);
  });

  it("opens circuit breaker after 5 consecutive failures", async () => {
    respond = () => ({ status: 500, body: "boom" });

    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      // Larger than 1 so notifyAppend doesn't auto-flush — the test drives flushes itself.
      gatewayBatchSize: 10,
      gatewayIntervalMs: 60_000,
    });

    pub.notifyAppend(makeEvent(1));
    for (let i = 0; i < 5; i++) {
      await pub.flushNow();
    }
    assert.equal(received.length, 5);

    // Circuit is now open — further flush attempts should be skipped.
    await pub.flushNow();
    assert.equal(received.length, 5);
  });

  it("respects timeout configuration", async () => {
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      setTimeout(() => {
        res.writeHead(202);
        res.end('{"accepted":1}');
      }, 3_000);
    });

    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 10,
      // timeoutMs is clamped to >= 1000 to prevent always-abort misconfiguration.
      gatewayTimeoutMs: 1000,
      gatewayIntervalMs: 60_000,
    });

    pub.notifyAppend(makeEvent(1));
    const start = Date.now();
    await pub.flushNow();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_500, `flushNow should not wait for slow server (took ${elapsed}ms)`);
    assert.ok(elapsed >= 900, `flushNow should respect timeout (only took ${elapsed}ms)`);
  });

  it("does not flush when buffer is empty", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 5,
      gatewayIntervalMs: 60_000,
    });
    await pub.flushNow();
    assert.equal(received.length, 0);
  });

  it("exposes bufferedCount and isCircuitOpen on the interface", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 100,
      gatewayIntervalMs: 60_000,
    });
    assert.equal(pub.bufferedCount(), 0);
    assert.equal(pub.isCircuitOpen(), false);
    pub.notifyAppend(makeEvent(1));
    pub.notifyAppend(makeEvent(2));
    assert.equal(pub.bufferedCount(), 2);
  });

  it("auto-chains to drain full batches when buffer >= batchSize after a successful flush", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 5,
      gatewayIntervalMs: 60_000,
    });

    // Seed 15 events; batchSize=5 → exactly 3 full batches drain via chain.
    // Without chaining, only the first batch would land before the next
    // interval tick (which we set to 60s).
    for (let i = 1; i <= 15; i++) pub.notifyAppend(makeEvent(i));

    // Wait for the chain to drain (microtasks + network round-trips).
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received.length, 3);
    assert.equal(received[0].body.events.length, 5);
    assert.equal(received[1].body.events.length, 5);
    assert.equal(received[2].body.events.length, 5);
    assert.equal(pub.bufferedCount(), 0);
  });

  it("does not auto-chain a partial residue batch — that waits for the timer", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 5,
      gatewayIntervalMs: 60_000,
    });

    // 7 events → one full batch flushes (chained because >= batchSize), then
    // 2 leftover events should NOT trigger another auto-flush — they wait for
    // either more events or the next timer tick.
    for (let i = 1; i <= 7; i++) pub.notifyAppend(makeEvent(i));
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received.length, 1, "only the full batch should have been sent");
    assert.equal(pub.bufferedCount(), 2, "partial residue must remain buffered");
  });

  it("start() is idempotent — repeated calls don't leak timers", async () => {
    const originalSetInterval = global.setInterval;
    let intervalsCreated = 0;
    global.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervalsCreated++;
      return originalSetInterval(...args);
    }) as typeof setInterval;
    try {
      const pub = createPub({
        gatewayUrl: `http://localhost:${port}`,
        gatewayApiKey: "sk-gw-test",
        gatewayBatchSize: 100,
        gatewayIntervalMs: 60_000,
      });
      await pub.start();
      await pub.start();
      await pub.start();
      assert.equal(intervalsCreated, 1, "start() should call setInterval exactly once");
      pub.stop();
    } finally {
      global.setInterval = originalSetInterval;
    }
  });

  it("drainForShutdown drains buffered events on shutdown", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 5,
      gatewayIntervalMs: 60_000,
    });
    for (let i = 1; i <= 12; i++) pub.notifyAppend(makeEvent(i));
    pub.stop();
    await drainForShutdown(pub);
    assert.equal(pub.bufferedCount(), 0, "drain should empty the buffer");
    // 12 events / batchSize 5 = 3 batches (5, 5, 2)
    assert.equal(received.length, 3);
  });

  it("drainForShutdown respects wall-clock deadline on a slow gateway", async () => {
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      // Stall every response longer than the shutdown deadline.
      setTimeout(() => {
        res.writeHead(202);
        res.end('{"accepted":1}');
      }, 600);
    });
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
      gatewayTimeoutMs: 1000,
      gatewayShutdownDeadlineMs: 1000,
    });
    for (let i = 1; i <= 5; i++) pub.notifyAppend(makeEvent(i));
    pub.stop();
    const start = Date.now();
    await drainForShutdown(pub);
    const elapsed = Date.now() - start;
    // Deadline is 1s; allow generous slack for the in-flight POST already
    // started before drain (await must let it complete) but should not run
    // for the full 5*timeout=5s a naive iteration cap would permit.
    assert.ok(elapsed < 3000, `drain should respect deadline (took ${elapsed}ms)`);
    assert.ok(pub.bufferedCount() > 0, "deadline should leave events behind, not drain all");
  });

  it("drainForShutdown exits early when the circuit is open", async () => {
    respond = () => ({ status: 500, body: "down" });
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
      gatewayShutdownDeadlineMs: 30_000,
    });
    for (let i = 1; i <= 10; i++) pub.notifyAppend(makeEvent(i));
    // Trip the breaker (5 failures → open).
    for (let i = 0; i < 6; i++) await pub.flushNow();
    assert.equal(pub.isCircuitOpen(), true);
    pub.stop();
    const before = received.length;
    await drainForShutdown(pub);
    assert.equal(received.length, before, "no further POSTs while circuit is open");
    assert.ok(pub.bufferedCount() > 0, "events stay buffered when circuit is open at shutdown");
  });

  it("stop() stops the interval timer", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 100,
      // Clamped to >= 1000 internally; pick something > 1s so a tick fires
      // within the wait window below.
      gatewayIntervalMs: 1000,
    });
    await pub.start();
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 1200));
    const seenAfterStart = received.length;
    assert.ok(seenAfterStart >= 1, `expected timer to fire; saw ${seenAfterStart} POSTs`);

    pub.stop();
    pub.notifyAppend(makeEvent(2));
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(received.length, seenAfterStart);
  });

  // --- Spec §11.3 wire-contract coverage ---

  it("wraps the batch with top-level machineId per spec §11.3", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 2,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1, { machineId: "machine-A" }));
    pub.notifyAppend(makeEvent(2, { machineId: "machine-A" }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received.length, 1);
    assert.equal(received[0].body.machineId, "machine-A",
      "envelope must carry top-level machineId, not just per-event machineId");
    assert.equal(received[0].body.events.length, 2);
  });

  it("clamps gatewayBatchSize > 100 down to the spec cap (100)", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 500,
      gatewayIntervalMs: 60_000,
    });
    // Push 150 events. With batchSize ceiling at 100, the publisher should
    // POST in two batches: 100 then 50 (chained auto-flush on the first).
    for (let i = 1; i <= 150; i++) pub.notifyAppend(makeEvent(i));
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received.length, 1,
      "first batch flushes on cross-threshold; partial 50 awaits timer/chain");
    assert.equal(received[0].body.events.length, 100,
      "batch size must be clamped to spec cap (100), not the misconfigured 500");
  });

  it("pauses publishing on 429 with retryAfterMs and requeues the batch", async () => {
    let callCount = 0;
    respond = () => {
      callCount++;
      if (callCount === 1) return { status: 429, body: '{"error":"RATE_LIMITED","retryAfterMs":500}' };
      return { status: 200, body: '{"accepted":1,"duplicateCount":0,"highestSequence":1}' };
    };

    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));
    // First POST hit 429 — batch must be back in the buffer and publisher paused.
    assert.equal(received.length, 1);
    assert.equal(pub.isPaused(), true, "429 must pause the publisher");
    assert.equal(pub.bufferedCount(), 1, "rate-limited batch must be requeued");

    // While paused, flushNow is a no-op.
    await pub.flushNow();
    assert.equal(received.length, 1, "must not POST while rate-limit window is active");

    // Wait out the rate-limit window, then drive a retry.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(pub.isPaused(), false);
    await pub.flushNow();
    assert.equal(received.length, 2, "retry after rate-limit window must POST again");
    assert.equal(pub.bufferedCount(), 0);
  });

  it("splits a 413'd batch in half and retries each piece", async () => {
    let callCount = 0;
    const seenBatchSizes: number[] = [];
    respond = (_req, raw) => {
      callCount++;
      const parsed = JSON.parse(raw) as { events: AuditEvent[] };
      seenBatchSizes.push(parsed.events.length);
      // First POST (size=4) → 413; subsequent halves → 200.
      if (callCount === 1) return { status: 413, body: '{"error":"PAYLOAD_TOO_LARGE"}' };
      return { status: 200, body: '{"accepted":' + parsed.events.length + '}' };
    };

    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 4,
      gatewayIntervalMs: 60_000,
    });
    for (let i = 1; i <= 4; i++) pub.notifyAppend(makeEvent(i));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual(seenBatchSizes, [4, 2, 2],
      "413 must trigger a halving retry: 4 → 2 + 2");
    assert.equal(pub.bufferedCount(), 0);
  });

  it("drops a single oversized event on 413 rather than spinning", async () => {
    respond = () => ({ status: 413, body: '{"error":"PAYLOAD_TOO_LARGE"}' });
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1, "single event sent once, then dropped (no infinite split)");
    assert.equal(pub.bufferedCount(), 0, "single oversized event must be dropped, not requeued");
  });

  it("treats spec 200 response as success and accepts {duplicateCount, highestSequence} body", async () => {
    respond = () => ({ status: 200, body: '{"accepted":1,"duplicateCount":0,"highestSequence":42}' });
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));
    // Successful path: no requeue, no circuit-open, no rate-limit.
    assert.equal(pub.bufferedCount(), 0);
    assert.equal(pub.isCircuitOpen(), false);
    assert.equal(pub.isPaused(), false);
  });

  // ── SMT envelope wire-format contract ──────────────────────────────

  it("returns no-op when computeHashes is missing — gateway requires hashes on every event", () => {
    // Bypass the test helper to exercise the missing-dep branch directly.
    const pub = createPublisherInternal({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("envelope shape: top-level machineId, per-event rawHash + censoredHash, no orgId/syncedAt/contentHash/previousHash", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(7, {
      content: "the prompt",
      // Local-only fields that must NOT appear on the wire:
      orgId: "org-local",
      syncedAt: "2026-01-01T00:00:00Z",
      contentHash: "deadbeef",
      previousHash: "feedface",
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    const body = received[0].body;
    assert.equal(body.machineId, "test-machine");
    assert.equal(body.events.length, 1);
    const event = body.events[0] as unknown as Record<string, unknown>;
    assert.equal(event.rawHash, RAW_HASH);
    assert.equal(event.censoredHash, CENSORED_HASH);
    assert.equal(event.content, "the prompt");
    assert.equal("orgId" in event, false, "must not forward orgId");
    assert.equal("syncedAt" in event, false, "must not forward syncedAt");
    assert.equal("contentHash" in event, false, "must not forward legacy contentHash");
    assert.equal("previousHash" in event, false, "must not forward legacy previousHash");
  });

  it("attaches smtCheckpoint when the lookup callback returns one for the batch's max sequence", async () => {
    const lookupCalls: number[] = [];
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 2,
      gatewayIntervalMs: 60_000,
    }, {
      latestAnchoredCheckpoint: (maxSeq) => {
        lookupCalls.push(maxSeq);
        return {
          smtRoot: "deadbeef".repeat(8),
          sequenceStart: 1,
          sequenceEnd: 5,
          deTxHash: "0xanchor",
          createdAt: "2026-04-28T12:30:00.000Z",
        };
      },
    });
    pub.notifyAppend(makeEvent(4));
    pub.notifyAppend(makeEvent(5));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(lookupCalls, [5], "callback receives batch's max sequence");
    assert.ok(received[0].body.smtCheckpoint);
    assert.equal(received[0].body.smtCheckpoint?.deTxHash, "0xanchor");
    assert.equal(received[0].body.smtCheckpoint?.sequenceEnd, 5);
  });

  it("omits smtCheckpoint when the lookup callback returns null", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    }, {
      latestAnchoredCheckpoint: () => null,
    });
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal("smtCheckpoint" in received[0].body, false);
  });

  it("omits smtCheckpoint when no latestAnchoredCheckpoint callback is wired", async () => {
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal("smtCheckpoint" in received[0].body, false);
  });

  it("includes the response body in the error message on 4xx so contract drift self-explains", async () => {
    respond = () => ({ status: 400, body: '{"error":"rawHash mismatch for event evt-1"}' });
    const captured = captureLogger(gatewayPublisherLog);
    try {
      const pub = createPub({
        gatewayUrl: `http://localhost:${port}`,
        gatewayApiKey: "sk-gw-test",
        gatewayBatchSize: 1,
        gatewayIntervalMs: 60_000,
      });
      pub.notifyAppend(makeEvent(1));
      await pub.flushNow();
      assert.ok(pub.bufferedCount() >= 1, "failed batch should be requeued");
      const errLine = captured.messages.find((m) => m.includes("Publish failed"));
      assert.ok(errLine, `expected a Publish failed log line; saw: ${captured.messages.join(" | ")}`);
      assert.ok(
        errLine.includes("rawHash mismatch for event evt-1"),
        `expected gateway response body in error message; got: ${errLine}`,
      );
    } finally {
      captured.restore();
    }
  });

  it("sanitizes CR/LF in 4xx response body so a hostile gateway can't forge log lines", async () => {
    respond = () => ({
      status: 400,
      body: "evil\r\n[audit-plugin] CRITICAL fake forged line\r\nrest",
    });
    const captured = captureLogger(gatewayPublisherLog);
    try {
      const pub = createPub({
        gatewayUrl: `http://localhost:${port}`,
        gatewayApiKey: "sk-gw-test",
        gatewayBatchSize: 1,
        gatewayIntervalMs: 60_000,
      });
      pub.notifyAppend(makeEvent(1));
      await pub.flushNow();
      const errLine = captured.messages.find((m) => m.includes("Publish failed"));
      assert.ok(errLine, "expected a Publish failed log line");
      assert.equal(errLine.includes("\r"), false, "carriage return must be stripped");
      assert.equal(errLine.includes("\n"), false, "newline must be stripped");
      assert.ok(errLine.includes("fake forged line"), "sanitized body is still present (just with spaces)");
    } finally {
      captured.restore();
    }
  });

  it("does not increment circuit breaker on 429 — rate-limit is not a transport failure", async () => {
    respond = () => ({ status: 429, body: '{"error":"RATE_LIMITED","retryAfterMs":50}' });
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    pub.notifyAppend(makeEvent(1));
    // Drive enough flush attempts to trip the breaker if 429 counted as a failure.
    for (let i = 0; i < 6; i++) {
      await pub.flushNow();
      // Wait out the (50ms) rate-limit window between attempts.
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(pub.isCircuitOpen(), false, "429 must not trip the circuit breaker");
  });

  it("requeues the batch when computeHashes throws — events are not silently lost", async () => {
    const pub = createPublisherInternal({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    }, {
      computeHashes: () => { throw new Error("simulated SDK crash"); },
    });
    pub.notifyAppend(makeEvent(1));
    await pub.flushNow();
    assert.equal(pub.bufferedCount(), 1, "thrown computeHashes must not drop the event");
  });

  it("refuses to send a batch whose machineIds disagree (and drops it without requeue)", async () => {
    const captured = captureLogger(gatewayPublisherLog);
    try {
      const pub = createPub({
        gatewayUrl: `http://localhost:${port}`,
        gatewayApiKey: "sk-gw-test",
        gatewayBatchSize: 2,
        gatewayIntervalMs: 60_000,
      });
      pub.notifyAppend(makeEvent(1, { machineId: "machine-A" }));
      pub.notifyAppend(makeEvent(2, { machineId: "machine-B" }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(received.length, 0, "mixed-machineId batch must not POST");
      assert.equal(pub.bufferedCount(), 0, "permanent invariant violation: drop, do not requeue");
      const errLine = captured.messages.find((m) => m.includes("mixes machineIds"));
      assert.ok(errLine, `expected a mixes-machineIds log line; saw: ${captured.messages.join(" | ")}`);
    } finally {
      captured.restore();
    }
  });

  it("selectAnchorCovering returns the latest anchored checkpoint even when sequenceEnd < maxSequence", () => {
    // In steady state the buffer's maxSequence is always past the last
    // anchor's sequenceEnd (new events accumulate after the anchor). The
    // helper must still return the anchor so the envelope ships it; the
    // gateway controller does its own per-event coverage filter to decide
    // which rows link to the checkpoint vs. land as anchor-pending.
    const checkpoints = [
      { smtRoot: "r1", sequenceStart: 1, sequenceEnd: 5, deTxHash: "tx-1", createdAt: "2026-05-15T12:32:33Z" },
      // anchor-pending — must be skipped
      { smtRoot: "r2", sequenceStart: 6, sequenceEnd: 7, deTxHash: null,   createdAt: "2026-05-15T12:32:48Z" },
    ];
    const result = selectAnchorCovering(checkpoints, 7);
    assert.ok(result, "anchored checkpoint must be returned even though sequenceEnd=5 < maxSequence=7");
    assert.equal(result.smtRoot, "r1");
    assert.equal(result.deTxHash, "tx-1");
  });

  it("selectAnchorCovering skips checkpoints whose sequenceStart is past maxSequence", () => {
    // A future-anchored range starting after the batch tail can't possibly
    // cover any event in the batch; skip it. (Pathological in practice
    // because anchors are always over already-published roots, but the
    // helper should defensively skip rather than return a hint that can't
    // link any event.)
    const checkpoints = [
      { smtRoot: "r1", sequenceStart: 100, sequenceEnd: 110, deTxHash: "tx", createdAt: "2026-05-15T12:32:33Z" },
    ];
    assert.equal(selectAnchorCovering(checkpoints, 5), null);
  });

  it("requeues only the failing half on partial split failure (gateway dedupe not relied on)", async () => {
    let callCount = 0;
    const seenBatchSizes: number[] = [];
    respond = (_req, raw) => {
      callCount++;
      const parsed = JSON.parse(raw) as { events: AuditEvent[] };
      seenBatchSizes.push(parsed.events.length);
      // First POST (4) → 413; first half (2) → 200; second half (2) → 500.
      if (callCount === 1) return { status: 413, body: '{"error":"PAYLOAD_TOO_LARGE"}' };
      if (callCount === 2) return { status: 200, body: '{"accepted":2}' };
      return { status: 500, body: "transient" };
    };
    const pub = createPub({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 4,
      gatewayIntervalMs: 60_000,
    });
    for (let i = 1; i <= 4; i++) pub.notifyAppend(makeEvent(i));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual(seenBatchSizes, [4, 2, 2]);
    // The accepted first half (sequences 1-2) must NOT be requeued. Only the
    // failing second half (sequences 3-4) returns to the buffer.
    assert.equal(pub.bufferedCount(), 2, "only the failing second half should be requeued");
  });

  describe("health() (R6)", () => {
    it("NoOp publisher returns isActive=false with zeroed counters", () => {
      const pub = createPub({});
      assert.deepEqual(pub.health(), {
        isActive: false,
        buffered: 0,
        droppedToday: 0,
        circuitOpen: false,
        lastSuccessAt: undefined,
        lastErrorAt: undefined,
      });
    });

    it("active publisher reports buffered+lastSuccessAt after a successful flush", async () => {
      const updates: { isActive: boolean; lastSuccessAt: string | undefined }[] = [];
      const pub = createPub({
        gatewayUrl: `http://localhost:${port}`,
        gatewayApiKey: "sk-gw-test",
        gatewayBatchSize: 1,
        gatewayIntervalMs: 60_000,
      }, {
        onHealthUpdate: (h) => updates.push({ isActive: h.isActive, lastSuccessAt: h.lastSuccessAt }),
      });
      pub.notifyAppend(makeEvent(1));
      await pub.flushNow();
      const h = pub.health();
      assert.equal(h.isActive, true);
      assert.equal(h.buffered, 0);
      assert.equal(h.circuitOpen, false);
      assert.ok(h.lastSuccessAt, "expected lastSuccessAt to be set after a successful flush");
      // At least one health update fired with a populated lastSuccessAt.
      assert.ok(updates.some((u) => u.lastSuccessAt));
    });

    it("active publisher reports droppedToday and lastErrorAt on failure", async () => {
      respond = () => ({ status: 500, body: "down" });
      const pub = createPub({
        gatewayUrl: `http://localhost:${port}`,
        gatewayApiKey: "sk-gw-test",
        gatewayBatchSize: 1,
        gatewayBufferCapacity: 1,
        gatewayIntervalMs: 60_000,
      });
      // First event fits in the buffer; flush fails (500), event requeued.
      pub.notifyAppend(makeEvent(1));
      await pub.flushNow();
      // Buffer now has the requeued event; capacity=1 so the next append drops.
      pub.notifyAppend(makeEvent(2));
      const h = pub.health();
      assert.equal(h.droppedToday, 1, `expected droppedToday=1, got ${h.droppedToday}`);
      assert.ok(h.lastErrorAt, "lastErrorAt should be populated after a 500");
    });
  });
});
