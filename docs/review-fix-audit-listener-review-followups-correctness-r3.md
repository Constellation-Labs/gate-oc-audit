# Correctness review (round 3) — fix/audit-listener-review-followups

Branch: `fix/audit-listener-review-followups` → `main`
HEAD: `3396d40` ("fix: address remaining M/L findings from the follow-up review")
Working tree: uncommitted edits to `package.json`, `src/hooks.ts`, `README.md`
(peer-dep floor `>=2026.4.15` → `>=2026.4.24`).
Test status: `npm test` → 409/409 pass.

## Summary

The round-2 [H] (SMT-vs-DB metadata mismatch on truncation) is fully and correctly
fixed in commit `5d3065f`. Every commit-level finding from rounds 1 and 2 is
resolved, and the new e2e regression guard at
`test/e2e.test.ts:1330-1371` proves the fix end-to-end (it builds an SMT
membership proof from the round-tripped row and verifies against the known
roots — exactly the scenario the round-2 report flagged as broken).

However, the same SMT-vs-DB invariant has a **second instance** that the
round-2 report did not look at: the `description` column. `safeDesc()`
(`src/hooks.ts:135-143`) clamps a string by `slice(0, DESCRIPTION_MAX - 1)`
without checking surrogate-pair boundaries. When a sender-controlled string
is long enough to be clamped *and* contains a non-BMP character (any emoji,
many CJK supplementary chars) straddling position 254-255, the clamp leaves
a lone high surrogate. SQLite stores TEXT as UTF-8, and on read-back the
lone surrogate is replaced with U+FFFD. The in-memory event has hash A; the
persisted-then-read event has hash B; SMT membership proof for the persisted
row fails. This is the same shape of bug as the round-2 [H], moved from the
metadata blob to the description column. Severity **H**.

The peer-dep floor bump (`2026.4.15` → `2026.4.24`) is internally consistent
with the surrounding code and does not break any existing behaviour, but the
plugin's *dev* environment still has openclaw 2026.4.1 installed
(`node_modules/openclaw/package.json` reports `version: "2026.4.1"`), so the
runtime path that the plugin actually exercises during `npm test` is the
older API. That's a test-fidelity concern, not a code defect — flagged **L**.

## Prior-finding verification

### Round-2 [H] SMT-vs-DB metadata mismatch — **FIXED** in `5d3065f`

Verified by reading the commit (`git show 5d3065f -- src/store/audit-store.ts`)
and the current working-tree state of `src/store/audit-store.ts:247-346`:

- `effectiveMetadata` is captured at `audit-store.ts:263` and updated in both
  the non-serializable branch (`:269`) and the size-cap branch (`:279`).
- The persisted `metadataCanonical` and the returned `effectiveMetadata` are
  always derived from the same source object (`audit-store.ts:270, 282`), so
  `sdk.canonicalize(returned.metadata) === persisted.metadataCanonical` by
  construction.
- The returned `AuditEvent.metadata` at `audit-store.ts:336` is now
  `effectiveMetadata`, not `insert.metadata`. SMT inserts a hash on the
  in-memory event whose metadata is the marker; a future verifier reading
  the row back via `JSON.parse(row.metadata)` (`audit-store.ts:109`) gets the
  same marker object. `computeRawHash` (`src/services/smt-service.ts:256-269`)
  re-canonicalizes; canonicalize is deterministic on key order, so both paths
  produce the same hash.

Regression guards landed:

- **Unit**: `test/store/audit-store.test.ts:96-117` (size-cap) and
  `:119-134` (non-serializable) both call `assert.deepEqual(returnedMd,
  persistedMd)` — the assertion that would fail on the pre-fix code. Verified
  by running `npm test` against the current tree (409/409 pass).
- **E2E**: `test/e2e.test.ts:1330-1371` — fires `before_install` with a
  >1MB `requestedSpecifier`, reads the row back via `rig.store.query`, then
  builds and verifies an SMT membership proof through
  `rig.smt.computeRawHash(events[0])` → `rig.smt.createProof(rawHash)` →
  `rig.smt.verifyProofWithRoots(proof, knownRoots)`. This exercises the full
  hook → limiter → store → SMT pipeline and rejects the regression scenario
  the round-2 report described.

