# Correctness review (round 2) — `feat/AG-118` delta

Base: round 1 (`docs/review-feat-ag-118-correctness.md`) · Branch:
`feat/AG-118-per-conversation-rollup` · Scope: the `--limit` / `--include-metadata`
delta on top of round 1.

Round 1 must-fix items B1–B4 (contentLength fallback, tool.denied,
smtLastSeq skip, smtRoot-only-when-verified) are **known and deferred** —
not re-litigated.

Test suite: `npm test` → 656 pass / 1 skipped / 0 fail (27.8s, 657 total).
Focused suite (`session-projection.test.ts` + `cli.test.ts`) → 16 / 16 pass.

Severity tags: blocker / must-fix / nice-to-have / nit.

---

## Priority 1 — `--raw --limit N` parity with `audit list --session X --limit N`

**Verdict: PASS at every session size.**

Trace:
- `cliAuditHandler` (`src/cli.ts:62-85`): `buildQueryOpts` populates
  `q.limit` from `opts.limit` (or `opts.last`); `q.contentPreview = 500`;
  no `order` is set, so `store.query` defaults to `DESC`
  (`audit-store.ts:616`); then `events.reverse()` produces ASC.
- `buildSessionProjection` (`src/reports/session-projection.ts:379-386`):
  `store.query({ sessionId, order: "desc", limit, contentPreview: previewChars })`
  + `.reverse()` produces ASC.

Both paths now select the **last `limit` events of the session by sequence**
and present them ASC. For session sizes ≤ limit, both enumerate all rows.
For session sizes > limit, both return sequences `[count-limit+1 .. count]`
in ASC order — identical sets, identical order.

The 75-event test at `test/reports/session-projection.test.ts:109-134`
exercises the > limit path explicitly with `limit: 50`, asserting
`p.timeline.map(e => e.sequence)` deep-equals
`store.query({ sessionId, limit: 50 }).reverse().map(e => e.sequence)`.

Subtle differences considered:
- **contentPreview**: `cliAuditHandler` hard-codes 500; `buildSessionProjection`
  defaults to 500 via `DEFAULT_CONTENT_PREVIEW_CHARS`. No divergence in
  default CLI use.
