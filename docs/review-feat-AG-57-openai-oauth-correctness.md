# Correctness review — feat/AG-57-openai-oauth

## Summary
PR 3's PKCE machinery is structurally correct (verifier length, S256 challenge, timing-safe state comparison, proper teardown). The most material defects are in the surrounding glue: `refreshOpenAIToken`'s "no rotation" branch is unreachable so a legitimate server reply will fail; in-flight OAuth sessions are not torn down on plugin shutdown; the CLI/route try/catch for `EADDRINUSE` cannot fire because `server.listen` errors asynchronously; the API-key clear-scope path silently drops a previously-set scope on re-install; and the UI poll loop dies permanently on a single transient network blip.

## Findings

### [H] `refreshOpenAIToken` cannot accept a non-rotating refresh response
**File:** src/services/openai-oauth.ts:243–259, 328
**Issue:** The comment + fallback at line 326–328 claim to support OAuth servers that omit `refresh_token` on refresh, but `normalizeTokenResponse` already rejects any response missing `refresh_token` (returns `undefined` → `throw "refresh response missing required fields"` at 325).
**Repro / why it's wrong:** A server that legitimately reuses the prior refresh token (RFC 6749 allows this) will return `{access_token, expires_in, token_type}` only. `normalizeTokenResponse` requires `refreshToken` (line 247–249); the function throws before reaching the `? token : { ...token, refreshToken }` ternary, so the fallback is dead code. The test at `test/openai-oauth.test.ts:247–267` documents this with a "missing required fields" rejection — but that's the bug, not the intended behaviour. Plugin will be unable to refresh against any OpenAI deployment that doesn't rotate refresh tokens.
**Suggestion:** Make `refresh_token` optional in `normalizeTokenResponse` when it's called from the refresh path (e.g. pass an `allowMissingRefreshToken: true` flag), then keep the existing fallback.

### [H] In-flight OAuth sessions are not cancelled on plugin shutdown
**File:** src/ui/routes.ts:179, 1003 ; src/index.ts:663–681 (shutdown service)
**Issue:** `openaiOauthSessions` is a module-local Map; on plugin shutdown (retention service `stop()` and the rest), no code iterates the map and calls `session.cancel()`. The loopback server keeps the port bound and the 5-minute timer pinned.
**Repro / why it's wrong:** Start an OAuth flow via `POST /api/gate/oauth/openai/start`; do not complete it. Trigger a plugin reload (host re-registers). The next `register()` call gets a fresh module scope (Node ESM caches the module though — actually the module-local Map *persists* across re-registers, so the new code path will see a stale `pending` session and 409 the operator). Even on full process exit it's fine, but on the host's hot-reload path it's stuck. Separately, the 5-minute timer holds the event loop open during graceful shutdown.
**Suggestion:** Either expose a `shutdownOauthSessions()` from `routes.ts` and call it from `retention.stop()` (or a new `ui-server.stop()`), or unref the timer + close the server on plugin teardown.

### [M] `EADDRINUSE` CLI / route "could not start listener" branch is unreachable
**File:** src/cli-provider.ts:154–165 ; src/ui/routes.ts:982–987
**Issue:** Both call sites wrap `startOpenAIOAuthFlow()` in a synchronous try/catch and inspect the message for `EADDRINUSE`, but `startOpenAIOAuthFlow` never throws synchronously — `server.listen()` is async and the listen error fires on `server.on("error", ...)` → rejects `waitForToken` (src/services/openai-oauth.ts:135–137, 139).
**Repro / why it's wrong:** The test at `test/openai-oauth.test.ts:230–243` confirms `EADDRINUSE` surfaces as a rejection on `flow.waitForToken`, not as a thrown error from the factory. The CLI's helpful "another OAuth flow is already running on this port" hint (line 160–161) is dead code; the operator sees the generic `OAuth flow failed: listen EADDRINUSE ...` message from line 184. The route returns a 200 with a valid sessionId, then the `/status` poll surfaces an `error` containing `EADDRINUSE` — confusing because the session looked like it started.
**Suggestion:** Detect `EADDRINUSE` inside the `flow.waitForToken` catch (CLI) and in `onOauthError` (route) and surface the dedicated message; or refactor `startOpenAIOAuthFlow` to return a promise that resolves only after `listening` so EADDRINUSE can be thrown synchronously.

### [M] OAuth API-key re-install cannot clear a previously-set scope
**File:** src/util/openclaw-config-writer.ts:372–375
**Issue:** Scope is only updated when `patch.oauth.scope !== undefined`; a caller who wants to clear scope (e.g. server stopped returning a scope on the latest refresh) has no way to express that.
**Repro / why it's wrong:** Initial OAuth install with `scope: "openid profile email"` writes scope; later refresh returns no `scope` field, plugin re-applies patch with `oauth.scope = undefined` — the stale `"openid profile email"` survives. Not a security issue (the runtime ignores `openclawAudit.oauth.scope`), but it's misleading metadata that contradicts the doc comment ("Persisted next to the provider entry...so the plugin can refresh...").
**Suggestion:** Drop the `!== undefined` guard and let `undefined` clear the field via `delete oauth.scope`, or document the asymmetry.

