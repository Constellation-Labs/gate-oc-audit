# Correctness review — feat/AG-57-gates-setup

## Summary
The branch adds a workable `audit gate install/status/test` flow with reasonable atomic-write semantics and idempotent patch helpers. However, the probe contract is wrong against the real swarm-deck DTO (missing `machineId` will trigger a 400 before the no-op branch is reached), and the `--allow-private-host` install-time bypass is **not** persisted to config, so install will accept a URL the runtime publisher will then reject at startup. A handful of smaller issues round things out.

## Findings

### [H] Probe omits required `machineId` — every probe against a real swarm-deck instance will fail
**File:** src/services/gate-client.ts:49 (and the no-op contract claim at src/services/gate-client.ts:8-13; README also documents the wrong shape)
**Issue:** The probe POSTs `{ events: [] }`, but the gateway's `IngestRequestDto.machineId` is `@IsString()` with no `@IsOptional()` (swarm-deck/apps/gateway-proxy/src/audit-ingest/types.ts:163-165), so the global ValidationPipe will 400 before the empty-events shortcut runs.
**Repro / why it's wrong:** swarm-deck's controller (apps/gateway-proxy/src/audit-ingest/audit-ingest.controller.ts:85) only returns `{ accepted: 0, …, highestSequence }` *after* DTO validation; the runtime publisher always sends `{ machineId, events }` (src/services/gateway-publisher.ts:657-659). With the current probe, every install against a real Gate yields `http-error` 400, the installer throws `probe-http`, and `--skip-probe` becomes the only way to install — which defeats the point of the probe.
**Suggestion:** Either send `{ machineId: "<plugin-machine-id>", events: [] }` (compute the same machineId the publisher will use, e.g. from `src/util/machine-id.ts`) or treat a 400 with `"machineId"` in the body as `ok` for the purpose of "URL+key reachable". Add an explicit test that asserts the probe body shape against the gateway DTO.

### [H] `--allow-private-host` is not persisted — install accepts URLs the runtime will reject
**File:** src/services/gate-installer.ts:96-117 (and src/util/openclaw-config-writer.ts:100-167); compare src/services/gateway-publisher.ts:845-848
**Issue:** Install calls `validateGatewayUrl(url, { allowPrivateHost: input.allowPrivateHost })`, but `applyGateInstallPatch` never writes `gatewayAllowPrivateHost: true` into `plugins.entries.<id>.config`.
**Repro / why it's wrong:** Operator runs `audit gate install --url https://10.0.0.5/... --allow-private-host …` → install succeeds, config written without `gatewayAllowPrivateHost`. On next openclaw start, `createGatewayPublisher` reads `config.gatewayAllowPrivateHost === true` (false) and rejects the URL via `validateGatewayUrl`, falling back to `NoOpGatewayPublisher` — events never ship. The CLI claimed "configured" but runtime won't actually publish.
**Suggestion:** When `allowPrivateHost` is true and the validated URL host actually requires it (`isPrivateOrLinkLocalIp(host) && !isLoopbackHost(host)`), also set `plugins.entries.<id>.config.gatewayAllowPrivateHost = true` so install-time and runtime acceptance agree.

### [M] `writeOpenclawConfig` claims fsync atomicity but never fsyncs
**File:** src/util/openclaw-config-writer.ts:62-88
**Issue:** The header comment says "the new content is fsync'd to a sibling tempfile first, then rename'd over the target," but the code uses plain `writeFileSync`, which does not fsync — only the rename is atomic.
**Repro / why it's wrong:** A hard power-cut between `writeFileSync(tmp, …)` and the dirent durability point can leave the new dirent pointing at a zero-byte or truncated file on filesystems without data-ordered defaults. Most modern ext4 setups happen to work, but the comment overpromises and there's no fsync of the parent directory either, so the rename itself isn't guaranteed durable.
**Suggestion:** Either drop the fsync claim from the comment or actually fsync: open the tmp via `fs.openSync` + `writeSync` + `fsyncSync` + `closeSync`, then `renameSync`, then `fsyncSync` on the parent dir handle. Same treatment for the `.bak`.

### [M] `promptSecret` hangs forever if stdin closes mid-prompt
**File:** src/cli-gate.ts:250-282
**Issue:** The raw-mode reader subscribes to `data` only; it has no listener for `end` or `close`. If stdin is redirected from a pipe that EOFs (no newline) or the user hits Ctrl-D on an empty buffer, the promise never resolves and the command hangs indefinitely.
**Repro / why it's wrong:** `echo -n "" | openclaw audit gate install --url https://…` (interactive path taken because `isTTY` is unset only when piped — but in a real TTY with Ctrl-D the same thing happens: `read` returns 0 bytes, `data` never fires again).
**Suggestion:** Attach `stdin.once("end", …)` and `stdin.once("close", …)` to reject (or resolve `buf`) with a clear "input closed" error. Restore raw mode and detach in both branches.