The marker-shape redesign (`{$auditTruncation: {reason, originalSize}}` at
`audit-store.ts:269, 280`) is a defensible namespace choice — a real plugin's
metadata cannot collide with `$auditTruncation` unless the plugin author
deliberately picks that key. The defensive bug-guard at `audit-store.ts:289-293`
is correct: marker payloads are primitive-only and cannot exceed the cap, but
the `throw` makes a future change re-introducing a sender-controlled marker
field fail loud rather than silently re-opening the size-evasion vector.

### Round-2 [L] U+2028/U+2029 not stripped by safeDesc — **FIXED**

`src/hooks.ts:138`: `CONTROL_CHARS = /[\x00-\x1F\x7F  ]/g`. Both
line/paragraph separators are in the character class. Verified empirically:
input `"abc<U+2028>def"` → `"abc def"` after `safeDesc`.

### Round-2 [L] No test asserts the conversation-access warning — **FIXED**

`test/hooks.test.ts:204-257` adds three regression tests under the
`conversation-access warning` describe block. Each calls
`_resetConversationAccessWarningStateForTests()` in `beforeEach`
(`hooks.test.ts:156`) so the module-scope flags don't leak across tests.

The three tests cover: (a) fires once when `before_tool_call` happens with
no prior `llm_input`, (b) does not fire again on subsequent tool calls,
(c) does not fire when `llm_input` is observed first.

Verified that the reset helper is exported and only intended for tests
(`src/hooks.ts:81-84`, no production caller via grep). The reset narrowly
clears the two flags — no other module-scope state needs unwinding.

### Round-2 [L] `degraded` flag and marker-path appends — accepted as-is

The marker-path appends still clear the `degraded` flag at
`src/store/audit-store.ts:323`. The round-2 report flagged this as worth
documenting; no documentation was added but it's a forward-looking concern,
not a regression. Leave as-is.

## New findings

### [H] `safeDesc()` slices through UTF-16 surrogate pairs, leaving a lone high surrogate that SQLite replaces with U+FFFD on round-trip — same SMT-vs-DB invariant break as round-2 [H], moved to the description column (`src/hooks.ts:139-143`, every `safeDesc` call site, `src/services/smt-service.ts:264`)

`safeDesc` clamps with `str.slice(0, DESCRIPTION_MAX - 1) + "…"` where
`DESCRIPTION_MAX = 256`. `String.prototype.slice` operates on UTF-16 code
units, not code points. If the input has length > 256 and a non-BMP
character (any emoji, math symbols, supplementary CJK) crosses position
254-255, the slice retains the leading high surrogate (U+D800-U+DBFF) and
discards the trailing low surrogate. The output description ends with
`<U+D83D>` followed by `<U+2026>` (`…`).

Concrete repro (Node):

```
slice(0, 255) of  "a".repeat(254) + "\u{1F600}" + "b".repeat(2)   length 258
output:           "a".repeat(254) + "\uD83D"  + "…"          length 256
                                    ^^^^^^^^^ lone high surrogate
```

The SMT pipeline computes `rawHash` via
`sdk.canonicalize({ ..., description: event.description, ... })`
(`src/services/smt-service.ts:259-267`) on the in-memory event — the
description is interpolated as JS UTF-16 with the lone surrogate intact.
The row is then INSERTed into SQLite TEXT (`src/store/audit-store.ts:316`,
`src/store/schema.ts:21`). SQLite stores TEXT as UTF-8; a lone high
surrogate is invalid UTF-8, and Node's `node:sqlite` driver substitutes
U+FFFD on read-back. Verified empirically:

```
input:  abc<U+D83D>def       (length 7, codes 61 62 63 d83d 64 65 66)
output: abc<U+FFFD>def       (length 7, codes 61 62 63 fffd 64 65 66)
```

