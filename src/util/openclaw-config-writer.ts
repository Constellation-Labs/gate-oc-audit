import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "openclaw/plugin-sdk/config-runtime";
import {
  applyAuthProfileConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { PLUGIN_ID } from "../plugin-id.js";

/**
 * Config-file IO for the audit plugin's Gate install / status flows.
 *
 * Historically this module hand-rolled the read / merge / atomic-write
 * against a hardcoded `~/.openclaw/config.json` path. That filename was
 * wrong — the SDK's canonical default is `openclaw.json`, with
 * `$OPENCLAW_CONFIG_PATH` as an override and JSON5 support — so the
 * wizard was creating an orphan `config.json` sibling that the runtime
 * never read. The IO layer now defers to the SDK's `mutateConfigFile` /
 * `writeConfigFile`, which gets us the right filename, env-var override,
 * Nix-mode write guard, optimistic-concurrency hash check, and atomic
 * crash-safe write for free. Only the patch shape is still ours.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** Single shared "is plain JSON object" predicate. Reused by readers in
 * gate-installer / cli-gate so we don't carry three near-identical copies. */
export function isJsonObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Returns true if the thrown error is the SDK's optimistic-concurrency
 * conflict. Detected by `name` because the class isn't re-exported
 * through a stable subpath. Callers may want a friendlier "retry —
 * another writer modified the config" message than the bare SDK text. */
export function isConfigMutationConflict(err: unknown): boolean {
  return err instanceof Error && err.name === "ConfigMutationConflictError";
}

export interface OpenclawConfigSnapshot {
  path: string;
  content: JsonObject;
}

/** Read the openclaw config file via the SDK. Returns the active config
 * path (`OPENCLAW_CONFIG_PATH` override, or the canonical default) and
 * the source contents as a plain JSON object. */
export async function readOpenclawConfigSnapshot(): Promise<OpenclawConfigSnapshot> {
  const { snapshot } = await readConfigFileSnapshotForWrite();
  return {
   path: snapshot.path,
   content: (snapshot.sourceConfig ?? {}) as unknown as JsonObject,
  };
}

/** Sync, read-only snapshot of the live config — for code paths where
 * the wider runtime is already loaded and we need to peek at the
 * current values. No path is returned (the SDK's sync loader doesn't
 * expose one); callers that need to display the path use the async
 * snapshot reader above. */
export function loadOpenclawConfig(): JsonObject {
  return (loadConfig() ?? {}) as unknown as JsonObject;
}

export interface MutateResult {
  path: string;
  changes: string[];
}

/** Read-modify-write the openclaw config via the SDK. The `mutate`
 * callback receives a draft to mutate in place and returns the list of
 * dotted-path keys it changed; an empty list short-circuits the write,
 * which preserves the wizard's "re-run is cheap" property.
 *
 * Built on `readConfigFileSnapshotForWrite` + `replaceConfigFile` rather
 * than the higher-level `mutateConfigFile` — the latter always writes
 * (it bumps `meta.lastTouchedAt`), which would defeat the idempotent
 * "no changes → no write" path.
 *
 * One automatic retry on `ConfigMutationConflictError` (another
 * writer raced the SDK's snapshot hash check): we re-read and re-apply
 * the mutate fn. Safe because the plugin's patches are idempotent —
 * they return an empty change list when the post-state already matches
 * the pre-state. After two attempts we re-throw. */
export async function mutateOpenclawConfig(
  mutate: (draft: JsonObject) => string[],
): Promise<MutateResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
   const { snapshot } = await readConfigFileSnapshotForWrite();
   const draft = structuredClone(snapshot.sourceConfig ?? {}) as unknown as JsonObject;
   const changes = mutate(draft);
   if (changes.length === 0) {
    return { path: snapshot.path, changes };
   }
   try {
    const result = await replaceConfigFile({
     nextConfig: draft as never,
     snapshot,
     // The SDK validates plugin-config blocks against schemas discovered
     // from installed plugin manifests. In CLI / setup contexts (where
     // the audit plugin's own manifest hasn't been registered with the
     // openclaw runtime that's running this code), the validator falls
     // back to the strict `additionalProperties: false` policy and
     // rejects our `gatewayUrl` / `gatewayApiKey` keys. We own this
     // plugin's config block, so skipping plugin-aware validation here
     // is safe — the base schema check still runs.
     writeOptions: {
      skipPluginValidation: true,
      // The SDK otherwise logs human-readable overwrite/anomaly notices
      // to stdout, which corrupts the wizard's `--json` output.
      skipOutputLogs: true,
     },
    });
    return { path: result.path, changes };
   } catch (err) {
    if (attempt === 0 && isConfigMutationConflict(err)) continue;
    throw err;
   }
  }
  // Unreachable — the loop either returns or throws on the second attempt.
  throw new Error("mutateOpenclawConfig: exhausted retries");
}

