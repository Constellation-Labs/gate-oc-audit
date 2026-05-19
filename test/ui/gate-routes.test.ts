/**
 * /api/gate/* route tests. Each test boots a fresh in-process HTTP server
 * with the audit-UI routes mounted, points the installer at an isolated
 * tmp openclaw config dir, and exercises the routes via fetch.
 *
 * The probe path is exercised by mocking the upstream Gate via a second
 * loopback HTTP server — that's enough to verify request shaping
 * (headers, body, redirect mode) without depending on a real swarm-deck.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AuditStore } from "../../src/store/audit-store.js";
import { SmtService } from "../../src/services/smt-service.js";
import { Verifier } from "../../src/services/verifier.js";
import { registerAuditUiRoutes } from "../../src/ui/routes.js";

type RouteEntry = {
  path: string;
  match?: "exact" | "prefix";
  auth: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
};

interface Rig {
  baseUrl: string;
  openclawDir: string;
  server: Server;
  destroy: () => Promise<void>;
}

async function bootRig(opts: {
  isNonLoopback?: () => boolean;
  allowGateMutationOnNonLoopback?: boolean;
} = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "audit-gate-routes-"));
  const dbPath = join(dir, "audit.db");
  const openclawDir = join(dir, ".openclaw");

  const store = new AuditStore(dbPath);
  const smt = new SmtService({ dbPath, smt: { checkpointDir: join(dir, "smt"), checkpointIntervalMs: 0 } });
  await smt.start();
  const verifier = new Verifier(store, smt);

  const routes: RouteEntry[] = [];
  const api = { registerHttpRoute: (r: RouteEntry) => { routes.push(r); } };
  registerAuditUiRoutes(api as never, store, smt, verifier, {
    isNonLoopback: opts.isNonLoopback,
    allowGateMutationOnNonLoopback: opts.allowGateMutationOnNonLoopback,
    openclawDir,
  });
  routes.sort((a, b) => b.path.length - a.path.length);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      for (const route of routes) {
        const ok = route.match === "exact" ? url.pathname === route.path : url.pathname.startsWith(route.path);
        if (!ok) continue;
        const handled = await route.handler(req, res);
        if (handled || res.headersSent || res.writableEnded) return;
      }
      if (!res.headersSent) { res.statusCode = 404; res.end(); }
    } catch (err) {
      if (!res.headersSent) { res.statusCode = 500; res.end(err instanceof Error ? err.message : String(err)); }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    openclawDir,
    server,
    destroy: async () => {
      await smt.stop();
      store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Boot a mock Gate that echoes a fixed status code. Lets the install
 * probe round-trip without needing a real swarm-deck.
 */
async function bootMockGate(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("/api/gate/status", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("returns 'not configured' on a fresh openclawDir", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, false);
    assert.equal(body.hasApiKey, false);
  });

  it("does not include the API key value after install", async () => {
    const mock = await bootMockGate((_req, res) => { res.statusCode = 200; res.end("{}"); });
    try {
      const installRes = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mock.url, apiKey: "sk-gw-aaaa", registerBroker: false, allowPrivateHost: false, skipProbe: true }),
      });
      assert.equal(installRes.status, 200);

      const statusRes = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/status`);
      const text = await statusRes.text();
      assert.ok(!text.includes("sk-gw-aaaa"), "status response must not leak the API key");
      const status = JSON.parse(text);
      assert.equal(status.hasApiKey, true);
      assert.equal(status.url, mock.url);
    } finally {
      await mock.close();
    }
  });
});

describe("/api/gate/install", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("writes config to the configured openclawDir on success", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", registerBroker: false, skipProbe: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.changes.length > 0);
    assert.equal(body.probe, "skipped");

    const cfg = JSON.parse(readFileSync(join(rig.openclawDir, "config.json"), "utf-8"));
    assert.equal(cfg.plugins.entries["constellation-audit-plugin"].config.gatewayUrl, "http://127.0.0.1:1");
  });

  it("returns 400 when url is missing", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-gw-aaaa" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when the URL fails validation (http to non-loopback)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://gate.example.com", apiKey: "sk-gw-aaaa", skipProbe: true }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /http/i);
  });

  it("returns 400 when the URL contains userinfo", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://user:pass@gate.example.com", apiKey: "sk-gw-aaaa", skipProbe: true }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /userinfo/i);
  });
});

describe("/api/gate/test", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("returns 400 when no config exists and no body is supplied", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, { method: "POST", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 400);
  });

  it("refuses --url override without an apiKey (exfil guard)", async () => {
    // Pre-install so a saved key exists on disk.
    await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-saved", registerBroker: false, skipProbe: true }),
    });

    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:2" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /apiKey/i);
  });

  it("probes the saved Gate when called with no body", async () => {
    const mock = await bootMockGate((req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/v1/audit/ingest");
      res.statusCode = 200;
      res.end('{"accepted":0}');
    });
    try {
      await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mock.url, apiKey: "sk-gw-aaaa", registerBroker: false, skipProbe: true }),
      });

      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, { method: "POST", headers: { "content-type": "application/json" } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.result.kind, "ok");
      assert.equal(body.url, mock.url);
    } finally {
      await mock.close();
    }
  });
});

describe("/api/gate/* non-loopback gating", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await bootRig({ isNonLoopback: () => true, allowGateMutationOnNonLoopback: false });
  });
  afterEach(async () => { await rig.destroy(); });

  it("blocks /install when gateway is non-loopback and opt-in is off", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", skipProbe: true }),
    });
    assert.equal(res.status, 403);
  });

  it("blocks /test when gateway is non-loopback and opt-in is off", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, { method: "POST", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 403);
  });

  it("status remains readable on a non-loopback bind (no mutation, no probe)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/status`);
    assert.equal(res.status, 200);
  });
});

