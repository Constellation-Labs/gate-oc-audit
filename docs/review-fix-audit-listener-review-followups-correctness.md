# Correctness review — fix/audit-listener-review-followups

Branch: `fix/audit-listener-review-followups` → `feat/upgrade-openclaw-pluing`
Commits reviewed: `403a7d2` (docs), `a8d0146` (fix)
Test status: `npm test` → 373/373 pass.

## Summary

The fix commit cleanly addresses every prior finding except the SMT/store consistency invariant. Module-scope warning state correctly fixes the per-instance re-registration bug; type aliases tighten the cast surface; `safeDesc()` plugs a real log-injection vector; `accountId`/`parentConversationId` are now captured. **However, the new "truncate-and-record" behaviour in `AuditStore.append` introduces a new H-severity correctness regression:** the in-memory `AuditEvent` returned to callers carries the original (oversized or non-serializable) `metadata`, while the persisted row carries the marker. The SMT tree is built from a hash that includes the original metadata — so any consumer reading the event back from SQLite and recomputing `computeRawHash` gets a hash that is NOT in the tree. For non-serializable metadata it is even worse: `computeRawHash` itself throws and the SMT silently skips the insert, leaving the persisted row with no SMT entry at all. Plus a handful of L-severity nits (no test asserts the conversation-access warning fires, U+2028/U+2029 not stripped by `safeDesc`).

## Prior-finding verification

- **[H] Re-registration warning bug**: Resolved — `llmInputObserved` (`src/hooks.ts:75`) and `conversationAccessWarned` (`src/hooks.ts:76`) are now module-scope so a second `registerHooks` call inherits the prior process's observed-state. Comment at `src/hooks.ts:69-74` correctly documents the rationale. Test coverage of the warning itself is **absent** (no test asserts `console.warn` fires or doesn't fire under any sequence) — see new finding L-1.
- **[H] peer-dep floor mismatch**: Resolved earlier on `feat/upgrade-openclaw-pluing` — not in this diff.
- **[M] Dead `HookActivity` export**: Resolved — no `HookActivity` symbol remains anywhere (`grep` over `src/` and `test/` finds zero hits). `registerHooks` returns `void`. Both call sites in `src/index.ts:148, 167` are unchanged.
- **[M] `message_sending` accountId**: Resolved — `src/hooks.ts:421` adds `accountId: ctx.accountId`. Test `test/hooks.test.ts:622-629` asserts the field. The assertion *would* fail if the field were omitted: it does an exact `assert.equal(meta.accountId, "acct-99")` against ctx-supplied value.
- **[M] `inbound_claim` parentConversationId**: Resolved — `src/hooks.ts:452`. Test `test/hooks.test.ts:661-668` asserts. Assertion would fail if field omitted (exact equality on the ctx-supplied "p1").
- **[M] AuditStore truncate-and-record**: **Partially resolved** — both branches now insert a marker row instead of dropping. `sequence` advances and `degraded` is reset (`src/store/audit-store.ts:307-308`). Marker payloads are tiny (67 chars and 50 chars) so neither marker can re-trigger the size cap, and neither contains a `BigInt`/symbol so neither re-triggers `canonicalize` failure. **However**, this fix breaks the SMT/DB reproducibility invariant — see new finding H-1 below. Audit-store tests at `test/store/audit-store.test.ts:96-122` cover only the store-isolated path; they don't exercise the SMT pipeline so they don't catch the regression.
- **[L] `session_end` `""` reason**: Resolved — `src/hooks.ts:594` now uses `e.reason != null && e.reason !== ""`. The metadata field still records the empty string verbatim (`src/hooks.ts:606`), which I read as intentional (preserve the raw payload for forensics, downgrade only the description). See L-3.

## New findings

### [H] SMT-vs-DB metadata mismatch on truncated events makes proofs unverifiable from the persisted record (`src/store/audit-store.ts:310-324`, `src/services/smt-service.ts:209, 256-269`)

`AuditStore.append` now produces a marker `metadataCanonical` for the persisted INSERT (`src/store/audit-store.ts:273-277` and `259-262`) but the `AuditEvent` returned to the caller carries `metadata: insert.metadata` (`src/store/audit-store.ts:321`) — the original, untruncated payload. The rate limiter passes that returned event to `smtService.onEventAppended(result)` (`src/rate-limiter.ts:66, 108`), which calls `computeRawHash(event)`. `computeRawHash` canonicalizes `event.metadata` (`src/services/smt-service.ts:265`) — i.e. the original blob — so the hash inserted into the SMT is bound to the pre-marker metadata.

Concrete consequence in the size-cap branch (verified by direct execution):

```
in-memory event metadata size : 1 048 690 bytes
persisted DB row metadata     : { metadataDropped: true, reason: "size-cap", originalSize: 1048690 }
hash from in-memory event     : 833741b1...
hash from persisted event     : 012e438a...
proof using in-memory hash    : membership = true
proof using persisted hash    : membership = false   ← exclusion proof
```

Any future verifier (the existing `cliVerifyHandler`, an external auditor reading the SQLite file, or the e2e proof loop at `test/e2e.test.ts:240-254`) loads the event from disk and calls `computeRawHash`. For oversized events that hash misses the tree — every truncated event fails verification with the very tool the plugin ships.

The non-serializable branch is strictly worse. `computeRawHash` invokes `sdk.canonicalize({ ..., metadata: event.metadata })` on the original `BigInt` (or symbol/circular) — `sdk.canonicalize` throws "Do not know how to serialize a BigInt". `onEventAppended` catches that and logs `"[audit-plugin:smt] Insert failed: ..."` (`src/services/smt-service.ts:246-249`), so the SMT entry is never inserted at all. The persisted row exists with the marker but **has no corresponding SMT leaf** — a verifier gets a clean exclusion proof.

