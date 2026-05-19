# Security review — feat/AG-57-gates-ui

## Summary
The new `/api/gate/*` routes correctly carry forward PR 1's input-validation
guards (URL/userinfo, API-key allowlist, redirect-manual probe, status
redaction, `--url`-without-key exfil block). The main exposure is CSRF: the
new credential-write endpoints inherit the same browser-reachable loopback
posture as the existing audit UI and the plugin does not check
`Origin`/`Sec-Fetch-Site` or require a non-simple `Content-Type`. A page in
the operator's browser can therefore redirect their Gate config to an
attacker-controlled host without any user interaction, which materially
escalates the impact of the pre-existing CSRF gap from "read-only metadata
exfil" to "persistent credential redirection + LLM-broker MITM".

## Findings

### [H] CSRF on `/api/gate/install` lets a webpage overwrite Gate config (persistent credential redirection)
**File:** src/ui/routes.ts:703-747 (no Origin / Sec-Fetch / Content-Type check; `readJsonBody` parses any body), plus the pre-existing TODO at src/ui/routes.ts:1-5
**Threat:** Any tab the operator opens can overwrite `gatewayUrl`, `gatewayApiKey`, `models.providers.gate.{baseUrl,apiKey}`, the plugin allowlist entry, the conversation-access hook (`grantConversationAccess: true`, see src/services/gate-installer.ts:138-147), and `enabled: true` — silently re-pointing audit egress, the model broker, and the LLM-input/output hook to an attacker-controlled Gate.
**Issue:** A cross-origin `fetch("http://127.0.0.1:<port>/plugins/audit/api/gate/install", {method:"POST", headers:{"Content-Type":"text/plain"}, body: JSON.stringify({url:"https://evil.example/", apiKey:"anything", skipProbe:true})})` is a CORS "simple request" (no preflight). The route reads the body with no Content-Type or Origin check (src/ui/routes.ts:157-170, 718-720), `installGate` validates the URL/key syntactically (both attacker-controlled), and the operator's `~/.openclaw/config.json` is atomically rewritten. `skipProbe: true` removes any guardrail; even without it, the attacker's own host responds 200 to the probe. Loopback exposure on dev machines (Tailscale, ssh `-L`, docker port-forward) widens the reach. The same pre-existing TODO note at line 1 calls out "no verification" — but the surface this PR adds is now credential-write, not just metadata-read.
**Suggestion:** Require a non-simple Content-Type (reject anything other than `application/json`) AND check `Origin`/`Sec-Fetch-Site` against an allowlist (loopback origins, or the same-origin Audit UI). A double-submit token in a cookie/header would also work but is heavier than needed for a loopback UI.

### [M] `/api/gate/test` is also CSRF-reachable; the saved-key guard prevents exfil but the route still drives operator-side outbound HTTP to attacker URLs
**File:** src/ui/routes.ts:638-699
**Threat:** A webpage can make the operator's host emit `POST https://attacker/api/v1/audit/ingest` with attacker-supplied API key — a stepping-stone for SSRF-from-loopback fingerprinting (timing, internal-host enumeration) or for laundering outbound HTTP through the operator's egress.
**Issue:** Same simple-request CSRF gap as `/install`. PR 1's "url override requires apiKey" guard (lines 658-665) does correctly prevent the *saved* key from being sent to an attacker URL (verified: `apiKey: ""` is falsy → guard fires; whitespace-only is caught later by `validateApiKeyOrThrow`), so credential exfil is blocked, but the SSRF surface remains. `normalizeAndValidateUrl(url, false)` (line 687) constrains the destination to public `https://` hosts (loopback/private blocked by default) which narrows but does not eliminate the SSRF reach — public-internet hosts can still be probed.
**Suggestion:** Fix together with the H finding above; once Content-Type/Origin gating is in place this collapses.

### [M] No CSRF defense on existing `/api/verify` and `/api/export` — pre-existing, but the new routes raise the bar enough that documenting + fixing is worth a single sweep
**File:** src/ui/routes.ts:399-440 (POST /verify), 443-498 (GET /export)
**Threat:** A webpage can trigger heavy CPU/DB work on the operator's host (DoS) and, for `/export`, scrape raw audit content if `?includeContent=true`. Already noted in the existing TODO and gated behind `allowExportOnNonLoopback`/`allowVerifyOnNonLoopback`, but on a default loopback bind a malicious browser tab can still reach them.
**Issue:** Same root cause as the H finding — no Origin/Sec-Fetch check, simple POST allowed via `Content-Type: text/plain`.
**Suggestion:** Centralize the CSRF check in `handleApi` so all mutating + content-bearing routes share it.

### [L] README warning understates the browser-reachability risk on loopback
**File:** README.md:53
**Threat:** Operator may believe "loopback default" means "safe from browser-driven attack".
**Issue:** The README mentions the non-loopback opt-in but does not say that even on loopback, a tab in the operator's browser can post to the gateway port. The pre-existing TODO at src/ui/routes.ts:1-5 acknowledges this internally; the README does not.
**Suggestion:** Add one sentence: "These endpoints are also reachable by JavaScript in any tab open in the operator's browser; until the CSRF gap is closed, treat any browser session on the audit host as trusted for writing Gate config."