describe("/api/gate/* with allowGateMutationOnNonLoopback=true", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await bootRig({ isNonLoopback: () => true, allowGateMutationOnNonLoopback: true });
  });
  afterEach(async () => { await rig.destroy(); });

  it("allows install on a non-loopback bind when the opt-in is set", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", registerBroker: false, skipProbe: true }),
    });
    assert.equal(res.status, 200);
  });
});

describe("CSRF defense on /api/gate/{install,test}", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("rejects POST /install without Content-Type: application/json (415)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", skipProbe: true }),
    });
    assert.equal(res.status, 415);
    const cfgPath = join(rig.openclawDir, "config.json");
    assert.equal(existsSync(cfgPath), false);
  });

  it("rejects POST /install when Origin does not match Host (403)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json", "origin": "https://evil.example" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", skipProbe: true }),
    });
    assert.equal(res.status, 403);
  });

  it("rejects POST /test when Sec-Fetch-Site is cross-site (403)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });

  it("accepts a same-origin POST (Sec-Fetch-Site: same-origin + Origin matches Host)", async () => {
    const port = new URL(rig.baseUrl).port;
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": `http://127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", registerBroker: false, skipProbe: true }),
    });
    assert.equal(res.status, 200);
  });

  it("sets X-Frame-Options: DENY on every JSON response (clickjacking)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/status`);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  });
});

