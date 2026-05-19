# Code-quality review — feat/AG-57-gates-setup

## Summary
The branch adds a clean, well-factored `audit gate {install,status,test}` flow split across a writer, an installer, a probe client, and a CLI module. Naming is clear, comments mostly explain WHY, and the writer's idempotent dotted-path-change reporting is a nice touch. A handful of small issues stand out: a dead option field, an unhandled-rejection path in interactive Ctrl-C, a duplicated `isObject` helper, and a thin spot in CLI-layer test coverage.

## Findings

### [M] Ctrl-C during interactive secret prompt becomes an unhandled rejection
**File:** src/cli-gate.ts:52-66
**Issue:** `promptSecret` rejects with `new Error("aborted")` on Ctrl-C, but the call site only wraps it in a `try { ... } finally { rl.close(); }` with no catch — the outer `try` (line 68) only wraps `installGate(...)`, so the rejection escapes `cliGateInstallHandler` unhandled.
**Suggestion:** Catch the abort inside the interactive block (or widen the outer try to cover prompting), set `process.exitCode = 130`, and return cleanly.

### [M] Dead/misleading `noBroker` field on `AuditGateInstallOptions`
**File:** src/cli-gate.ts:29-30
**Issue:** Commander turns `--no-broker` into `opts.broker = false`, and the handler reads `opts.broker !== false`. The separately-declared `noBroker?: boolean` field is never read and never set — its presence implies the handler honors it.
**Suggestion:** Drop `noBroker` from the interface; the JSDoc above it can move onto `broker?`.

### [M] No test coverage for `applyBrokerProviderPatch` idempotency or URL-switch behavior
**File:** test/gate-installer.test.ts:118-149
**Issue:** The patch is tested for the empty-config case and the custom-key case, but not for re-applying the same patch (should be a no-op) or for changing `baseUrl` on an existing entry. `applyGateInstallPatch` has both of those tests; the broker patch should match.
**Suggestion:** Add one idempotency test and one "switch baseUrl" test that mirrors the existing pattern.

### [L] `isObject` helper duplicated in three files
**File:** src/cli-gate.ts:222-224, src/services/gate-installer.ts:205-207, src/util/openclaw-config-writer.ts:91-94 (inline)
**Issue:** Three near-identical predicates for "is a plain JSON object" — one is named `isObj`, the other `isObject`. The writer module already exports `JsonObject`; co-locating the predicate next to that type would let the other two import it.
**Suggestion:** Export `isJsonObject` (or similar) from `openclaw-config-writer.ts` and reuse.

### [L] `readApiKeyFromConfig` silently swallows config-read errors
**File:** src/cli-gate.ts:217-219
**Issue:** The `catch {}` collapses both "config doesn't exist" and "config is malformed JSON" into the same undefined return, which downstream becomes the generic "could not resolve URL or API key" message — an operator with a broken config gets a misleading diagnostic.
**Suggestion:** Let the error propagate (the outer `cliGateTestHandler` has no try/catch around this call today, so introduce one) and surface the real reason via `handleError`.

### [L] `parseTimeout` silently swallows invalid input
**File:** src/cli-gate.ts:226-231
**Issue:** `--timeout-ms abc` returns `undefined`, which falls through to the 10 s default. An operator who fat-fingered the value gets no feedback.
**Suggestion:** Either throw a `GateInstallError("invalid-timeout", …)` or print a warning via `errLine` before returning `undefined`.

### [L] CLI handlers have no direct tests
**File:** test/gate-installer.test.ts (whole file), src/cli-gate.ts (whole file)
**Issue:** `cliGateInstallHandler`, `cliGateStatusHandler`, and `cliGateTestHandler` are tested only indirectly via the underlying services. Specifically, the `--no-broker`/`--yes`/`--json` branches in `cliGateInstallHandler` have no coverage, and `cliGateTestHandler`'s "override URL but no key" branch (line 145-154) isn't exercised.
**Suggestion:** Add a small handler-level test file that captures stdout/stderr and asserts the JSON output shape for at least the happy `install --json --skip-probe` path and the `test --json` path.

### [L] `safeText` truncation uses a U+2026 character
**File:** src/services/gate-client.ts:67-68
**Issue:** Body truncation appends `"…"` (single horizontal-ellipsis code point). Harmless, but the rest of the repo uses ASCII `...` in CLI messages and JSON shapes, so this is a one-off.
**Suggestion:** Use `"..."` for consistency, or document why the codepoint matters.

### [L] Module-level docstring in `gate-client.ts` is a free-floating comment, not a JSDoc on an export
**File:** src/services/gate-client.ts:1-13
**Issue:** The large doc block sits above the first `const`, not above `probeGate`. Editors/IDEs surface the JSDoc on `probeGate` instead — which is shorter and less informative.
**Suggestion:** Either move the rationale onto `probeGate`'s JSDoc, or convert it into a `/** @file ... */` block.

### [L] `applyBrokerProviderPatch` JSDoc says it "leaves models[] empty" but the installer wires it up "separately" — that follow-up doesn't exist yet
**File:** src/util/openclaw-config-writer.ts:182-186
**Issue:** The comment refers to a "live model-list probe … the installer wires up separately." There's no such wiring on this branch. The comment is forward-looking and reads as if it were already implemented.
**Suggestion:** Reword to "future work: a model-list probe will populate this; today it's an empty array operators fill in by hand."

## What's good
- Three-layer split (writer / installer / client / CLI) is clean and matches the repo's existing service-shape convention.
- `applyGateInstallPatch` returning a list of changed dotted-path keys instead of a boolean is a genuinely useful UX choice — the `+ key` output is much better than "wrote config".
- Atomic write with `.bak` snapshot + sibling tempfile + `renameSync`, mode `0o600`, is the right choice for a file that holds an API key. The "no-op when no changes" gate (gate-installer.ts:121) avoids spamming `.bak` files on re-runs.
- `normalizeAndValidateUrl` and `validateApiKeyOrThrow` reuse the existing `gateway-publisher` validators verbatim — no drift risk between install-time and runtime validation.
- The `probe-empty-batch` probe choice is documented with the right caveat ("if the contract changes, fail loud").
- `outLine`/`errLine` is mirrored from `cli.ts` with a comment pointing back at the original rationale (route-logs-to-stderr) — that's the right way to copy a pattern.
- `readGateStatus` reports a stable shape even on malformed JSON instead of crashing; the test covers it.
- `ProbeResult` is a tagged union with `kind` discriminators, which makes the CLI `switch` exhaustive-friendly.
- Test file uses `node:test` + `assert/strict` consistent with the rest of the repo; tempdir cleanup is handled in `afterEach`.

## Open questions
- `promptSecret` decodes each `chunk: Buffer` via `chunk.toString("utf8")` per `data` event. In practice raw-mode TTY input arrives one keypress at a time so this is fine, but if an operator pastes a long key the chunk boundary could (in theory) split a multi-byte codepoint. I couldn't reproduce a real failure in a quick mental walk-through, so flagging as a question rather than a finding — is paste-into-raw-mode a supported entry path, or do you assume operators will use `--api-key`/stdin redirection for that?
- `applyBrokerProviderPatch` always sets `provider.auth = "api-key"` even if a hand-edited config used a different scheme. Is overwriting `auth` on re-install intended (so `gate install` heals a broken config) or should it be preserved when already set?