### [L] Audit UI sends no `X-Frame-Options` / `Content-Security-Policy` — clickjacking + UI-redress against the Gate tab
**File:** src/ui/routes.ts:759-775 (static handler), src/util/asset-server.ts (not modified in this PR — pre-existing)
**Threat:** A malicious page can iframe `/plugins/audit/#/gate` and use UI redress to trick the operator into clicking "Install" with attacker-prefilled form values. Less severe than the H above because the form does need to be filled, but a transparent-iframe overlay is the classic vector.
**Suggestion:** Set `X-Frame-Options: DENY` (and a basic CSP `frame-ancestors 'none'`) in the static asset response and in `sendJson`. Single one-line change at most.

### [L] `audit-gate-routes` URL input lacks `autocomplete="off"`
**File:** src/control-ui/components/gate-setup.ts:225-228
**Threat:** Browsers may store the Gate URL in cross-site autofill suggestions — minor leakage of which Gate host the operator uses.
**Issue:** `type="text"` with no autocomplete attribute; the API-key field correctly sets `autocomplete="off"` (line 232) but the URL field doesn't.
**Suggestion:** Add `autocomplete="off"` on the URL input for consistency.

## Verified safe
- **`/api/gate/status` does not leak the API-key value.** `readGateStatus` (src/services/gate-installer.ts:189-254) returns `hasApiKey: boolean` only; the test at test/ui/gate-routes.test.ts:120-139 explicitly asserts the response text never contains the installed key.
- **`--url` override without `apiKey` is rejected (PR 1's exfil block carried over).** src/ui/routes.ts:658-665. Empty-string `apiKey: ""` is caught by the `!apiKey` falsy check; whitespace-only `apiKey: "  "` bypasses that check but `validateApiKeyOrThrow` (src/services/gate-installer.ts:78-85) trims and rejects "empty". Critically, the saved key is only loaded via `readSavedApiKey` in the no-override fallback branch (line 666-681), so a body with both `url` and `apiKey` present never touches the saved key.
- **URL validation rejects userinfo, non-http(s) protocols, numeric IP encodings, and plain-http to non-loopback.** `normalizeAndValidateUrl` + `validateGatewayUrl` (src/services/gate-installer.ts:52-76, src/services/gateway-publisher.ts:198-220). The route calls both validators before passing to `installGate`/`probeGate`.
- **`isNonLoopback` is evaluated at request time, not stale at registration time.** Stored as a function in `AuditUiContext` (src/ui/routes.ts:53-79) and invoked per request at the 403 gates (lines 400, 444, 517, 587, 639, 704). src/index.ts:708 passes `() => resolveGatewayBaseUrl().nonLoopback`, re-resolved each call.
- **64 KB request-body cap applies to the new routes.** `readJsonBody` (src/ui/routes.ts:157-170) checks `total > MAX_JSON_BODY_BYTES` and is the only body reader used by `/api/gate/{install,test}`.
- **Prototype pollution via JSON `__proto__` keys is a non-issue.** `JSON.parse('{"__proto__":{...}}')` sets `__proto__` as an own property, not as the actual prototype. The routes use plain `b.url` / `b.apiKey` accesses on the parsed object; nothing reaches `Object.prototype`.
- **Probe response body is sanitized before being echoed.** `safeText` (src/services/gate-client.ts:78-86) applies `sanitizeForLog` which strips CR/LF/ANSI before the body is returned in the JSON response, eliminating CRLF/log-injection / header-splitting vectors via attacker-controlled probe bodies. Final response goes through `JSON.stringify` anyway, which escapes control chars.
- **`redirect: "manual"` on the probe blocks SSRF redirect chains.** src/services/gate-client.ts:50-59 — a hostile Gate cannot 302 the probe (with `X-Gateway-Api-Key`) to a private SSRF target.
- **The Lit form does not log the API key anywhere.** No `console.log`, `localStorage`, `sessionStorage`, `postMessage`, or URL-hash writes touch `this.apiKey`. `runInstall` clears it on success (line 207). The `<input type="password">` field has `autocomplete="off"` (line 232).
- **The form-typed API key is not exfiltrated to the server when the user only clicks "Test connection" against the saved URL.** `runTest` (lines 163-187) sends an empty body `{}` unless the URL field has been edited away from `status.url`. Server falls back to the saved key only in that case (route lines 666-681).
- **`registerBroker` defaults to true when omitted from the request body** (route line 729: `b.registerBroker !== false`) — matches CLI behavior; the Lit form always sends the flag explicitly, so the only difference an attacker gets is "broker is also installed by default", which the H finding already captures.
- **No user-controlled data flows into response headers.** All `setHeader` calls in routes.ts use fixed strings or values derived from validated input; error messages go into the JSON body, not headers, so header-injection via reflected keys/URLs is not reachable.
