# Round-3 Code-Quality Review — `fix/audit-listener-review-followups`

**Branch:** `fix/audit-listener-review-followups`
**Compared against:** `main`
**Lens:** code quality (readability, naming, dead code, over-engineering, missing
boundary error-handling, test gaps, comment hygiene, consistency, ergonomics)
**Includes:** uncommitted edits to `package.json`, `src/hooks.ts`, `README.md` (peer-dep floor bump `>=2026.4.15` → `>=2026.4.24`)
**Test status at HEAD:** `npm test` 409/409, build clean (verified locally).

The two prior review reports are `docs/PR25-FINDINGS.md` (round-1, on PR #25, branch `feat/upgrade-openclaw-pluing`) and the prior r2 work is captured in commits `5d3065f` / `e8138fb` and `1f1b1d5`. This report assumes round-1 = PR25-FINDINGS. There is no separate round-2 markdown artifact in `docs/`; the round-2 verifications below cite commits.

---

## Summary

The branch resolves most of round-1's M/L code-quality items. `HookActivity` is gone, the inline `as` casts are centralized, `safeDesc` closes the log-injection vector, the conversation-access warning has full unit coverage, and the metadata-truncation marker keeps SMT proofs valid. The peer-floor bump in the uncommitted edits closes round-1 H-2.

What's still open from round-1: H-3 (intent vs outcome), H-4 (`builtinScan.findings` not persisted), M-3 (asymmetric `runId`/`sessionKey` fallbacks across message hooks), M-5 (scan status not surfaced in description), M-7 (no PII note in README for `senderId`/`messageId`/`threadId`).

The new code introduces a small set of fresh nits: the `SessionFileEvt` cast aliases that the SDK already types, module-scope warning state with no e2e reset, an unbounded total description length when multiple `safeDesc(...)` slots compose, a README example that switches to `$HOME` while the runtime only expands `~`, and the test/scanner.test.ts.bk backup file lingering in `test/`.

---

## Verifies-prior-findings

### From `docs/PR25-FINDINGS.md` (round-1)

| ID | Title | Status | Where |
|---|---|---|---|
| H-1 | `activation` block may break eager startup | Out of code-quality scope; not re-verified. |
| H-2 | Peer floor below `allowConversationAccess` floor | **Resolved** by uncommitted edit. `package.json:40,52,53` and `README.md:11` now `>=2026.4.24`; `src/hooks.ts:99` comment updated. |
| H-3 | `system.install` records intent, not outcome | **Still open.** No `after_install` / outcome hook subscribed; no `system.install_attempted` rename. README still says "non-decisive — observes only and never blocks" (`README.md:300`) without distinguishing attempted vs completed. |
| H-4 | `builtinScan.findings` dropped | **Still open.** `src/hooks.ts:758-760, 784-788` — only counts/status persisted; `findings: []` is still discarded. |
| H-5 | No tests for `before_install` try/catch fallback or missing `builtinScan` | **Resolved.** New e2e at `test/e2e.test.ts:1265-1322` simulates the throw and asserts a `system.install_hook_unavailable` audit row. Missing-`builtinScan` is implicitly covered by the existing `before_install` happy-path tests using optional chaining. |
| M-1 | Dead `HookActivity` return | **Resolved.** Interface removed; `registerHooks` returns `void` (`src/hooks.ts:150`). |
| M-2 | Eight ad-hoc `as typeof evt & { ... }` casts | **Resolved.** Centralized in `AgentCtxExtra` / `MessageCtxExtra` / `MessageEvtExtra` / `SessionFileEvt` / `SessionEndEvtExtra` (`src/hooks.ts:101-126`). |
| M-3 | Asymmetric `runId` / `sessionKey` fallbacks across message hooks | **Still open.** `src/hooks.ts:375` (`message_received`) and `:403` (`message_sent`) and `:464` (`inbound_claim`) all do `c.runId ?? e.runId`, but `:433` (`message_sending`) is `c.runId` only. For `sessionKey`, only `inbound_claim` (`:463`) falls back to `e.sessionKey`. The new `MessageEvtExtra` type now uniformly carries both fields, so the asymmetry is no longer a type concern — it's a forgotten alignment. |
| M-4 | Manifest duplicates `version: "0.1.0"` | Out of scope this branch (`openclaw.plugin.json` not in diff vs main). |
| M-5 | Scan `status` (`skipped`/`error`) buried in metadata, not in description | **Still open.** `src/hooks.ts:769` description is unchanged; an operator running `audit list` cannot tell a clean scan from a skipped one. |
| M-6 | Conversation-access warning untested | **Resolved.** `test/hooks.test.ts:190-256` covers all three cases (fires once, never re-fires, suppressed when `llm_input` precedes). |
| M-7 | New PII surface (`senderId`/`messageId`/`threadId`) without README privacy note | **Still open.** No README entry on which identifier fields persist when redaction is on; no `redactSenderIds` config. |
| L-1 | False-positive on conversation-access heuristic | Partially mitigated — the warning text now explicitly calls out branch (b) "tool was invoked outside a normal LLM turn" (`src/hooks.ts:91`). Reasonable tradeoff. |
| L-2 | `(api.on as unknown as ...)` cast for `before_install` | Still required (verified — `before_install` is not in `PluginHookName` even at SDK 2026.4.x). The cast is unavoidable; the comment at `src/hooks.ts:738-747` is up to date. |
| L-3 | Description bloat from unbounded `targetName` | **Resolved per-field** via `safeDesc` (`DESCRIPTION_MAX = 256`). See N-1 below for the residual *total*-length issue. |
| L-5 | `(ctx as { jobId?: string })` duplicated | **Resolved** — folded into `AgentCtxExtra`. |
| L-7 | No `after_install` correlation captured | Still open — same as H-3. |

### From the round-2 commits (`5d3065f`, `e8138fb`)

| Commit-2 change | Status |
|---|---|
| `AuditEvent.metadata` returned in sync with persisted form on truncation | **Verified.** `src/store/audit-store.ts:336` returns `effectiveMetadata`; regression-guarded by `test/store/audit-store.test.ts:96-118` and `test/e2e.test.ts:1325-1374` (the latter explicitly asserts the SMT membership proof verifies for the truncated row). |
| Reserved `$auditTruncation` namespace key | **Verified.** Centralized in two places (`audit-store.ts:269, 280`); test expects `"$auditTruncation" in metadata` shape. |
| Defensive "marker exceeds cap" throw | `audit-store.ts:289-293` is defensible — it's narrow, comment justifies why, and protects the size-evasion vector. Acceptable. |

---

## New findings

### M-N1. Total description length is not bounded when several `safeDesc(...)` slots compose
- **Where:** `src/hooks.ts:769` (`Install ${mode}: ${target} ${name}` — three 256-char slots → up to ~770 chars), `:365`/`:396`/`:426` (`{recipient/sender} on {channelId}` — two slots, up to 512 chars), `:616-617` (session.end with two slots).
- **Why it matters:** L-3 in round-1 asked for "bound description to ~256 chars". `safeDesc` enforces 256 *per slot*, but the composite description has no overall cap. A pathological install with three near-256-char fields produces a description column over 750 chars, defeating the spirit of L-3.
- **Fix:** either (a) wrap final composed description in `safeDesc` once more (clamping the composite to 256), or (b) tighten per-slot caps to e.g. 80 chars in description context and document. (a) is the more reliable shape because it keeps `metadata` unaffected.

### M-N2. Module-scope `llmInputObserved` / `conversationAccessWarned` is reset only by `hooks.test.ts`; e2e tests don't clear it
- **Where:** `src/hooks.ts:75-84`; `test/hooks.test.ts:151` calls `_resetConversationAccessWarningStateForTests` in `beforeEach`. `test/e2e.test.ts:113, 406, 1308` do not.
- **Why it matters:** Tests in different files share node:test process. Whichever file runs first will set `conversationAccessWarned=true` if it ever fires `before_tool_call` without a preceding `llm_input` (most e2e setups do exactly that). Subsequent files relying on the warning *not* having fired could be subtly affected. Today the suite passes; it's order-dependent and brittle.
- **Fix:** either call the reset from a shared `before` hook in `test/e2e.test.ts` or (better) thread the state through an injectable holder so module-scope isn't required. The author's comment at `src/hooks.ts:69-74` explains *why* module scope was chosen (re-registration on a fresh api instance) — but that argument applies to a single process, and openclaw's re-registration is idempotent on the warning state anyway. A per-`registerHooks` holder behind a closure-local default + an exported `setHookActivityProvider()` would re-introduce the symmetry.

### L-N1. README CLI example uses `$HOME`, but the store only expands `~`
- **Where:** `README.md:47` shows `openclaw config set ... config.dbPath "$HOME/.openclaw/audit.db"`; `src/store/audit-store.ts:168` expands only `dbPath.replace(/^~/, process.env.HOME ?? ".")`.
- **Why it matters:** Whether `$HOME` is interpolated depends on the operator's shell at the moment they run the CLI command, *not* on the audit-store. If openclaw's `config set` stores the value verbatim (which is the conservative assumption), the persisted JSON will read `"$HOME/.openclaw/audit.db"` and the audit-store will create a directory literally named `$HOME` under the cwd. Round-1 docs guidance ("Document config changes with both CLI and JSON forms") is followed in form (line 47 CLI vs line 61 JSON), but the CLI form has been changed to a non-equivalent value: line 61 still shows `~/.openclaw/audit.db`.
- **Fix:** revert the CLI example to `"~/.openclaw/audit.db"` to match the JSON example and what audit-store actually expands. Alternatively, expand `$HOME` (and other `process.env.X`) in the store — but that widens the contract and isn't requested.

### L-N2. Redundant `SessionFileEvt` casts where the SDK already types `sessionFile`
- **Where:** `src/hooks.ts:533, 553, 573` cast event to `evt & SessionFileEvt`. The plugin-sdk types at `node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1681,1684,1695` (`PluginHookBeforeCompactionEvent`, `PluginHookBeforeResetEvent`, `PluginHookAfterCompactionEvent`) already include `sessionFile?: string`.
- **Why it matters:** M-2's centralization comment instructs "do NOT add fields here without verifying they exist in the openclaw types" — but `SessionFileEvt` violates the inverse rule: it adds a cast for a field that is *already* typed. Cast aliases for already-typed fields obscure which fields are SDK-supported vs unofficial.
- **Fix:** delete `SessionFileEvt`; access `evt.sessionFile` directly in `before_compaction`, `after_compaction`, `before_reset`. `SessionEndEvtExtra` should drop the `extends SessionFileEvt` and define `sessionFile` inline (the `PluginHookSessionEndEvent` type does NOT include `sessionFile`, so the cast IS still needed there — verified at `types.d.ts:1876-1881`).

### L-N3. `system.install_hook_unavailable` README claim of "appended once" is imprecise
- **Where:** `README.md:302` — "appended once if the `before_install` registration throws".
- **Why it matters:** The catch in `src/hooks.ts:794-806` runs on every call to `registerHooks`. `src/index.ts:148-154` re-invokes `registerHooks` on every fresh api instance for the same process. On a future runtime that throws, you'd get one row per re-registration, not one per process. Minor, but the README guarantee is stronger than the code.
- **Fix:** either change the README to "appended once per registerHooks call" / "each time openclaw re-registers an api instance", or move the catch's `safeAppend` behind a module-scope "already-recorded" flag analogous to `conversationAccessWarned`.

### L-N4. `inbound_claim` falls back on `e.parentConversationId`? — actually no, but should it?
- **Where:** `src/hooks.ts:462`: `parentConversationId: ctx.parentConversationId`. The SDK types (`types.d.ts:1716`) put `parentConversationId` on **both** the event and the ctx (`PluginHookInboundClaimEvent` and `PluginHookInboundClaimContext`).
- **Why it matters:** Same shape of issue as round-1 M-3: when both event and ctx carry the same field and you only read one of them, you risk gaps if openclaw populates only the other. New test (`test/hooks.test.ts:737-744`) only verifies the ctx path. The fix mirrors M-3: `ctx.parentConversationId ?? (evt as ...).parentConversationId`.

### L-N5. Stale backup file `test/scanner.test.ts.bk` in working tree
- **Where:** `test/scanner.test.ts.bk` (untracked). 5.7 KB of dead code, not in `.gitignore`.
- **Fix:** delete or move out of tree. (Out of scope of this branch's diff — but it's a working-tree-cleanliness nit and the task asked for "current working-tree state" findings.)

### L-N6. `_resetConversationAccessWarningStateForTests` exported but `_`-prefixed
- **Where:** `src/hooks.ts:81`, exported.
- **Why it matters:** The leading underscore is a convention for "private", but TypeScript's `export` ignores conventions. A consumer could import it. The function is unavoidable given the module-scope state, but if M-N2 is fixed (state is no longer module-scope), this can be removed.
- **Fix:** address as part of M-N2, or guard with `if (process.env.NODE_ENV !== "test") return;`.

---

## What's done well

- The `safeDesc` helper is well-scoped: a single regex, a clear length rule, comment explaining the threat model. The unit test at `test/hooks.test.ts:970-993` precisely captures the log-line forgery vector.
- Centralizing the cast aliases (round-1 M-2) trims ~30 LoC of inline noise and gives one place to delete when the SDK catches up. The comment at `src/hooks.ts:94-100` makes the contract explicit.
- The metadata-truncation marker design (`$auditTruncation` reserved key, defensive size-recheck) is exactly the right shape: keeps the audit signal, namespaces the marker so a real plugin can't collide, and the regression guard at `test/store/audit-store.test.ts:108-110` plus the SMT-proof e2e at `test/e2e.test.ts:1366-1373` make the contract impossible to silently break in future.
- The conversation-access warning text now spells out *both* root causes (operator opt-in missing OR tool invoked outside an LLM turn). That tempers round-1 L-1's false-positive concern without losing diagnostic value.
- Coverage for the `before_install` try/catch fallback (round-1 H-5) is exemplary — the e2e test stands up a real `AuditStore` + `RateLimiter` + `SmtService` and asserts the audit row appears, not just that no exception leaked.
- Test descriptions read as specifications (e.g. `test/store/audit-store.test.ts:96` "records oversized metadata events with a truncation marker rather than dropping them"). Future readers will understand the *why* without spelunking the original commit.

---

## Severity rollup

| Severity | Count | Items |
|---|---|---|
| **H** | 0 | (none introduced this round; round-1 H-3, H-4 still open are out of code-quality lens — they are correctness/forensics findings) |
| **M** | 2 | M-N1, M-N2 |
| **L** | 6 | L-N1 … L-N6 |
| **TOTAL new** | 8 | |

Round-1 items still open (across lenses): H-3, H-4, M-3, M-5, M-7. None of these were re-introduced; they were not addressed in r2 either, so they remain on the backlog.

## Minimum bar before merge (code-quality only)

1. Decide M-N1 (composite description length). One-line fix.
2. Decide M-N2 (module-scope warning state). Either thread state through, or add the e2e reset.
3. Revert L-N1 (CLI example back to `~`) — this is a doc regression introduced by the uncommitted edit, not pre-existing.

The round-1 H-3, H-4, M-3, M-5, M-7 are correctness/UX items, not code-quality blockers; surface them in this branch's PR description as known-deferred and they don't need to gate this merge.
