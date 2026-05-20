# AG-57 — Rewrite OpenAI provider auth on top of the openclaw SDK

PR 3 (`feat/AG-57-openai-oauth`) currently:
- ships its own PKCE module (`src/services/openai-oauth.ts`),
- runs a loopback callback server on port 1455,
- stores the access token + refresh metadata under
  `models.providers.openai.openclawAudit.oauth` in `~/.openclaw/config.json`,
- exposes an HTTP `/api/gate/oauth/openai/{start,<sid>/status,<sid>/cancel}`
  flow driven by browser polling, and
- has a CLI counterpart `audit gate provider add openai --oauth`.

The openclaw SDK already supplies all of this and the install scanner
treats `child_process` (used by our own `tryOpenBrowser`) as a fatal
warning. Plan: replace the entire OAuth flow with SDK helpers and move
credentials into the SDK's canonical auth-profile store.

## SDK surface we'll use

All from `openclaw/plugin-sdk/provider-auth`:

| Symbol | Purpose |
|---|---|
| `loginOpenAICodexOAuth` (`provider-auth-login`) | Turnkey OpenAI Codex OAuth flow. Takes `{ prompter, runtime, isRemote, openUrl }`. Returns `OAuthCredentials \| null`. |
| `WizardPrompter` (`plugin-sdk/setup`) | TUI abstraction the SDK's wizard expects. We'll need a minimal stdin/stdout implementation. |
| `upsertAuthProfileWithLock` | Persist an `AuthProfileCredential` to the SDK store. |
| `upsertApiKeyProfile` / `buildApiKeyCredential` | Same path for `--api-key`. |
| `applyAuthProfileConfig` | Update `models.providers.openai.apiKey` to a marker the SDK runtime resolves through the profile store. |
| `writeOAuthCredentials` | Persist the OAuth tokens to the openclaw-credentials store the SDK uses for codex CLI compat. |
| `CODEX_CLI_PROFILE_ID` | Canonical profile id for the Codex login. |
| `removeProviderAuthProfilesWithLock` | Mirror for `audit gate provider remove`. |
| `listProfilesForProvider` | Mirror for `audit gate provider list`. |

`openUrl` lives at `openclaw/dist/plugin-sdk/src/plugins/setup-browser.js`
(also `dist/plugin-sdk/src/infra/browser-open.js`). It is NOT exported as
a clean subpath. Two options:
1. Deep import: `import { openUrl } from "openclaw/dist/plugin-sdk/src/plugins/setup-browser.js";`. Works; scanner is happy because the import string is `"openclaw/..."`, not `"child_process"`. Brittle long-term (subpath could move between SDK versions).
2. Skip auto-launch: pass an `openUrl` that just prints "open this URL in your browser" and returns. Operator copy-pastes. Loses UX nicety but adds zero coupling.

Plan: option 1 with an explicit `try`/catch fallback to option 2 if the
deep import resolves but fails at runtime. The deep import is what the
SDK's own internal callers do, so the "stability" risk is bounded by the
same risk we already accept for everything else we import from
`openclaw/plugin-sdk/*`.

## What gets ripped out

- `src/services/openai-oauth.ts` — delete (replaced by SDK).
- `src/services/openai-oauth-constants.ts` — delete (SDK owns these).
- `src/util/openclaw-config-writer.ts` — drop `ProviderEntryPatch.oauth`,
  drop the OAuth-metadata branch in `applyProviderEntryPatch`, drop
  `applyProviderEntryPatch` writing `apiKey` directly when we go through
  the SDK. The api-key path can stay (or move to `upsertApiKeyProfile`
  too; see below).
- `src/ui/routes.ts` — delete:
  - `openaiOauthSessions` Map, `OAuthSession` type, `OAUTH_SESSION_GRACE_MS`, `DEFAULT_OAUTH_TIMEOUT_MS`, `reapOauthSessions`, `shutdownOauthSessions`, `onOauthComplete`, `onOauthError`.
  - Routes: `POST /api/gate/oauth/openai/start`, `GET /api/gate/oauth/openai/<sid>/status`, `POST /api/gate/oauth/openai/<sid>/cancel`.
  - The `shutdownOauthSessions()` call from `src/index.ts:ui-server.stop()`.
- `src/control-ui/api.ts` — delete `startOpenAIOAuth`, `getOpenAIOAuthStatus`, `cancelOpenAIOAuth`, the `OAuthSessionStatus` type, the `OAuthStartResponse` type.
- `src/control-ui/components/provider-panel.ts` — delete `startOauth`, `scheduleOauthPoll`, `clearOauthPoll`, `cancelOauth`, `renderOauthBlock`, all `oauth*` state. Keep the API-key paste form and the provider list.
- `test/openai-oauth.test.ts` — delete.
- Sections of `test/ui/gate-routes.test.ts`, `test/cli-provider.test.ts`, `test/gate-installer.test.ts` covering the deleted behavior — delete.

## What gets added

### `src/services/wizard-prompter.ts`
Minimal `WizardPrompter` implementation backed by `node:readline/promises`
+ stdout. Used only by the CLI's OAuth path. Implements:
- `intro` / `outro` / `note` / `plain` → `console.error` line writes.
- `text({ message, sensitive })` → `readline.question(message)` with the same secret-prompt raw-mode trick the existing `cli-gate.ts` `promptSecret` uses when `sensitive: true`.
- `select` / `multiselect` → numbered list + readline answer parser.
- `confirm({ message })` → `readline.question(message + " [y/N]")`.
- `progress` → minimal `update`/`stop` that just writes lines (no fancy redraw).

Lives in `src/services/` because it has no UI dependency.

### `src/cli-provider.ts`
Rewritten:

