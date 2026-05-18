# Correctness review — `fix/verify-jump-to-interval`

## Summary

- Verifier `findTamperedRange()` is correct for the cases enumerated in the brief: boundary `=== smtLastSeq` inclusive, range starting at seq #1, single-row range, partial final batch, and exactly-`BATCH`-sized log. `BATCH` is the module-local constant at `src/services/verifier.ts:24` and resolves at the same scope as the new function.
- Server offset math at `src/ui/routes.ts:172-179` is correct for the happy path and for `focusSeq` beyond the highest sequence; pruned/missing `focusSeq` lands the user on a nearby page (acceptable graceful degradation).
- One real correctness bug: **negative or zero `focusSeq` is accepted** because `parseInt32` returns the integer as-is; the page is still computed but the URL is meaningless and the chip displays "#0" or "#-N". Low severity.
- Event-table hashchange/clearFocus/onFilters interactions were traced and contain no reload races — `this.focus` is mutated synchronously *before* the hash is updated, so the listener observes `before === after === undefined` and skips the redundant reload.
- `count(opts)` correctly ignores `limit/offset/order/includeContent` (none are referenced by `buildWhere`). `total` returned at `routes.ts:192` reflects the filter set, which keeps client paging arithmetic consistent.
- New tests are solid (specific sequence assertions, no smoke-only checks). No assertions were weakened.

## Findings

### M1 — Filter+focusSeq leaves the focused row off the returned page (documented, but still reachable)

`src/ui/routes.ts:172-179` — When `focusSeq` is set together with `type`/`category`/`session` filters and the focused row does **not** match those filters, the row simply isn't in the result set. The position computation still places the offset at "the page where the row *would* sit in the filtered desc list", which puts the user on a page that contains other rows but not the target. Concrete repro: 100 events all `category=A` except seq 50 (`category=B`); URL `/api/events?focusSeq=50&category=A&limit=10` → `position = count(afterSequence>50, cat=A) = 50`, `offset = 50`, page returns seqs `[49..40]`. Seq 50 is filtered out — the highlight is invisible.

The client at `event-table.ts:226-238` (`syncFromHash`) clears filters when focus is set, so the browser flow is safe. But the server is the source of truth and a hand-crafted URL or future API caller can hit this. Suggested fix (optional, since the diff comments call this out): either (a) document in `EventsQuery` that `focusSeq` is incompatible with filters, or (b) drop filters server-side when `focusSeq` is present (mirrors client), or (c) when `focusSeq` is passed, fall back to computing position from an unfiltered count so the row is guaranteed to be on the returned page (sacrifices filter, matches client intent).

### L1 — Negative/zero `focusSeq` is silently accepted

`src/ui/routes.ts:158` calls `parseInt32(url.searchParams.get("focusSeq"))`, which returns finite negative/zero values as-is. With `focusSeq = -5`, `count({afterSequence:-5,...})` equals the total event count, and the user lands on the *last* page with no chip highlight (sequences are always ≥1 in production). With `focusSeq = 0`, same outcome. Behavior is harmless but non-obvious. Suggested fix: reject `focusSeq < 1` (`if (focusSeq !== undefined && focusSeq >= 1)` guard) or treat ≤0 as "no focus".

### L2 — `focusSeq` referring to a pruned/never-existed sequence lands on an off-by-one page

`src/ui/routes.ts:174` — When `focusSeq` falls in a gap (e.g., pruned), `position = count(afterSequence>focusSeq)` is computed from existing rows only, so the resulting offset puts the user one page *too low* relative to where the row would be if it existed. Concrete repro: events `[1..5, 7..26]` (seq 6 pruned), `focusSeq=6`, `limit=10` → `position = 20`, `offset = 20`, page returns `[5..1]`. The first row of the prior page (seq 7) is where the user really wanted to be. Mostly harmless because the chip text still reads "Jumped to event #6" so the user knows the row is gone. Suggested fix: optional — if `position == count(all_filters_no_focus)` and `position > 0` (i.e. focusSeq is below the smallest matching row), back off by one page. Not worth the complexity.

