# AG-57 — Gate install/setup in the audit plugin

## Context

"Gate" is Constellation's swarm-deck product. Today it acts as the **audit
ingest gateway** (`POST /admin/audit/ingest`) for this plugin, and is also
the **LLM broker** that OpenClaw can talk to as a model provider (one
service, two roles).

Right now there is no install UX for either role. Operators have to set
audit-gateway config keys by hand (`gatewayUrl` / `gatewayApiKey`) and
configure OpenClaw model providers separately. AG-57 wires both into a
single, opinionated setup flow with two surfaces: CLI + control UI.

OpenAI integration: the broker side wants OpenAI as a backend. We support
two paths — paste an API key, or sign in with OpenAI via PKCE (the same
flow `codex-cli` uses).

### Findings from code/SDK inspection

- `src/index.ts:94` registers the `audit` CLI tree via `api.registerCli`.
  Adding `audit gate ...` subcommands fits the existing pattern.
- `openclaw.plugin.json` configSchema already has `gatewayUrl` /
  `gatewayApiKey` / `gatewayEnabled` for the audit-ingest side. No new
  schema keys required for that role.
- The openclaw SDK exposes `ModelProviderConfig` (`baseUrl`, `apiKey`,
  `auth`, `models[]`, `headers`, `request`, …) and
  `ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token"`.
  Source: `node_modules/.../openclaw/dist/types.models-*.d.ts`. OAuth as
  an auth mode is already a first-class concept upstream — we don't have
  to invent it.
- Control UI is plain TS components under `src/control-ui/components/`,
  routed through `src/ui/routes.ts` under `/plugins/audit/`. Adding a
  `/plugins/audit/gate` subpage matches the existing layout.
- The plugin already writes openclaw config keys for itself in
  documentation; for AG-57 we'll programmatically write to
  `~/.openclaw/config.json` via the SDK config API (see "Persistence"
  below). The `openclawDir` resolver is already in
  `src/util/openclaw-paths.ts`.

## Scope

In scope:
1. **`audit gate install`** — interactive CLI that connects this plugin
   to a Gate instance for both audit publishing and (optionally) model
   brokering.
2. **`audit gate provider ...`** — add/remove/list model-provider
   connections that flow through Gate, including OpenAI via OAuth PKCE.
3. **Control-UI page** `/plugins/audit/gate` — same operations as the CLI,
   browser-driven.
4. **OAuth helper** — local-loopback PKCE flow against
   `auth.openai.com` to obtain an OpenAI access/refresh token that the
   broker (or local config) can use.
5. **Tests** — unit (PKCE/codepath), CLI dry-run, UI smoke.

Out of scope (defer):
- Non-OpenAI OAuth (Anthropic, Google) — same scaffolding, different
  client IDs; ticket later.
- Bootstrapping a *new* Gate deployment. We assume the operator already
  has a reachable Gate URL.
- Secret encryption at rest beyond what openclaw's existing `SecretInput`
  / SecretRef machinery provides.

## Surfaces

### CLI commands (registered in `src/index.ts` under the existing `audit`
tree)

```
audit gate install              # interactive setup wizard
  --url <https://...>           #   non-interactive overrides
  --api-key <sk-gw-...>
  --no-broker                   #   audit-only mode (skip provider setup)
  --json                        #   structured output for scripting
audit gate status               # show current connection + last health probe
audit gate test                 # round-trip: hit ingest + broker health
audit gate provider list
audit gate provider add openai
  --oauth                       #   triggers PKCE flow
  --api-key <sk-...>            #   alternative: paste key
audit gate provider remove <id>
```

Files:
- `src/cli-gate.ts` — new file. CLI action handlers, mirroring
  the structure of `src/cli.ts`. Keep `cli.ts` focused on
  audit-read commands.
- `src/index.ts` — register the new subcommand tree alongside
  the existing `inventory`, `report`, `smt` trees (~line 218).

Interactive prompts: use Node's built-in `node:readline/promises` to
avoid adding a deps. No `inquirer` / `prompts` / `enquirer`. The plugin
already runs on Node ≥ 22.13.

### Control UI

New page: `src/control-ui/components/gate-setup.ts`, wired into
`audit-app.ts` as a `/gate` tab. HTTP backends added to `src/ui/routes.ts`:

