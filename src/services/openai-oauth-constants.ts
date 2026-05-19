/**
 * OpenAI OAuth (PKCE) endpoint constants.
 *
 * These values are **not part of OpenAI's officially-documented public
 * API**. They come from the open-source `codex-cli` (github.com/openai/
 * codex) which implements the same ChatGPT-account-based sign-in flow.
 * They are reverse-engineered from a public client and may change at
 * any time — re-verify against the upstream `auth.ts` source before
 * cutting a release.
 *
 * Override-via-env-var is supported so operators can update endpoints
 * without a plugin rebuild when (not if) upstream changes:
 *
 *   OPENCLAW_OPENAI_OAUTH_BASE_URL   default: https://auth.openai.com
 *   OPENCLAW_OPENAI_OAUTH_CLIENT_ID  default: app_EMoamEEZ73f0CkXaXp7hrann (codex-cli)
 *   OPENCLAW_OPENAI_OAUTH_PORT       default: 1455
 *   OPENCLAW_OPENAI_OAUTH_SCOPES     default: openid profile email offline_access
 *
 * Operators who have their own OAuth registration with OpenAI (for
 * non-personal use) should set OPENCLAW_OPENAI_OAUTH_CLIENT_ID to their
 * own application ID; the default value is the public codex-cli client
 * and tying production deployments to it is fragile.
 */

const DEFAULT_BASE_URL = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_PORT = 1455;
const DEFAULT_SCOPES = "openid profile email offline_access";

export interface OpenAIOAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Loopback port the redirect_uri points at. Must match a value the
   * upstream OAuth provider has on its allowlist for the client_id. */
  redirectPort: number;
  scopes: string;
  /** Full redirect URI advertised to the OAuth provider. */
  redirectUri: string;
}

export function resolveOpenAIOAuthEndpoints(env: NodeJS.ProcessEnv = process.env): OpenAIOAuthEndpoints {
  const baseUrl = (env.OPENCLAW_OPENAI_OAUTH_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const clientId = env.OPENCLAW_OPENAI_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const portRaw = env.OPENCLAW_OPENAI_OAUTH_PORT;
  const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : DEFAULT_PORT;
  const scopes = env.OPENCLAW_OPENAI_OAUTH_SCOPES ?? DEFAULT_SCOPES;
  return {
    authorizeUrl: `${baseUrl}/oauth/authorize`,
    tokenUrl: `${baseUrl}/oauth/token`,
    clientId,
    redirectPort: port,
    scopes,
    redirectUri: `http://localhost:${port}/callback`,
  };
}
