import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { startOpenAIOAuthFlow, refreshOpenAIToken } from "../src/services/openai-oauth.js";
import type { OpenAIOAuthEndpoints } from "../src/services/openai-oauth-constants.js";

/**
 * Spin up a mock OAuth provider on an ephemeral loopback port. Returns
 * endpoint constants the OAuth module accepts via the `endpoints`
 * option, plus a way to drive the flow by triggering the callback as
 * the "browser" would.
 */
async function bootMockProvider(opts: {
  // Optional override for how the token endpoint responds
  tokenStatus?: number;
  tokenBody?: unknown;
} = {}): Promise<{
  endpoints: (loopbackPort: number) => OpenAIOAuthEndpoints;
  capturedAuthorize: { params: URLSearchParams }[];
  capturedToken: { params: URLSearchParams }[];
  close: () => Promise<void>;
  baseUrl: string;
}> {
  const capturedAuthorize: { params: URLSearchParams }[] = [];
  const capturedToken: { params: URLSearchParams }[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    if (url.pathname === "/oauth/authorize") {
      capturedAuthorize.push({ params: url.searchParams });
      res.statusCode = 200;
      res.end("authorize-page-mock");
      return;
    }
    if (url.pathname === "/oauth/token") {
      const chunks: Buffer[] = [];
      for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
      const body = Buffer.concat(chunks).toString("utf8");
      capturedToken.push({ params: new URLSearchParams(body) });
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
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    endpoints: (loopbackPort: number) => ({
      authorizeUrl: `${baseUrl}/oauth/authorize`,
      tokenUrl: `${baseUrl}/oauth/token`,
      clientId: "test-client",
      redirectPort: loopbackPort,
      scopes: "openid profile email offline_access",
      redirectUri: `http://localhost:${loopbackPort}/callback`,
    }),
    capturedAuthorize,
    capturedToken,
    close: () => new Promise<void>((r) => server.close(() => r())),
    baseUrl,
  };
}

/** Allocate a free ephemeral port for the OAuth loopback. */
async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const s: Server = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Drive the OAuth callback as the browser would, after parsing the
 * state out of the authorize URL the flow emitted. */
async function simulateCallback(authUrl: string, loopbackPort: number, opts: { code?: string; stateOverride?: string; error?: string } = {}): Promise<Response> {
  const url = new URL(authUrl);
  const state = opts.stateOverride ?? url.searchParams.get("state") ?? "";
  const code = opts.code ?? "test-auth-code";
  const cb = new URL(`http://localhost:${loopbackPort}/callback`);
  if (opts.error) {
    cb.searchParams.set("error", opts.error);
  } else {
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", state);
  }
  return await fetch(cb.toString(), { redirect: "manual" });
}

describe("openai-oauth: startOpenAIOAuthFlow", () => {
  it("completes the PKCE round-trip and resolves with a token", async () => {
    const port = await freeLoopbackPort();
    const mock = await bootMockProvider();
    try {
      const endpoints = mock.endpoints(port);
      const flow = startOpenAIOAuthFlow({ endpoints });

      // The authorize URL must include challenge, state, redirect, scope, client_id
      const url = new URL(flow.authUrl);
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("client_id"), "test-client");
      assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${port}/callback`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const challenge = url.searchParams.get("code_challenge");
      assert.ok(challenge && challenge.length >= 43, "code_challenge missing or short");
      const state = url.searchParams.get("state");
      assert.ok(state && state.length >= 32, "state missing or short");

      // Simulate the user completing the flow
      const cbRes = await simulateCallback(flow.authUrl, port);
      assert.equal(cbRes.status, 200);

      const token = await flow.waitForToken;
      assert.equal(token.accessToken, "tok_access_abc");
      assert.equal(token.refreshToken, "tok_refresh_xyz");
      assert.equal(token.tokenType, "Bearer");
      assert.ok(token.expiresAt > new Date().toISOString());

      // Token endpoint must receive code, code_verifier, and client_id.
      assert.equal(mock.capturedToken.length, 1);
      const params = mock.capturedToken[0].params;
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("client_id"), "test-client");
      assert.equal(params.get("code"), "test-auth-code");
      assert.ok(params.get("code_verifier"));
    } finally {
      await mock.close();
    }
  });

  it("rejects on state mismatch (CSRF / replay)", async () => {
    const port = await freeLoopbackPort();
    const mock = await bootMockProvider();
    try {
      const flow = startOpenAIOAuthFlow({ endpoints: mock.endpoints(port) });
      // Attach the assertion synchronously so the rejection has a
      // listener by the time it fires.
      const asserted = assert.rejects(flow.waitForToken, /state mismatch/);
      const cbRes = await simulateCallback(flow.authUrl, port, { stateOverride: "wrong-state" });
      assert.equal(cbRes.status, 400);
      await asserted;
    } finally {
      await mock.close();
    }
  });

  it("rejects when the provider returns ?error=", async () => {
    const port = await freeLoopbackPort();
    const mock = await bootMockProvider();
    try {
      const flow = startOpenAIOAuthFlow({ endpoints: mock.endpoints(port) });
      const asserted = assert.rejects(flow.waitForToken, /access_denied/);
      await simulateCallback(flow.authUrl, port, { error: "access_denied" });
      await asserted;
    } finally {
      await mock.close();
    }
  });

  it("rejects when the token endpoint returns a non-2xx", async () => {
    const port = await freeLoopbackPort();
    const mock = await bootMockProvider({ tokenStatus: 401, tokenBody: { error: "invalid_grant" } });
    try {
      const flow = startOpenAIOAuthFlow({ endpoints: mock.endpoints(port) });
      const asserted = assert.rejects(flow.waitForToken, /HTTP 401/);
      await simulateCallback(flow.authUrl, port);
      await asserted;
    } finally {
      await mock.close();
    }
  });

  it("rejects when the token endpoint omits required fields", async () => {
    const port = await freeLoopbackPort();
    const mock = await bootMockProvider({ tokenBody: { access_token: "only-access" } });
    try {
      const flow = startOpenAIOAuthFlow({ endpoints: mock.endpoints(port) });
      const asserted = assert.rejects(flow.waitForToken, /missing required fields/);
      await simulateCallback(flow.authUrl, port);
      await asserted;
    } finally {
      await mock.close();
    }
  });

  it("times out cleanly when no callback arrives", async () => {
    const port = await freeLoopbackPort();
    const mock = await bootMockProvider();
    try {
      const flow = startOpenAIOAuthFlow({ endpoints: mock.endpoints(port), timeoutMs: 100 });
      await assert.rejects(flow.waitForToken, /timed out/);
    } finally {
      await mock.close();
    }
  });

  it("cancel() tears the listener down so the port is freed", async () => {
    const port = await freeLoopbackPort();
    const mock = await bootMockProvider();
    try {
      const flow = startOpenAIOAuthFlow({ endpoints: mock.endpoints(port), timeoutMs: 30_000 });
      flow.cancel();
      // After cancel, the loopback port is released — we can bind a new
      // server on it without EADDRINUSE.
      await new Promise<void>((resolve) => {
        const s = createServer();
        s.listen(port, "127.0.0.1", () => { s.close(() => resolve()); });
      });
    } finally {
      await mock.close();
    }
  });

  it("EADDRINUSE when the loopback port is already bound", async () => {
    const port = await freeLoopbackPort();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    const mock = await bootMockProvider();
    try {
      const flow = startOpenAIOAuthFlow({ endpoints: mock.endpoints(port), timeoutMs: 200 });
      const asserted = assert.rejects(flow.waitForToken, /EADDRINUSE/);
      await asserted;
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
      await mock.close();
    }
  });
});

describe("openai-oauth: refreshOpenAIToken", () => {
  it("surfaces a clear error when the response omits required fields", async () => {
    // The current normalize requires refresh_token; a server that
    // doesn't include one yields a clean "missing required fields"
    // error rather than a silently broken token struct.
    const mock = await bootMockProvider({
      tokenBody: {
        access_token: "tok_new_access",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });
    try {
      const endpoints = mock.endpoints(0);
      await assert.rejects(
        refreshOpenAIToken("rt-prior", { endpoints }),
        /missing required fields/,
      );
    } finally {
      await mock.close();
    }
  });

  it("happy path: rotated refresh token replaces the prior one", async () => {
    const mock = await bootMockProvider({
      tokenBody: {
        access_token: "tok_new_access",
        refresh_token: "tok_new_refresh",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });
    try {
      const endpoints = mock.endpoints(0);
      const token = await refreshOpenAIToken("rt-prior", { endpoints });
      assert.equal(token.accessToken, "tok_new_access");
      assert.equal(token.refreshToken, "tok_new_refresh");
    } finally {
      await mock.close();
    }
  });
});
