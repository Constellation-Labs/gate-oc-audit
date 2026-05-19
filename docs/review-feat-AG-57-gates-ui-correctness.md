# Correctness review — feat/AG-57-gates-ui

## Summary
Three new HTTP routes plus a Lit component to drive them. Route ordering and `apiPath` matching are clean (exact-equality blocks, no overlap with existing `events/*`/`report/*` handlers). The exfil guard (`urlOverride && !apiKey`) is in place and the non-loopback gate is consistent with sibling endpoints. The most consequential correctness issues are: (1) `/api/gate/test` hardcodes `allowPrivateHost: false` so a Gate installed on an RFC1918 / link-local URL cannot be re-tested from the UI even though `audit gate test --allow-private-host` would work; (2) the `GateInstallResponse.probe` client union claims four failure values that the server can never emit (install throws → 400 on probe failure), making the typed shape misleading; and (3) the install path lacks any test that exercises `registerBroker: false` actually skipping the broker write, the probe-failure path, or that GET /status reports the full populated shape.

## Findings

### [M] `/api/gate/test` hardcodes `allowPrivateHost: false`; cannot re-probe a private-host Gate
**File:** src/ui/routes.ts:687
**Issue:** The route calls `normalizeAndValidateUrl(url, false)` unconditionally, so any saved Gate URL that points at a private/link-local host (10.x, 192.168.x, fc00::/7, etc.) — which `audit gate install --allow-private-host` deliberately accepts — will be rejected with `400 invalid-url` when the operator clicks "Test connection" without typing anything.
**Repro / why it's wrong:** Install via CLI: `audit gate install --url http://10.0.0.5:8080 --api-key sk-gw-… --allow-private-host`. Open the UI Gate tab and click "Test connection". The route hits the fallback path, reads `status.url = "http://10.0.0.5:8080"`, then `normalizeAndValidateUrl(..., false)` rejects with `private-host`. The CLI counterpart `cliGateTestHandler` (src/cli-gate.ts:211) threads `opts.allowPrivateHost === true` through. The UI route loses this knob; the `GateInstallRequest` client type exposes `allowPrivateHost` for install but the test client (api.ts:191) and route do not.
**Suggestion:** Accept `allowPrivateHost?: boolean` in the test body and forward it to `normalizeAndValidateUrl`, or read the operator's saved `allowPrivateHost` flag from config and re-use it for the fallback path.

### [M] `GateInstallResponse.probe` union advertises four states the server can never return
**File:** src/control-ui/api.ts:208, src/ui/routes.ts:737, src/services/gate-installer.ts:113-130
**Issue:** The typed client union is `"ok" | "unauthorized" | "http-error" | "network-error" | "skipped"`, but `installGate` throws `GateInstallError` for any probe that returns `unauthorized`, `network-error`, or `http-error` (gate-installer.ts:113, 119, 125). Those three values can never appear on a 200 response — the route's catch turns them into a 400. In practice the server only ever sends `probe: "ok"` or `probe: "skipped"`.
**Repro / why it's wrong:** Send `POST /api/gate/install` with `skipProbe: false` against a mock Gate that returns 401. The route returns 400 with body `{ "error": "Gate rejected the API key (HTTP 401)..." }`, never 200 with `probe: "unauthorized"`. The renderInstallResult helper in gate-setup.ts:285 prints `Probe: ${r.probe}` and will only ever see `ok` / `skipped`.
**Suggestion:** Tighten the client union to `"ok" | "skipped"` and drop the unreachable variants, or change the route to return 200 with the failure kind instead of converting probe failures to 400. (The status-quo CLI behaviour is "probe failure aborts the install" — keeping the type narrow is the lower-risk fix.)

### [M] `apiKey: ""` in body of `/api/gate/install` returns "url and apiKey are required" instead of the empty-key validator's error
**File:** src/ui/routes.ts:719-723
**Issue:** Body coercion is `const apiKey = typeof b.apiKey === "string" ? b.apiKey : "";`. An explicitly empty string (or omitted field) both end up at `""` and fall into the generic `"url and apiKey are required"` 400. That's correct for the omitted case but means a literal empty submission can't be distinguished from a missing field — the CLI surfaces this via `validateApiKeyOrThrow`'s explicit "Gate API key rejected: …" message.
**Repro / why it's wrong:** Send `{ "url": "https://x.example", "apiKey": "" }`. Server replies 400 "url and apiKey are required" even though the client did supply `apiKey`. Minor UX inconsistency; not a vulnerability.
**Suggestion:** Distinguish "field missing/wrong type" from "field present but blank" — let the latter flow into `validateApiKeyOrThrow` for the canonical error string.

### [M] Test/install route accepts whitespace-only `apiKey` past the exfil guard
**File:** src/ui/routes.ts:655-658
**Issue:** The guard is `if (urlOverride && !apiKey)`. JS `!"   "` is `false`, so a body like `{ "url": "https://attacker.example", "apiKey": "   " }` bypasses the exfil-guard 400. Execution proceeds to `validateApiKeyOrThrow` which trims to `""` and throws `invalid-api-key` → 400. Outcome is still a 400, but the error message no longer says "url override requires apiKey" — it says "Gate API key rejected" — which obscures the actual policy violation in operator logs.
**Repro / why it's wrong:** The CLI counterpart (cli-gate.ts:169) runs `resolveApiKeyFromOptsOrEnv` which `.trim()`s before the `urlOverride && !apiKey` check, so it produces the policy-violation message correctly. The route trims later. End result: same status code, different error message → drift between CLI and HTTP surfaces.
**Suggestion:** Trim the body-provided `apiKey` once at parse time (matching the CLI), so the exfil guard sees the post-trim value.

