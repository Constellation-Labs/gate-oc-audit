# Code-quality review — feat/AG-57-openai-oauth

## Summary
The OAuth module, config-writer additions, and provider-panel are well-commented and clean — the PKCE flow has good security-rationale comments and the writer helpers are idempotent and tested. Two real bugs stand out, however: the Commander registration `command("add openai")` is mis-spelled and silently mis-binds the positional, breaking the `audit gate provider add openai` CLI entirely; and the synchronous try/catch around `startOpenAIOAuthFlow` in cli-provider cannot catch the EADDRINUSE it claims to handle. Coverage on the new `/api/gate/oauth/openai/*` routes and the cli-provider handlers is also notably thinner than the PR-1/PR-2 precedent.

## Findings

### [H] Commander command `"add openai"` is mis-registered — handler receives a string, not options
**File:** src/index.ts:297
**Issue:** `provider.command("add openai")` registers `add` as the command name with a required positional argument named `openai`; Commander then invokes the action with `(positionalValue, options, command)` — so `cliProviderAddOpenAIHandler` receives the literal string `"openai"` as its `opts` argument, every flag (`--oauth`, `--api-key`, `--json`, …) silently becomes `undefined`, and the handler always falls into the "missing API key" error branch. Verified empirically with the same commander 14.0.3 the repo pins.
**Suggestion:** Either rename to `.command("add-openai")` (matches `gate install` style — no positional needed) or use `.command("add <kind>")` and validate `kind === "openai"` inside the handler signature `(kind, opts)`. Add a smoke test that drives commander parse end-to-end so this kind of mis-binding can't sneak back in.

### [H] No tests for the `/api/gate/oauth/openai/*` route family
**File:** src/ui/routes.ts:964-1031 (no covering tests in test/ui/gate-routes.test.ts)
**Issue:** PR-2 covered every `/api/gate/{install,test,status}` branch — same-origin/CSRF reject, non-loopback gate, malformed body, redaction. PR-3 adds three new routes (`oauth/openai/start`, `…/<sid>/status`, `…/<sid>/cancel`) plus the module-local `openaiOauthSessions` map, the `reapOauthSessions` reaper, the "another flow in progress" 409 branch, and `onOauthComplete` (which mutates `~/.openclaw/config.json` from a non-route code path). None of that has a route test; only the bare `openai-oauth.ts` module is exercised.
**Suggestion:** Add a route-level test that boots the rig, mocks the upstream provider, posts to `/start`, drives the loopback callback as the browser would, polls `/status`, and asserts the config file is written. Also add: 409 on a second `/start`, 404 on an unknown `sid`, CSRF reject on `/cancel`, and non-loopback gate behaviour.

### [M] Synchronous try/catch in `runOAuthFlow` cannot catch EADDRINUSE
**File:** src/cli-provider.ts:154-165
**Issue:** `startOpenAIOAuthFlow` returns the flow synchronously; the `server.listen(...)` happens inside the Promise and `server.on("error", ...)` rejects `waitForToken` asynchronously. The synchronous `try { flow = startOpenAIOAuthFlow(...) } catch` therefore never fires for EADDRINUSE — that error surfaces at `await flow.waitForToken`, where the generic error path on line 184 prints `OAuth flow failed: …` without the helpful "set OPENCLAW_OPENAI_OAUTH_PORT" hint. The dedicated hint at line 160-162 is dead code in the EADDRINUSE case it was written for.
**Suggestion:** Move the EADDRINUSE-specific messaging into the `catch` around `await flow.waitForToken`, or expose a `flow.listening: Promise<void>` so the caller can `await` the bind phase before printing "Listening on …".

