import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";

import {
  GateInstallError,
  installGate,
  normalizeAndValidateUrl,
  readGateStatus,
  validateApiKeyOrThrow,
} from "./services/gate-installer.js";
import { probeGate } from "./services/gate-client.js";
import { isJsonObject, readOpenclawConfig } from "./util/openclaw-config-writer.js";
import { resolveOpenclawDir } from "./util/openclaw-paths.js";

/** Env-var fallback for the API key — preferred over `--api-key` in CI
 * since flag values land in `ps`/argv and shell history. */
const API_KEY_ENV = "OPENCLAW_GATE_API_KEY";

/** Write a line to stdout directly. Mirrors `outLine` in cli.ts; see the
 * note there about why we bypass console.log in the CLI dispatch path. */
function outLine(s: string): void {
  process.stdout.write(`${s}\n`);
}
function errLine(s: string): void {
  process.stderr.write(`${s}\n`);
}

export interface AuditGateInstallOptions {
  url?: string;
  apiKey?: string;
  /** Read the API key from stdin (one line, newline-terminated). Use
   * this in CI to keep the key out of argv/process table. */
  apiKeyStdin?: boolean;
  /** Commander negates `--no-broker` to `broker: false`. The default is
   * "yes, register broker" unless the operator opts out. */
  broker?: boolean;
  allowPrivateHost?: boolean;
  skipProbe?: boolean;
  /** Non-interactive: fail (rather than prompt) if any required value is
   * missing. Useful for scripts and CI. */
  yes?: boolean;
  json?: boolean;
  openclawDir?: string;
}

export async function cliGateInstallHandler(opts: AuditGateInstallOptions): Promise<void> {
  const interactive = !opts.yes && process.stdin.isTTY === true;
  let url = opts.url?.trim();
  let apiKey = await resolveApiKeyFromOptsOrEnv(opts);
  // Default broker on; --no-broker sets broker=false explicitly.
  const registerBroker = opts.broker !== false;

  if ((!url || !apiKey) && !interactive) {
    errLine(
      `audit gate install: missing inputs in non-interactive mode. ` +
      `Provide --url and one of --api-key / --api-key-stdin / $${API_KEY_ENV}.`,
    );
    process.exitCode = 1;
    return;
  }

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!url) url = (await rl.question("Gate URL (https://…): ")).trim();
      if (!apiKey) apiKey = await promptSecret(rl, "Gate API key: ");
    } catch (err) {
      // Ctrl-C / stdin EOF inside the prompt — exit clean with the
      // shell-conventional 130 code, no stack trace, no unhandled
      // rejection.
      rl.close();
      const reason = err instanceof Error ? err.message : "aborted";
      if (opts.json) outLine(JSON.stringify({ ok: false, code: "aborted", error: reason }));
      else errLine(`audit gate install: ${reason}`);
      process.exitCode = 130;
      return;
    } finally {
      rl.close();
    }
  }

  if (!url || !apiKey) {
    errLine("audit gate install: missing URL or API key");
    process.exitCode = 1;
    return;
  }

  try {
    const report = await installGate({
      url,
      apiKey,
      registerBroker,
      allowPrivateHost: opts.allowPrivateHost === true,
      skipProbe: opts.skipProbe === true,
      openclawDir: opts.openclawDir,
    });

    if (opts.json) {
      outLine(JSON.stringify({
        ok: true,
        configPath: report.configPath,
        changes: report.changes,
        probe: report.probe?.kind ?? "skipped",
      }));
      return;
    }

    outLine(`Wrote ${report.configPath}`);
    if (report.changes.length === 0) {
      outLine("  (config already up to date — no changes)");
    } else {
      for (const key of report.changes) outLine(`  + ${key}`);
    }
    if (report.probe?.kind === "ok") {
      outLine("Probe: ok");
    } else if (opts.skipProbe) {
      outLine("Probe: skipped");
    }
    outLine("Restart openclaw for changes to take effect.");
  } catch (err) {
    handleError(err, opts.json === true);
  }
}

export interface AuditGateStatusOptions {
  json?: boolean;
  openclawDir?: string;
}