function ensureObject(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isJsonObject(existing)) {
   return existing;
  }
  const fresh: JsonObject = {};
  parent[key] = fresh;
  return fresh;
}

export interface GateInstallPatch {
  /** Audit-ingest gateway URL (this plugin's gatewayUrl config). */
  gatewayUrl: string;
  /** Audit-ingest API key (this plugin's gatewayApiKey config). */
  gatewayApiKey: string;
  /**
  * When true, also trust this plugin in `plugins.allow` (silences the
  * "non-bundled plugins may auto-load" warning).
  */
  addToAllowlist: boolean;
  /**
  * When true, set `plugins.entries.<id>.hooks.allowConversationAccess`.
  * Required for the plugin to receive llm_input/llm_output/agent_end
  * hooks under openclaw >= 2026.4.24.
  */
  grantConversationAccess: boolean;
  /**
  * When true, persist `gatewayAllowPrivateHost: true` so the runtime
  * gateway publisher accepts the same private/link-local URL that
  * passed install-time validation. Should be set whenever the URL was
  * validated with `allowPrivateHost: true` and points at a
  * private/link-local host (loopback URLs don't need the flag).
  */
  allowPrivateHost: boolean;
  /**
  * If false, the patch leaves `enabled` untouched — an operator who
  * deliberately disabled the plugin and runs `audit gate install` to
  * rotate keys won't silently re-enable it. Default `true` for first
  * installs (no prior `enabled` value).
  */
  enable: boolean;
}

/**
 * Apply a Gate install patch to an in-memory config object. Pure
 * mutation — callers persist via `mutateOpenclawConfig`. Idempotent:
 * re-applying the same patch returns an empty change list.
 *
 * Returns a list of the dotted-path keys that changed, so the CLI can
 * show "wrote: a.b, c.d" instead of "wrote config".
 */
export function applyGateInstallPatch(content: JsonObject, patch: GateInstallPatch): string[] {
  const changes: string[] = [];

  const plugins = ensureObject(content, "plugins");

  if (patch.addToAllowlist) {
   const allow = Array.isArray(plugins.allow) ? plugins.allow.slice() : [];
   if (!allow.includes(PLUGIN_ID)) {
    allow.push(PLUGIN_ID);
    plugins.allow = allow as JsonValue[];
    changes.push("plugins.allow");
   }
  }

  const entries = ensureObject(plugins, "entries");
  const entry = ensureObject(entries, PLUGIN_ID);

  // Only flip enabled when the operator opted into enabling (default for
  // first install) AND the field isn't already a deliberate `false`. A
  // separate `audit gate install --enable` rotation should not silently
  // re-enable a plugin the operator explicitly disabled.
  if (patch.enable && entry.enabled !== true && entry.enabled !== false) {
   entry.enabled = true;
   changes.push(`plugins.entries.${PLUGIN_ID}.enabled`);
  }

  if (patch.grantConversationAccess) {
   const hooks = ensureObject(entry, "hooks");
   if (hooks.allowConversationAccess !== true) {
    hooks.allowConversationAccess = true;
    changes.push(`plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`);
   }
  }

  const cfg = ensureObject(entry, "config");
  if (cfg.gatewayUrl !== patch.gatewayUrl) {
   cfg.gatewayUrl = patch.gatewayUrl;
   changes.push(`plugins.entries.${PLUGIN_ID}.config.gatewayUrl`);
  }
  if (cfg.gatewayApiKey !== patch.gatewayApiKey) {
   cfg.gatewayApiKey = patch.gatewayApiKey;
   changes.push(`plugins.entries.${PLUGIN_ID}.config.gatewayApiKey`);
  }
  if (patch.allowPrivateHost && cfg.gatewayAllowPrivateHost !== true) {
   cfg.gatewayAllowPrivateHost = true;
   changes.push(`plugins.entries.${PLUGIN_ID}.config.gatewayAllowPrivateHost`);
  }

  return changes;
}

