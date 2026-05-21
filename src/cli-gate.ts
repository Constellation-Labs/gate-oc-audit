import { createInterface } from "node:readline/promises";

import {
  GateInstallError,
  installGate,
  normalizeAndValidateUrl,
  readGateStatus,
  readSavedGatewayApiKey,
  validateApiKeyOrThrow,
} from "./services/gate-installer.js";
import { probeGate } from "./services/gate-client.js";
import { STAGING_GATE_URL, STAGING_GATE_KEYS_URL } from "./services/gate-endpoints.js";
import { cliProviderAddOpenAIHandler } from "./cli-provider.js";
import { isConfigMutationConflict } from "./util/openclaw-config-writer.js";
import { outLine, errLine } from "./util/cli-output.js";
import { readStdinLine, StdinTtyError } from "./util/stdin.js";
import { promptSecret } from "./util/prompt-secret.js";

/** Env-var fallback for the API key — preferred over `--api-key` in CI
 * since flag values land in `ps`/argv and shell history. */
const GATE_API_KEY_ENV = "OPENCLAW_GATE_API_KEY";

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
  let apiKey: string | undefined;
  try {
    apiKey = await resolveApiKeyFromOptsOrEnv(opts);
  } catch (err) {
    handleError(err, opts.json === true);
    return;
  }
  // Default broker on; --no-broker sets broker=false explicitly.
  const registerBroker = opts.broker !== false;

  // While the broker is in staging the wizard pins the URL. CI / scripted
  // callers can still override via --url; only the URL prompt is gone.
  if (!url) url = STAGING_GATE_URL;

  if (!apiKey && !interactive) {
    errLine(
      `audit gate install: missing inputs in non-interactive mode. ` +
      `Provide one of --api-key / --api-key-stdin / $${GATE_API_KEY_ENV}.`,
    );
    process.exitCode = 1;
    return;
  }

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!apiKey) {
        outLine(`Gate URL: ${url}`);
        outLine(`Create an API key at ${STAGING_GATE_KEYS_URL} and paste it below.`);
        apiKey = await promptSecret(rl, "Gate API key: ");
      }
    } catch (err) {
      // Ctrl-C / stdin EOF inside the prompt — exit clean with the
      // shell-conventional 130 code, no stack trace, no unhandled
      // rejection. `finally` below closes `rl`.
      const reason = err instanceof Error ? err.message : "aborted";
      if (opts.json) outLine(JSON.stringify({ ok: false, code: "aborted", error: reason }));
      else errLine(`audit gate install: ${reason}`);
      process.exitCode = 130;
      return;
    } finally {
      rl.close();
    }
  }

  if (!apiKey) {
    errLine("audit gate install: missing API key");
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

    if (interactive) {
      await maybeRunOpenAIOAuthFollowup(opts.openclawDir);
    }
  } catch (err) {
    handleError(err, opts.json === true);
  }
}

/** Post-install nudge: offer to configure OpenAI OAuth so the operator
 * doesn't have to remember `audit gate provider add openai --oauth` as a
 * separate step. Skipped in --yes / --json / non-TTY paths to keep the
 * scripted contract unchanged. */
async function maybeRunOpenAIOAuthFollowup(openclawDir: string | undefined): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await rl.question("Configure OpenAI (ChatGPT) OAuth now? [y/N]: ")).trim().toLowerCase();
  } catch {
    // Ctrl-C / EOF at the follow-up prompt — treat as "skip", install
    // already succeeded.
    rl.close();
    return;
  } finally {
    rl.close();
  }
  if (answer !== "y" && answer !== "yes") {
    outLine("Skipped. Run `openclaw audit gate provider add openai --oauth` later if you change your mind.");
    return;
  }
  await cliProviderAddOpenAIHandler({ oauth: true, openclawDir });
}

export interface AuditGateStatusOptions {
  json?: boolean;
  openclawDir?: string;
}

export async function cliGateStatusHandler(opts: AuditGateStatusOptions): Promise<void> {
  const status = await readGateStatus();

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
  let apiKey: string | undefined;
  try {
    apiKey = await resolveApiKeyFromOptsOrEnv(opts);
  } catch (err) {
    handleError(err, opts.json === true);
    return;
  }

  if (urlOverride && !apiKey) {
    errLine(
      `audit gate test: --url override requires an explicit --api-key / --api-key-stdin / $${GATE_API_KEY_ENV}. ` +
      `Refusing to send the saved API key to a non-configured URL.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!url || !apiKey) {
    let status;
    try {
      status = await readGateStatus();
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
        apiKey = await readSavedGatewayApiKey();
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

  // Set exitCode up front so both --json and human-readable branches
  // share the same exit-on-failure policy. CI scripts that consume
  // --json should be able to branch on `$?` alone.
  if (result.kind !== "ok") process.exitCode = 1;

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
      break;
    case "http-error":
      outLine(`Probe: http-error (HTTP ${result.status})`);
      if (result.body) outLine(`  body: ${result.body}`);
      break;
    case "network-error":
      outLine(`Probe: network-error — ${result.message}`);
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
    // Wrap the TTY-throw in a typed error so the handler can surface a
    // friendly message instead of letting the stack escape.
    try {
      const raw = await readStdinLine("openclaw audit gate install");
      return raw.trim() || undefined;
    } catch (err) {
      if (err instanceof StdinTtyError) {
        throw new GateInstallError("missing-api-key-stdin", err.message);
      }
      throw err;
    }
  }
  const env = process.env[GATE_API_KEY_ENV];
  if (env && env.length > 0) return env.trim();
  return undefined;
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

function handleError(err: unknown, asJson: boolean): void {
  process.exitCode = 1;
  if (err instanceof GateInstallError) {
    if (asJson) outLine(JSON.stringify({ ok: false, code: err.code, error: err.message }));
    else errLine(`audit gate: ${err.message}`);
    return;
  }
  // `ConfigMutationConflictError` from the SDK wins both attempts of
  // `mutateOpenclawConfig`'s retry only when a third writer raced
  // both passes — surface as a retryable, not a stack.
  if (isConfigMutationConflict(err)) {
    const msg = "another writer modified ~/.openclaw/openclaw.json — retry";
    if (asJson) outLine(JSON.stringify({ ok: false, code: "config-conflict", error: msg }));
    else errLine(`audit gate: ${msg}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (asJson) outLine(JSON.stringify({ ok: false, code: "internal", error: message }));
  else errLine(`audit gate: ${message}`);
}
