import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { createGatewayPublisher } from "../../src/services/gateway-publisher.js";
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
      }, 500);
    });

    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 10,
      gatewayTimeoutMs: 50,
      gatewayIntervalMs: 60_000,
    });

    pub.notifyAppend(makeEvent(1));
    const start = Date.now();
    await pub.flushNow();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 400, `flushNow should not wait for slow server (took ${elapsed}ms)`);
    assert.ok(elapsed >= 40, `flushNow should respect timeout (only took ${elapsed}ms)`);
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
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 100,
      gatewayIntervalMs: 30,
    });
    await pub.start();
    await pub.start();
    await pub.start();
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 100));
    pub.stop();
    // Three timers would mean three POSTs in 100ms (~30ms each); a single
    // timer guarantees at most a small number of ticks. The auto-chain only
    // fires if buffer >= batchSize, which never happens here, so each tick
    // emits at most one POST. Just verify it didn't explode.
    assert.ok(received.length >= 1, "at least one tick should have fired");
    assert.ok(received.length <= 5, `expected only one timer, got ${received.length} POSTs`);
  });

  it("stop() stops the interval timer", async () => {
    const pub = createGatewayPublisher({
      gatewayUrl: `http://localhost:${port}`,
      gatewayApiKey: "sk-gw-test",
      gatewayBatchSize: 100,
      gatewayIntervalMs: 25,
    });
    await pub.start();
    pub.notifyAppend(makeEvent(1));
    await new Promise((r) => setTimeout(r, 80));
    const seenAfterStart = received.length;
    assert.ok(seenAfterStart >= 1);

    pub.stop();
    pub.notifyAppend(makeEvent(2));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(received.length, seenAfterStart);
  });
});