export function cliGateStatusHandler(opts: AuditGateStatusOptions): void {
  const status = readGateStatus(opts.openclawDir);

  if (opts.json) {
    outLine(JSON.stringify(status));
    return;
  }

  outLine(`Config: ${status.configPath}`);
  if (!status.configured) {
    outLine("Gate: not configured");
    outLine("Run `openclaw audit gate install` to set it up.");
    return;
  }
  outLine(`Gate URL: ${status.url}`);
  outLine(`API key: ${status.hasApiKey ? "set" : "missing"}`);
  outLine(`In plugins.allow: ${status.allowlisted ? "yes" : "no"}`);
  outLine(`Conversation access: ${status.conversationAccess ? "granted" : "missing"}`);
  if (status.enabled === false) outLine("Plugin enabled: NO (set explicitly to false)");
  outLine(`Broker provider: ${status.brokerProviderKey ?? "(none)"}`);
}

export interface AuditGateTestOptions {
  json?: boolean;
  openclawDir?: string;
  /** Override the configured URL/key for one-off probes. Pairing rule:
   * if `--url` is overridden, `--api-key` (or stdin/env) must be
   * provided too — otherwise the saved key would get sent to the
   * override URL, which is a credential-exfiltration vector. */
  url?: string;
  apiKey?: string;
  apiKeyStdin?: boolean;
  allowPrivateHost?: boolean;
  timeoutMs?: string;
}