- **Default limit when `--limit` not specified**: `cliAuditHandler` falls
  through to `store.query`'s 50-row default; `buildSessionProjection` falls
  through to `SESSION_FETCH_CAP = 50_000`. So *without* `--limit`, the two
  commands no longer match — that was round 1 must-fix #1 and is the
  documented behaviour ("`--raw` shows all session rows; pass `--limit N`
  for parity with `audit list`"). The help text at `src/index.ts:184`
  ("default: all, capped at 50000") communicates this. The PRD-level parity
  claim is now scoped to "when both commands are given the same `--limit N`".

No new finding on priority 1.

---

## Priority 2 — `--limit N` with N ≥ total events

**Verdict: PASS.**

When the session has `C` events and `N ≥ C`:
- `store.query({ sessionId, order: "desc", limit: N })` returns all `C`
  rows (DESC) — SQL `LIMIT N` doesn't enlarge result sets.
- `events.length === C`.
- `truncated = events.length >= limit && store.count({ sessionId }) > events.length`
  → `C >= N` is true only when `N === C`; in that subcase
  `store.count({ sessionId }) > events.length` is `C > C` = false. → `truncated = false`. ✓
- When `N > C`: `events.length >= limit` is `C >= N` = false. → `truncated = false`. ✓

The slice contains all events; the windowed aggregations therefore reflect
the full session in this regime — semantically correct.

---

## Priority 3 — `--limit N` interaction with aggregations (window-only semantics)

**Verdict: PASS.**

`buildSessionProjection` calls `aggregateTools(events)`,
`aggregateLlmCost(events)`, `aggregateOutbound(events, previewChars)`, and
`computeIntegrity(events, ...)` — all four take the already-windowed `events`
slice (`src/reports/session-projection.ts:407-410`). There is no
parallel "full session" query inside the projection; `store.count({
sessionId })` is invoked only for the `truncated` flag check at line 390 and
its return value is not used in aggregations.

`jobId` hoisting (`session-projection.ts:400-404`) also iterates over
`events` (the slice), not the full session. Consequence worth flagging
(nice-to-have, not a defect):

### nice-to-have R2-1 · `jobId` may be `null` when `--limit N` excludes `cron.executed`

**File:** `src/reports/session-projection.ts:400-404`

The session's `cron.executed` row carries the canonical `jobId` and is
emitted near the start of a cron run. When `--limit N` drops the earliest
rows (because `N < count`), the slice may not contain `cron.executed`,
and the resulting projection has `jobId: null` even though the underlying
session was cron-triggered.

This matches the documented "window-only" semantic the user chose, and is
not a regression. Flagging because a future operator reading
`session-NNNN.json --limit 5` will see `jobId: null` for a clearly
cron-driven session and may misread it as "non-cron session". Cheap
mitigation: in the windowed case, also fetch the first event of the
session (cost: one row) just to lift `jobId`. Not required for AG-118
acceptance.

No other aggregation was inadvertently left global.

---

## Priority 4 — `truncated` flag accuracy

**Verdict: PASS for the three documented cases; additional edge case noted.**

Formula: `events.length >= limit && store.count({ sessionId }) > events.length`
(`src/reports/session-projection.ts:390`).

- **Exactly `limit` events:** `events.length === limit`, count `== limit`,
  → `count > events.length` is false → `truncated = false`. ✓
- **`limit + 1` events:** `events.length === limit` (SQL caps to limit), count
  `== limit + 1` → `count > events.length` is true → `truncated = true`. ✓
- **0 events:** `events.length === 0`, `0 >= limit` is false for any
  `limit >= 1` (clamp guarantees) → `truncated = false`. ✓
- **`--limit 0` clamped to 1, 0 events:** clamp produces `limit = 1`;
  `events.length === 0`; `0 >= 1` false → `truncated = false`. ✓

### nice-to-have R2-2 · `store.count({ sessionId })` adds a second SQL roundtrip per report

**File:** `src/reports/session-projection.ts:390`

The truncated check fires `store.count({ sessionId })` even when
`events.length < limit` (cheap and useful), and even in the common case
when the session is small. For the typical 12-event session this adds one
`SELECT COUNT(*) FROM audit_events WHERE session_id = ?` per `audit
report session` invocation. Negligible cost at current scale; flagging
because the count is only needed when `events.length === limit` (and could
be guarded with `if (events.length >= limit) const total = store.count(...)`).

Already partly guarded by the short-circuit on `events.length >= limit`
(JS `&&`), so the `store.count` call is skipped when the slice is smaller
than the limit. Re-reading the code: **the short-circuit is correct** —
`store.count` only runs when `events.length >= limit`. No fix needed;
withdrawing the perf concern.

---

## Priority 5 — `--limit` boundary handling

**Verdict: PASS.**

Two-layer defence:
1. CLI layer (`src/cli.ts:438-448`, `parsePositiveInt`): rejects
   `undefined → undefined` (passes through), non-integer (`1.5`, `"abc"`,
   `"NaN"`), zero, negative, > max (50_000). Throws an `Error` with a
   helpful message; this propagates up to commander which prints the
   error and exits non-zero. Behaviour is identical to the existing
   `--dup-window-sec` / `--lookback-days` / `--top-tools` flags.
2. Projection layer (`session-projection.ts:371`):
   `Math.max(1, Math.min(opts.limit ?? SESSION_FETCH_CAP, SESSION_FETCH_CAP))`.
   Programmatic callers (non-CLI) that bypass `parsePositiveInt` are
   clamped: negative or zero → 1; > 50_000 → 50_000; undefined → 50_000.

### nit R2-3 · NaN slips past the projection-layer clamp

**File:** `src/reports/session-projection.ts:371`

`Math.min(NaN, 50000)` is `NaN`; `Math.max(1, NaN)` is `NaN`. A
programmatic caller passing `limit: NaN` would yield `limit = NaN`,
which propagates to SQL as a `NaN` parameter — SQLite would coerce to 0
or error, depending on the binding. The CLI path can't produce NaN
(parsePositiveInt rejects), so this only matters to direct in-process
callers. One-line fix:
```ts
const rawLimit = opts.limit;
const limit = Number.isFinite(rawLimit)
  ? Math.max(1, Math.min(rawLimit as number, SESSION_FETCH_CAP))
  : SESSION_FETCH_CAP;
```

Cosmetic; no test covers this path.

---

## Priority 6 — Metadata stripping correctness

**Verdict: PASS.**

`serializeSessionProjectionJson` (`src/cli.ts:427-436`):
```ts
if (includeMetadata) return JSON.stringify(projection);
return JSON.stringify({
  ...projection,
  timeline: projection.timeline.map(({ metadata: _omit, ...rest }) => rest),
});
```

Destructuring with `...rest` preserves every other enumerable property of
the timeline entry:
- `sequence`, `id`, `createdAt`, `eventType`, `category`, `description`,
  `contentHash`, `contentPreview`, `collapsedCount`, `collapsedSequences`
  — all preserved.
- `metadata` — omitted.

Test coverage in `test/reports/session-projection.test.ts:278-317` covers:
- `metadata` absent on every timeline entry (`:286-288`).
- Secret literal `hunter2` (planted in `metadata.args.cmd`) does not appear
  anywhere in the JSON (`:289`).
- `includeMetadata=true` restores full metadata (`:297-300`).
- Dedup mode also strips metadata, and `collapsedCount` survives stripping
  (`:303-317`).

Sections outside `timeline` are not touched: `toolsUsed` (toolName, calls,
errors, durationMs), `llmCost` (provider, model, tokens, cost),
`outboundMessages` (channel, recipient, contentHash, contentLength,
success), `integrity` (counts, smtRoot). The user prompt confirms this is
intentional — the text formatter prints all of these fields, so gating
them would hide visible info.

### nit R2-4 · `outboundMessages[].bodyPreview` is still present after stripping

**File:** `src/reports/session-projection.ts:81-85`, `src/cli.ts:432-435`

The strip removes `metadata` from each `timeline` entry but leaves
`outboundMessages[].bodyPreview` untouched. That field carries up to 500
chars of the actual outbound message body — channel content, not tool
args, but still PII-adjacent (phone numbers and message text are in the
12-event fixture). The text formatter does print this preview
(`format-session.ts:80-86` based on the read above), so gating it would
hide visible info — consistent with the documented policy. Flagging
because the round 1 security review's M1 (the basis for adding
`--include-metadata`) was specifically about "data the text formatter
never prints"; `bodyPreview` does land in both surfaces, so this is
consistent — but a future tightening might also consider redacting
`bodyPreview` under a separate flag. Out of scope for this round.