### [L] `url = url ?? status.url` silently passes through an empty-string body `url`
**File:** src/ui/routes.ts:672
**Issue:** Nullish coalescing only triggers on `null`/`undefined`; an empty-string `url` from the body short-circuits `?? status.url`. The next check (`!url || !apiKey`) catches it and 400s with "could not resolve URL or API key" — so the bug is benign — but the error message is misleading (the operator did supply a key, just an empty URL).
**Repro / why it's wrong:** `{ "url": "", "apiKey": "sk-gw-…" }` → 400 "could not resolve URL or API key" despite the saved URL being available. The user-intent reading would be "fall back to saved URL".
**Suggestion:** Treat empty-string URL the same as missing: `urlOverride = typeof b.url === "string" && b.url.trim() !== "" ? b.url : undefined`.

### [L] `b.registerBroker !== false` accepts truthy non-boolean values without validation
**File:** src/ui/routes.ts:729
**Issue:** The default-to-true semantics means `null`, `"false"`, `0`, `"true"`, `[]`, `{}` all silently produce `registerBroker: true`. Only the literal boolean `false` skips broker registration.
**Repro / why it's wrong:** A client that posts `{ "registerBroker": "false" }` (stringified) will unexpectedly write the broker provider into config — wide of the principle of least surprise. The Lit component always sends a real boolean so this is theoretical, but the route is a public-shape contract.
**Suggestion:** Either require `b.registerBroker === true || b.registerBroker === false` (reject other types with 400) or document the loose coercion in the README.

### [L] Lit `loadStatus` won't refresh the URL field after install if the operator already typed one
**File:** src/control-ui/components/gate-setup.ts:175-177
**Issue:** `if (this.status.url && !this.url) this.url = this.status.url;`. After install, `runInstall` calls `loadStatus()`. By then `this.url` is the value the operator typed (e.g. `http://10.0.0.5:8080`). If `normalizeAndValidateUrl` rewrote it (today it only trims, but the trim *does* drop trailing whitespace), the form will continue to display the un-normalised input while the saved config has the normalised form.
**Repro / why it's wrong:** Type `  https://gate.example.com/  ` into the URL field. Install succeeds; saved URL is `https://gate.example.com/`. Form still shows the leading whitespace. Cosmetic only — install was correct.
**Suggestion:** After a successful install, set `this.url = installResult ?? this.status.url` so the field reflects the canonical saved value.

### [L] `runTest` treats any typed URL as an override when status hasn't loaded yet
**File:** src/control-ui/components/gate-setup.ts:198-201
**Issue:** `const savedUrl = this.status?.url; const usingOverride = overrideUrl !== "" && overrideUrl !== savedUrl;`. If `loadStatus` errored or is still in flight, `savedUrl` is `undefined`, so any non-empty `overrideUrl` is treated as override → requires a typed API key. This is safe-fail (no exfil possible), but the error message ("URL override requires an API key…") is misleading when the operator's intent was "test the saved config".
**Repro / why it's wrong:** With a flaky load-status call, the operator clicks Test → gets a confusing error. The server-side guard would catch the real exfil case anyway.
**Suggestion:** When `this.status` is undefined or `statusError` is set, surface "status not loaded — refresh and try again" instead of falling through to the override branch.

### [L] Test coverage gaps
**File:** test/ui/gate-routes.test.ts
**Issue:** Missing cases noted in the brief that would catch regressions of the above findings:
- No assertion that `{ registerBroker: false }` actually omits `models.providers.gate` from the written config — the existing install test only checks `gatewayUrl`.
- No test for the install probe-failure path: 401 mock Gate → expected 400 with the gate-installer error message. Currently the only probe success is exercised via `/test`, not `/install`.
- No test that `GET /api/gate/status` returns the full populated shape (configPath string, configured=true, hasApiKey=true, allowlisted, conversationAccess, brokerProviderKey) after a real install — only the `hasApiKey` boolean and `url` are asserted, so a regression in `readGateStatus` (e.g. losing `allowlisted` or `brokerProviderKey`) would slip past.
- No coverage of the `--allow-private-host` story for the test endpoint (relevant once the M finding above is fixed).
**Suggestion:** Add four targeted cases.

### [L] Test rig depends on real local TCP for the probe path (low flake risk on shared CI)
**File:** test/ui/gate-routes.test.ts:60-72, 79-92
**Issue:** Two real loopback servers per test (one for routes, one for the mock Gate). Each calls `listen(0, "127.0.0.1")` to grab an ephemeral port. There's no port collision risk (kernel allocates), but each test allocates/releases two ports and one tmp dir; running the suite in parallel against many cores can exhaust ports under stress (`EADDRINUSE`-on-close lingers in TIME_WAIT). Probably fine for CI but worth flagging.
**Suggestion:** None — the test design is reasonable; just be aware if CI flakes appear.

## Open questions

- The `GateInstallResponse.probe` client union: is the intent to evolve the route into returning 200 with the probe kind on failure (and let the UI render it), or to keep the throw-on-probe-failure CLI semantics? Today the type asserts the former while the code implements the latter.
- Should the test route accept `allowPrivateHost` (and `skipProbe`?) the way the install route does, or read those flags from the saved config? The CLI exposes both via flags; the UI form exposes only the install side.
- README claims "the same shape as `audit gate status --json`" — confirmed by reading both code paths (both emit `JSON.stringify(readGateStatus(...))` verbatim), but a snapshot test would lock it down.