### [M] Add-path silently allows `providerKey: "gate"` and overwrites the broker
**File:** src/cli-provider.ts:106, src/ui/routes.ts:912, src/ui/routes.ts:979
**Issue:** `removeProviderEntry` refuses `"gate"`, but the three add paths (CLI, POST `/api/gate/providers`, POST `/api/gate/oauth/openai/start`) take an arbitrary `providerKey` and route through `applyProviderEntryPatch` which will happily overwrite `models.providers.gate` — clobbering the broker config that `audit gate install` set up, with a different `baseUrl` (`https://api.openai.com/v1`) and the user's OpenAI key as the broker key. Asymmetric with the remove guard.
**Suggestion:** Apply the same "refuses 'gate'" guard in `applyProviderEntryPatch` (or in each add caller) so the broker can only be written through `applyBrokerProviderPatch`.

### [M] `onOauthComplete` calls `resolveOpenAIOAuthEndpoints()` twice in a row
**File:** src/ui/routes.ts:1051-1052
**Issue:** Two consecutive calls to the same env-resolving helper to read `.authorizeUrl` and `.clientId` separately. Cheap, but reads as careless and is asymmetric with `runOAuthFlow` in cli-provider (which captures the endpoints once and reuses them). Future-you reading the diff will wonder if a refresh between the two calls is intentional.
**Suggestion:** `const endpoints = resolveOpenAIOAuthEndpoints();` once at the top of the function, then reference its fields.

### [M] CLI handler tests for cli-provider.ts are missing
**File:** test/ (no test/cli-provider.test.ts)
**Issue:** PR-1 set the precedent (`test/cli-gate.test.ts` directly exercises `cliGateInstallHandler` / `Status` / `Test` with json/skip-probe/env-var/error paths). The new `cliProviderListHandler`, `cliProviderRemoveHandler`, and `cliProviderAddOpenAIHandler` have no direct tests. Coverage today is the provider-side of the route tests plus the writer tests — neither would catch the Commander mis-binding above, the EADDRINUSE-error misrouting, or stdin/env-var fallback edge cases.
**Suggestion:** Add `test/cli-provider.test.ts` modeled on `test/cli-gate.test.ts`: list (empty / populated, json), remove (success / 'gate' guard / non-existent), add openai (--api-key, --api-key-stdin, env-var fallback, --json output, mutual-exclusion with --oauth).

### [M] Provider-panel polling uses a different timer pattern than the rest of the UI
**File:** src/control-ui/components/provider-panel.ts:108, 167-193
**Issue:** Every other Lit component in `src/control-ui/components/` is event/refresh-driven; no other component uses `window.setTimeout` for polling. The `oauthPollTimer` + `scheduleOauthPoll` + `clearOauthPoll` triad here is the only such loop in the codebase. It's also re-entrant: a `connectedCallback`-triggered `refresh()` while a poll is in flight could race the state writes (`oauthStatus`, `submitOk`). The lone `clearOauthPoll` on disconnect is the only protection.
**Suggestion:** Either keep but document why (the route is fundamentally async — a notable WHY comment is missing), or factor into a small `oauth-status-poller.ts` helper so the polling lives apart from the render component. Either way, drop a comment explaining that the poll re-arms itself only while `kind === "pending"`.

### [L] `openai-oauth-constants.ts` doesn't have an in-code TODO about the reverse-engineered client_id
**File:** src/services/openai-oauth-constants.ts:26
**Issue:** The file-header docstring warns about the reverse-engineered codex-cli client_id, but the `DEFAULT_CLIENT_ID = "app_…"` line itself has no marker — a future grep for `TODO` / `FIXME` / `// XXX` won't surface it, and `git blame` jumps to the constant, not the docstring. Operationally easy to overlook on upgrade.
**Suggestion:** Inline `// TODO(codex-cli-client-id): re-verify against github.com/openai/codex auth.ts on each release` next to the constant.

### [L] Hard-coded `"https://api.openai.com/v1"` in three places
**File:** src/cli-provider.ts:16, src/ui/routes.ts:928, src/ui/routes.ts:1047
**Issue:** Three copies of the same provider URL. The CLI hoists a `const OPENAI_BASE_URL`; the two route handlers inline the literal. If the URL ever needs an env override (e.g. for an Azure-style endpoint reroute), three sites to touch.
**Suggestion:** Move to a small shared constant alongside `openai-oauth-constants.ts` (or export `OPENAI_BASE_URL` from cli-provider.ts and import).

