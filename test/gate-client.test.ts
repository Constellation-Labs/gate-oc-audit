import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { probeGate } from "../src/services/gate-client.js";

function mockFetch(response: Partial<Response> & { url?: string } = {}): {
  fn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init: init as RequestInit | undefined });
    const status = response.status ?? 200;
    return new Response(response.body as BodyInit | null ?? "{}", {
      status,
      statusText: response.statusText ?? "OK",
    });
  };
  return { fn, calls };
}

describe("probeGate", () => {
  it("posts to /v1/audit/ingest with X-Gateway-Api-Key header", async () => {
    const { fn, calls } = mockFetch({ status: 200, body: '{"accepted":0}' });
    const result = await probeGate("https://gate.example.com", "sk-gw-aaaa", { fetchImpl: fn, machineId: "mach-test" });

    assert.equal(result.kind, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://gate.example.com/v1/audit/ingest");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-Gateway-Api-Key"], "sk-gw-aaaa");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(calls[0].init?.method, "POST");
  });

  it("includes machineId in the probe body so the gateway DTO validates", async () => {
    const { fn, calls } = mockFetch({ status: 200 });
    await probeGate("https://gate.example.com", "sk-gw-aaaa", { fetchImpl: fn, machineId: "mach-test" });
    const body = JSON.parse(calls[0].init?.body as string);
    assert.equal(body.machineId, "mach-test");
    assert.deepEqual(body.events, []);
  });

  it("sets redirect: manual so the API key is never resent across origins", async () => {
    const { fn, calls } = mockFetch({ status: 200 });
    await probeGate("https://gate.example.com", "sk-gw-aaaa", { fetchImpl: fn });
    assert.equal((calls[0].init as RequestInit).redirect, "manual");
  });

  it("strips trailing slashes from the base URL", async () => {
    const { fn, calls } = mockFetch({ status: 200 });
    await probeGate("https://gate.example.com//", "sk-gw-aaaa", { fetchImpl: fn });
    assert.equal(calls[0].url, "https://gate.example.com/v1/audit/ingest");
  });

  it("classifies 401 as unauthorized", async () => {
    const { fn } = mockFetch({ status: 401, body: "bad key" });
    const result = await probeGate("https://gate.example.com", "sk-gw-aaaa", { fetchImpl: fn });
    assert.equal(result.kind, "unauthorized");
    if (result.kind === "unauthorized") {
      assert.equal(result.status, 401);
      assert.equal(result.body, "bad key");
    }
  });

  it("classifies 500 as http-error", async () => {
    const { fn } = mockFetch({ status: 500, body: "boom" });
    const result = await probeGate("https://gate.example.com", "sk-gw-aaaa", { fetchImpl: fn });
    assert.equal(result.kind, "http-error");
  });

  it("classifies thrown fetch as network-error", async () => {
    const fn: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    const result = await probeGate("https://gate.example.com", "sk-gw-aaaa", { fetchImpl: fn });
    assert.equal(result.kind, "network-error");
    if (result.kind === "network-error") {
      assert.match(result.message, /ECONNREFUSED/);
    }
  });

  it("sanitizes control characters in the reflected error body", async () => {
    // Server echoing the submitted key into its 500 body must not flow
    // raw ANSI/CR/LF back to the operator's terminal.
    const evil = "leaked sk-gw-aaaa\r\n\x1b[31mred\x1b[0m";
    const { fn } = mockFetch({ status: 500, body: evil });
    const result = await probeGate("https://gate.example.com", "sk-gw-aaaa", { fetchImpl: fn });
    assert.equal(result.kind, "http-error");
    if (result.kind === "http-error") {
      // sanitizeForLog replaces \x00-\x1f and \x7f with spaces
      assert.equal(/[\x00-\x1f\x7f]/.test(result.body), false);
    }
  });
});
