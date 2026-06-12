import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { isUnsafeWebhookUrl, postJsonWebhook } from "../../src/util/webhook.js";
import {
  assertResolvedAddressAllowed,
  classifyResolvedAddress,
} from "../../src/util/network-policy.js";

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

describe("classifyResolvedAddress (send-time SSRF)", () => {
  it("allows a loopback IP when the configured host is loopback (dev http://localhost)", () => {
    assert.equal(classifyResolvedAddress("127.0.0.1", { hostIsLoopback: true }).ok, true);
    assert.equal(classifyResolvedAddress("::1", { hostIsLoopback: true }).ok, true);
  });

  it("rejects a loopback IP when the configured host is public (DNS->loopback)", () => {
    const r = classifyResolvedAddress("127.0.0.1", { hostIsLoopback: false });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /loopback/);
  });

  it("rejects private/link-local resolved IPs for a public host", () => {
    for (const ip of ["10.0.0.5", "192.168.1.10", "169.254.169.254", "172.16.0.1"]) {
      const r = classifyResolvedAddress(ip, { hostIsLoopback: false });
      assert.equal(r.ok, false, `${ip} should be rejected`);
    }
  });

  it("rejects a loopback host that resolves into a private/link-local range", () => {
    const r = classifyResolvedAddress("169.254.169.254", { hostIsLoopback: true });
    assert.equal(r.ok, false);
  });

  it("allows a public IP for a public host", () => {
    assert.equal(classifyResolvedAddress("93.184.216.34", { hostIsLoopback: false }).ok, true);
  });

  it("honors allowPrivateHost only for the private range, never loopback", () => {
    assert.equal(
      classifyResolvedAddress("10.0.0.5", { hostIsLoopback: false, allowPrivateHost: true }).ok,
      true,
    );
    assert.equal(
      classifyResolvedAddress("127.0.0.1", { hostIsLoopback: false, allowPrivateHost: true }).ok,
      false,
    );
  });
});

describe("assertResolvedAddressAllowed (injected lookup)", () => {
  it("blocks a public hostname that resolves to a private IP", async () => {
    const r = await assertResolvedAddressAllowed(
      "https://evil.example.com/hook",
      async () => [{ address: "10.1.2.3" }],
    );
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /private\/link-local/);
  });

  it("blocks if ANY resolved address violates the policy", async () => {
    const r = await assertResolvedAddressAllowed(
      "https://multi.example.com/hook",
      async () => [{ address: "93.184.216.34" }, { address: "169.254.169.254" }],
    );
    assert.equal(r.ok, false);
  });

  it("allows http://localhost resolving to loopback (dev path preserved)", async () => {
    const r = await assertResolvedAddressAllowed(
      "http://localhost:1234/",
      async () => [{ address: "127.0.0.1" }],
    );
    assert.equal(r.ok, true);
  });

  it("fails safe on a DNS lookup error (do not send)", async () => {
    const r = await assertResolvedAddressAllowed(
      "https://broken.example.com/hook",
      async () => { throw new Error("ENOTFOUND"); },
    );
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /DNS resolution failed/);
  });

  it("fails safe when resolution yields no addresses", async () => {
    const r = await assertResolvedAddressAllowed(
      "https://empty.example.com/hook",
      async () => [],
    );
    assert.equal(r.ok, false);
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

  it("sanitizes CR/LF/tab and caps length in the error string", async () => {
    rig.setHandler((_req, res) => {
      // Pad statusMessage with CRLF and a long tail. Node may already strip
      // CRLF from statusText, but our sanitizer is the contract here.
      res.statusCode = 503;
      res.statusMessage = "bad" + "x".repeat(500);
      res.end();
    });
    const result = await postJsonWebhook(rig.baseUrl + "/long", { x: 1 });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.ok(!/[\r\n\t]/.test(result.error!), "CR/LF/tab must be stripped");
    assert.ok(result.error!.length <= 200, `error capped to 200 chars, got ${result.error!.length}`);
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
