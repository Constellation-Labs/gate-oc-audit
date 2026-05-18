# Code-quality review — `fix/verify-jump-to-interval`

## Summary
- Feature is well-scoped: `tamperedStart/End` on the mismatch result, a server-computed offset for `focusSeq`, and a sticky "marker, not filter" chip in the event table. Names and comments are mostly load-bearing.
- The verifier scan (`findTamperedRange`) is a clean addition but is asymmetric with the verifier's own replay (uses the live SMT to check, not the just-replayed one) — that "why" is doc-worthy and the existing comment captures it well.
- `AuditStore.count(opts)` was promoted to take filters, which is the right shape for the server's offset math. Tests for the store changes are thorough.
- HTTP-level test for the new `focusSeq` query param is missing — the offset-snap math has no integration coverage.
- One bit of dead API (`beforeSequence`) is introduced but never used by any caller. One bit of likely over-engineering in `event-table`'s `pendingFocusSeq` vs. `focus` split.

## Findings

### M — Dead API: `beforeSequence` is added but unused by callers
`src/store/audit-store.ts:38,502-505` introduces `beforeSequence` to `QueryOptions` and wires it into `buildWhere`, with three new unit tests covering it. But no production code path (verifier, routes, export, index) passes `beforeSequence`. The jump-to-interval flow ended up using server-side `count({afterSequence})` for offset math, not a windowed `query`. Either delete the option until something needs it (your `Change Discipline` rule), or land the caller that motivated it in the same PR. Leaving a tested-but-unused query parameter invites future drift between the SQL and the only callers exercising it (tests).

### M — Missing HTTP test for the `focusSeq` offset-snap behaviour
`src/ui/routes.ts:158-179` is the load-bearing piece of the feature: given a `focusSeq`, the server has to compute the same-filter position via `count({...opts, afterSequence: focusSeq})` and snap to a page boundary. `test/ui/routes.test.ts` adds a verifier-level test for `tamperedStart/End` but no test hits `/plugins/audit/api/events?focusSeq=N` to confirm the returned `offset` actually puts that sequence on the page. Three small cases would suffice: focus on first row, focus on a row deep in the log, focus combined with `type=` filter to confirm the `...opts` spread carries through.

### M — `findTamperedRange` has no direct test for its two early-exit branches
`src/services/verifier.ts:244-276`. The new tamper test only exercises the happy path (two scattered mutations, both inside `smtLastSeq`). The two early exits — (1) `batch.length === 0` with no tamper found, and (2) crossing `event.sequence > smtLastSeq` mid-batch — are untested. The second one is particularly worth covering because it's the only branch that returns `undefined` despite having scanned events (when min/max were never set before crossing the high-water mark). Pair this with a test for the `reason: "events-missing"` case showing `tamperedStart/End` stay undefined (currently asserted only by absence in the tamper test).

### L — Comment in `findTamperedRange` overstates the cross-checkpoint case
`src/services/verifier.ts:30-34, 240-243`. Both the field doc and the function comment claim the tampered range "may live outside the *first* failing checkpoint, e.g. if the failing cp's recompute diverged for an unrelated reason." That's an interesting hedge, but the scan iterates `afterSequence: 0` upward over the whole audit store — it doesn't actually try to *prove* the inside-vs-outside claim, it just reports whatever the SMT disagrees with. The comment reads like a justification for a feature the code doesn't really provide (the verifier already stops at the *first* failing cp, so callers only ever see one mismatch object). Trim the comment to: "Scan every event the SMT tracks and bracket the [first, last] sequence whose current content no longer matches a leaf. Mirrors `classifyEvent`'s tampered/untracked rule."

### L — `pendingFocusSeq` + `focus` is one state too many for what it does
`src/control-ui/components/event-table.ts:194-200, 226-239, 241-265`. `pendingFocusSeq` exists solely to be sent on the *next* `load()` and then cleared. But `this.focus.seq` already carries that value, and `load()` is the only consumer. A cleaner shape: track a `pendingFocus: boolean` (set by `syncFromHash`, cleared in the `finally`) and pass `focusSeq: this.pendingFocus ? this.focus?.seq : undefined`. One field instead of two, and the invariant "if we're focusing, the seq is on `this.focus`" stops being implicit.

### L — `page()` and `jumpToOffset()` collapse to one method
`src/control-ui/components/event-table.ts:292-304`. Both compute `Math.max(0, Math.min(target, this.lastPageOffset()))`, bail on no-change, set `this.offset`, then `void this.load()`. `page(delta)` is just `jumpToOffset(this.offset + delta * PAGE_SIZE)`. Fold it.

### L — Hash construction is duplicated between `clearFocus` and `onFilters`
`src/control-ui/components/event-table.ts:267-285`. Both write `window.location.hash = "#/events"`. Tiny, but a `clearFocusHash()` helper (or just have `onFilters` call `clearFocus`) would make the "filter retires focus" invariant single-sourced.

### L — Stale TODO-style comment removed but its successor over-explains
`src/control-ui/components/verify-panel.ts:122-131`. The old `jumpToInterval` had a "Phase 1 event-table doesn't read query params yet" note that was legitimately load-bearing because the event table ignored the hash. The new `jumpRange` comment is fine but five lines for a two-line function is a lot — the load-bearing part is just "fall back to the checkpoint range when `tamperedStart` is unset (events-missing has nothing to scan)." The rest restates what the event-table doc already says.

### L — `seq-chip` button uses a literal `×` glyph as button content
`src/control-ui/components/event-table.ts:350`. `<button title="Dismiss marker">×</button>` has no accessible name beyond the title (which a11y trees handle inconsistently). `aria-label="Dismiss marker"` would be the conventional fix. Stylistic nit — flagging because the rest of this component is otherwise accessible.

## Out of scope but worth flagging
- `src/ui/routes.ts:158,173`: `focusSeq = parseInt32(...)` can be negative or zero with no clamp; `count({afterSequence: 0})` returns total, so `focusSeq=0` snaps to the last page rather than rejecting. Correctness lens.
- `src/services/verifier.ts:248-273`: `findTamperedRange` re-paginates via `afterSequence = event.sequence`, but if the very first event is past `smtLastSeq` the function returns `undefined` before `afterSeq` advances — fine here, but the loop guard `if (batch.length < BATCH) break;` assumes batches are dense; correctness lens should double-check it can't loop forever on a sparse sequence column.