describe("/api/gate/install — additional cases", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("registerBroker: false actually omits the broker provider from config", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", registerBroker: false, skipProbe: true }),
    });
    assert.equal(res.status, 200);
    const cfg = JSON.parse(readFileSync(join(rig.openclawDir, "config.json"), "utf-8"));
    assert.equal(cfg.models, undefined);
  });

  it("rejects a non-boolean registerBroker (truthy stringy value does not skip broker)", async () => {
    // Strict validation: only `false` opts out. `"false"` (a string)
    // must default to true (so the broker IS written).
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", registerBroker: "false", skipProbe: true }),
    });
    assert.equal(res.status, 200);
    const cfg = JSON.parse(readFileSync(join(rig.openclawDir, "config.json"), "utf-8"));
    assert.ok(cfg.models?.providers?.gate);
  });

  it("returns 400 with the canonical validator message when probe fails (401)", async () => {
    const mock = await bootMockGate((_req, res) => { res.statusCode = 401; res.end("bad key"); });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mock.url, apiKey: "sk-gw-aaaa", registerBroker: false }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /401/);
      // Nothing should be written when probe fails
      assert.equal(existsSync(join(rig.openclawDir, "config.json")), false);
    } finally {
      await mock.close();
    }
  });

  it("returns 400 for malformed JSON body", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  it("treats empty-string url as missing", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "", apiKey: "sk-gw-aaaa" }),
    });
    assert.equal(res.status, 400);
  });

  it("treats whitespace-only apiKey as missing", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "   " }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 404 for GET on the install path (method-not-allowed via implicit miss)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`);
    assert.equal(res.status, 404);
  });
});

describe("/api/gate/test — additional cases", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("supports both url + apiKey overridden (no saved config touched)", async () => {
    const mock = await bootMockGate((_req, res) => { res.statusCode = 200; res.end("{}"); });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mock.url, apiKey: "sk-gw-override" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.result.kind, "ok");
      assert.equal(body.url, mock.url);
    } finally {
      await mock.close();
    }
  });

  it("supports apiKey-only body (no url) — falls back to saved url", async () => {
    const mock = await bootMockGate((_req, res) => { res.statusCode = 200; res.end("{}"); });
    try {
      // First install so a saved URL exists
      await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mock.url, apiKey: "sk-gw-saved", registerBroker: false, skipProbe: true }),
      });

      // Now test with a different apiKey but no url override — must use saved url
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-gw-different" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.url, mock.url);
    } finally {
      await mock.close();
    }
  });

  it("honors allowPrivateHost when probing a saved private-host Gate", async () => {
    // Install a Gate at a private-IP loopback (no allowPrivateHost
    // needed at install time because 127.0.0.1 is loopback, not private).
    // But test the allowPrivateHost knob on /test itself via a body that
    // exercises the validator path:
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://10.0.0.5:8080", apiKey: "sk-gw-aaaa", allowPrivateHost: true }),
    });
    // 10.0.0.5 won't actually respond, but we should pass URL validation
    // and reach the probe (which then network-errors). Either way: NOT 400.
    assert.notEqual(res.status, 400);
    if (res.status === 200) {
      const body = await res.json();
      assert.equal(body.result.kind, "network-error");
    }
  });

  it("rejects a private-host URL without allowPrivateHost", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://10.0.0.5:8080", apiKey: "sk-gw-aaaa" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /private/i);
  });
});

describe("/api/gate/providers (add / list / remove)", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("starts empty, then lists an openai provider after add", async () => {
    const list1 = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`).then((r) => r.json());
    assert.deepEqual(list1, { providers: [] });

    const addRes = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "openai", apiKey: "sk-test-aaaa" }),
    });
    assert.equal(addRes.status, 200);

    const list2 = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`).then((r) => r.json());
    assert.equal(list2.providers.length, 1);
    assert.equal(list2.providers[0].key, "openai");
    assert.equal(list2.providers[0].auth, "api-key");
    assert.equal(list2.providers[0].hasApiKey, true);
    // The API key value must NEVER appear in the redacted listing
    const text = JSON.stringify(list2);
    assert.equal(text.includes("sk-test-aaaa"), false);
  });

  it("rejects non-openai kinds", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "anthropic", apiKey: "sk-x" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects empty / whitespace apiKey", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "openai", apiKey: "   " }),
    });
    assert.equal(res.status, 400);
  });

  it("removes a provider via DELETE", async () => {
    await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "openai", apiKey: "sk-test-aaaa" }),
    });
    const delRes = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers/openai`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    assert.equal(delRes.status, 200);
    const list = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`).then((r) => r.json());
    assert.deepEqual(list, { providers: [] });
  });

  it("refuses to delete the 'gate' broker key", async () => {
    // Install a real gate broker first
    await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", skipProbe: true }),
    });
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers/gate`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /broker/i);
  });

  it("CSRF: POST without application/json content-type is rejected", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ kind: "openai", apiKey: "sk-test" }),
    });
    assert.equal(res.status, 415);
  });
});

