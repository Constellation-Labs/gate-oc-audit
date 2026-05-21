import { validateGatewayUrl, validateGatewayApiKey } from "./gateway-publisher.js";
import {
  applyBrokerProviderPatch,
  applyGateInstallPatch,
  isJsonObject,
  mutateOpenclawConfig,
  readOpenclawConfigSnapshot,
  type JsonObject,
} from "../util/openclaw-config-writer.js";
import { probeGate, type ProbeResult } from "./gate-client.js";
import { PLUGIN_ID } from "../plugin-id.js";

export interface InstallInput {
  url: string;
  apiKey: string;
  /** Also register Gate as a model broker under `models.providers.gate`. */
  registerBroker: boolean;
  /** Allow `https://` URLs to private/link-local hosts (RFC1918/CGNAT).
   * When set AND the URL needs it, the installer also persists
   * `gatewayAllowPrivateHost: true` so the runtime publisher accepts the
   * same URL at startup. */
  allowPrivateHost: boolean;
  /** Skip the live probe — used in non-interactive setups where the
   * operator already knows the connection works (e.g. CI). */
  skipProbe: boolean;
}

export interface InstallReport {
  configPath: string;
  changes: string[];
  probe: ProbeResult | null;
}

export class GateInstallError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Normalize the operator-supplied URL (strip trailing slashes) and
 * validate it against the same rules the runtime gateway publisher
 * uses — so a URL that passes install will never get rejected later at
 * gateway startup. Userinfo (`https://user:pass@host`) is rejected here
 * because it would be persisted into the config and echoed to terminal
 * output by `audit gate status` / `audit gate test`; the plugin
 * authenticates via `X-Gateway-Api-Key`, never basic-auth.
 */
export function normalizeAndValidateUrl(raw: string, allowPrivateHost: boolean): string {
  const trimmed = raw.trim().replace(/\/+$/, "");

  // Reject userinfo early — `new URL("https://u:p@host").hostname === "host"`,
  // so `validateGatewayUrl` doesn't see the credential; we have to filter
  // it here before persistence or status display.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GateInstallError("invalid-url", "Gate URL rejected: malformed URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new GateInstallError(
      "invalid-url",
      "Gate URL rejected: userinfo (user:pass@host) is not supported — pass the API key via --api-key instead",
    );
  }

  const validation = validateGatewayUrl(trimmed, { allowPrivateHost });
  if (!validation.ok) {
    throw new GateInstallError("invalid-url", `Gate URL rejected: ${validation.reason}`);
  }
  return trimmed;
}

export function validateApiKeyOrThrow(key: string): string {
  const trimmed = key.trim();
  const validation = validateGatewayApiKey(trimmed);
  if (!validation.ok) {
    throw new GateInstallError("invalid-api-key", `Gate API key rejected: ${validation.reason}`);
  }
  return trimmed;
}

/**
 * Returns true when the URL passes validation only with `allowPrivateHost
 * = true` — i.e. the runtime publisher will need the config flag set to
 * accept this URL too. Computed by re-running the same validator with
 * the flag off; avoids re-implementing private/link-local IP detection
 * separately from the gateway publisher.
 */
function urlNeedsAllowPrivateHost(url: string): boolean {
  const strict = validateGatewayUrl(url, { allowPrivateHost: false });
  const permissive = validateGatewayUrl(url, { allowPrivateHost: true });
  return !strict.ok && permissive.ok;
}

/**
 * Run the full Gate install: validate inputs, probe the connection, and
 * (on success) merge new keys into the openclaw config file (path
 * resolved by the SDK). Returns a report describing exactly which
 * dotted-path keys were written so the caller can show the user
 * "wrote: a.b, c.d" instead of "wrote config".
 */
export async function installGate(input: InstallInput): Promise<InstallReport> {
  const url = normalizeAndValidateUrl(input.url, input.allowPrivateHost);
  const apiKey = validateApiKeyOrThrow(input.apiKey);

  let probe: ProbeResult | null = null;
  if (!input.skipProbe) {
    probe = await probeGate(url, apiKey);
    if (probe.kind === "unauthorized") {
      throw new GateInstallError(
        "probe-unauthorized",
        `Gate rejected the API key (HTTP ${probe.status}). Check the key and try again.`,
      );
    }
    if (probe.kind === "network-error") {
      throw new GateInstallError(
        "probe-network",
        `Could not reach Gate at ${url}: ${probe.message}`,
      );
    }
    if (probe.kind === "http-error") {
      throw new GateInstallError(
        "probe-http",
        `Gate returned HTTP ${probe.status}. Body: ${probe.body || "(empty)"}`,
      );
    }
  }

  const { path: configPath, changes } = await mutateOpenclawConfig((draft) => {
    const out: string[] = [];
    out.push(
      ...applyGateInstallPatch(draft, {
        gatewayUrl: url,
        gatewayApiKey: apiKey,
        addToAllowlist: true,
        grantConversationAccess: true,
        allowPrivateHost: input.allowPrivateHost && urlNeedsAllowPrivateHost(url),
        enable: true,
      }),
    );
    if (input.registerBroker) {
      out.push(
        ...applyBrokerProviderPatch(draft, {
          baseUrl: url,
          apiKey,
        }),
      );
    }
    return out;
  });

  return {
    configPath,
    changes,
    probe,
  };
}

