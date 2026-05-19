import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

import { resolveOpenAIOAuthEndpoints, type OpenAIOAuthEndpoints } from "./openai-oauth-constants.js";

/**
 * Local-loopback OAuth 2.1 PKCE flow against `auth.openai.com`. The
 * plugin starts an ephemeral HTTP server on a fixed loopback port the
 * upstream OAuth provider has on its redirect-URI allowlist, hands the
 * operator a URL to open in their browser, and waits for the callback.
 *
 * Security guards:
 *   - `state` is a 32-byte CSPRNG nonce; mismatched/missing → reject.
 *   - The callback handler refuses any request whose Host header is
 *     not loopback (defeats the case where the system has somehow
 *     bound the listener to a non-127.0.0.1 interface).
 *   - The loopback server has a hard TTL; if no callback arrives
 *     within `timeoutMs` it is torn down so the port doesn't linger.
 *   - On Ctrl-C / external abort, the server is torn down.
 *   - Tokens / authorization codes are never logged.
 *
 * Concurrency: the redirect_uri port is fixed (codex convention) so at
 * most one flow can be in flight at a time. `startOpenAIOAuthFlow`
 * throws `EADDRINUSE` if the port is busy; callers should surface that
 * to the operator.
 */

export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Seconds until access token expiry. */
  expiresIn: number;
  /** Absolute ISO-8601 expiry (computed: now + expiresIn). */
  expiresAt: string;
  scope?: string;
  tokenType: string;
}

export interface StartOAuthFlowOptions {
  /** Override default endpoint constants. Mainly for tests. */
  endpoints?: OpenAIOAuthEndpoints;
  /** Cap the wait. Server is torn down on timeout. Default: 5 minutes. */
  timeoutMs?: number;
  /** Test seam: override fetch for the token-exchange call. */
  fetchImpl?: typeof fetch;
}

export interface ActiveOAuthFlow {
  /** Open this URL in the operator's browser. */
  authUrl: string;
  /** Resolves when the operator completes the flow; rejects on
   *  timeout, state mismatch, or token-exchange failure. */
  waitForToken: Promise<OAuthToken>;
  /** Force teardown — invokes the same cleanup as a successful callback
   *  or a timeout. Safe to call multiple times. */
  cancel: () => void;
  /** The loopback port the listener is bound to (informational). */
  port: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const SUCCESS_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Sign-in complete</title></head>" +
  "<body style=\"font-family:system-ui;text-align:center;padding:4em\">" +
  "<h1>Sign-in complete</h1><p>You can close this tab and return to OpenClaw.</p>" +
  "</body></html>";

export function startOpenAIOAuthFlow(opts: StartOAuthFlowOptions = {}): ActiveOAuthFlow {
  const endpoints = opts.endpoints ?? resolveOpenAIOAuthEndpoints();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const verifier = base64urlBytes(randomBytes(32));
  const challenge = base64urlBytes(createHash("sha256").update(verifier).digest());
  const state = base64urlBytes(randomBytes(32));

  let server: Server | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveToken!: (t: OAuthToken) => void;
  let rejectToken!: (err: Error) => void;

  const tokenPromise = new Promise<OAuthToken>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  // Hoisted so `cancel()` can settle the promise itself rather than
  // tearing down resources without notifying awaiting callers — a
  // bare `server.close()` would leave anyone holding `waitForToken`
  // hanging forever.
  const finish = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (server) server.close();
    fn();
  };

  timeoutHandle = setTimeout(() => {
    finish(() => rejectToken(new Error(`OAuth flow timed out after ${timeoutMs}ms — no callback received`)));
  }, timeoutMs);

  server = createServer(async (req, res) => {
    try {
      const handled = await handleCallback(req, res, {
        endpoints,
        expectedState: state,
        verifier,
        fetchImpl,
      });
      if (handled.kind === "wrong-path") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      if (handled.kind === "non-loopback") {
        res.statusCode = 400;
        res.end("only loopback callbacks are accepted");
        return;
      }
      if (handled.kind === "error") {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`OAuth callback error: ${handled.message}`);
        finish(() => rejectToken(new Error(handled.message)));
        return;
      }
      // success path
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      finish(() => resolveToken(handled.token));
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("internal error");
      }
      finish(() => rejectToken(err instanceof Error ? err : new Error(String(err))));
    }
  });

  server.on("error", (err) => {
    finish(() => rejectToken(err));
  });

  server.listen(endpoints.redirectPort, "127.0.0.1");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: endpoints.clientId,
    redirect_uri: endpoints.redirectUri,
    scope: endpoints.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authUrl = `${endpoints.authorizeUrl}?${params.toString()}`;

  // Pre-attach a no-op rejection handler so an unawaited `cancel()`
  // doesn't surface as an unhandled-rejection warning. Callers that
  // care attach their own handler via `await waitForToken`.
  tokenPromise.catch(() => { /* swallow — callers opt in via waitForToken */ });

  return {
    authUrl,
    waitForToken: tokenPromise,
    cancel: () => finish(() => rejectToken(new Error("OAuth flow cancelled"))),
    port: endpoints.redirectPort,
  };
}

type CallbackOutcome =
  | { kind: "wrong-path" }
  | { kind: "non-loopback" }
  | { kind: "error"; message: string }
  | { kind: "ok"; token: OAuthToken };

