# Security review — feat/AG-57-openai-oauth

## Summary
The PKCE OAuth flow against `auth.openai.com` is implemented with the right shape: CSPRNG state/verifier, S256 challenge, manual-redirect token exchange, `redirect: "manual"`, atomic 0o600 config writes, and CSRF guards (`requireSameOriginJsonPost`) on every mutating route. No credentials are echoed by `/api/gate/providers` GET or `/oauth/.../status`. The most material findings are (1) the `isLoopbackHostHeader` check has two regex-bypasses (defense-in-depth only — listener is bound to 127.0.0.1 so they aren't network-reachable), and (2) the OAuth `/cancel` route does not honour `allowGateMutationOnNonLoopback`. Nothing exploitable for credential theft was found.

## Findings

### [M] `isLoopbackHostHeader` `includes("[::1]")` allows Host-header bypass
**File:** src/services/openai-oauth.ts:262-272
**Threat:** A misconfigured upstream proxy or future change that lets the listener bind beyond 127.0.0.1 would let an off-host attacker pass the Host-header guard by sending `Host: evil.com[::1]`, since the final fallback `h.includes("[::1]")` matches anywhere in the string.
**Issue:** The fallback is a substring search, not an anchored equality test — port-strip on `evil.com[::1]` yields `evil.com[`, fails the localhost/127/`::1` checks, then the `includes` catch-all returns true. Also `split(":")[0]` on a raw `::1` Host yields `""`, so legitimate raw `::1` Hosts fail.
**Suggestion:** Parse Host with `URL` (using a dummy scheme) and compare the resulting hostname against an allow-set of `localhost`, `127.0.0.1`, `[::1]`; drop the substring fallback.

### [M] `/api/gate/oauth/openai/<sid>/cancel` skips the `allowGateMutationOnNonLoopback` gate
**File:** src/ui/routes.ts:1019-1031
**Threat:** When the audit gateway is bound beyond loopback and the operator has not set `allowGateMutationOnNonLoopback`, a CSRF-bearing same-origin caller can still cancel a pending OAuth flow that another local operator initiated. Blast radius is annoyance (forces the operator to restart the flow), not credential theft.
**Issue:** `start`, the API-key `POST /providers`, and `DELETE /providers/:key` all carry the non-loopback gate, but `/cancel` only carries `requireSameOriginJsonPost`. Inconsistent posture.
**Suggestion:** Mirror the same gate on `/cancel` (and consider it on `/status` GET too, though that one only reads state).

### [L] `configPath` returned in OAuth status leaks the operator's home path
**File:** src/ui/routes.ts:1014, 1059-1064
**Threat:** A successful-status response includes `configPath` (e.g. `/home/alice/.openclaw/config.json`), which discloses the OS username to anyone who can read same-origin responses from the SPA.
**Issue:** The UI does not display this; it's used only for the success message. The same field is already returned by `/api/gate/install`, so this is consistent with existing posture — flag for completeness.
**Suggestion:** None required; if you ever serve the UI to a less-trusted operator, redact to a relative path.

### [L] Write-error messages from the post-OAuth config write surface in the status response
**File:** src/ui/routes.ts:1065-1067 + src/util/openclaw-config-writer.ts:135,142
**Threat:** If `writeOpenclawConfig` throws (EACCES, ENOSPC, symlink-realpath failure), the error message — which contains the absolute file path — is stored on `session.status.message` and returned by `/status`. Tokens are **not** in the message (the writer wraps `(e as Error).message` from the underlying syscall, never the JSON contents), so this is a path-disclosure parallel to the finding above, not a token leak.
**Issue:** Same class as the configPath disclosure; documented here so a future reviewer doesn't have to re-trace.
**Suggestion:** None; the path is already in other responses.

### [L] `evil.com[::1]` / similar trick Hosts pass loopback check (defense-in-depth)
**File:** src/services/openai-oauth.ts:270 — duplicate of the M-rated finding above
**Threat:** Same root cause — flagged separately because it also masks a benign bug: raw `Host: ::1` (no brackets) is *rejected*, contradicting the inline comment "accept both raw `::1` and after bracket-strip".
**Issue:** `"::1".split(":")[0]` is `""`, not `::1`.
**Suggestion:** Same fix as the M finding.

## Verified safe

- **CSPRNG state and PKCE verifier.** Both are 32-byte `randomBytes` → base64url, yielding 43-char strings. `timingSafeEqual` over equal-length buffers is used for the state comparison (src/services/openai-oauth.ts:75-77, 274-279).
- **Missing/empty `state` and `code` in callback.** `searchParams.get` returns `null`; the `!code` / `!state` truthiness checks reject both `null` and `""` before the timing-safe compare (src/services/openai-oauth.ts:201-207).
- **Token exchange `redirect: "manual"`.** A 3xx from the token endpoint becomes an opaque-redirect Response with `ok: false`, falling into the `!res.ok` branch and producing a clean error — no silent follow (src/services/openai-oauth.ts:219-231).
- **Tokens / authorization codes are not logged.** Grep for `console.log` / `log.*` shows the OAuth module emits nothing. The route-level `log.warn` at src/ui/routes.ts:1173 logs `apiPath` (pathname only — no query, no body), so the code/state/token never reach the logger even on a thrown error.
- **`safeBodyText` truncates and strips control chars.** Token-endpoint error bodies are capped at 500 bytes and stripped of `\x00-\x1f\x7f` before being concatenated into an error message (src/services/openai-oauth.ts:285-295). Even if the upstream echoed the verifier/code, the message lands on `session.status` (loopback-only) and never on the disk-bound config.
- **`requireSameOriginJsonPost` covers every new mutating route.** Confirmed for POST /api/gate/providers (line 904), DELETE /api/gate/providers/:key (line 944), POST /api/gate/oauth/openai/start (line 969), POST /api/gate/oauth/openai/:sid/cancel (line 1020). Content-Type, Origin=Host, and Sec-Fetch-Site checks all pass.
- **`allowGateMutationOnNonLoopback` covers POST /providers, DELETE /providers/:key, and /oauth/start.** Verified at routes.ts:900, 940, 965. (Cancel is the gap — see M finding.)
- **`apiKey` body validation.** `bodyStr` returns `undefined` for non-string, empty, or whitespace-only inputs; the additional `/\s/.test(apiKey)` at routes.ts:918 rejects internal whitespace too. Tested in test/ui/gate-routes.test.ts:538-545.
- **DELETE /api/gate/providers/:key path traversal.** The key is used only as an object-property name in `removeProviderEntry` → `delete providers[providerKey]` (openclaw-config-writer.ts:404). `delete obj["../"]` on a plain JSON object cannot escape to siblings — JavaScript object-property access has no path semantics. Confirmed `gate` is also explicitly refused (line 397-399).
- **`tryOpenBrowser` argv-form spawn.** `spawn(cmd, [url], …)` is invoked without `shell: true`, so the URL is passed as a single argv slot regardless of metacharacters. The `^https://` guard is belt-and-braces (cli-provider.ts:250-258).
- **`window.open` with `noopener,noreferrer`.** Confirmed at src/control-ui/components/provider-panel.ts:160; the OAuth authorize link in the pending-status block also carries `rel="noopener noreferrer"` (line 292).
- **`/api/gate/providers` GET redaction.** No `apiKey` or refresh-token field is included; only `key`, `baseUrl`, `auth`, `hasApiKey`, `oauthExpiresAt` (routes.ts:877-892). Covered by an explicit `assert.equal(text.includes("sk-test-aaaa"), false)` test at test/ui/gate-routes.test.ts:526.
- **`/oauth/.../status` response shape.** Returns `kind`, plus per-kind fields `authUrl`/`startedAt`, `configPath`/`providerKey`/`expiresAt`, or `message`. No `accessToken` or `refreshToken` (routes.ts:166-169, 1014).
- **Refresh token storage at-rest.** Persisted under `models.providers.<k>.openclawAudit.oauth.refreshToken` via the same atomic 0o600 writer used in PR 1 (openclaw-config-writer.ts:96-151, 364-376). `.bak` snapshot is also 0o600.
- **Concurrent-flow guard.** `/start` walks the session map and rejects with 409 only when an existing session is in `pending` state (routes.ts:971-976); `error`/`complete` sessions are skipped, matching the intent.
- **API-key entry hardening in UI.** `<input type="password" autocomplete="off">` (provider-panel.ts:227-230); the value is POSTed once and never written to `window.location`, console, or localStorage.
- **Mock OAuth provider in tests.** Listeners bind ephemeral ports on 127.0.0.1 and are closed in `finally` blocks. No global state mutation, no listeners leaked between tests.
- **OAuth client_id rotation risk.** README:64-77 documents the third-party client_id risk and the env-var override path, satisfying the threat-model item.

## Open questions

- Does Node's undici treat a `Set-Cookie` from the token endpoint specially with `redirect: "manual"`? Not investigated — token exchange is a one-shot POST and the response isn't piped anywhere stateful, so even if a cookie were attached it would be dropped at function exit.
- The `/api/gate/oauth/openai/<sid>/status` endpoint isn't rate-limited; an attacker who reaches loopback could poll at high frequency. Same posture as existing GET endpoints; not changed by this PR.
