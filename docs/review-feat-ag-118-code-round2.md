# AG-118 per-conversation rollup — code-quality review (round 2)

Scope: the delta since round 1 only. Files touched:

- `src/cli.ts` — new `cliReportSessionHandler`, new exported helper
  `serializeSessionProjectionJson`, new `AuditReportSessionOptions` interface,
  `--limit` plumbed through `parsePositiveInt`.
- `src/index.ts` — two new `.option(...)` lines (`--limit`,
  `--include-metadata`) and the subcommand wiring.
- `src/reports/session-projection.ts` (uncommitted) —
  `BuildSessionProjectionOptions.limit`, query switched to
  `order: "desc"` + `.reverse()`, `truncated` now uses
  `store.count({ sessionId })`.
- `test/reports/session-projection.test.ts` (uncommitted) — one limit test
  + a new `serializeSessionProjectionJson` suite (3 tests).
- `test/reports/cli.test.ts` — trailing newline only.

Round 1 deferred items (B1–B4 + the nice-to-haves listed in the brief) are
intentionally **not** re-flagged here.

Findings are by severity; file:line refs are against the working tree.

---

## must-fix

_None._ The delta is well-contained and the security gating works as
advertised; remaining items are quality polish.

---

## nice-to-have

### R2-1. `serializeSessionProjectionJson` parameter type leaks an implementation detail
`src/cli.ts:421-429`

```ts
export function serializeSessionProjectionJson(
  projection: ReturnType<typeof buildSessionProjection>,
  includeMetadata: boolean,
): string {
```

`ReturnType<typeof buildSessionProjection>` is technically correct but it
makes the signature opaque at the call site and forces every consumer to
re-derive the shape. The module already exports `SessionProjection` from
`session-projection.ts:99` — that's the public surface and what the JSDoc
above the helper *describes* the input as ("Serialize a SessionProjection
…").

Recommend:

```ts
import type { SessionProjection } from "./reports/session-projection.js";
// …
export function serializeSessionProjectionJson(
  projection: SessionProjection,
  includeMetadata: boolean,
): string {
```

The `ReturnType<typeof …>` indirection is also a slight latent footgun: if
`buildSessionProjection`'s return type ever widens to a union (e.g.
`SessionProjection | ErrorShape`), the helper silently accepts the wider
type without a compile error to flag the new contract.

### R2-2. `serializeSessionProjectionJson` belongs next to `SessionProjection`, not in cli.ts
`src/cli.ts:413-429`

The justification for extracting the helper is sound (covered in R2-5
below), but its current location is awkward:

- It has no dependency on Commander, `outLine`, `console`, `process`, or any
  other CLI primitive — it's a pure `SessionProjection → string` function.
- The two tests for it live in `test/reports/session-projection.test.ts`
  (correctly — they cover projection-shaped data, not CLI behaviour), which
  now imports `serializeSessionProjectionJson` from `../../src/cli.js`. That
  reverse-direction import (test/reports → src/cli) is the smell.
- The sibling `formatSessionProjectionText` lives in
  `src/reports/format-session.ts`. JSON serialization with a redaction toggle
  is conceptually the same: a format adapter over the projection.

