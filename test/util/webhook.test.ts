import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { isUnsafeWebhookUrl, postJsonWebhook } from "../../src/util/webhook.js";

describe("isUnsafeWebhookUrl", () => {
  it("accepts https URLs", () => {
    assert.equal(isUnsafeWebhookUrl("https://hooks.slack.com/x"), undefined);
  });

  it("accepts http URLs (loopback/dev)", () => {
    assert.equal(isUnsafeWebhookUrl("http://127.0.0.1:1234/"), undefined);
  });

  it("rejects malformed URLs", () => {
    assert.match(isUnsafeWebhookUrl("not a url")!, /malformed/);
  });

  it("rejects non-http(s) protocols", () => {
    assert.match(isUnsafeWebhookUrl("file:///etc/passwd")!, /disallowed protocol file:/);
    assert.match(isUnsafeWebhookUrl("ftp://example.com/")!, /disallowed protocol ftp:/);
    assert.match(isUnsafeWebhookUrl("javascript:alert(1)")!, /disallowed protocol/);
  });
});

interface WebhookRig {
  baseUrl: string;
  /** Bodies the server received, in order. */
  received: Array<{ method: string; headers: Record<string, string>; body: string }>;
  /** Override per-request to control status/timing. */
  setHandler: (h: (req: IncomingMessage, res: ServerResponse) => void) => void;
  destroy: () => Promise<void>;
}

async function createWebhookRig(): Promise<WebhookRig> {
  const received: WebhookRig["received"] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    received.push({
      method: req.method ?? "",
      headers: req.headers as Record<string, string>,
      body: Buffer.concat(chunks).toString("utf-8"),
    });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    setHandler: (h) => { handler = h; },
    destroy: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("postJsonWebhook", () => {
  let rig: WebhookRig;
  before(async () => { rig = await createWebhookRig(); });
  after(async () => { await rig.destroy(); });

  it("POSTs JSON and returns ok=true on 2xx", async () => {
    const result = await postJsonWebhook(rig.baseUrl + "/ok", { hello: "world" });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    const last = rig.received[rig.received.length - 1]!;
    assert.equal(last.method, "POST");
    assert.equal(last.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(last.body), { hello: "world" });
  });

  it("returns ok=false with status on 5xx", async () => {
    rig.setHandler((_req, res) => { res.statusCode = 503; res.statusMessage = "Service Unavailable"; res.end(); });
    const result = await postJsonWebhook(rig.baseUrl + "/oops", { x: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.error, "Service Unavailable");
  });

  it("returns ok=false on a network failure (closed port)", async () => {
    // 127.0.0.1:1 is reserved and not listened to in normal envs.
    const result = await postJsonWebhook("http://127.0.0.1:1/", { x: 1 }, { timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  it("times out a slow server within timeoutMs", async () => {
    rig.setHandler((_req, _res) => {
      // Don't reply — let the AbortSignal cut us off.
    });
    const start = Date.now();
    const result = await postJsonWebhook(rig.baseUrl + "/slow", { x: 1 }, { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.ok(result.error);
    // A bit of slack for slow CI; the signal should still fire well under 1s.
    assert.ok(elapsed < 1000, `expected fast timeout, got ${elapsed}ms`);
  });
});
