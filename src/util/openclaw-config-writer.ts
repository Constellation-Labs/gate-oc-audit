import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Atomic read-merge-write helper for the operator's `~/.openclaw/config.json`.
 *
 * The audit plugin needs to mutate three regions of this file during Gate
 * install:
 *   - `plugins.allow`              (trust the plugin)
 *   - `plugins.entries.<id>.*`     (plugin config + conversation-access opt-in)
 *   - `models.providers.*`         (Gate broker provider + per-provider entries)
 *
 * The openclaw SDK does not expose a plugin-side mutator for the root
 * config, so we read-merge-write the JSON file directly. Writes are
 * staged through a sibling tempfile + `fsyncSync` + `renameSync` so a
 * crash mid-write never leaves a half-written config behind, and a
 * `.bak` snapshot of the prior content (also mode 0o600) is kept for
 * one-step rollback.
 */

const PLUGIN_ID = "constellation-audit-plugin";
const SECRET_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface OpenclawConfigFile {
  path: string;
  content: JsonObject;
}

/** Single shared "is plain JSON object" predicate. Reused by readers in
 * gate-installer / cli-gate so we don't carry three near-identical copies. */
export function isJsonObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function configFilePath(openclawDir: string): string {
  return join(openclawDir, "config.json");
}

export function readOpenclawConfig(openclawDir: string): OpenclawConfigFile {
  const path = configFilePath(openclawDir);
  if (!existsSync(path)) return { path, content: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`failed to read ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${path} must contain a JSON object at the top level`);
  }
  return { path, content: parsed };
}

/**
 * Write `content` to `path` atomically with a `.bak` snapshot of the prior
 * file (if any). Crash-safety: the new content is written + fsync'd to a
 * sibling tempfile, then `rename`d over the target — POSIX guarantees the
 * rename is atomic on the same filesystem — and finally the parent dir
 * is fsync'd so the rename itself becomes durable. Both the .bak and
 * tempfile are created mode 0o600 so the prior API key cannot be read by
 * other local users on rotation.
 *
 * If `path` is a symlink (e.g. dotfile-managed), the rename writes through
 * to the symlink target rather than replacing the symlink with a regular
 * file.
 */
export function writeOpenclawConfig(path: string, content: JsonObject): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });

  // Resolve symlink targets so dotfile-managed config files (~/.openclaw
  // → ~/.dotfiles/openclaw) are written through, not replaced.
  let targetPath = path;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      targetPath = realpathSync(path);
    }
  } catch {
    // file doesn't exist yet — that's fine, just use `path`
  }

  if (existsSync(targetPath)) {
    try {
      const prior = readFileSync(targetPath);
      writeFileSync(`${targetPath}.bak`, prior, { mode: SECRET_MODE });
    } catch (e) {
      throw new Error(`failed to snapshot ${targetPath} before write: ${(e as Error).message}`);
    }
  }

  // crypto-random suffix + O_EXCL (`wx`) defeats a local attacker who
  // pre-creates the tempfile (potentially as a symlink redirect) on a
  // mis-permissioned ~/.openclaw.
  const suffix = randomBytes(8).toString("hex");
  const tmp = `${targetPath}.tmp-${suffix}`;
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  let fd = -1;
  try {
    fd = openSync(tmp, "wx", SECRET_MODE);
    writeSync(fd, serialized);
    fsyncSync(fd);
  } catch (e) {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* swallow — primary error wins */ }
    }
    throw new Error(`failed to write ${tmp}: ${(e as Error).message}`);
  }
  try { closeSync(fd); } catch { /* swallow — close failure is not actionable here */ }

  try {
    renameSync(tmp, targetPath);
  } catch (e) {
    throw new Error(`failed to rename ${tmp} to ${targetPath}: ${(e as Error).message}`);
  }

  // fsync the directory so the rename itself is durable across power loss.
  // Failure here is non-fatal — best-effort durability.
  try {
    const dirFd = openSync(dirname(targetPath), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* swallow — dir fsync is best-effort */ }
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
   * validated with `allowPrivateHost: true` and actually points at a
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
 * Apply a Gate install patch to an in-memory config object. Pure mutation
 * — callers persist via `writeOpenclawConfig`. Idempotent: re-applying
 * the same patch is a no-op.
 *
 * Returns a list of the dotted-path keys that actually changed, so the
 * CLI can show "wrote: a.b, c.d" instead of "wrote config".
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
  } else if (patch.enable && entry.enabled === false) {
    // No-op, but flag in the changes list so operator sees it was intentional.
    // (Suppressed: we don't add to changes because nothing was written.)
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