### L3 — `clearFocus` reads `this.focus` after setting it (dead guard, harmless)

`src/control-ui/components/event-table.ts:279-285` — `clearFocus` sets `this.focus = undefined` then sets the hash. The hashchange listener at `:214-224` re-reads `this.focus` as `before` — at that point it is already `undefined`, so `before === after === undefined`, no reload. Intentional and correct, but slightly fragile: a future refactor that moves the focus-clear *after* the hash set would silently introduce a redundant reload. Suggested fix (defensive only): consider extracting a `setFocusFromHash(): boolean` returning whether anything changed, or use a single `applyFocus(info | undefined, reload: boolean)` helper. Not blocking.

### Verifier loop — verified correct

`src/services/verifier.ts:244-276`:

- `BATCH` is the file-level const at `:24`, in scope. ✓
- `order: "asc"` is passed on every query (`:253`). The `event.sequence > smtLastSeq` exit relies on ascending order, which is satisfied. ✓
- Boundary `event.sequence === smtLastSeq` is **inclusive** because the check is strict `>`. A tampered range ending exactly at `smtLastSeq` is correctly returned. ✓
- Range starting at seq #1 works (`min` is set on first encountered tampered row regardless of sequence number). ✓
- Single tampered row → `min = max = N`, returned as `{start: N, end: N}`. ✓
- Final partial batch: `batch.length < BATCH` short-circuits cleanly after the inner loop has processed *all* rows in the batch — no events are skipped. ✓
- Exactly-BATCH-sized log: first iter returns BATCH events (no early break since `batch.length === BATCH`); next iter with `afterSequence = lastSeq` returns 0 → `batch.length === 0` break. ✓
- `afterSeq` is updated even after the early-return-on-`>smtLastSeq` path is taken — but the function returns immediately on that branch, so the unused update is harmless.

### Server offset math — verified correct

`src/ui/routes.ts:172-179`:

- `focusSeq` is the highest sequence (`position = 0`): `offset = 0`. Page contains the focused row at index 0. ✓
- `focusSeq` is exactly on a page boundary (`position = 10`, `limit = 10`): `offset = 10`, page is rows `[10..19]`, the focused row sits at index 10 (start of page). ✓
- `focusSeq` is mid-page (`position = 15`, `limit = 10`): `offset = 10`, page is `[10..19]`, focused row at index 15. ✓
- `count(opts)` on line 192 returns the filter-scoped total, which is what the client paging UI expects. ✓
- `opts.offset = offset` is set before `count(opts)` is called; `count` calls `buildWhere(opts)` which never references `offset/limit/order/includeContent`. ✓

### `buildWhere` refactor — verified safe

`src/store/audit-store.ts:482-532`:

- All callers pass only `string | number | string[] (categoryIn)` into the field set referenced by `buildWhere`. No boolean, array-of-non-string, or undefined leaks into `params`. ✓
- Empty `categoryIn` correctly emits `1 = 0` (preserves "match nothing" intent). ✓
- `count({})` produces `WHERE` = "" and calls `.get({})` — better-sqlite3 accepts an empty params object on a parameterless statement. Existing test at `test/store/audit-store-query.test.ts:212-215` exercises this path with no opts. ✓

### Tests — verified solid

- `test/store/audit-store-query.test.ts:92-107` asserts exact `[3,4,5]`, `[1,2]`, `[2,3,4]` sequences — no smoke.
- `test/store/audit-store-query.test.ts:214-225` asserts specific count values (3/4/2 and 2/3).
- `test/ui/routes.test.ts:436-475` asserts `tamperedStart === tamperedA.sequence` and `tamperedEnd === tamperedB.sequence` for the multi-row tampering scenario, distinct from `sequenceStart/sequenceEnd`. Good coverage of the "tampered range narrower than checkpoint range" case. The test also verifies `mismatchAt.reason === "root-mismatch"`. ✓

## Out of scope but worth flagging

- `focusSeq` ingests un-validated user input into a SQL parameter binding. Already parameterized via `@afterSequence`, so injection is not possible; flagging only because the security lens will likely note bounds on the int.