Consequence: the future verifier (the `cliVerifyHandler` reading rows back
from SQLite, an external auditor, or even our own e2e proof loop at
`test/e2e.test.ts:240-254`) computes `computeRawHash` on the persisted
event with U+FFFD where the in-memory event had U+D83D — different
canonical bytes → different hash → SMT membership proof fails. Every row
whose description was truncated through a non-BMP char produces a silent
exclusion proof.

The trigger surface is real, not theoretical. `safeDesc` is called with
sender-controllable values at:
- `src/hooks.ts:243` — `evt.error` from cron run failures
- `src/hooks.ts:272, 287, 300, 320` — `evt.toolName`, `evt.error` from tool calls
- `src/hooks.ts:339, 514` — `evt.provider`, `evt.model` from LLM I/O
- `src/hooks.ts:365, 396, 426, 456, 481` — `sender`, `recipient`, `ctx.channelId` from message hooks
- `src/hooks.ts:578` — `evt.reason` from session reset
- `src/hooks.ts:597, 616, 617` — `evt.sessionId`, `e.reason` from session lifecycle
- `src/hooks.ts:642, 660, 679, 699` — subagent `agentId`, `outcome`, `childSessionKey`
- `src/hooks.ts:732` — `evt.reason` for gateway shutdown
- `src/hooks.ts:769` — `request?.mode`, `target`, `name` for install events (the most likely external trigger; install names can be Unicode, e.g. `@user/skill-😀-with-a-deliberately-long-name-padded-to-cross-the-boundary`)
- `src/hooks.ts:803` — error message from registration failure

A short repro: any of those hook invocations with a value of length 257+
where a non-BMP character lands at positions 254-255. The
e2e regression test at `test/e2e.test.ts:1330-1371` does NOT catch this —
it uses `targetName: "@example/large"` (short string, no clamp triggered).

Recommended fix: either (a) make `safeDesc` surrogate-aware
(after slice, drop a trailing high surrogate before appending the
ellipsis — same trick used by `previewGunzip` at
`src/store/audit-store.ts:78-79`), or (b) operate on code points via
`Array.from(str).slice(0, DESCRIPTION_MAX - 1).join("")`. Option (a) is the
smaller change and matches an existing pattern in the codebase.

Severity: **H**. Same severity rationale as the round-2 [H] — silent
verification failure on operator-controlled inputs is exactly the
forensic signal the plugin is supposed to preserve. The SMT-vs-DB
invariant must hold for *every* event field that's both hashed and
round-tripped through SQLite, not just metadata.

### [M] `_resetConversationAccessWarningStateForTests` is only called inside the `registerHooks` describe block; module state from later tests can therefore leak into earlier-running test suites if test order changes (`test/hooks.test.ts:156`, `test/hooks.test.ts:1138-1294`, `test/e2e.test.ts:*`)

`_resetConversationAccessWarningStateForTests` is exported and called only
in the `beforeEach` of `describe("registerHooks", ...)` at
`test/hooks.test.ts:147-158`. The two large describe blocks below
(`describe("redactToolArgs", ...)` at `:1138` and
`describe("redactPromptText", ...)` at `:1196`) both call `registerHooks`
and fire `before_tool_call` (e.g. `:1152, 1164, 1176, 1187, 1188`)
without resetting the module flags. The e2e tests likewise never call
the reset.

Today this is harmless because the only assertions on warning behaviour
live inside the conversation-access describe block, which resets
defensively. But:

1. Node's test runner reads `test/*.test.ts test/**/*.test.ts` in glob
   order, which is lexicographic on most filesystems. A future test file
   sorted alphabetically before `hooks.test.ts` (e.g. `test/audit.test.ts`)
   that fires `before_tool_call` without `llm_input` would set the
   module-scope `conversationAccessWarned = true`. The `beforeEach` at
   `:147-158` correctly *resets* that, so the existing tests survive —
   but only because the reset exists and is called before every assertion.
   The contract is "every test that asserts on the warning must call the
   reset". That contract is not enforced by code review (a future
   contributor adding a warning assertion in another file will not see
   the helper unless they grep for it).