Recommend moving the helper (and its interface, if you ever grow one) to
`src/reports/format-session.ts` (or a new `src/reports/session-projection-json.ts`
if you'd rather keep text/JSON separate). The CLI then just calls
`serializeSessionProjectionJson(projection, opts.includeMetadata === true)`
and imports it from the same neighbourhood as `formatSessionProjectionText`.

### R2-3. `truncated` makes an unconditional second DB roundtrip
`src/reports/session-projection.ts:390`

```ts
const truncated = events.length >= limit && store.count({ sessionId }) > events.length;
```

JavaScript short-circuits `&&` so this is *not* always a second roundtrip —
the `count` only fires when `events.length >= limit`. For the default
`--limit` = `SESSION_FETCH_CAP` (50k) on a typical 12-event session, the
left operand is false and the count is skipped. Functionally correct.

That said, when a caller passes a small `--limit` (e.g. `--limit 50` on a
75-event session), the count *does* fire and indexes `session_id` again. Two
suggestions:

- Add a one-line comment noting the short-circuit is load-bearing — anyone
  reading `count({ sessionId }) > events.length` will wonder whether it
  always runs. Cheap insurance against a future refactor reordering
  operands.
- For sessions where `events.length === limit` (boundary case), the count
  query can resolve in one indexed lookup, so this is fine in practice. No
  action beyond the comment.

### R2-4. DESC + `.reverse()` parity comment is in the code; consider strengthening to a test invariant
`src/reports/session-projection.ts:373-386`

The comment explaining why DESC+reverse is used (parity with
`cliAuditHandler`) is good — it answers the "why not ASC?" question. The
test `--raw --limit N matches \`audit list --session <id> --limit N\``
(`test/reports/session-projection.test.ts:109-134`) locks the contract in.

Two minor things worth knowing:

1. **Performance**: at the SQL level, `ORDER BY sequence DESC LIMIT N` and
   `ORDER BY sequence ASC LIMIT N` cost the same when `sequence` is indexed
   (which it is — sequence is the PK monotonic column). SQLite walks the
   index in the requested direction and stops at N. No measurable slowdown
   on large sessions.
2. **Readability**: the `.reverse()` mutates the returned array in place.
   Not a bug (the result is fresh from `query()`), but pairing DESC+reverse
   in two lines with a four-line comment is more cognitive load than `ASC,
   limit` would be. The cost of switching to ASC is breaking the row-for-row
   parity with `audit list` for the last-N-events semantic — *which is the
   whole point*. Keep it as-is; the comment justifies it.

If you wanted to make this self-documenting at the call site rather than the
comment, a small helper like
`store.queryLastN({ sessionId, limit, contentPreview })` that does the
DESC+reverse internally would hide the asymmetry from both callers. Defer
unless a third caller materialises.

### R2-5. Helper extraction is correct; the test-driven smell is the location, not the existence
Conceptual.

The brief asks whether extracting `serializeSessionProjectionJson` for
testability is a clean abstraction or a test-driven design smell. Verdict:
**the extraction is clean; the location is the smell.** A
projection-→-string function with a redaction toggle has obvious value
independent of testing — gateway HTTP handlers, dashboard exporters, future
SDK consumers all want to call it. The handler itself shouldn't own the
serialization logic; that's a layering inversion.

Fixing R2-2 (move to `src/reports/`) resolves the smell. With the helper in
the reports layer, the test file imports it from `src/reports/…` (same
directory as `buildSessionProjection`) instead of reaching into `src/cli.js`,
and the abstraction reads as "projection format adapter" rather than "thing
extracted because stdout was hard to capture."

### R2-6. `parsePositiveInt` already rejects `--limit 0`; the inner `Math.max(1, …)` is dead
`src/cli.ts:438-448` + `src/reports/session-projection.ts:371`

```ts
// cli.ts:438
if (!Number.isInteger(n) || n <= 0) {
  throw new Error(`${flag} must be a positive integer (got "${value}")`);
}
```

```ts
// session-projection.ts:371
const limit = Math.max(1, Math.min(opts.limit ?? SESSION_FETCH_CAP, SESSION_FETCH_CAP));
```

`opts.limit` arriving at `buildSessionProjection` from the CLI has already
been validated by `parsePositiveInt` (`>= 1` or thrown). The `Math.max(1,
…)` is therefore a no-op for the CLI path.

For a *library-level* call into `buildSessionProjection` (e.g. a future
gateway handler that passes a JS number directly), `Math.max(1, …)` could
fire — but it silently rewrites bad input. Per the project's change
discipline ("no defensive guards"), pick one:

- **Strict**: drop the `Math.max(1, …)` clamp; throw on `opts.limit <= 0`.
  Mirrors `parsePositiveInt`. The CLI already enforces this, and a library
  caller passing `0` or `-1` is buggy.
- **Permissive**: keep the clamp but document that it tolerates non-positive
  input. Less recommended.

To answer the brief directly: yes, `--limit 0` *should* be an error rather
than silently rewritten. Today the CLI gets it right (`parsePositiveInt`
throws); the library entry point gets it wrong (the clamp swallows it). The
fix is on the library side, not the CLI side.

### R2-7. `--include-metadata` flag description lists "tool args / recipients" but recipients ship today
`src/index.ts:186`

```ts
.option("--include-metadata", "Include raw event metadata in --json output (off by default; may contain tool args / recipients)")
```

`recipient` is already in `SessionOutboundSend` (`session-projection.ts:75`)
and is emitted in the default JSON (it's not under `metadata`; it's a
top-level field on the outbound send). Listing it in the
`--include-metadata` warning suggests it's gated, which it isn't — only
metadata-blob fields are gated.

Suggest tightening to:

```
"Include raw event metadata in --json output (off by default; may contain tool args, prompts, secrets)"
```

Or drop the parenthetical and rely on the `--json metadata gating` test
suite name to document intent.

---

## nit

### R2-8. `{ metadata: _omit, ...rest }` does drop `metadata` from the inferred type
`src/cli.ts:427`

```ts
timeline: projection.timeline.map(({ metadata: _omit, ...rest }) => rest),
```

TypeScript correctly infers `rest` as `Omit<SessionTimelineEntry,
"metadata">`. The `_omit` underscore-prefix convention silences `noUnused`
warnings. This is fine.

One nit: the spread + destructure idiom rebuilds every timeline entry to
omit one field. For a 50k-event raw session that's 50k allocations. If the
JSON path is on a hot path (it isn't today, but might be for a dashboard
poller), the cheaper form is:

```ts
timeline: projection.timeline.map((e) => {
  const { metadata: _omit, ...rest } = e;
  return rest;
}),
```

…which is the same allocation cost. There's no faster form short of mutating
the projection (don't). Accept as-is.

### R2-9. Test cast `(e: { collapsedCount?: number })` can be tightened
`test/reports/session-projection.test.ts:314`

```ts
const collapsed = parsed.timeline.find((e: { collapsedCount?: number }) => (e.collapsedCount ?? 1) > 1);
```

`parsed` is `any` (from `JSON.parse`), so `parsed.timeline` is `any[]` and
`e` defaults to `any`. The annotation is there to narrow the predicate's
view of `e.collapsedCount` for type-safety inside the test. It's correct as
written and matches the round-trip-through-JSON nature of the data.

Tightening options:

- Define a local `type StrippedEntry = Omit<SessionTimelineEntry,
  "metadata">` and cast `parsed.timeline as StrippedEntry[]` once at the top
  of the test. Then `find((e) => …)` needs no annotation. Cleaner if you
  expect to add more tests in this suite.
- Or use `parsed.timeline.find((e) => (e.collapsedCount ?? 1) > 1)` and
  accept `e: any`. Tradeoff: loses the narrow but matches the JSON-blob
  reality.

Either is fine; the current form is defensible.

### R2-10. Test file `cli.test.ts` differs from baseline by exactly one trailing newline
`test/reports/cli.test.ts:104` (the appended blank line)

Confirmed: the file is 104 lines locally vs. 103 lines at HEAD
(`86d9df73`). The diff is a single trailing `\n` appended after the
existing terminator (visible as `+$` in `git diff` with `cat -A`). The
substantive test changes for the new feature live in
`session-projection.test.ts`, not here, as designed.

Recommend reverting to baseline before the PR
(`git checkout HEAD -- test/reports/cli.test.ts`) to keep the diff focused.
Zero behavioural impact either way.

### R2-11. `truncated` semantics differ subtly from the prior `>= cap` form
`src/reports/session-projection.ts:387-390`

Round-1 form (implicit from context): `truncated = events.length >= CAP`.
Round-2 form: `events.length >= limit && store.count({ sessionId }) >
events.length`.

The new form is more accurate: it distinguishes "we hit the cap" from "the
caller asked for a smaller window than the session has." Both are honestly
reported as `truncated: true`, which is the right contract.

One edge case: if `events.length === limit` and `count === events.length`
(session is *exactly* the size of the limit), `truncated` is `false`. That's
correct. Worth a passing test someday.

### R2-12. `SESSION_PROJECTION_SCHEMA_VERSION` did not bump
`src/reports/session-projection.ts:5`

Adding `truncated` accuracy improvements, `limit` option, and `--json`
gating doesn't change the wire shape — every output field that existed
before still exists and means the same thing. Leaving the version at `1` is
correct. Flagging only as confirmation, not a request to bump.

---

## summary

The delta is tight and the helper extraction is the right move. Top three
actionable items, in order:

1. **R2-2 / R2-5**: move `serializeSessionProjectionJson` from `src/cli.ts`
   to `src/reports/` (likely `format-session.ts`). Resolves both the
   "test imports from CLI" smell and the layering inversion in one go.
2. **R2-1**: change the helper's input type from
   `ReturnType<typeof buildSessionProjection>` to `SessionProjection`. Pure
   readability, no behaviour change.
3. **R2-6**: drop `Math.max(1, …)` from the `limit` clamp in
   `buildSessionProjection`; CLI validation already enforces positivity and
   the library-side silent rewrite violates change-discipline.

Everything else is comment-level or nit. No correctness or security
regressions introduced by round 2; the `--include-metadata` gating works
(test suite verifies the literal `hunter2` does not appear in the default
JSON, the strongest possible assertion for that contract). Test file
`cli.test.ts` is essentially unchanged (one trailing newline only) — revert
before merge to keep the diff clean.

DESC+reverse vs ASC: keep DESC+reverse. The parity argument with
`audit list` is real, the perf cost is zero on an indexed column, and the
comment + parity test together document the choice well.