export interface StatusReport {
  configPath: string;
  configured: boolean;
  url?: string;
  hasApiKey: boolean;
  allowlisted: boolean;
  conversationAccess: boolean;
  enabled?: boolean;
  brokerProviderKey?: string;
}

const DEFAULT_BROKER_KEY = "gate";

/** ENOENT detection across Node fs errors and SDK errors. Node attaches
 * `code === "ENOENT"`; the SDK's runtime-refresh / read errors don't
 * always set it but also don't wrap an underlying fs error, so falling
 * back to a name/message sniff catches the rest. */
function isEnoent(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") return true;
    if (err.name === "ConfigFileNotFoundError") return true;
  }
  return false;
}

/**
 * Read-only summary of the operator's current Gate config. Does not
 * touch the network. Used by `audit gate status`.
 */
export async function readGateStatus(): Promise<StatusReport> {
  let snapshot: { path: string; content: JsonObject };
  try {
    snapshot = await readOpenclawConfigSnapshot();
  } catch (err) {
    // ENOENT — no openclaw config yet — is the "nothing configured"
    // case, which we want to answer truthfully rather than crash.
    // Anything else (malformed JSON, EACCES, SDK refresh failure,
    // etc.) is a real broken state that should propagate so the
    // caller surfaces a clear diagnostic instead of a misleading
    // "Gate: not configured" message on a corrupted file.
    if (!isEnoent(err)) throw err;
    // SDK error shapes that carry the resolved path attach it on the
    // error object; fall back to "" if absent (the report's
    // configPath field is informational only when configured=false).
    const errPath = err instanceof Error
      ? (err as unknown as { path?: unknown }).path
      : undefined;
    const path = typeof errPath === "string" ? errPath : "";
    return {
      configPath: path,
      configured: false,
      hasApiKey: false,
      allowlisted: false,
      conversationAccess: false,
    };
  }

  const content = snapshot.content;
  const plugins = isJsonObject(content.plugins) ? content.plugins : {};
  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  const allowlisted = allow.includes(PLUGIN_ID);

  const entries = isJsonObject(plugins.entries) ? plugins.entries : {};
  const entry = isJsonObject(entries[PLUGIN_ID]) ? entries[PLUGIN_ID] : {};
  const cfg = isJsonObject(entry.config) ? entry.config : {};
  const hooks = isJsonObject(entry.hooks) ? entry.hooks : {};

  const url = typeof cfg.gatewayUrl === "string" ? cfg.gatewayUrl : undefined;
  const hasApiKey = typeof cfg.gatewayApiKey === "string" && cfg.gatewayApiKey.length > 0;
  const conversationAccess = hooks.allowConversationAccess === true;
  const enabled = typeof entry.enabled === "boolean" ? entry.enabled : undefined;

  const models = isJsonObject(content.models) ? content.models : {};
  const providers = isJsonObject(models.providers) ? models.providers : {};
  // Prefer the conventional "gate" key when it matches the configured URL;
  // only fall back to scanning when an operator hand-named the provider
  // something else. Avoids the insertion-order ambiguity when two
  // providers share the same baseUrl.
  let brokerProviderKey: string | undefined;
  if (url) {
    const conventional = providers[DEFAULT_BROKER_KEY];
    if (isJsonObject(conventional) && conventional.baseUrl === url) {
      brokerProviderKey = DEFAULT_BROKER_KEY;
    } else {
      for (const [k, v] of Object.entries(providers)) {
        if (isJsonObject(v) && typeof v.baseUrl === "string" && v.baseUrl === url) {
          brokerProviderKey = k;
          break;
        }
      }
    }
  }

  return {
    configPath: snapshot.path,
    configured: Boolean(url && hasApiKey),
    url,
    hasApiKey,
    allowlisted,
    conversationAccess,
    enabled,
    brokerProviderKey,
  };
}

/**
 * Re-read the on-disk gateway API key for the test/probe fallback path.
 * `readGateStatus` reports `hasApiKey: boolean` only to keep the key out
 * of status output — callers that need the actual value (CLI `audit
 * gate test`, HTTP `/api/gate/test`) go through this helper. Errors
 * propagate so callers can surface a clear "config is broken"
 * diagnostic instead of a misleading "could not resolve" message.
 */
export async function readSavedGatewayApiKey(): Promise<string | undefined> {
  const { content } = await readOpenclawConfigSnapshot();
  const plugins = content.plugins;
  if (!isJsonObject(plugins)) return undefined;
  const entries = plugins.entries;
  if (!isJsonObject(entries)) return undefined;
  const entry = entries[PLUGIN_ID];
  if (!isJsonObject(entry)) return undefined;
  const cfg = entry.config;
  if (!isJsonObject(cfg)) return undefined;
  const key = cfg.gatewayApiKey;
  return typeof key === "string" ? key : undefined;
}