### [L] `void sessionId` parameter in `onOauthComplete` / `onOauthError`
**File:** src/ui/routes.ts:1037, 1071, 1074, 1077
**Issue:** `sessionId` is passed and immediately discarded with `void sessionId`. Easier to read with the parameter removed entirely — the comment on line 1069-1070 explains the absence well, but the parameter itself is dead.
**Suggestion:** Drop the parameter from both helpers; the comment can move to the call site or `OAuthSession` type doc.

### [L] `runOAuthFlow` synthesizes the issuer URL by re-parsing `endpoints.authorizeUrl`
**File:** src/cli-provider.ts:175, src/ui/routes.ts:1051
**Issue:** `new URL(endpoints.authorizeUrl).origin` is the same as the upstream baseUrl `endpoints` is derived from. Constants module could export an `issuer` field directly so callers don't have to derive it.
**Suggestion:** Add `issuer: baseUrl` to `OpenAIOAuthEndpoints` in `openai-oauth-constants.ts` and consume it.

### [L] `cliProviderAddOpenAIHandler`: `(opts.providerKey ?? "openai").trim() || "openai"` is over-engineered
**File:** src/cli-provider.ts:106
**Issue:** Two collapses of "empty → openai" — once via `??`, once via `|| "openai"`. The second handles the case where `--provider-key " "` got past Commander; cleaner as `const providerKey = (opts.providerKey?.trim() || "openai");`.
**Suggestion:** Collapse to a single expression.

### [L] `readStdinLine` listener cleanup re-runs `off()` for events that already fired (`once`)
**File:** src/cli-provider.ts:222-238
**Issue:** Stylistic only — `process.stdin.once(...)` listeners auto-remove themselves on fire, so the `cleanup()` call inside `onEnd` / `onError` only needs to clear the `on("data", …)` handler. Not buggy, just noisier than necessary.

## What's good
- `openai-oauth.ts` is well-scoped: a CallbackOutcome discriminated-union + a single `handleCallback` keeps the route-style request handling readable and exhaustive.
- The OAuth security comments at the top of `openai-oauth.ts` explain the *why* (fixed-port concurrency, host-header belt-and-braces, never-log tokens) — keep these intact in future refactors.
- `tryOpenBrowser` explicitly hard-validates `^https://` before shelling out and detaches via `child.unref()` with a `.on("error", ...)` swallow — the comment naming "defense-in-depth" is good.
- `applyProviderEntryPatch` is idempotent and tested for the three meaningful transitions (fresh write, oauth→api-key wipes oauth metadata, repeated apply is a no-op).
- The redacted listing in `/api/gate/providers` GET and `cliProviderListHandler` never echoes the apiKey or refresh token, and `test/ui/gate-routes.test.ts:526` explicitly asserts non-leakage.
- The README has both CLI and env-var forms for the OAuth constants and is loud about the reverse-engineered client_id.
- `removeProviderEntry` refuses the conventional `gate` key and is tested for it.
- `safeBodyText` caps and control-char-strips before surfacing token-endpoint error bodies — good defense against a hostile mock.
- Module-local `openaiOauthSessions` map carries a TTL + grace and is reaped on every start/status request — no orphan flows.

## Open questions
- Is `provider.command("add openai")` ever exercised in CI? If the e2e suite (the `audit gate install` / etc. checks added in PR-1) doesn't reach this subcommand, the H finding above has been latent since PR-3 landed.
- Is there an intent for a `/api/gate/oauth/openai/refresh` route or a background refresher? The schema in `openclaw-config-writer.ts:325-331` stores `refreshToken` + `expiresAt`, but no caller of `refreshOpenAIToken` exists in this branch — could be a deferred follow-up, or dead code if not.
- Should `providerKey="gate"` be rejected by all add paths (M finding above) — or is the asymmetric guard intentional because the broker patch shape is structurally compatible enough that an overwrite is "rotate the broker via the wrong CLI" rather than data loss? Sibling correctness/security reviews may have a stronger opinion.