```
GET    /plugins/audit/api/gate/status
POST   /plugins/audit/api/gate/connect        body: { url, apiKey }
POST   /plugins/audit/api/gate/test
GET    /plugins/audit/api/gate/providers
POST   /plugins/audit/api/gate/providers      body: { kind, ... }
DELETE /plugins/audit/api/gate/providers/:id
POST   /plugins/audit/api/gate/oauth/openai/start    -> { authUrl, sessionId }
GET    /plugins/audit/api/gate/oauth/openai/:sid/status  (long-poll)
```

Auth posture: same `auth: "plugin"` + loopback assumption as the other
audit routes (already TODO'd in `src/ui/routes.ts:1`). The OAuth callback
listener does **not** ride on these routes — it spawns its own ephemeral
HTTP server on a high port (see below).

## OpenAI OAuth PKCE flow

Reference impl: `codex-cli`'s `auth.ts`. Public-client PKCE against
`https://auth.openai.com`.

Pre-implementation step: verify the current OpenAI ChatGPT-login PKCE
endpoints + client ID against the latest `codex-cli` release at the time
of branch work. These are not officially documented as a stable API, so
we lock the values in a small constants module and re-check before
shipping. If endpoints have changed, narrow the patch to that module.

Mechanics:
1. Generate `code_verifier` (43–128 chars, URL-safe) and
   `code_challenge = base64url(sha256(verifier))`.
2. Pick a free loopback port (try `1455` first, fall back to OS-assigned);
   start `http.createServer` listening only on `127.0.0.1`.
3. Build authorize URL:
   ```
   https://auth.openai.com/oauth/authorize
     ?response_type=code
     &client_id=<OPENAI_CLI_CLIENT_ID>     # constant, mirrors codex-cli
     &redirect_uri=http://localhost:<port>/callback
     &scope=openid profile email offline_access
     &state=<csrf-random>
     &code_challenge=<challenge>
     &code_challenge_method=S256
   ```
4. CLI: print URL + try `xdg-open` / `open`. UI: render in a popup.
5. On callback, verify `state`, exchange `code` at
   `https://auth.openai.com/oauth/token` with `code_verifier`.
6. Persist `{ access_token, refresh_token, id_token, expires_at }`.
7. Tear down the loopback server (one-shot; bound TTL ~5 min so a stalled
   flow doesn't keep a port open).

Module: `src/services/openai-oauth.ts`. Exports:
- `startOAuthFlow(opts): Promise<{authUrl, waitForToken: () => Promise<OAuthToken>}>`
- `refreshToken(refresh: string): Promise<OAuthToken>`

Security guards:
- `state` is a 32-byte CSPRNG nonce; mismatched/missing → reject.
- Reject any callback whose `host` header is not `127.0.0.1` /
  `localhost`.
- Cap server lifetime at 300s; close on first valid callback.
- Never log the `code`, `code_verifier`, or any tokens. The existing
  audit redaction policy must not catch this code path either.
- Tokens flow through `SecretInput` so they're SecretRef-eligible.

Failure modes to handle explicitly: port already bound, browser open
fails (print URL and instruct user to paste), user closes browser
(timeout cleanly), refresh-token denial (re-prompt sign-in).

## Persistence

Two separate config trees:

1. **Audit-plugin config** (existing) — `gatewayUrl`, `gatewayApiKey`,
   `gatewayEnabled` continue to live under
   `plugins.entries.constellation-audit-plugin.config.*`. The installer
   writes these.

2. **OpenClaw provider config** — Gate-as-broker and any per-provider
   entries (OpenAI, etc.) live under `models.providers.*`. We write a
   `gate` provider entry like:
   ```jsonc
   {
     "models": {
       "providers": {
         "gate": {
           "baseUrl": "<gateUrl>/v1",     // broker endpoint
           "auth": "api-key",
           "apiKey": { "secretRef": "constellation-audit:gate-key" },
           "models": [ /* discovered from gate */ ]
         },
         "openai": {                       // optional, when OAuth used
           "baseUrl": "https://api.openai.com/v1",
           "auth": "oauth",
           "headers": {
             "Authorization": { "secretRef": "constellation-audit:openai-oauth" }
           },
           "models": [ /* catalog */ ]
         }
       }
     }
   }
   ```

Writer: prefer the openclaw SDK's config-write API if exposed via
`api.config`/`api.setConfig` (check at impl time; current code uses
read-only `api.pluginConfig`). Fallback: read+merge+write
`~/.openclaw/config.json` atomically via the same util that
`util/openclaw-paths.ts` resolves.

Secrets: store API keys / OAuth tokens via openclaw's SecretRef
mechanism (`SecretInput`); the plain value never gets written to the
JSON config. If SecretRef isn't reachable in this plugin context,
fall back to env-var indirection (`{ "envVar": "GATE_API_KEY" }`-style
input) and document it.

## File-by-file plan

| File | Action | Why |
|------|--------|-----|
| `src/index.ts` | add `audit gate ...` registration block ~L218 | mount new CLI tree |
| `src/cli-gate.ts` | new | CLI handlers for install/status/test/providers |
| `src/services/openai-oauth.ts` | new | PKCE flow + token exchange |
| `src/services/gate-installer.ts` | new | shared logic: validate URL, write config, ping, register provider — used by both CLI + UI route handlers |
| `src/services/gate-client.ts` | new | thin wrapper over Gate's broker/admin endpoints (health, list models, register provider on gate side if applicable) |
| `src/util/openclaw-config-writer.ts` | new | atomic read-merge-write of `~/.openclaw/config.json` |
| `src/ui/routes.ts` | extend | add `/api/gate/*` and `/api/gate/oauth/openai/*` routes |
| `src/control-ui/components/gate-setup.ts` | new | UI panel |
| `src/control-ui/components/audit-app.ts` | extend | add `/gate` tab |
| `openclaw.plugin.json` | maybe extend | only if we discover a config key the existing schema doesn't cover (e.g. `gateBrokerBaseUrl` if it differs from `gatewayUrl`) |
| `README.md` | extend | new "Connecting to Gate" section + screenshot/CLI transcript |
| `test/gate-installer.test.ts` | new | URL validation, config merge, idempotency |
| `test/openai-oauth.test.ts` | new | PKCE challenge derivation, state mismatch rejection, port-bind failure path |
| `test/e2e.test.ts` | extend | `audit gate install --url … --api-key …` non-interactive happy path |

## Risks / open questions

- **OpenAI OAuth endpoint stability.** Not officially-documented public
  API; expect breakage. Mitigation: isolate endpoints + client ID in a
  single constants module, add an integration test that pings the well-
  known config endpoint, and keep an API-key fallback so the feature
  still works if OAuth breaks.
- **Cross-platform `open browser`.** Use a 3-line shell-detect (`xdg-
  open`, `open`, `start`) instead of pulling in `open` npm package; on
  failure, print the URL and instruct the operator.
- **Writing to `~/.openclaw/config.json`.** If the SDK doesn't expose a
  write API at this plugin level, we need atomic file writes + a backup
  copy and clear error reporting on schema validation failure.
- **OpenAI OAuth ↔ Gate handoff.** Two implementation choices:
  (a) plugin holds the OAuth token, refreshes it, and hands access
  tokens to Gate per request; (b) Gate stores the refresh token and
  refreshes itself. (b) is cleaner but needs a Gate admin API; (a) is
  fully local and ships now. Default to (a), revisit later.
- **Loopback port collision** in containerised dev (no browser). Detect
  no-DISPLAY / SSH session and switch the CLI to copy-paste-the-code
  mode (auth code shown to user, they paste back into the TTY).

## Out-of-band prerequisites

Before coding starts, confirm:
1. Gate's broker base URL path (e.g. `/v1` vs `/admin/llm/v1`).
2. Whether Gate has a `GET /admin/models` endpoint to populate the
   provider's `models[]` array, or whether we hard-code a catalog.
3. Whether Gate stores provider credentials server-side (option b
   above) — affects whether OpenAI OAuth tokens leave the box.

These three answers determine the exact shape of `gate-client.ts` and
the persisted provider config — none of them block starting on the CLI
scaffolding, OAuth module, or UI shell, but they need answers before the
end-to-end install can be wired up.

## Suggested PR slicing

1. **PR 1** — `audit gate install` CLI (interactive + flags), `audit
   gate status`/`test`, config writer, README section. No OAuth. No UI.
2. **PR 2** — Control-UI `/gate` page + supporting `/api/gate/*` routes.
   Reuses the same `gate-installer.ts` from PR 1.
3. **PR 3** — `audit gate provider add openai --oauth` + OAuth module +
   UI "Sign in with OpenAI" button.

Each PR is independently shippable; PR 3 is the only one with the
endpoint-stability risk, so isolating it keeps the rest of the feature
out of that blast radius.