2. The e2e proof tests at `test/e2e.test.ts:240-254` do not assert on the
   warning, but they do fire `before_tool_call` repeatedly through
   `harness.ts`. After running e2e, `conversationAccessWarned = true` at
   process scope. The `hooks.test.ts` tests reset, so they pass — but the
   reset is the only safety net.

Lower-effort mitigation: add a top-level `before(() => _resetConversation...)`
in any test file that asserts on warning behaviour, AND document on the
`_resetConversationAccessWarningStateForTests` JSDoc that callers must
invoke it before any warning assertion. The current comment at
`hooks.ts:78-80` documents intent but doesn't mandate caller behaviour.

Alternative (more invasive): inject the warning state via a parameter on
`registerHooks` so it's per-call rather than module-scoped, and have a
top-level `index.ts`-owned singleton hold the cross-instance bridge. That
removes the module-scope timeout entirely.

Severity **M** because the production behaviour is correct *today*; the
finding is about future-test-author footgun, not a current bug.

### [M] `system.install_hook_unavailable` is appended via `safeAppend` from inside the `try/catch` that surrounds `before_install` registration — but that registration runs at plugin init time, before any rate-limit window has accumulated, so the event passes through `RateLimiter.append`'s direct path. Correct, but only because of an implicit invariant about call timing (`src/hooks.ts:794-806`, `src/rate-limiter.ts:58-77`)

The event has `category: "system"` (`src/hooks.ts:802`), which is in
`FULL_FIDELITY_CATEGORIES` (`src/rate-limiter.ts:12`), so it would also
bypass coalescing if it ever reached the buffer. So in practice the event
is preserved. But the routing path is:

1. `registerHooks` is called from `src/index.ts` during plugin init
2. The catch fires synchronously if `api.on("before_install", ...)` throws
3. `safeAppend` calls `limiter.append` (when limiter is provided)
4. `limiter.append` checks `windowEvents < maxPerSec && buffer.length === 0`
5. At init time, both are 0, so the event takes the direct `store.append` path

This is correct but fragile. If a future change to `index.ts` calls
`registerHooks` after handling some prior burst of events (e.g. catching
up after a restart, replaying a queue), the buffer could be non-empty at
init and the install_hook_unavailable event would land in the buffer.
Because of `FULL_FIDELITY_CATEGORIES`, it would still be preserved when
the buffer drains. So the invariant survives — but only because two
unrelated mechanisms (init-time emptiness + system-category bypass) agree.

The e2e regression test at `test/e2e.test.ts:1265-1323` exercises the
"throws on register" path with a freshly-constructed limiter, so it does
not catch a regression where this event lands mid-stream during a real
operator run.

Severity **M** because the failure mode is operator-environment-dependent
and, even when it triggers, the system-category bypass keeps the event.
It's a robustness concern: two invariants must hold for the audit
guarantee, not one. Worth a comment at `src/hooks.ts:800-806` noting that
the event must remain in `FULL_FIDELITY_CATEGORIES` for correctness.

### [L] Dev environment installs openclaw 2026.4.1 even though the peer-dep floor is now `>=2026.4.24` (`package.json:34, 40`, `node_modules/openclaw/package.json`)

`devDependencies."openclaw": "^2026.4.1"` resolves to `2026.4.1` (verified
via `node_modules/openclaw/package.json`). The peer floor is now
`>=2026.4.24`. So the test suite runs against an openclaw runtime that
is **below** the peer floor — `before_install` is not in `PluginHookName`
on this runtime (`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1583`),
and the plugin's outer `try/catch` at `src/hooks.ts:748-806` exercises only
the warn-and-skip path (no throw, so the catch never fires under `npm test`
either).

This means:
- The `system.install_hook_unavailable` audit row is exercised only via
  the e2e flaky-api test at `test/e2e.test.ts:1265-1323` (which manually
  constructs a `flakyApi` whose `on("before_install")` throws). The "real"
  warn-and-skip behaviour of the dev openclaw is not exercised — but
  there's no event to observe in that path, so there's nothing to assert.
- The `before_install` happy path is exercised only via the test rig's
  mocked api in `test/harness.ts` and the e2e test at
  `test/e2e.test.ts:1330+`, neither of which uses the real openclaw event
  bus.

