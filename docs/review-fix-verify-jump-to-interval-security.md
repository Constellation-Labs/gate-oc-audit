# Security review — `fix/verify-jump-to-interval`

## Summary

- The new `focusSeq` query param on `/api/events` is integer-validated by `parseInt32` and feeds a parameterised `count()` against `sequence > @afterSequence`. `sequence` is the table's primary key, so even pathological inputs (negative, very large, zero) resolve via index lookup — no SQLi, no expensive scan.
- The `buildWhere` refactor preserves prepared-statement binding for every column, including the `categoryIn` IN-list. Param names are uniquely generated (`@categoryIn0`, `@categoryIn1`, …) and never collide with the fixed-name bindings; the shared `params` object is supplied to both `query()` and `count()` via better-sqlite3's named-bind API, so user strings cannot influence SQL structure.
- The Lit templates added in `verify-panel.ts` and `event-table.ts` use only text-interpolation bindings (`${expr}`) — no `unsafeHTML`, no attribute-context expressions taking attacker data. XSS surface is unchanged.
- `Verifier.findTamperedRange` adds a full-table-scan + per-row gunzip on the mismatch path of `/api/verify`. Output is purely numeric (`{start,end}`), so there's no new information-disclosure channel, but it materially amplifies CPU work per request on an endpoint that has no concurrency cap.
- `/api/verify` has no loopback/opt-in gate equivalent to `/api/export`; the diff doesn't introduce this gap, but the new code increases the cost of leaving it ungated. Pre-existing TODO at `src/ui/routes.ts:1-5` already acknowledges all routes here lean on the loopback default for safety.

## Findings

### M1 — `/api/verify` lacks the concurrency cap and loopback gate now that it does a full-content rescan

`src/ui/routes.ts:327-350`, `src/services/verifier.ts:244-276`

The verifier already replayed every event with `includeContent: true` (gunzip cost) during `verifyRange`. The new `findTamperedRange()` runs a *second* full pass with `includeContent: true` whenever a root mismatch is hit — calling `smtService.computeRawHash(event)` and `findContainingTreeKey(rawHash)` on every row up to `smtLastSeq`. There is no `MAX_CONCURRENT_VERIFIES` (compare `MAX_CONCURRENT_EXPORTS = 2` at `src/ui/routes.ts:63`) and no `isNonLoopback` gate on the `/api/verify` POST handler. If the gateway is ever bound non-loopback, an unauthenticated client can repeatedly POST `/api/verify` with a wide window to pin the event loop on gunzip + hashing. Mitigation: add an in-flight counter mirroring the export limiter, and apply the same `ctx.isNonLoopback() && !allowVerifyOnNonLoopback` 403 to `/api/verify` (or document explicitly that verify is loopback-only and reject non-loopback by default). At minimum, short-circuit `findTamperedRange()` once `min`/`max` have been established for a configurable maximum row budget.

### L1 — `focusSeq` accepts negative integers and silently lands on the last page

`src/ui/routes.ts:158, 173-178`, `src/store/audit-store.ts:498-501`

`parseInt32("-1")` returns `-1` (finite, integer), which flows into `count({afterSequence: -1})` → matches all rows → `offset = lastPage`. Functionally a no-op DoS-wise (one indexed COUNT(*)), but it's an unvalidated coercion of attacker-controllable input into a numeric DB filter, and the client-side `readFocusFromHash` in `src/control-ui/components/event-table.ts:54` also accepts negatives via `Number()` and forwards them. Recommend clamping `focusSeq` to `>= 0` server-side (and similarly `rangeStart`/`rangeEnd >= 0` in the hash parser) so the contract matches the underlying `sequence` domain. Hardening, not exploitable.

### L2 — URL-hash params propagate without bounds to a server-side count

`src/control-ui/components/event-table.ts:47-63, 248-263`

`readFocusFromHash` parses `focusSeq`/`rangeStart`/`rangeEnd` with `Number()` then `Number.isFinite`. `Number("1e15")` is finite, so a crafted URL hash forwards arbitrarily large integers to `/api/events?focusSeq=…`. The server then issues `count({afterSequence: 1e15})`, which is cheap (indexed) and returns 0, so the page renders empty — no harm. Listed only because the chain "DOM hash → fetch URL → SQL bind" is exactly the shape that often grows into an injection later; keeping the client clamp tight (`Number.isInteger(seq) && seq >= 0 && seq <= 2**31-1`) closes the door. The `rangeStart`/`rangeEnd` values are pure rendering (`tr.row.focused` class check) and never reach the server, so they're inert beyond UI confusion.

## Out of scope but worth flagging

- `src/ui/routes.ts:174` — when `focusSeq` is set the server *ignores* an explicit `offset` query param. That's the intended UX but means a client that passes both gets behaviour different from the docstring. Correctness lens, not security.