export interface BrokerProviderPatch {
  /**
  * Provider key under `models.providers.*`. Defaults to "gate". Mutating
  * an existing key with a different baseUrl is allowed (this is "switch
  * to a different Gate" not "add a second one").
  */
  providerKey?: string;
  /** Full broker base URL, e.g. https://gate.example.com/v1 */
  baseUrl: string;
  /** API key for the broker. Stored inline; future work: SecretRef. */
  apiKey: string;
}

/**
 * Register Gate as an LLM provider under `models.providers.<key>`. The
 * `models[]` array is initialized to `[]` — operators populate it by
 * hand today; a future patch may add a live model-list probe against
 * Gate to fill it in automatically.
 */
export function applyBrokerProviderPatch(content: JsonObject, patch: BrokerProviderPatch): string[] {
  const key = patch.providerKey ?? "gate";
  const changes: string[] = [];
  const models = ensureObject(content, "models");
  const providers = ensureObject(models, "providers");
  const provider = ensureObject(providers, key);

  if (provider.baseUrl !== patch.baseUrl) {
   provider.baseUrl = patch.baseUrl;
   changes.push(`models.providers.${key}.baseUrl`);
  }
  if (provider.auth !== "api-key") {
   provider.auth = "api-key";
   changes.push(`models.providers.${key}.auth`);
  }
  if (provider.apiKey !== patch.apiKey) {
   provider.apiKey = patch.apiKey;
   changes.push(`models.providers.${key}.apiKey`);
  }
  if (!Array.isArray(provider.models)) {
   provider.models = [];
   changes.push(`models.providers.${key}.models`);
  }
  return changes;
}

export interface AuthProfilePatch {
  /** Profile id returned by the SDK auth-profile store's upsert. */
  profileId: string;
  /** Provider key under `models.providers.*` (e.g. "openai"). */
  provider: string;
  /** Credential type stamped on the provider entry. */
  mode: "api_key" | "oauth" | "token";
  /** Optional email stamped on the provider entry for OAuth flows. */
  email?: string;
}

/**
 * Apply an auth-profile reference to the openclaw config via the SDK's
 * `applyAuthProfileConfig` helper, then mutate the in-memory draft in
 * place. Pure shape — callers persist via `mutateOpenclawConfig`.
 *
 * Wipes every top-level key off `draft` and reassigns from `next` so
 * the SDK's nested rewrites land verbatim. The SDK owns the schema for
 * the keys it touches (`models.providers.*`, `models.activeProfileIds`,
 * etc.); we trust its output as the authoritative shape.
 *
 * Always returns a non-empty change list so the wizard / UI can print
 * an "applied" line; the SDK's writer is single-pass and we don't
 * track granular dotted paths here.
 */
export function applyAuthProfilePatch(content: JsonObject, patch: AuthProfilePatch): string[] {
  const cfg = content as unknown as OpenClawConfig;
  const next = applyAuthProfileConfig(cfg, patch);
  for (const key of Object.keys(content)) delete content[key];
  Object.assign(content, next as unknown as Record<string, unknown>);
  return [`models.providers.${patch.provider}`];
}