### [M] UI poll loop stops permanently on first transient error
**File:** src/control-ui/components/provider-panel.ts:171–185
**Issue:** The `setTimeout` callback wraps the `getOpenAIOAuthStatus` call in a try/catch but only reschedules itself when `status.kind === "pending"`. A single network blip (CORS preflight retry, plugin reload, etc.) puts the catch branch in charge, sets `this.oauthError`, and never reschedules.
**Repro / why it's wrong:** Drop the network for 1.5 s while the operator is signing in. `getOpenAIOAuthStatus(sid)` throws. The catch sets `oauthError` and exits without `this.scheduleOauthPoll()`. Even after the server-side flow completes, the UI never polls again — the operator has to refresh the page (which loses `oauthSessionId` state on the in-memory Lit component).
**Suggestion:** Reschedule the poll in the catch with a backoff cap, or at minimum continue polling N more times before giving up.

### [M] `cancel()` doesn't reject `waitForToken`
**File:** src/services/openai-oauth.ts:156–161
**Issue:** `cancel()` clears the timer + closes the server but never rejects the in-flight `tokenPromise`. Any caller `await`-ing `waitForToken` after `cancel()` runs hangs forever.
**Repro / why it's wrong:** This isn't reachable from current callers (the route's cancel handler doesn't await `waitForToken` again; the CLI only `await`s once). But anyone composing `cancel()` + `waitForToken` (e.g. a future race-against-Ctrl-C in the CLI: `Promise.race([flow.waitForToken, signalAbort])`) will deadlock. The `.then(onComplete, onError)` attached at routes.ts:998–1001 also never fires — it's the route handler that flips status to "error", not the underlying promise.
**Suggestion:** In `cancel()`, when not yet settled, `finish(() => reject(new Error("cancelled")))` instead of bypassing `finish`.

### [M] `isLoopbackHostHeader` accepts forged Host with `[::1]` substring
**File:** src/services/openai-oauth.ts:262–272
**Issue:** Line 270 returns true whenever `h.includes("[::1]")` — a substring check, not a prefix/exact match. A header like `Host: evil.com[::1]` (legal characters in an HTTP header value) passes.
**Repro / why it's wrong:** `isLoopbackHostHeader("Foo[::1]Bar")` returns true. Mitigated by the fact that the server itself binds to `127.0.0.1`, so a forged Host alone can't redirect traffic — but the comment at line 16–17 says this guard is the belt to the binder's braces. The bare IPv6 form `::1` (no brackets) actually returns *false* because `"::1".split(":")[0] === ""` — minor inconsistency, browsers always send the bracketed form anyway.
**Suggestion:** Replace `h.includes("[::1]")` with a stricter check on `h` (e.g. `/^\[::1\](:\d+)?$/`); confirm whether bare `::1` host needs to be supported.

### [M] Route's OAuth flow-in-progress check uses default 5-min timeout but reapAt is 6 min
**File:** src/ui/routes.ts:179, 970–976, 994
**Issue:** The `/start` route sets `reapAt = now + 6 * 60_000` and the OAuth flow uses the default `DEFAULT_TIMEOUT_MS = 5 * 60_000`. The intent (per the inline comment) is "5min timeout + 1min grace". This works *only* because `onOauthError` fires at 5min and resets `reapAt = now + 60_000`. If `onOauthError` ever fails to fire (e.g. a synchronous throw inside the `.then` callback, or a future refactor that decouples the rejection), the session stays in `pending` past the 5-min timeout but `reapAt` is 6min, so the next `/start` 5m30s later still sees `pending` and 409s.
**Repro / why it's wrong:** Today it works by accident; the invariant that `reapAt` is always reset on settle is implicit. A reviewer or future maintainer can break it.
**Suggestion:** Make `reapAt` lazily computed from `status` (e.g. `terminal -> +60s`, `pending -> startedAt + timeoutMs + 60s`) so the invariant is structural; or add a periodic reaper that doesn't rely on session callbacks.

### [L] OAuth-complete write failure loses the refresh token
**File:** src/ui/routes.ts:1042–1067
**Issue:** `onOauthComplete` does the token exchange (already complete), then tries to write the config; if `writeOpenclawConfig` throws (disk full, permission denied, ENOSPC), the catch flips status to `error` and the refresh token is lost (only ever held in the `token` local).
**Repro / why it's wrong:** The operator completed the OAuth flow successfully — provider issued tokens — but the plugin presents the result as an OAuth failure. They have to redo the whole flow. Cosmetic on first failure, blocking if disk-full persists.
**Suggestion:** Log the refresh token to a separate file (mode 0o600) before the main config write, or surface a different error class so the UI can suggest "config write failed, try again" rather than "OAuth failed".