### [M] `applyGateInstallPatch` force-flips `entry.enabled` to `true` unconditionally
**File:** src/util/openclaw-config-writer.ts:143-146
**Issue:** Regardless of the patch flags, `installGate` (via this helper) will always set `plugins.entries.<id>.enabled = true` if it isn't already. There is no opt-out flag.
**Repro / why it's wrong:** If an operator disabled the plugin deliberately (`enabled: false`) and runs `audit gate install` to update only the key, the install silently re-enables the plugin. The CLI claims "writes only what changed" — that includes this side effect, but the user's mental model is "install/update connection", not "force-enable plugin".
**Suggestion:** Either always force-enable but document that explicitly in `install --help` and the changes list, or gate this behind `--enable` / `--enabled` and skip if the field exists and is `false`.

### [L] `readGateStatus` broker-provider lookup picks insertion-order-first match
**File:** src/services/gate-installer.ts:184-192
**Issue:** When multiple `models.providers.*` entries share the same `baseUrl`, the first one in `Object.entries(providers)` wins and is reported as the broker.
**Repro / why it's wrong:** `Object.entries` preserves insertion order. A hand-edited config with `{ providers: { my-other-thing: { baseUrl: X }, gate: { baseUrl: X } } }` will report `brokerProviderKey: "my-other-thing"`, surprising the operator. Not a functional bug — `audit gate test` would still use the configured URL — but the status output is misleading.
**Suggestion:** Prefer `providers.gate` when present, then fall back to scanning for a URL match.

### [L] Dead `noBroker?: boolean` field in `AuditGateInstallOptions`
**File:** src/cli-gate.ts:26-29
**Issue:** The interface declares both `broker?: boolean` and `noBroker?: boolean`, but Commander turns `--no-broker` into `broker: false`. `noBroker` is never read.
**Suggestion:** Delete the `noBroker` field; keep the doc comment on `broker`.

### [L] `.bak` written with default mode while tmp+main use 0o600
**File:** src/util/openclaw-config-writer.ts:74
**Issue:** `writeFileSync(${path}.bak, prior)` omits the `mode` argument, so the backup is created with the process default (typically 0o644 after umask), while the new config is written 0o600. The `.bak` contains the API key.
**Repro / why it's wrong:** Even though the main file was 0o600, a fresh `.bak` may be world-readable on a freshly created `~/.openclaw`. Out-of-scope for correctness strictly, but it does mean the file modes differ across the two files the same writer produces, which is surprising.
**Suggestion:** `writeFileSync(${path}.bak, prior, { mode: 0o600 })`.

### [L] `renameSync` over a symlinked config replaces the symlink with a regular file
**File:** src/util/openclaw-config-writer.ts:84
**Issue:** If `~/.openclaw/config.json` is a symlink (some operators dotfile-manage it that way), `renameSync(tmp, path)` replaces the symlink with the regular file, breaking the dotfile-management link.
**Suggestion:** Optional: if `lstatSync(path).isSymbolicLink()`, resolve the target via `realpathSync` and write through to that.

### [L] Idempotency test does not re-read from disk
**File:** test/gate-installer.test.ts:244-262
**Issue:** The "second install is a no-op" assertion only checks `second.changes`, not that the file mtime / `.bak` are unchanged.
**Repro / why it's wrong:** `installGate` already has the guard `if (changes.length > 0)` before writing, so this aligns with the property the caller cares about. But the test claim ("second install is a no-op") implies disk-level idempotency, which the test doesn't actually exercise — a regression that moves the guard could pass this test.
**Suggestion:** Capture `statSync(report.configPath).mtimeMs` after first install and assert it is unchanged after the second, and assert `existsSync(${path}.bak) === false` after a second install on a fresh dir.

### [L] Multi-byte UTF-8 split across `data` chunks could corrupt the secret in raw-mode prompt
**File:** src/cli-gate.ts:252-279
**Issue:** `chunk.toString("utf8")` per `data` event will produce replacement chars if a multi-byte sequence is split across two reads. Unlikely on a TTY, but possible.
**Suggestion:** Buffer raw bytes and decode with `StringDecoder("utf8")` to handle continuation bytes.

## Open questions
- I could not confirm what swarm-deck's response is for `{ events: [] }` *without* `machineId` — I inferred a 400 from the DTO decorators and the global ValidationPipe convention. If the gateway happens to be deployed with `transform: true, skipMissingProperties: true` (or similar), the empty-events branch might still be reached. Worth a one-shot curl against a staging Gate to confirm before merging.
- Commander's `parseAsync` flow with `process.exitCode = 1` was not directly observed in the openclaw-loader source I read (no `parseAsync` / `process.exit` appears in `loader-DkTFEskE.js`). The host could conceivably override the exit code via a `try/catch` wrapper. The handlers as written *set* `exitCode` correctly, but whether the openclaw harness honors it (vs. resetting to 0 on a clean return) is not verifiable from this repo alone.
- `resolveOpenclawDir` falls back to `resolve(".", ".openclaw")` when `$HOME` is unset (src/util/openclaw-paths.ts:10). That means under an unusual environment (some CI runners) install would write `./.openclaw/config.json` relative to the current working directory. Probably fine, but worth confirming the install CLI shouldn't refuse to proceed in that case.
