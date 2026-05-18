# Code-quality review — feat/AG-122-reportWebhook-config

## Summary
- The shared `src/util/webhook.ts` extraction is clean and well-scoped — validation + POST primitive in one place with retry policy left to callers. Tests cover the surface adequately.
- `format-blocks.ts` is straightforward and has good test coverage including anomaly edge cases and the empty-store integrity branch.
- The main code-quality issue is duplication in `report-pusher.ts`: `formatYmd`, `weekStringFor`, and `pad2` are private helpers that re-implement logic already living in `time-window.ts`. The `dayMostRecentlyCompleted` / `weekMostRecentlyCompleted` flow is more roundabout than it needs to be as a result.
- `nextDailyAt` / `nextWeeklyAt` in `health()` are cached state, refreshed only inside `tick`/`start`. Between ticks the values can lag by up to 5 minutes (or, after `stop()`, indefinitely). Computing on demand is both simpler and more correct.
- Lifecycle: `start()` is not idempotent and the `AbortController` is not recreated in `stop()`, so a `stop()`-then-`start()` cycle leaves the service immediately aborting all retries. No external caller hits this today, but it's a footgun worth fixing or documenting.

## Findings

### M — Duplicated calendar helpers in `report-pusher.ts:263-286` vs `time-window.ts:165-179`
`formatYmd` (report-pusher.ts:263-268) is the exact body of `todayInTz` (time-window.ts:165-170) — and `todayInTz` already takes an injectable `Date`. `weekStringFor` (report-pusher.ts:270-282) is a copy of the private `isoWeek`+`isoWeekYear` pair (time-window.ts:122-145) with the formatting glued on; that formatting is exactly what `thisWeekInTz` (time-window.ts:173-175) produces. `pad2` is defined identically in both files (report-pusher.ts:284-286, time-window.ts:177-179). The cheap fix: replace `formatYmd(d, tz)` with `todayInTz(tz, d)` and `weekStringFor(d, tz)` with `thisWeekInTz(tz, d)`. Both private helpers then disappear, as does the local `pad2`. The duplication is a real maintainability cost because the two implementations *could* drift silently (e.g., if ISO-week math is ever fixed in one place).

### M — Roundabout `dayMostRecentlyCompleted` at `report-pusher.ts:220-226`
The chain is `todayInTz → parseDate → subtractCalendarDays → new Date → formatYmd`. Three of those steps exist only to convert between "YYYY-MM-DD string" and "Date object" representations. With the fix above this collapses to roughly `todayInTz(tz, new Date(this.now().getTime() - 86_400_000))` (UTC) or, for DST-correct local handling, `parseDate(todayInTz(tz, this.now()), tz)` to get today's local midnight as a Date, subtract via `subtractCalendarDays`, then feed straight to `todayInTz`. Either way the helper drops to two or three lines. Same observation applies to `weekMostRecentlyCompleted` at lines 232-239.

### M — `health()` returns stale `nextDailyAt`/`nextWeeklyAt` (report-pusher.ts:125-127, 241-251)
`refreshNextFireTimes` is only called from `start()` and the `finally` of `tick()`. Between ticks the `nextDailyAt`/`nextWeeklyAt` values in the returned snapshot can lag by up to the 5-minute tick interval, and after the tick that crosses a boundary they're set to the *new* "today's end" — correct for that moment but stale for the next 5 minutes. Trivial fix: compute these inline in `health()` from `this.now()` rather than reading from `this.state`. The persisted `service_health` row is still a snapshot — that's fine — but the live getter shouldn't be. (You can keep persisting them for observability, but the in-memory getter should be authoritative.)

### M — `start()` not idempotent; `AbortController` not reset in `stop()` (report-pusher.ts:100-123)
Two related lifecycle issues:
1. `start()` has no guard against being called twice. A second call would create a second `setInterval` and overwrite `this.timer`, leaking the first interval (it'd keep ticking until the process exits, modulo `unref`).
2. `stop()` aborts `this.abortController` but never replaces it. If anything later calls `start()` (e.g., on a config-watcher-driven restart, which isn't wired today but the registerService API supports it), every `postWithRetry` immediately returns `false` because `signal.aborted` is `true` on entry (line 175), and `delayOrAbort` returns immediately on entry (line 201).

If start-after-stop is genuinely unsupported, an `if (this.timer) throw new Error("already started")` guard would make that contract explicit. If it is supported, recreate the `AbortController` at the top of `start()`.

### L — `postWithRetry` for-loop is awkward (report-pusher.ts:171-196)
The `for (let attempt = 0; attempt < 2; attempt++)` with internal `continue` and `if (attempt === 0)` branching reads like a generalised retry loop but the bound is hard-coded to two. As two distinct sequential attempts the control flow is more transparent and the `continue` disappears. Not load-bearing — the current version works and is tested — but worth a small refactor if you're already touching the file.

### L — `pendingFocus`-style `disabled` flag (report-pusher.ts:72, 88-97, 101, 131)
The `disabled` boolean is set in the constructor and never cleared. The cascade is clear: undefined URL → disabled, unsafe URL → log + disabled. The only thing that would muddle this is if config-watcher gained the ability to swap webhook URLs at runtime — at that point `disabled` would have to become observable state, not constructor-frozen. Fine as-is for the current contract; flagging only as a "watch this if config hot-reload lands".

### L — README cadence caveat is informative but buried (README.md:29)
The "5-minute resolution; a digest scheduled for 00:00 may arrive anywhere in [00:00, 00:05)" line lives at the end of the table row. Operators scanning the table will likely miss it. Worth pulling out into a short prose note under the table, but not blocking.

### L — Comment on retention/registration order is load-bearing (`src/index.ts:540-546`)
Keep this one. It explains *why* the report-pusher is registered before retention (reverse-order shutdown), which is non-obvious and easy to break in a future reorder.

### L — Constructor side effect: clearing `webhookUrl` on unsafe URL (report-pusher.ts:95)
`this.webhookUrl = undefined` after the disable branch is harmless but redundant — `disabled` is the single source of truth and `tick()` already guards on both. Either drop the assignment or drop the `disabled` check from `tick()`; pick one to express the invariant.

## Out of scope but worth flagging
- The 30-second retry delay (`DEFAULT_RETRY_DELAY_MS`) combined with the 10-second POST timeout means a hung receiver can hold a tick for ~50s. If a tick can overlap the next `setInterval` fire, two ticks could run concurrently — re-entrancy through `tick()` would race on `this.state`. Probably belongs to the correctness lens.
- `fmtUsd` in `format-blocks.ts:189-191` hard-codes 4 decimal places. If costs ever exceed a few dollars the trailing zeros get noisy; if they're sub-cent the precision is fine. Belongs to the product/formatting conversation, not code quality.