describe("/api/gate/oauth/openai/* — lifecycle", () => {
  let rig: Rig;
  let mockProvider: { close: () => Promise<void>; baseUrl: string };
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => {
    if (mockProvider) await mockProvider.close();
    await rig.destroy();
    delete process.env.OPENCLAW_OPENAI_OAUTH_BASE_URL;
    delete process.env.OPENCLAW_OPENAI_OAUTH_CLIENT_ID;
    delete process.env.OPENCLAW_OPENAI_OAUTH_PORT;
  });

  async function bootMockOauthProvider(opts: { tokenStatus?: number; tokenBody?: unknown } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const { createServer } = await import("node:http");
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      if (url.pathname === "/oauth/authorize") { res.statusCode = 200; res.end("authorize-page-mock"); return; }
      if (url.pathname === "/oauth/token") {
        const chunks: Buffer[] = [];
        for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
        const status = opts.tokenStatus ?? 200;
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        const defaultBody = {
          access_token: "tok_access_abc",
          refresh_token: "tok_refresh_xyz",
          id_token: "id_jwt",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email offline_access",
        };
        res.end(JSON.stringify(opts.tokenBody ?? defaultBody));
        return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  /** Allocate a free loopback port for the OAuth listener. */
  async function freePort(): Promise<number> {
    const { createServer } = await import("node:http");
    return await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
  }

  it("start → status (pending) → callback → status (complete) writes provider config", async () => {
    mockProvider = await bootMockOauthProvider();
    const port = await freePort();
    process.env.OPENCLAW_OPENAI_OAUTH_BASE_URL = mockProvider.baseUrl;
    process.env.OPENCLAW_OPENAI_OAUTH_CLIENT_ID = "test-client";
    process.env.OPENCLAW_OPENAI_OAUTH_PORT = String(port);

    const startRes = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startRes.status, 200);
    const { sessionId, authUrl } = await startRes.json();
    assert.ok(sessionId);
    assert.match(authUrl, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize/);

    // Pending check
    let statusBody = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/${sessionId}/status`).then((r) => r.json());
    assert.equal(statusBody.kind, "pending");

    // Simulate the operator completing the flow by hitting the loopback
    // callback with the state parsed from the authorize URL.
    const state = new URL(authUrl).searchParams.get("state")!;
    const cb = await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    assert.equal(cb.status, 200);

    // Poll until complete (the route's onOauthComplete runs in a then() callback).
    let kind = "pending";
    for (let i = 0; i < 30 && kind === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      statusBody = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/${sessionId}/status`).then((r) => r.json());
      kind = statusBody.kind;
    }
    assert.equal(kind, "complete");
    assert.equal(statusBody.providerKey, "openai");
    assert.ok(typeof statusBody.expiresAt === "string");

    // The token must NOT appear in the status response
    const text = JSON.stringify(statusBody);
    assert.equal(text.includes("tok_access_abc"), false);
    assert.equal(text.includes("tok_refresh_xyz"), false);

    // And the config file must contain the provider with the access token
    const cfg = JSON.parse(readFileSync(join(rig.openclawDir, "config.json"), "utf-8"));
    assert.equal(cfg.models.providers.openai.apiKey, "tok_access_abc");
    assert.equal(cfg.models.providers.openai.openclawAudit.oauth.refreshToken, "tok_refresh_xyz");
  });

  it("rejects a second /start while one is pending (409)", async () => {
    mockProvider = await bootMockOauthProvider();
    const port = await freePort();
    process.env.OPENCLAW_OPENAI_OAUTH_BASE_URL = mockProvider.baseUrl;
    process.env.OPENCLAW_OPENAI_OAUTH_PORT = String(port);

    const first = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(second.status, 409);

    // Cleanup: cancel the pending flow
    const { sessionId } = await first.json();
    await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  });

  it("status returns 404 for an unknown sessionId", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/does-not-exist/status`);
    assert.equal(res.status, 404);
  });

  it("/cancel rejects without application/json content-type (CSRF)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/anything/cancel`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "",
    });
    assert.equal(res.status, 415);
  });
});

describe("/api/gate/oauth/openai/* — non-loopback gating", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig({ isNonLoopback: () => true, allowGateMutationOnNonLoopback: false }); });
  afterEach(async () => { await rig.destroy(); });

  it("blocks /start when bound beyond loopback and opt-in off", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  it("blocks /cancel when bound beyond loopback and opt-in off", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/oauth/openai/any-sid/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });
});

describe("/api/gate/providers — refuses providerKey: 'gate' (symmetric with remove)", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("POST returns 400 when providerKey is 'gate'", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "openai", providerKey: "gate", apiKey: "sk-x" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /broker|reserved/i);
  });
});

describe("/api/gate/status — populated shape", () => {
  let rig: Rig;
  beforeEach(async () => { rig = await bootRig(); });
  afterEach(async () => { await rig.destroy(); });

  it("returns the full StatusReport shape after install", async () => {
    await fetch(`${rig.baseUrl}/plugins/audit/api/gate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "sk-gw-aaaa", registerBroker: true, skipProbe: true }),
    });
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/gate/status`);
    const body = await res.json();
    assert.equal(typeof body.configPath, "string");
    assert.equal(body.configured, true);
    assert.equal(body.url, "http://127.0.0.1:1");
    assert.equal(body.hasApiKey, true);
    assert.equal(body.allowlisted, true);
    assert.equal(body.conversationAccess, true);
    assert.equal(body.enabled, true);
    assert.equal(body.brokerProviderKey, "gate");
    // Critical: the actual key value must NEVER be in the response
    assert.equal(Object.values(body).some((v) => v === "sk-gw-aaaa"), false);
  });
});