Practical impact: zero today (the plugin does not exercise any 2026.4.24+
behaviour at runtime). Forward-looking impact: the moment a new openclaw
hook is added that requires the 2026.4.24 dispatcher, `npm test` will
silently pass against the older runtime while real installs fail. Bump
`devDependencies."openclaw"` to `^2026.4.24` (or `>=2026.4.24`) so dev
testing aligns with peer-dep claims.

Severity **L** — process/CI hygiene rather than a code defect.

### [L] No test asserts that `system.install_hook_unavailable` has `category: "system"` and therefore bypasses coalescing (`test/e2e.test.ts:1265-1323`)

The e2e test for the registration-failure path asserts the event is
recorded and that its metadata mentions "before_install"
(`test/e2e.test.ts:1310-1316`). It does not assert `event.category ===
"system"` — i.e. it does not pin the rate-limit-coalescing-bypass
contract. If a future contributor edited `src/hooks.ts:802` to
`category: "agent"` (or any non-`FULL_FIDELITY_CATEGORIES` value), the
event would still land in the SQLite log under low load and the test
would pass; but under a realistic operator burst, the event would be
coalesced into a summary row and the operator's forensic signal would
be lost.

Lowest-effort mitigation: add `assert.equal(miss!.category, "system")`
at `test/e2e.test.ts:1316`, and a comment explaining why the category
matters. Severity **L**.

## What's done well

- The round-2 [H] fix uses a single source-of-truth (`effectiveMetadata`)
  for both persistence and the returned event. The read-back path
  (`src/store/audit-store.ts:97-115`) inverts cleanly through
  `JSON.parse(row.metadata)` because canonicalize is deterministic.
  Confirmed by running `npm test` and reading the e2e regression guard.
- The defensive guard at `src/store/audit-store.ts:289-293` (throw if the
  marker payload itself exceeds the cap) is a textbook fail-loud check
  that closes a future-regression vector.
- The `$auditTruncation` namespace key avoids collision with any plausible
  plugin-author-chosen key. Better than the original `metadataDropped`
  shape — a plugin auditing `metadataDropped` events would have had a name
  clash.
- The conversation-access warning tests (`test/hooks.test.ts:204-257`)
  thoroughly pin the once-per-process semantics, including the
  llm_input-first happy path. The `captureWarn` helper cleanly snapshots
  console.warn output without leaking across tests.
- `_resetConversationAccessWarningStateForTests` is correctly named with a
  leading underscore and `ForTests` suffix to signal "do not call from
  production". The narrow reset (just the two flags) is exactly right —
  no other module state needs unwinding.
- The peer-dep floor bump from `2026.4.15` → `2026.4.24` is the correct
  call. `2026.4.24` introduces `allowConversationAccess` (per the warning
  string at `src/hooks.ts:88-90` and the README), and the plugin's hooks
  code references this opt-in directly. A user on `2026.4.15-2026.4.23`
  would silently lose llm_input/output without the warning text being
  accurate (since the opt-in didn't exist on those versions). The bump
  aligns reality with documentation.
- The `description` clamp uses character math that is correct for the
  no-non-BMP case: `slice(0, 255)` (255 chars) + `…` (1 char) = 256 chars
  total. The 256/258-byte distinction noted in the round-2 report is moot
  because the description column is unbounded TEXT in SQLite (no VARCHAR
  cap to enforce).
- Type aliases at `src/hooks.ts:101-126` (`AgentCtxExtra`, `MessageCtxExtra`,
  `MessageEvtExtra`, `SessionFileEvt`, `SessionEndEvtExtra`) are reused at
  every relevant cast site. `grep -n "as typeof"` confirms a uniform
  pattern; no orphan inline structural casts remain.
- The `system.install_hook_unavailable` event correctly uses
  `category: "system"` (`src/hooks.ts:802`), which means it bypasses
  coalescing per `src/rate-limiter.ts:12, 144-152`. The category choice is
  semantically right (it's a system-level diagnostic) AND functionally
  right (full fidelity is what an operator wants for this kind of signal).