async function handleCallback(
  req: IncomingMessage,
  _res: ServerResponse,
  ctx: {
    endpoints: OpenAIOAuthEndpoints;
    expectedState: string;
    verifier: string;
    fetchImpl: typeof fetch;
  },
): Promise<CallbackOutcome> {
  // Reject anything where the Host header doesn't look like loopback.
  // The listener already binds to 127.0.0.1 only; this is belt-and-
  // braces against a misconfigured proxy or a forged Host header.
  const host = req.headers.host;
  if (typeof host !== "string" || !isLoopbackHostHeader(host)) {
    return { kind: "non-loopback" };
  }
  const url = (() => {
    try { return new URL(req.url ?? "", `http://${host}`); } catch { return undefined; }
  })();
  if (!url) return { kind: "error", message: "malformed callback URL" };
  if (url.pathname !== "/callback") return { kind: "wrong-path" };

  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description") ?? "";
    return { kind: "error", message: `${error}${desc ? `: ${desc}` : ""}` };
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return { kind: "error", message: "missing 'code' parameter" };
  if (!state) return { kind: "error", message: "missing 'state' parameter" };
  if (!timingSafeStringEq(state, ctx.expectedState)) {
    return { kind: "error", message: "state mismatch (CSRF / replay)" };
  }

  // Token exchange
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ctx.endpoints.clientId,
    code,
    code_verifier: ctx.verifier,
    redirect_uri: ctx.endpoints.redirectUri,
  });
  let res: Response;
  try {
    res = await ctx.fetchImpl(ctx.endpoints.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
  } catch (err) {
    return { kind: "error", message: `token exchange failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const text = await safeBodyText(res);
    return { kind: "error", message: `token endpoint returned HTTP ${res.status}: ${text}` };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { kind: "error", message: "token endpoint did not return JSON" };
  }
  const token = normalizeTokenResponse(parsed);
  if (!token) return { kind: "error", message: "token endpoint response missing required fields" };
  return { kind: "ok", token };
}

/** When `allowMissingRefreshToken` is true, callers must supply a
 * prior refresh token to fold into the result — used by the refresh
 * flow where some OAuth servers legitimately omit `refresh_token` and
 * expect the client to reuse the prior one (RFC 6749 §6). */
function normalizeTokenResponse(raw: unknown, opts: { allowMissingRefreshToken?: boolean } = {}): OAuthToken | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const accessToken = typeof r.access_token === "string" ? r.access_token : undefined;
  const refreshToken = typeof r.refresh_token === "string" ? r.refresh_token : undefined;
  const expiresIn = typeof r.expires_in === "number" ? r.expires_in : undefined;
  if (!accessToken || expiresIn === undefined) return undefined;
  if (!refreshToken && !opts.allowMissingRefreshToken) return undefined;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    accessToken,
    refreshToken: refreshToken ?? "",
    idToken: typeof r.id_token === "string" ? r.id_token : undefined,
    expiresIn,
    expiresAt,
    scope: typeof r.scope === "string" ? r.scope : undefined,
    tokenType: typeof r.token_type === "string" ? r.token_type : "Bearer",
  };
}

/**
 * Accept only Host header values whose effective host is loopback.
 * Browsers and the upstream OAuth provider always send one of:
 *   - `localhost[:port]`
 *   - `127.0.0.1[:port]` (or any 127.x.x.x)
 *   - `[::1][:port]` (bracketed IPv6 — RFC 7230 §5.4)
 *
 * Anchored matches only; substring tricks like `evil.com[::1]` are
 * rejected. This is belt-and-braces — the listener itself binds to
 * `127.0.0.1`, so a forged Host header can't reach it remotely. But
 * the guard guards against a future change that lets the listener
 * bind beyond loopback (e.g. an operator override).
 */
function isLoopbackHostHeader(h: string): boolean {
  const lower = h.toLowerCase();
  // localhost[:port]
  if (/^localhost(:\d+)?$/.test(lower)) return true;
  // 127.x.x.x[:port]
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(lower)) return true;
  // [::1][:port] — RFC 7230 bracketed-IPv6 form
  if (/^\[::1\](:\d+)?$/.test(lower)) return true;
  // Bare ::1 — non-standard for Host headers, but accept defensively
  // since some test harnesses (and curl --resolve) emit it.
  if (lower === "::1") return true;
  return false;
}

function timingSafeStringEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function base64urlBytes(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    // Strip control chars and cap at 500 bytes — the token endpoint
    // could legitimately echo the submitted client_id but should never
    // echo the code or verifier; trim defensively anyway.
    return t.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * Refresh an expired (or near-expired) OAuth access token using its
 * refresh token. The new refresh token (if rotated) replaces the old
 * one in the returned struct — callers should persist the full result.
 */
export async function refreshOpenAIToken(
  refreshToken: string,
  opts: { endpoints?: OpenAIOAuthEndpoints; fetchImpl?: typeof fetch } = {},
): Promise<OAuthToken> {
  const endpoints = opts.endpoints ?? resolveOpenAIOAuthEndpoints();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: endpoints.clientId,
    refresh_token: refreshToken,
  });
  const res = await fetchImpl(endpoints.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  if (!res.ok) {
    const text = await safeBodyText(res);
    throw new Error(`refresh failed: HTTP ${res.status}: ${text}`);
  }
  const parsed = await res.json();
  const token = normalizeTokenResponse(parsed, { allowMissingRefreshToken: true });
  if (!token) throw new Error("refresh response missing required fields");
  // RFC 6749 §6: refresh token rotation is optional. Reuse the existing
  // refresh token when the server doesn't include a new one.
  return token.refreshToken !== "" ? token : { ...token, refreshToken };
}
