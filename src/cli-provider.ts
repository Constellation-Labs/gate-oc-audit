import { createInterface } from "node:readline/promises";

import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  removeProviderAuthProfilesWithLock,
  upsertApiKeyProfile,
  writeOAuthCredentials,
} from "openclaw/plugin-sdk/provider-auth";
import { loginOpenAICodexOAuth } from "openclaw/plugin-sdk/provider-auth-login";

import {
  applyAuthProfilePatch,
  isConfigMutationConflict,
  mutateOpenclawConfig,
} from "./util/openclaw-config-writer.js";
import { resolveOpenclawDir } from "./util/openclaw-paths.js";
import { createReadlineWizardPrompter } from "./services/wizard-prompter.js";
import { outLine, errLine } from "./util/cli-output.js";
import { readStdinLine, StdinTtyError } from "./util/stdin.js";
import { promptSecret } from "./util/prompt-secret.js";

const OPENAI_API_KEY_ENV = "OPENCLAW_OPENAI_API_KEY";
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export interface ProviderListOptions {
  json?: boolean;
  openclawDir?: string;
}

export function cliProviderListHandler(opts: ProviderListOptions): void {
  const agentDir = opts.openclawDir ?? resolveOpenclawDir({ openclawDir: opts.openclawDir });
  let store;
  try { store = ensureAuthProfileStore(agentDir); }
  catch (err) {
    errLine(`provider list: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // Walk every provider in the store; openclaw owns the canonical list
  // of providers, but the audit plugin only knows about OpenAI today.
  // Track the provider each id was found under — the SDK doesn't always
  // stamp `cred.provider` on the credential itself (OAuth profiles are
  // indexed by provider, not labelled), so falling back to the lookup
  // key keeps the output usable instead of printing `undefined`.
  const providerById = new Map<string, string>();
  for (const provider of [OPENAI_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID]) {
    for (const id of listProfilesForProvider(store, provider)) {
      if (!providerById.has(id)) providerById.set(id, provider);
    }
  }

  const rows: Array<{
    profileId: string;
    provider: string;
    type: string;
    email?: string;
    displayName?: string;
    expiresAt?: string;
  }> = [];
  for (const [id, provider] of providerById) {
    const cred = store.profiles?.[id];
    if (!cred) continue;
    const row: typeof rows[number] = {
      profileId: id,
      provider: typeof cred.provider === "string" && cred.provider.length > 0 ? cred.provider : provider,
      type: cred.type,
    };
    if (cred.email) row.email = cred.email;
    if (cred.displayName) row.displayName = cred.displayName;
    if ((cred.type === "oauth" || cred.type === "token") && typeof cred.expires === "number") {
      row.expiresAt = new Date(cred.expires).toISOString();
    }
    rows.push(row);
  }

  if (opts.json) { outLine(JSON.stringify({ profiles: rows })); return; }
  if (rows.length === 0) { outLine("No OpenAI provider profiles configured."); return; }
  for (const r of rows) {
    const extras = [r.email, r.displayName, r.expiresAt ? `expires ${r.expiresAt}` : undefined]
      .filter(Boolean)
      .join("  ");
    outLine(`${r.profileId}  ${r.type}  ${r.provider}${extras ? "  " + extras : ""}`);
  }
}

export interface ProviderRemoveOptions {
  json?: boolean;
  openclawDir?: string;
}

export async function cliProviderRemoveHandler(provider: string, opts: ProviderRemoveOptions): Promise<void> {
  // Reserved key from the audit-gate broker. The provider config under
  // `models.providers.gate` is owned by `audit gate install`; refuse
  // to touch it through the profile-removal path.
  if (provider === "gate") {
    errLine("provider remove: the 'gate' provider is managed by `audit gate install`");
    process.exitCode = 1;
    return;
  }
  const agentDir = opts.openclawDir ?? resolveOpenclawDir({ openclawDir: opts.openclawDir });
  try {
    await removeProviderAuthProfilesWithLock({ provider, agentDir });
  } catch (err) {
    errLine(`provider remove: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) { outLine(JSON.stringify({ ok: true, provider })); return; }
  outLine(`Removed all '${provider}' profiles from the auth-profile store.`);
  outLine("Restart openclaw to apply.");
}

export interface ProviderAddOpenAIOptions {
  oauth?: boolean;
  apiKey?: string;
  apiKeyStdin?: boolean;
  yes?: boolean;
  json?: boolean;
  openclawDir?: string;
}

export async function cliProviderAddOpenAIHandler(opts: ProviderAddOpenAIOptions): Promise<void> {
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

  const agentDir = opts.openclawDir ?? resolveOpenclawDir({ openclawDir: opts.openclawDir });

  if (wantOAuth) {
    await runOAuthFlow(agentDir, opts);
    return;
  }

  // API-key path. Read from --api-key, --api-key-stdin, env var, or
  // interactive prompt (in that order).
  let apiKey = opts.apiKey?.trim();
  if (!apiKey && opts.apiKeyStdin) {
    try {
      apiKey = (await readStdinLine("openclaw audit gate provider add openai")).trim();
    } catch (err) {
      if (err instanceof StdinTtyError) {
        errLine(`provider add openai: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }
  if (!apiKey) {
    const env = process.env[OPENAI_API_KEY_ENV];
    if (env && env.length > 0) apiKey = env.trim();
  }
  if (!apiKey && !opts.yes && process.stdin.isTTY === true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { apiKey = await promptSecret(rl, "OpenAI API key (sk-…): "); }
    catch (err) {
      rl.close();
      const reason = err instanceof Error ? err.message : "aborted";
      errLine(`provider add openai: ${reason}`);
      process.exitCode = 130;
      return;
    }
    finally { rl.close(); }
  }
  if (!apiKey) {
    errLine(`provider add openai: missing API key. Provide --api-key, --api-key-stdin, or $${OPENAI_API_KEY_ENV} (or pick --oauth).`);
    process.exitCode = 1;
    return;
  }
  if (/\s/.test(apiKey)) {
    errLine("provider add openai: API key contains whitespace");
    process.exitCode = 1;
    return;
  }

  let profileId: string;
  try {
    profileId = upsertApiKeyProfile({
      provider: OPENAI_PROVIDER_ID,
      input: apiKey,
      agentDir,
    });
  } catch (err) {
    errLine(`provider add openai: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  try {
    await mutateOpenclawConfig((draft) =>
      applyAuthProfilePatch(draft, {
        profileId,
        provider: OPENAI_PROVIDER_ID,
        mode: "api_key",
      }),
    );
  } catch (err) {
    // Config write failed after the API key was upserted — roll back
    // the SDK auth-profile store so we don't strand an orphan
    // credential on disk. (The SDK only exposes per-provider removal,
    // which wipes all profiles for "openai"; in practice the upsert
    // just touched the only one.)
    try { await removeProviderAuthProfilesWithLock({ provider: OPENAI_PROVIDER_ID, agentDir }); }
    catch { /* swallow — original error is more informative */ }
    const reason = isConfigMutationConflict(err)
      ? "another writer modified ~/.openclaw/openclaw.json — retry"
      : err instanceof Error ? err.message : String(err);
    errLine(`provider add openai: ${reason}`);
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    outLine(JSON.stringify({ ok: true, profileId, provider: OPENAI_PROVIDER_ID, mode: "api_key" }));
  } else {
    outLine(`Wrote profile '${profileId}' for provider '${OPENAI_PROVIDER_ID}'.`);
    outLine("Restart openclaw to apply.");
  }
}

async function runOAuthFlow(agentDir: string, opts: ProviderAddOpenAIOptions): Promise<void> {
  const prompter = createReadlineWizardPrompter();
  const isRemote = detectRemote();

  let creds;
  try {
    creds = await loginOpenAICodexOAuth({
      prompter,
      runtime: { log: (...a) => process.stderr.write(a.join(" ") + "\n"), error: (...a) => process.stderr.write(a.join(" ") + "\n"), exit: (c) => { process.exitCode = c; } },
      isRemote,
      openUrl: openUrlOrPrint,
      localBrowserMessage: "Sign in to OpenAI in the browser tab that just opened (or copy the URL above).",
    });
  } catch (err) {
    errLine(`provider add openai: OAuth flow failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (!creds) {
    errLine("provider add openai: OAuth flow returned no credentials (cancelled or rejected)");
    process.exitCode = 1;
    return;
  }

  let profileId: string;
  try {
    profileId = await writeOAuthCredentials(OPENAI_CODEX_PROVIDER_ID, creds, agentDir);
  } catch (err) {
    errLine(`provider add openai: failed to persist OAuth credentials: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  try {
    await mutateOpenclawConfig((draft) =>
      applyAuthProfilePatch(draft, {
        profileId,
        provider: OPENAI_PROVIDER_ID,
        mode: "oauth",
        email: typeof creds.email === "string" ? creds.email : undefined,
      }),
    );
  } catch (err) {
    // OAuth credentials are already written to the SDK store; the
    // config write failed afterwards. Roll back the credentials so
    // the operator can re-run cleanly. Removal removes all profiles
    // for the codex-OAuth provider; in practice the just-written
    // profile is the only one for it.
    try { await removeProviderAuthProfilesWithLock({ provider: OPENAI_CODEX_PROVIDER_ID, agentDir }); }
    catch { /* swallow — original error is more informative */ }
    const reason = isConfigMutationConflict(err)
      ? "another writer modified ~/.openclaw/openclaw.json — retry"
      : err instanceof Error ? err.message : String(err);
    errLine(`provider add openai: ${reason}`);
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    outLine(JSON.stringify({ ok: true, profileId, provider: OPENAI_PROVIDER_ID, mode: "oauth" }));
  } else {
    outLine(`Wrote OAuth profile '${profileId}' for provider '${OPENAI_PROVIDER_ID}'.`);
    outLine("Restart openclaw to apply.");
  }
}

function detectRemote(): boolean {
  // No DISPLAY / WAYLAND_DISPLAY → no local browser. SSH_TTY / SSH_CONNECTION
  // → likely remote shell. The SDK uses isRemote to switch to a paste-the-
  // code flow rather than trying to open a browser.
  if (process.platform === "linux") {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  }
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return true;
  return false;
}

/**
 * Attempt to open the URL via the SDK's browser-open helper; print the
 * URL to stderr regardless so the operator can copy-paste if the
 * launch fails or this is a headless box. We deep-import because the
 * SDK ships `openUrl` at this path but doesn't expose it through a
 * top-level subpath in package.json — if a future SDK version moves
 * it, we silently degrade to print-only.
 */
async function openUrlOrPrint(url: string): Promise<void> {
  errLine(`Open this URL in your browser: ${url}`);
  try {
    // SDK ships `openUrl` at this path but doesn't expose it through a
    // top-level subpath. Deep-import via string concat so TypeScript
    // doesn't try to resolve the missing .d.ts at compile time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(
      "openclaw/dist/plugin-sdk/src/plugins/" + "setup-browser.js"
    ).catch(() => null);
    if (mod && typeof mod.openUrl === "function") {
      await mod.openUrl(url);
    }
  } catch { /* swallow — URL is already on stderr */ }
}