---

## Priority 7 — Test reshuffle

**Verdict: PASS.**

- `test/reports/cli.test.ts` vs main: `git diff main -- test/reports/cli.test.ts`
  shows only a single trailing newline added. Structurally identical. ✓
- Metadata-gating tests in
  `test/reports/session-projection.test.ts:252-318` call
  `serializeSessionProjectionJson(projection, false|true)` directly and
  inspect the parsed JSON. No `console.log` monkey-patching, no stdout
  capture, no node:test reporter interference. ✓
- All tests pass (see top of report).

---

## Priority 8 — PRD R4 acceptance criteria still hold

**Verdict: PASS.**

- **12-event session, `--raw` (no `--limit`)**: the existing test at
  `test/reports/session-projection.test.ts:136-157` still passes. The
  DESC + reverse path returns the same 12 sequences as ASC (a session
  with 12 events and `limit = 50_000` triggers no truncation). The deep-equal
  assertion against `store.query({ sessionId, limit: 50 }).reverse()` holds
  because 12 ≤ 50 — both queries return the same set.
- **Default mode dedups four near-duplicate rows**: test at `:84-107`
  passes; the slice contains all 12 events, dedup runs over them, four
  rows collapse to one anchored on `prompt.response`. ✓
- **Latency < 1s**: test at `:242-249` passes; the new DESC + reverse path
  adds one Array reverse on at most `limit` rows — O(n) and immeasurable
  compared to the SQLite roundtrip. The PRD R4 budget excluded
  `ensureReady()` (round 1 nice-to-have #1); that's unchanged.

The round 1 must-fix #1 ("`--raw` parity quietly breaks above 50 events")
is **resolved** by the AG-118-Round-2 delta:
- Either the user passes `--limit N` and parity is exact (priority 1
  verdict above).
- Or the user doesn't pass `--limit`, in which case `--raw` shows all
  rows; the help text at `src/index.ts:184` documents this.

---

## Summary

- **0 blockers.**
- **0 must-fix.** The B1-B4 deferred items from round 1 still apply; the
  delta does not introduce new must-fix bugs.
- **2 nice-to-have**:
  - R2-1: `jobId` becomes `null` when `--limit` excludes `cron.executed`.
    Window-only semantic is by design; this is a UX rough edge.
  - (R2-2 retracted on second read.)
- **2 nits**:
  - R2-3: NaN slips past the projection-layer clamp (programmatic-caller
    edge case; CLI is safe).
  - R2-4: `outboundMessages[].bodyPreview` is not gated by
    `--include-metadata`; intentional per the text-formatter-parity rule
    but flagging for a possible future redact-channel-bodies flag.
- **Test count**: 657 total (656 pass, 1 skipped), up from the round 1
  baseline of 653 — the 4 new tests added in this delta are the 75-event
  parity test and 3 metadata-gating tests. Focused suite (`session-projection.test.ts`
  + `cli.test.ts`) = 16 tests, all green.

Recommended fix order:
1. (nice-to-have R2-1) Decide on `jobId` semantics when the window
   excludes `cron.executed` — either accept null with a comment, or fetch
   the first session row separately.
2. (nit R2-3) Guard `Number.isFinite(opts.limit)` before the clamp.
3. (nit R2-4) Decide whether `outboundMessages[].bodyPreview` should be
   gated by a future flag.
