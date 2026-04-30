# Code-quality review — fix/audit-listener-review-followups

## Summary
The follow-up cleanly addresses the prior code-review findings (`HookActivity` deletion, cast aliases, README count drift, before_install comment overshoot) and the security/correctness items it picked up (control-char stripping for descriptions, truncate-and-record on metadata overflow, `system.install_hook_unavailable` audit event, `accountId` on `message_sending`, `parentConversationId` on `inbound_claim`). New code is well-scoped; the new tests genuinely verify the intended behavior. Two correctness gaps to flag: the truncation marker’s payload claims `metadataDropped: true` even when the canonicalize step succeeded but happened to exceed 1MB on its own, and the prior `peerDependencies` floor finding was *partially* addressed (bumped to `>=2026.4.15`, not the `>=2026.4.24` the prior correctness review specifically called for as the version the README declares for the conversation-access opt-in).

## Verifies-prior-findings

- **[code/M] `HookActivity` is exported and returned but no caller consumes it** — **Resolved.** `registerHooks` is back to `void` (`src/hooks.ts:135-140`); no `HookActivity` export remains anywhere in `src/`. Module-scope `llmInputObserved` and `conversationAccessWarned` (`src/hooks.ts:75-76`) replace the closure tracker.
- **[code/L] Repeated inline `(evt as typeof evt & {...})` casts** — **Resolved.** Five aliases (`AgentCtxExtra`, `MessageCtxExtra`, `MessageEvtExtra`, `SessionFileEvt`, `SessionEndEvtExtra`) introduced at `src/hooks.ts:91-116` and applied at every call site that previously used inline shapes.
- **[code/L] Hook count comment in README is now load-bearing** — **Resolved with caveats.** README phrasing reworked at `README.md:222` to "every public OpenClaw lifecycle hook" (no number). The two test asserts at `test/hooks.test.ts:160` and `test/index.test.ts:67` still hard-code `26`, but that is now a strictly internal contract (no README sync required).
- **[code/L] `try/catch` around `before_install` registration comment overshoots** — **Resolved.** Comment at `src/hooks.ts:723-729` now plainly states "older runtimes warn-and-skip; the catch is a defense-in-depth guard against future runtimes that throw."
- **[code/L] `console.warn` for the conversation-access banner is multi-line and noisy** — **Resolved.** Banner condensed to a single string with newline-free embedding (`src/hooks.ts:78-82`). Single-line, structured-log-aggregator-friendly.
- **[code/L] `description` for `cron.executed` is hard-coded** — **Resolved.** Now interpolates `jobId` when present (`src/hooks.ts:182-184`), defensively wrapped in `safeDesc()`.
- **[correctness/H] Re-registration creates a fresh `activity` closure on `api2`** — **Resolved.** `llmInputObserved` and `conversationAccessWarned` are module-scope (`src/hooks.ts:75-76`), so `index.ts:148`'s second `registerHooks` call no longer resets them. The comment at L69-74 explains the design choice. (Note: `llmInputObserved` is wrapped as `{ value: false }` to allow mutation through closure — equivalent to a plain `let`, just more visually clear).
- **[correctness/H] `peerDependencies.openclaw: ">=2026.4.1"` is below the version that exposes `before_install`** — **Resolved with caveats.** Bumped to `>=2026.4.15` (`package.json:40`, also `compat.pluginApi` and `compat.minGatewayVersion`), and the comment at `src/hooks.ts:723-724` now reads "lands in openclaw >=2026.4.15." However, the prior correctness review specifically pointed to **2026.4.24** as the version that introduces the `allowConversationAccess` opt-in referenced in the warning string; the floor `>=2026.4.15` is below that. See [M] *peerDependencies floor still below `allowConversationAccess` opt-in version* below.
- **[correctness/M] `session_end` description mishandles falsy non-undefined `reason`** — **Resolved.** Explicit `hasReason = e.reason != null && e.reason !== ""` gate at `src/hooks.ts:594` followed by branched description.
- **[correctness/M] `before_install` outer try/catch comment unclear** — **Resolved.** See above. Comment at `src/hooks.ts:722-729` is now clear about the warn-and-skip default and the throw-path defense.
- **[correctness/M] `message_sending` omits `accountId`** — **Resolved.** Added at `src/hooks.ts:421`, with a dedicated test at `test/hooks.test.ts:622-629`.
- **[correctness/M] `inbound_claim` does not capture `parentConversationId`** — **Resolved.** Added at `src/hooks.ts:452`, with a dedicated test at `test/hooks.test.ts:661-668`. Comment at L439-441 documents the intentional `sessionId: ctx.conversationId` choice (also closing the prior sub-finding about silent convention).
- **[correctness/M] Cast safety: `(ctx as { jobId?: string })` silently breaks under field renames** — **Resolved.** The named module-level aliases (see code/L resolution above) replace the inline shapes and centralize the rename surface.
- **[security/M] Sender-controlled fields can evade audit recording via the 1 MB metadata cap** — **Resolved with caveats.** The store now records the event with a marker rather than dropping it (`src/store/audit-store.ts:265-278`). See [M] *truncate-and-record marker shape ambiguity* and [L] *truncation marker can itself exceed cap* below.
- **[security/M] `before_install` registration failure is swallowed without an audit-trail signal** — **Resolved.** `system.install_hook_unavailable` event added (`src/types/events.ts:51`, emitted at `src/hooks.ts:782-787`), with an e2e test that injects a throwing `api.on` (`test/e2e.test.ts:1265-1323`).
- **[security/L] `description` template embeds attacker-controlled fields without escaping** — **Resolved.** `safeDesc()` (`src/hooks.ts:129-133`) strips control chars and clamps length. Applied at every interpolating description site (verified by `grep`: every `description: \`...\${...}\`` either passes the value through `safeDesc()` or interpolates a numeric/non-string literal).
- **[security/L] `CONVERSATION_ACCESS_WARNING` reveals the exact opt-in path** — Not addressed; not flagged as a fix target in the diff. Prior reviewer rated L for awareness only.
- **[security/L] README CLI examples use unquoted-tilde paths inside double quotes** — **Resolved (partially).** First example flipped to `$HOME/.openclaw/audit.db` at `README.md:47`. The second site at original `README.md:184` (within the DE config block, which uses `deWalletKeyFile`) was not updated.

