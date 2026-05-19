import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import {
  applyProviderEntryPatch,
  readOpenclawConfig,
  readProviders,
  removeProviderEntry,
  writeOpenclawConfig,
  type JsonObject,
} from "./util/openclaw-config-writer.js";
import { resolveOpenclawDir } from "./util/openclaw-paths.js";
import { OPENAI_PROVIDER_BASE_URL, resolveOpenAIOAuthEndpoints } from "./services/openai-oauth-constants.js";
import { startOpenAIOAuthFlow } from "./services/openai-oauth.js";

const API_KEY_ENV = "OPENCLAW_OPENAI_API_KEY";

function outLine(s: string): void { process.stdout.write(`${s}\n`); }
function errLine(s: string): void { process.stderr.write(`${s}\n`); }

export interface ProviderListOptions {
  json?: boolean;
  openclawDir?: string;
}

export function cliProviderListHandler(opts: ProviderListOptions): void {
  const dir = resolveOpenclawDir({ openclawDir: opts.openclawDir });
  let file;
  try { file = readOpenclawConfig(dir); }
  catch (err) { errLine(`provider list: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; return; }
  const providers = readProviders(file.content);

  // Per-provider redacted view: never emit the api-key value or OAuth
  // refresh token; only the metadata that helps the operator decide
  // whether a provider entry is healthy.
  const rows = Object.entries(providers).map(([key, entry]) => {
    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : "(unset)";
    const auth = typeof entry.auth === "string" ? entry.auth : "(unset)";
    const hasApiKey = typeof entry.apiKey === "string" && entry.apiKey.length > 0;
    let oauthExpiresAt: string | undefined;
    if (entry.openclawAudit && typeof entry.openclawAudit === "object" && !Array.isArray(entry.openclawAudit)) {
      const meta = entry.openclawAudit as Record<string, unknown>;
      if (meta.oauth && typeof meta.oauth === "object" && !Array.isArray(meta.oauth)) {
        const oa = meta.oauth as Record<string, unknown>;
        if (typeof oa.expiresAt === "string") oauthExpiresAt = oa.expiresAt;
        else if (oa.expiresAt !== undefined) oauthExpiresAt = "(malformed)";
      }
    }
    return { key, baseUrl, auth, hasApiKey, oauthExpiresAt };
  });

  if (opts.json) {
    outLine(JSON.stringify({ providers: rows }));
    return;
  }
  if (rows.length === 0) {
    outLine("No providers configured.");
    return;
  }
  for (const r of rows) {
    const oauth = r.oauthExpiresAt ? `  oauth: token expires ${r.oauthExpiresAt}` : "";
    outLine(`${r.key}\n  ${r.auth}  ${r.baseUrl}  ${r.hasApiKey ? "[key set]" : "[no key]"}${oauth}`);
  }
}

export interface ProviderRemoveOptions {
  json?: boolean;
  openclawDir?: string;
}

export function cliProviderRemoveHandler(providerKey: string, opts: ProviderRemoveOptions): void {
  const dir = resolveOpenclawDir({ openclawDir: opts.openclawDir });
  let file;
  try { file = readOpenclawConfig(dir); }
  catch (err) { errLine(`provider remove: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; return; }
  let changes: string[];
  try { changes = removeProviderEntry(file.content, providerKey); }
  catch (err) {
    errLine(`provider remove: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (changes.length > 0) writeOpenclawConfig(file.path, file.content);
  if (opts.json) {
    outLine(JSON.stringify({ ok: true, changes }));
    return;
  }
  if (changes.length === 0) outLine(`No provider named '${providerKey}'.`);
  else outLine(`Removed provider '${providerKey}'. Restart openclaw to apply.`);
}

export interface ProviderAddOpenAIOptions {
  oauth?: boolean;
  apiKey?: string;
  apiKeyStdin?: boolean;
  /** Override the provider key under models.providers. Defaults to "openai". */
  providerKey?: string;
  /** Cap the OAuth wait, in seconds. */
  oauthTimeoutSec?: string;
  yes?: boolean;
  json?: boolean;
  openclawDir?: string;
}

export async function cliProviderAddOpenAIHandler(opts: ProviderAddOpenAIOptions): Promise<void> {
  const providerKey = opts.providerKey?.trim() || "openai";
  const wantOAuth = opts.oauth === true;
  if (wantOAuth && (opts.apiKey || opts.apiKeyStdin)) {
    errLine("provider add openai: pick --oauth OR --api-key, not both");
    process.exitCode = 1;
    return;
  }
  if (opts.apiKey && opts.apiKeyStdin) {
    errLine("provider add openai: pick --api-key OR --api-key-stdin, not both");
    process.exitCode = 1;
    return;
  }

  if (wantOAuth) {
    await runOAuthFlow(providerKey, opts);
    return;
  }

  // API-key path. Read from --api-key, --api-key-stdin, env var, or
  // interactive prompt (in that order).
  let apiKey = opts.apiKey?.trim();
  if (!apiKey && opts.apiKeyStdin) {
    apiKey = (await readStdinLine()).trim();
  }
  if (!apiKey) {
    const env = process.env[API_KEY_ENV];
    if (env && env.length > 0) apiKey = env.trim();
  }
  if (!apiKey && !opts.yes && process.stdin.isTTY === true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { apiKey = (await rl.question("OpenAI API key (sk-…): ")).trim(); }
    finally { rl.close(); }
  }
  if (!apiKey) {
    errLine(`provider add openai: missing API key. Provide --api-key, --api-key-stdin, or $${API_KEY_ENV} (or pick --oauth).`);
    process.exitCode = 1;
    return;
  }
  if (/\s/.test(apiKey)) {
    errLine("provider add openai: API key contains whitespace");
    process.exitCode = 1;
    return;
  }
  persistProvider(providerKey, apiKey, undefined, opts);
}

async function runOAuthFlow(providerKey: string, opts: ProviderAddOpenAIOptions): Promise<void> {
  const endpoints = resolveOpenAIOAuthEndpoints();
  let timeoutMs: number | undefined;
  if (opts.oauthTimeoutSec !== undefined) {
    const n = Number(opts.oauthTimeoutSec);
    if (!Number.isFinite(n) || n <= 0) {
      errLine(`provider add openai: --oauth-timeout-sec "${opts.oauthTimeoutSec}" is not a positive number`);
      process.exitCode = 1;
      return;
    }
    timeoutMs = Math.floor(n * 1000);
  }

  // startOpenAIOAuthFlow returns synchronously; bind errors (notably
  // EADDRINUSE) surface asynchronously via waitForToken's rejection,
  // not via a synchronous throw — so the catch belongs around the await.
  const flow = startOpenAIOAuthFlow({ endpoints, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

  outLine("Open this URL in your browser to sign in with OpenAI:");
  outLine(`  ${flow.authUrl}`);
  outLine(`Listening on http://127.0.0.1:${flow.port}/callback (will close automatically).`);
  tryOpenBrowser(flow.authUrl);

  try {
    const token = await flow.waitForToken;
    persistProvider(providerKey, token.accessToken, {
      issuer: endpoints.issuer,
      clientId: endpoints.clientId,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
    }, opts);
    outLine(`Token captured; expires ${token.expiresAt}.`);
  } catch (err) {
    flow.cancel();
    const msg = err instanceof Error ? err.message : String(err);
    errLine(`provider add openai: OAuth flow failed: ${msg}`);
    if (/EADDRINUSE/.test(msg)) {
      errLine(`  → port ${endpoints.redirectPort} is already in use. Wait or set OPENCLAW_OPENAI_OAUTH_PORT.`);
    }
    process.exitCode = 1;
  }
}

function persistProvider(
  providerKey: string,
  apiKey: string,
  oauth: { issuer: string; clientId: string; refreshToken: string; expiresAt: string; scope?: string } | undefined,
  opts: ProviderAddOpenAIOptions,
): void {
  const dir = resolveOpenclawDir({ openclawDir: opts.openclawDir });
  let file;
  try { file = readOpenclawConfig(dir); }
  catch (err) { errLine(`provider add openai: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; return; }
  const content: JsonObject = file.content;
  let changes: string[];
  try {
    changes = applyProviderEntryPatch(content, {
      providerKey,
      baseUrl: OPENAI_PROVIDER_BASE_URL,
      apiKey,
      tokenKind: oauth ? "oauth-access" : "api-key",
      oauth,
    });
  } catch (err) {
    errLine(`provider add openai: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (changes.length > 0) writeOpenclawConfig(file.path, content);
  if (opts.json) {
    outLine(JSON.stringify({ ok: true, providerKey, changes, oauth: Boolean(oauth) }));
    return;
  }
  outLine(`Wrote ${file.path}`);
  for (const k of changes) outLine(`  + ${k}`);
  outLine("Restart openclaw to apply.");
}

async function readStdinLine(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("--api-key-stdin requires the key to be piped in, e.g. `echo $KEY | openclaw audit gate provider add openai --api-key-stdin`");
  }
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) { cleanup(); resolve(buf.slice(0, nl).replace(/\r$/, "")); }
    };
    const onEnd = (): void => { cleanup(); resolve(buf.replace(/\r$/, "")); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

/**
 * Best-effort browser launch. Failure is silent — the URL is already on
 * stdout so the operator can copy-paste. We avoid the `open` npm package
 * to keep the dependency surface small.
 */
function tryOpenBrowser(url: string): void {
  // Hard-validate the scheme so a maliciously-crafted URL can't shell
  // out via `xdg-open file://...`. We only ever pass our own
  // OpenAI authorize URL here, but defense-in-depth.
  if (!/^https:\/\//i.test(url)) return;
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", () => { /* swallow — operator can still copy-paste */ });
  } catch { /* swallow */ }
}