- `add openai --api-key …` → `buildApiKeyCredential({ provider: "openai", key })` → `upsertApiKeyProfile({ store, profile })` → `applyAuthProfileConfig(cfg, params)` → write config. No more `applyProviderEntryPatch` on this path; the SDK's writer updates the provider key.
- `add openai --oauth` → construct `WizardPrompter`, deep-import `openUrl`, call `loginOpenAICodexOAuth({ prompter, runtime, isRemote, openUrl })`. On success, the SDK persists the credential via `writeOAuthCredentials`; we then call `applyAuthProfileConfig` to point `models.providers.openai` at the resulting profile id (`CODEX_CLI_PROFILE_ID`).
- `list` → `listProfilesForProvider({ provider: "openai", store })`. The redacted output stays (we only emit profile ids + auth kind + email when present).
- `remove <key>` → `removeProviderAuthProfilesWithLock({ provider, profileId, agentDir })`. The `gate` guard moves with us.

`RuntimeEnv` is provided by `api.runtime` (need to confirm by reading
the SDK definition); fallback is a manual construct from
`{ stdin, stdout, stderr, env }`.

### `src/ui/routes.ts`
- `GET /api/gate/providers` — rewritten to read from the auth-profile
  store via `listProfilesForProvider`. Same redacted shape as today.
- `POST /api/gate/providers` — still accepts `{ kind: "openai", apiKey }`
  but writes through `upsertApiKeyProfile` + `applyAuthProfileConfig`.
- `DELETE /api/gate/providers/<key>` — calls `removeProviderAuthProfilesWithLock`.
- No more OAuth routes. The UI's API key form keeps working; the
  Providers tab loses the "Sign in with OpenAI" button.

### `src/control-ui/components/provider-panel.ts`
- Keep: provider list, API key paste form, "Remove" button per row.
- Drop: OAuth button, polling state, the renderOauthBlock variants.
- Add: a one-line note pointing the operator at the CLI for OAuth
  sign-in (`Run \`openclaw audit gate provider add openai --oauth\` from
  a terminal to sign in via the browser.`).

### `openclaw.plugin.json`
No change.

### `README.md`
- Rewrite the LLM providers section to describe the new shape.
- Drop the codex-cli `client_id` warning (no longer applicable; SDK
  owns the constants).
- Drop the `OPENCLAW_OPENAI_OAUTH_*` env-var docs (no longer ours).
- Mention that OAuth is CLI-only; the UI handles API-key only.

## Tests

Replace, don't extend:

- `test/cli-provider.test.ts` — keep the API-key cases; rewrite to
  mock the SDK helpers (probably via dependency injection of the
  store/profiler) or, easier, write to a tmp `AGENT_DIR` and use the
  real SDK helpers and assert on disk state.
- `test/ui/gate-routes.test.ts` — drop OAuth lifecycle tests, rewrite
  /providers tests to assert against the auth-profile store on disk.
- `test/openai-oauth.test.ts` — delete.
- `test/gate-installer.test.ts` — delete the `applyProviderEntryPatch`
  cases that asserted OAuth-metadata persistence. Keep the api-key path
  if `applyProviderEntryPatch` is still used.

## Risks / open questions

1. **`RuntimeEnv` shape.** `loginOpenAICodexOAuth` requires it. Is it
   accessible to plugin code via `api.runtime`, or do we have to
   construct one? If construct: what fields are mandatory?
2. **`AuthProfileStore` location.** Likely under
   `~/.openclaw/auth-profiles/` or similar. We need to call
   `ensureAuthProfileStore({ agentDir })` to get a handle; `agentDir`
   default needs confirming.
3. **`isRemote` flag for the OAuth flow.** Set to `false` for CLI
   (local browser available). The SDK uses this to switch to a
   copy-paste-the-code flow on remote/headless hosts. We can detect by
   `process.env.DISPLAY` / `process.env.SSH_TTY` / `process.stdin.isTTY`.
4. **Wizard-prompter implementation completeness.** Some SDK flows may
   call methods we don't implement (e.g. `progress.update` with redraw).
   First pass implements the minimum; we can extend if `loginOpenAICodexOAuth`
   crashes on a missing method.
5. **Backward-compat for existing operators.** Operators who already ran
   `audit gate provider add openai --api-key` and have
   `models.providers.openai.apiKey` set inline will keep working —
   `applyAuthProfileConfig` only changes the openclaw runtime's
   resolution order, not the legacy inline-apikey path. We do NOT need
   to migrate existing configs.
6. **Deep-importing `openUrl`.** Documented in the file we add; if the
   SDK ever moves it, the catch falls back to print-only mode. Risk is
   bounded.
7. **Loss of UI OAuth button.** Acceptable — the CLI flow remains, and
   the SDK's own wizard works the same way (CLI-driven). The README
   carries the new instruction.

## Slicing

This is one commit on `feat/AG-57-openai-oauth`. The branch already has
a "review round-1 fixes" commit on top of the original PR; this becomes
a second fixup. Not splitting into more — the deletion and replacement
are tightly coupled.

## Suggested sequence

1. Read SDK runtime / agent-dir contracts (RuntimeEnv, ensureAuthProfileStore).
2. Write `src/services/wizard-prompter.ts`.
3. Rewrite `cli-provider.ts` (api-key path first, then oauth path).
4. Rewrite `routes.ts` (drop oauth machinery, rewrite /providers).
5. Trim `provider-panel.ts` (drop oauth state).
6. Update `applyProviderEntryPatch` (drop oauth fields).
7. Delete dead modules + dead tests.
8. Rewrite tests against the SDK.
9. README update.
10. Build + test + commit + force-push to overwrite the existing
    round-1 fixup commit (or add as a second fixup — pick before push).