The existing e2e test `test/e2e.test.ts:1325-1359` exercises the size-cap path through the full hook → limiter → store → SMT pipeline but only asserts the persisted marker, not that an SMT proof can be constructed from the persisted event. That's why all 373 tests pass while the regression is real.

Recommended fix: have `append` either (a) return the marker metadata in the result so SMT and DB agree, or (b) compute the canonical metadata once, decide on the marker, and pass that decision to *both* the `INSERT` and the returned object. Option (a) is the smaller change. Either way, the non-serializable path needs the marker substituted *before* `computeRawHash` runs, otherwise SMT insertion silently fails.

Severity: **H**. Silent verification failure on operator-controlled inputs (oversized `requestedSpecifier`, hostile sender fields) is exactly the forensic signal the truncate-and-record path was added to preserve.

### [L] `safeDesc` does not strip Unicode line/paragraph separators U+2028/U+2029 (`src/hooks.ts:128`)

`CONTROL_CHARS = /[\x00-\x1F\x7F]/g` covers ASCII C0 + DEL — CR, LF, TAB, NUL, etc. all stripped (verified). It does NOT strip U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), which JavaScript treats as line terminators and which several log shippers and browser-based viewers (anything that splits on ` `) will treat as a newline. An attacker-controlled field interpolated into a description (`targetName`, `senderName`, etc.) can still inject a fake log line by sending `evil [audit-plugin] FAKE...`. The metadata field is unaffected (it's stringified through `sdk.canonicalize` and JSON-escapes them), only the `description` column.

Add U+2028/U+2029 to the regex: `/[\x00-\x1F\x7F  ]/g`. Optional but cheap. Severity **L** because the realistic attack surface is small (most operators won't tail audit descriptions through a U+2028-aware viewer) and the intent of the fix was clearly the C0 set per the comment at `src/hooks.ts:126-127`.

### [L] No test asserts the conversation-access warning fires (or doesn't) — module-scope state can mask regressions (`test/hooks.test.ts`)

`grep` for `CONVERSATION_ACCESS_WARNING`, `conversationAccessWarned`, or `allowConversationAccess` in `test/` returns zero hits. The warning logic at `src/hooks.ts:250-253` is therefore exercised but never asserted. Two concrete consequences:

1. The fix-commit's main behavioural claim ("warning fires once per process, not once per re-registration") has no regression guard. A revert to closure-scope `conversationAccessWarned` would not be caught by any test.
2. Module-scope `conversationAccessWarned` means: once `before_tool_call` fires in *any* test in the file (the `before_tool_call` describe at `test/hooks.test.ts:301`, the redaction tests at 1076-1112) without a prior `llm_input`, the flag flips for the rest of the test run. If a future contributor adds a test that wants to assert the warning fires twice (e.g. once per registration), it cannot — the module flag is sticky.

Lowest-effort mitigation: a single test that wraps `console.warn`, fires `before_tool_call` without `llm_input`, asserts the warning string contains "tool.invoked observed without any preceding llm_input", then fires it again and asserts no second warning. Run that test first (or in its own file) so module state is clean. Severity **L** because the production behaviour is correct.

### [L] `degraded` flag is reset on every successful append, including marker-path appends (`src/store/audit-store.ts:308`)

This is unchanged from the prior code, but the new truncate-and-record behaviour means a long stream of oversized/non-serializable events that previously surfaced as `isDegraded() === true` (because they returned `undefined`) now silently succeed and the operator sees `isDegraded() === false`. The rate of "metadata dropped" markers in the DB is the only signal. If the operator's monitoring relies on `isDegraded()` to flag pathological inputs, that signal is now muted.

Not a defect of the fix per se — the marker is the new canonical signal — but worth documenting on `isDegraded()`'s JSDoc that it is *not* a substitute for monitoring `metadataDropped: true` rows. Severity **L**.

## What's done well

- The two-tier marker design (size-cap vs non-serializable) is sensible and the markers themselves are tiny enough that they cannot recurse the size cap or re-throw `canonicalize`.
- `safeDesc` is a function declaration so hoisting is not a concern; every interpolation site that mixes evt/ctx-controlled strings is wrapped (verified by `grep -n "description:"` cross-referenced with `safeDesc`). The 256-char ellipsis math is correct (`length === 256`, UTF-8 `…` = 3 bytes giving 258 bytes — fine if the column is char-counted).
- Type aliases (`AgentCtxExtra`, `MessageEvtExtra`, `MessageCtxExtra`, `SessionFileEvt`, `SessionEndEvtExtra`) replace inline structural casts at every site I checked (`grep -n "as typeof"` shows 14 hits, all using one of the new aliases). The compiler-friendly extension pattern means a future SDK upgrade lets you delete the alias and TypeScript reports the now-redundant casts.
- The `safeAppend` closure used inside the `before_install` catch is correctly in scope — the `try/catch` at `src/hooks.ts:730-788` is fully inside `registerHooks`, and `safeAppend` is defined at `src/hooks.ts:144-162`. The new `system.install_hook_unavailable` test at `test/e2e.test.ts:1265-1323` exercises this path with a flaky api that throws on `before_install`; the assertion at line 1313 confirms the audit row lands.
- `test/e2e.test.ts:895-917` (which I did not have to look at again here) plus the test rig's clean teardown via `destroyRig` keep SMT consistent across describe blocks. The SMT/DB invariant break in finding H-1 is independent of test rigging — it's a code-level mismatch that no test currently asserts against.