## New findings

### [M] Truncation marker payload may itself exceed `MAX_METADATA_SIZE` for unusual canonicalize results (`src/store/audit-store.ts:265-278`)
The new size-cap path replaces the metadata with `{ metadataDropped: true, reason: "size-cap", originalSize: <int> }`. The marker is canonicalized into a fixed-shape JSON of ~70 bytes, so in practice it cannot exceed the cap. **However**, there is no second size check after the marker is built — if a future contributor adds a sender-controlled field to the marker (e.g. `originalEventType: insert.eventType`, or `firstByteOf: <truncated source>`), the safeguard against the original problem (sender-controlled fields evading the cap) is silently re-introduced because the marker itself becomes attacker-influenceable.

Mitigation: either (a) add an `assert(metadataCanonical.length <= MAX_METADATA_SIZE)` after the marker is built and fall back to a hard-coded constant if the assert fails, or (b) write a short comment at the marker site warning future contributors not to interpolate sender-supplied values into the marker payload. (a) is a few lines and prevents accidental regression.

### [M] `peerDependencies` floor is still below the version that introduced `allowConversationAccess` (`package.json:40`, `src/hooks.ts:78-82`)
The prior correctness review explicitly called for `>=2026.4.24` because that's the version that ships the `plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess` opt-in referenced verbatim in `CONVERSATION_ACCESS_WARNING`. The fix branch bumped to `>=2026.4.15` (the floor for `before_install`) but did not bump to `>=2026.4.24`. An operator on 2026.4.15-2026.4.23 will install successfully, hit the warning, and find the opt-in key non-functional. The README "Required openclaw config" section (mentioned at `README.md:11-37` per prior review, still present) declares 2026.4.24 as the minimum for the conversation-access feature.

Mitigation: bump `package.json:40` peer floor and `package.json:52-53` `compat.pluginApi` / `compat.minGatewayVersion` to `>=2026.4.24`. (`engines.openclawVersion` at `package.json:56` is a separate metadata field and may stay at the SDK build version.)

### [M] `metadataDropped: true` collides with a hypothetical real metadata field of the same name (`src/store/audit-store.ts:259-277`)
Downstream consumers parsing audit metadata cannot distinguish between:
1. The store's own truncation marker `{ metadataDropped: true, reason: "size-cap", originalSize: N }`, and
2. A future event handler that legitimately stores `metadataDropped` as a domain field (e.g. an upstream gateway forwarding a "metadata was dropped at the source" signal).

The marker has no namespacing prefix and no field that uniquely identifies it as store-emitted (the trio is suggestive but not unique — a domain handler could reasonably emit the same shape). For an audit-log consumer building dashboards or alerts, "metadata was dropped" is a load-bearing signal; an ambiguity here means a forensic investigator could misclassify a legitimate domain event as a truncation, or vice versa.

Mitigation: rename the marker key to something namespaced and unmistakable, e.g. `__store_truncation: { reason, originalSize }`, or `_auditStore.metadataDropped: true`. The `__`/`_`-prefix convention is established for system-only fields. Test fixtures at `test/store/audit-store.test.ts:96-122` and `test/e2e.test.ts:1325-1359` would each need a one-line key rename.

### [L] `safeDesc()` and `sanitize()` have non-overlapping concerns but the comment at `safeDesc()` doesn't say so (`src/hooks.ts:118-133`, `src/hooks.ts:31-47`)
`sanitize()` redacts by **key name**; `safeDesc()` strips control chars and clamps **value length**. They don't overlap — one operates on the structured metadata path, the other on the description string — but a reader landing at `safeDesc()` and remembering `sanitize()` exists could reasonably wonder why we have two. One additional sentence in the `safeDesc()` doc-comment ("complementary to `sanitize()`, which redacts by key in metadata; this scrubs by value in descriptions") would prevent the duplicate-utility question.