### [L] `--provider-key gate` can overwrite the broker entry via `applyProviderEntryPatch`
**File:** src/cli-provider.ts:106, 200–207 ; src/util/openclaw-config-writer.ts:340–388 ; src/ui/routes.ts:912, 926–934
**Issue:** `removeProviderEntry` throws when `providerKey === "gate"` (line 397), but `applyProviderEntryPatch` does not. A CLI invocation `audit gate provider add openai --provider-key gate --api-key sk-...` or the equivalent POST `/api/gate/providers { providerKey: "gate", apiKey: "sk-..." }` will silently rewrite `models.providers.gate` (clobbering `auth`, `apiKey`, and `baseUrl`) and leave the broker key broken on next openclaw start.
**Repro / why it's wrong:** Inconsistent: the matching `remove` path protects against `gate`, but the `add/update` path does not. The route-level handler at routes.ts:912 takes `providerKey` from the body verbatim.
**Suggestion:** In `applyProviderEntryPatch`, throw if `patch.providerKey === "gate"`, or normalize the CLI/route handlers to reject that key before they reach the writer.

### [L] `--oauth-timeout-sec` swallows bad input silently
**File:** src/cli-provider.ts:149–152
**Issue:** `Number("not-a-number")` is `NaN`; `Number.isFinite(NaN)` is false; `timeoutMs` becomes `undefined`, the default 5-minute timeout kicks in. The operator who typed `--oauth-timeout-sec abc` doesn't get an error and silently waits 5 minutes.
**Repro / why it's wrong:** Commander's parsing leaves `opts.oauthTimeoutSec` as the raw string `"abc"`. No `errLine` is printed.
**Suggestion:** Reject the flag with `errLine` + `exitCode = 1` when the value is non-numeric.

### [L] `tryOpenBrowser` swallows non-existent-binary errors
**File:** src/cli-provider.ts:246–259
**Issue:** Comment says "Failure is silent — the URL is already on stdout". True for ENOENT on `xdg-open`, but on a Linux box without `xdg-open` the operator never sees any indication that the browser didn't open — they have to notice that the auth page didn't appear and copy-paste manually.
**Repro / why it's wrong:** Functionally fine (URL is on stdout per line 168–169), but the UX has a beat where it looks like the CLI hung. The comment says this is intentional, so this is a nit.

### [L] `oauthExpiresAt` redaction misses non-string boolean/array shapes
**File:** src/cli-provider.ts:42–48 ; src/ui/routes.ts:882–889
**Issue:** Both readers only surface `oauthExpiresAt` when the underlying value is a string. If a corrupted config has `expiresAt: 1234567890` (number) the provider listing silently omits the field, making it look like an api-key provider. Not a correctness bug per se but operator gets misleading signal.
**Suggestion:** Surface the malformed-shape case as a warning row or `oauthExpiresAt: "(malformed)"`.

### [L] No route-level test for the OAuth session lifecycle
**File:** test/ui/gate-routes.test.ts (entire) ; test/openai-oauth.test.ts (entire)
**Issue:** Confirmed — there are no tests covering `/api/gate/oauth/openai/start`, `/status`, or `/cancel`. The state machine, reap timing, single-flow guard (409), and `onOauthComplete` writing through to disk are all uncovered. Regressions to any of those are unlikely to break existing tests.
**Suggestion:** Add a test that mocks `startOpenAIOAuthFlow` via the existing endpoints override, exercises start → callback → status → file on disk.

### [L] `cliProviderAddOpenAIHandler` mutual-exclusivity is asymmetric
**File:** src/cli-provider.ts:108–112
**Issue:** `if (wantOAuth && (opts.apiKey || opts.apiKeyStdin))` correctly rejects `--oauth --api-key ...` and `--oauth --api-key-stdin`, but a user who passes both `--api-key sk-...` and `--api-key-stdin` together is silently accepted: `--api-key` wins (line 121), stdin is never read, the operator's piped value is discarded.
**Suggestion:** Reject `--api-key` + `--api-key-stdin` combination explicitly.

### [L] Loopback callback Host parsing accepts `localhost:` and `[::1]:foo`
**File:** src/services/openai-oauth.ts:264–270
**Issue:** `"localhost:".split(":")` → `["localhost", ""]` → stripped `"localhost"` → returns true. Same for `[::1]:abc` (the includes check wins). Functionally harmless because the callback URL is constructed by the OAuth provider redirect, but the validator is more permissive than the doc string implies.

## Open questions
- Does Codex CLI's upstream client_id include scope rotation? If yes, the [H] refresh issue is more urgent because OpenAI's auth server probably *does* omit `refresh_token` on at least some refresh paths.
- Is the OAuth session map intended to survive a plugin hot-reload? If not, the cleanup gap in [H] is moot for the production case; if yes (the redirect port is global), it needs explicit teardown.
- Is `cancel()` ever exposed to a code path that awaits `waitForToken` afterwards? Today no — the [M] severity reflects future-proofing rather than a current bug.
