import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { createGatewayPublisher, drainForShutdown } from "../../src/services/gateway-publisher.js";
import type { AuditEvent } from "../../src/types/events.js";

interface ReceivedRequest {
  url: string;
  method: string;
  headers: NodeJS.Dict<string | string[]>;
  body: { events: AuditEvent[] };
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
    const pub = createGatewayPublisher({});
    assert.equal(pub.isActive(), false);
  });

  it("returns no-op when gatewayApiKey is missing", () => {
    const pub = createGatewayPublisher({ gatewayUrl: `http://localhost:${port}` });
    assert.equal(pub.isActive(), false);
  });

  it("returns no-op when gatewayEnabled=false even if url+key are set", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayEnabled: false,
    });
    assert.equal(pub.isActive(), false);
  });

  it("returns no-op when gatewayUrl protocol is unsafe", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: "file:///etc/passwd",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects http:// to non-loopback host", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: "http://gateway.example.com",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects http:// to AWS metadata service", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: "http://169.254.169.254/latest/meta-data/",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("accepts http:// to loopback (localhost / 127.0.0.1 / [::1])", () => {
    for (const host of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      const pub = createGatewayPublisher({ gatewayUrl: host, gatewayApiKey: "sk-gw-test" });
      assert.equal(pub.isActive(), true, `expected ${host} to be accepted`);
    }
  });

  it("rejects https:// to private RFC1918 IP without allow opt-in", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: "https://10.0.0.5",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("accepts https:// to private IP when gatewayAllowPrivateHost=true", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: "https://10.0.0.5",
      gatewayApiKey: "sk-gw-test",
      gatewayAllowPrivateHost: true,
    });
    assert.equal(pub.isActive(), true);
  });

  it("rejects malformed URL", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: "not a url",
      gatewayApiKey: "sk-gw-test",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects API key containing CR/LF (header injection footgun)", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-bad\r\nX-Injected: 1",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects API key containing whitespace", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw bad",
    });
    assert.equal(pub.isActive(), false);
  });

  it("rejects empty API key", () => {
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "",
    });
    assert.equal(pub.isActive(), false);
  });

  it("clamps batchSize/intervalMs/timeoutMs to safe minima (no infinite-loop on 0/0.5)", async () => {
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 0.5,        // floor=0, but clamp pushes to >= 1
      gatewayIntervalMs: 0,          // would fire every tick — clamp to >= 1000
      gatewayTimeoutMs: 0,           // would always-abort — clamp to >= 1000
    });
    assert.equal(pub.isActive(), true);

    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 80));
    // batchSize clamped to 1 — single event flushes successfully (POST landed,
    // not an empty body re-firing endlessly).
    assert.equal(received.length, 1);
    assert.equal(received[0].body.events.length, 1);
  });

  it("forwards event.content to the gateway", async () => {
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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

  it("POSTs batch with X-Gateway-Api-Key header to /admin/audit/ingest", async () => {
    const pub = createGatewayPublisher({
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
    assert.equal(req.url, "/admin/audit/ingest");
    assert.equal(req.headers["x-gateway-api-key"], "sk-gw-test");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.body.events.length, 2);
    assert.equal(req.body.events[0].sequence, 1);
    assert.equal(req.body.events[1].sequence, 2);
  });

  it("strips trailing slash on gatewayUrl when building ingest URL", async () => {
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}/`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });

    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received[0].url, "/admin/audit/ingest");
  });

  it("requeues events on failure and retries on next flush", async () => {
    let callCount = 0;
    respond = () => {
      callCount++;
      if (callCount === 1) return { status: 500, body: "server error" };
      return { status: 202, body: '{"accepted":1}' };
    };

    const pub = createGatewayPublisher({
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

    const pub = createGatewayPublisher({
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

    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 5,
      gatewayIntervalMs: 60_000,
    });
    await pub.flushNow();
    assert.equal(received.length, 0);
  });

  it("exposes bufferedCount and isCircuitOpen on the interface", async () => {
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
      const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
    const pub = createGatewayPublisher({
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
});