export async function cliGateTestHandler(opts: AuditGateTestOptions): Promise<void> {
  const urlOverride = opts.url;
  let url = urlOverride;
  let apiKey = await resolveApiKeyFromOptsOrEnv(opts);

  if (urlOverride && !apiKey) {
    errLine(
      `audit gate test: --url override requires an explicit --api-key / --api-key-stdin / $${API_KEY_ENV}. ` +
      `Refusing to send the saved API key to a non-configured URL.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!url || !apiKey) {
    let status;
    try {
      status = readGateStatus(opts.openclawDir);
    } catch (err) {
      handleError(err, opts.json === true);
      return;
    }
    if (!status.configured) {
      errLine("audit gate test: nothing to test — Gate is not configured. Run `audit gate install` first.");
      process.exitCode = 1;
      return;
    }
    url = url ?? status.url;
    if (!apiKey) {
      try {
        apiKey = readApiKeyFromConfig(opts.openclawDir);
      } catch (err) {
        handleError(err, opts.json === true);
        return;
      }
    }
  }

  if (!url || !apiKey) {
    errLine("audit gate test: could not resolve URL or API key");
    process.exitCode = 1;
    return;
  }

  try {
    url = normalizeAndValidateUrl(url, opts.allowPrivateHost === true);
    apiKey = validateApiKeyOrThrow(apiKey);
  } catch (err) {
    handleError(err, opts.json === true);
    return;
  }

  const timeoutMs = parseTimeout(opts.timeoutMs);
  const result = await probeGate(url, apiKey, { timeoutMs });

  if (opts.json) {
    outLine(JSON.stringify({ url, result }));
    return;
  }

  outLine(`Gate URL: ${url}`);
  switch (result.kind) {
    case "ok":
      outLine(`Probe: ok (HTTP ${result.status})`);
      break;
    case "unauthorized":
      outLine(`Probe: unauthorized (HTTP ${result.status})`);
      if (result.body) outLine(`  body: ${result.body}`);
      process.exitCode = 1;
      break;
    case "http-error":
      outLine(`Probe: http-error (HTTP ${result.status})`);
      if (result.body) outLine(`  body: ${result.body}`);
      process.exitCode = 1;
      break;
    case "network-error":
      outLine(`Probe: network-error — ${result.message}`);
      process.exitCode = 1;
      break;
  }
}

interface ApiKeyOpts {
  apiKey?: string;
  apiKeyStdin?: boolean;
}

async function resolveApiKeyFromOptsOrEnv(opts: ApiKeyOpts): Promise<string | undefined> {
  if (opts.apiKey) return opts.apiKey.trim();
  if (opts.apiKeyStdin) {
    const raw = await readLineFromStdin();
    return raw.trim() || undefined;
  }
  const env = process.env[API_KEY_ENV];
  if (env && env.length > 0) return env.trim();
  return undefined;
}

/** Read one newline-terminated line from stdin. Errors if stdin is a TTY
 * (so the operator can't accidentally hang the install). */
async function readLineFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new GateInstallError(
      "missing-api-key-stdin",
      "--api-key-stdin requires the key to be piped in, e.g. `echo $KEY | openclaw audit gate install --api-key-stdin`",
    );
  }
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx >= 0) {
        cleanup();
        resolve(buf.slice(0, newlineIdx).replace(/\r$/, ""));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buf.replace(/\r$/, ""));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
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
 * Re-read the on-disk gateway API key for `audit gate test`. The status
 * helper exposes only `hasApiKey` (boolean) to avoid leaking the key
 * into status output, so the test handler reads it explicitly through
 * this path. Errors propagate so a malformed config produces a clear
 * diagnostic instead of "could not resolve URL or API key".
 */
function readApiKeyFromConfig(openclawDirOverride?: string): string | undefined {
  const dir = resolveOpenclawDir({ openclawDir: openclawDirOverride });
  const file = readOpenclawConfig(dir);
  const plugins = file.content.plugins;
  if (!isJsonObject(plugins)) return undefined;
  const entries = plugins.entries;
  if (!isJsonObject(entries)) return undefined;
  const entry = entries["constellation-audit-plugin"];
  if (!isJsonObject(entry)) return undefined;
  const cfg = entry.config;
  if (!isJsonObject(cfg)) return undefined;
  const key = cfg.gatewayApiKey;
  return typeof key === "string" ? key : undefined;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    errLine(`audit gate test: --timeout-ms "${raw}" is not a positive number; using default`);
    return undefined;
  }
  return Math.floor(n);
}

/**
 * Read a secret from a TTY without echoing it. The fallback path (when
 * stdin is not a real TTY or `setRawMode` fails) just reads a line — no
 * masking, but still better than crashing. We don't try to be cleverer
 * than that here; mature secret entry belongs in the SDK, not this
 * plugin.
 *
 * Multi-byte safety: a single `data` event may split a UTF-8 codepoint
 * across continuation bytes (rare on a TTY, possible on paste), so we
 * accumulate raw bytes through a `StringDecoder` and only emit complete
 * characters. After the terminator, any remaining bytes in the chunk
 * are discarded so a multi-line paste does not flush the tail to the
 * shell after the process exits.
 */
async function promptSecret(rl: ReadlineInterface, prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return (await rl.question(prompt)).trim();
  }

  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  const decoder = new StringDecoder("utf8");

  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      const s = decoder.write(chunk);
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        const code = ch.charCodeAt(0);
        if (code === 0x03) {
          finish();
          process.stdout.write("\n");
          reject(new Error("aborted (Ctrl-C)"));
          return;
        }
        if (code === 0x0d || code === 0x0a) {
          // Drain anything after the line terminator in this same chunk
          // and discard it so a multi-line paste doesn't dump its tail
          // into the post-exit shell.
          finish();
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (code === 0x7f || code === 0x08) {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const onEnd = (): void => {
      finish();
      reject(new Error("aborted (stdin closed)"));
    };
    const onError = (err: Error): void => {
      finish();
      reject(err);
    };
    const finish = (): void => {
      try { stdin.setRawMode(false); } catch { /* swallow */ }
      stdin.pause();
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("close", onEnd);
      stdin.off("error", onError);
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.once("error", onError);
  });
}

function handleError(err: unknown, asJson: boolean): void {
  process.exitCode = 1;
  if (err instanceof GateInstallError) {
    if (asJson) outLine(JSON.stringify({ ok: false, code: err.code, error: err.message }));
    else errLine(`audit gate: ${err.message}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (asJson) outLine(JSON.stringify({ ok: false, code: "internal", error: message }));
  else errLine(`audit gate: ${message}`);
}