### [L] `llmInputObserved` is wrapped in an object but the wrapping is unnecessary (`src/hooks.ts:75`)
```ts
const llmInputObserved = { value: false };
let conversationAccessWarned = false;
```
The asymmetry is odd: `conversationAccessWarned` is a plain `let`, `llmInputObserved` is a single-property object. Both are module-scope `let`-able primitives. The object form makes the read site `llmInputObserved.value` slightly noisier than `llmInputObserved`. There is no reason for the asymmetry — the `{value: ...}` wrapper does not enable any pattern that a plain `let` doesn't.

Mitigation: convert `llmInputObserved` to `let llmInputObserved = false;` and update the two read/write sites at `src/hooks.ts:250` and `src/hooks.ts:324`. Pure cosmetic, but it removes a small WTF.

### [L] `before_compaction` / `after_compaction` / `before_reset` use inline `(evt as typeof evt & SessionFileEvt)` rather than the new alias (`src/hooks.ts:532, 550, 566`)
The new module-scope alias `SessionFileEvt` is defined at `src/hooks.ts:108-110`. It IS used as a stand-alone type and as a base for `SessionEndEvtExtra`. But three handlers still inline the cast `(evt as typeof evt & SessionFileEvt)` rather than hoisting `const e = evt as typeof evt & SessionFileEvt;` once and reading `e.sessionFile`. Minor consistency nit — every other module-scope alias is used via the destructure-once pattern; only these three handlers retain the inline cast.

Mitigation: trivial — destructure once at the top of each handler and read from the cast variable. No behavior change.

### [L] e2e registration-failure rig duplicates the createMockApi shape inline (`test/e2e.test.ts:1282-1306`)
The `flakyApi` mock duplicates ~25 lines of `createMockApi()`'s mock object just to override `on()`'s behavior for one hook. A `createMockApi({ throwOn: ["before_install"] })` extension or a small `withFlakyHook(api, "before_install")` wrapper would keep the test focused on its actual claim ("registration failure → audit row") rather than re-stating boilerplate. Not a correctness issue, just a future-test-readability nit.

### [L] e2e `oversized metadata` test does not exercise the non-serializable branch (`test/e2e.test.ts:1325-1359`)
The unit test at `test/store/audit-store.test.ts:111-122` covers the `BigInt` non-serializable branch directly against `AuditStore.append`, but the e2e file only exercises the size-cap branch end-to-end. Adding a parallel e2e test for non-serializable metadata fired through a hook handler would prove that the marker survives the rate limiter / SMT path the same way size-cap does. Optional — unit coverage is sufficient for the store-level invariant.

## What's done well

- The module-scope `llmInputObserved` / `conversationAccessWarned` correctly preserves "fires once per process" semantics across both initial and re-registration calls (the prior [H] correctness finding). The comment at `src/hooks.ts:69-74` explicitly explains the per-api-instance hazard the previous closure-scope had.
- `safeDesc()` is applied **consistently** across every description that interpolates a non-numeric value, including pre-existing sites that the prior review did not call out (e.g. `cron.executed` at L182-184, `cron.failed` at L233, every `subagent_*` at L626/644/663/683, both `gateway_*` at L704/716). I scanned every description template and could not find a remaining attacker-controllable interpolation that bypasses `safeDesc()`. The `before_install` description, which the prior security review specifically named, is fully covered at `src/hooks.ts:751`.
- The new test at `test/hooks.test.ts:895-917` verifies BOTH halves of the security claim: the description has CR/LF stripped *and* the metadata preserves the raw payload for forensics — that is exactly the right invariant pair.
- The new e2e test at `test/e2e.test.ts:1265-1323` injects a throwing `api.on` for just `before_install`, which is precisely the version-skew scenario the [security/M] finding called out. The test cleans up its own rig (no leak into the shared describe-scope rig).
- `AuditStore.append` correctly preserves all other invariants on the truncate-and-record path: `nextSequence = this.sequence + 1` runs *after* the truncation logic, and `this.degraded = false` still fires, so the marker write is treated as a successful append (`src/store/audit-store.ts:280-308`). The unit test at `test/store/audit-store.test.ts:96-109` asserts `isDegraded() === false` and that the event is queryable, so the invariant is locked down.
- The new module-scope cast aliases are minimally scoped — only fields actually consumed by handlers appear in each alias. `MessageEvtExtra` correctly omits SDK-typed fields like `from`/`to`/`content`. The aliases are also separated by usage (event vs context), so a future SDK that adds these fields to the event but not the context doesn't force a partial cast.
- `test/harness.ts` continues to work unchanged with the void return type because it never captured the previous return value (`test/harness.ts:85` calls `registerHooks(api, store, limiter);` with no LHS).
- All 373 tests pass on the branch tip (`npm test`).
- The `system.install_hook_unavailable` event type is exported from `src/types/events.ts:51`, documented in the README at `README.md:298-300`, and emitted with metadata that captures the underlying error message. End-to-end story is complete.
