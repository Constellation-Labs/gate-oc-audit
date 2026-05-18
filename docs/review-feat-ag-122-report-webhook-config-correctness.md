# Correctness review — `feat/AG-122-reportWebhook-config`

## Summary

- Calendar-day and ISO-week math is sound in both `local` and `utc` modes; the one apparent ms-subtraction in `weekMostRecentlyCompleted` is incidentally DST-safe because the result only feeds back into ISO-week classification, not into a window boundary.
- One real concurrency bug: `tick()` is not re-entrant, so a long retry sleep can let a second tick fire and POST the same window twice.
- One real lifecycle bug: an exception thrown by `fireDaily` / `fireWeekly` (e.g. `buildProjection` failure) escapes `tick()` and surfaces as an unhandled promise rejection from inside `setInterval`. `service_health` is still persisted (in `finally`) but with `nextDailyAt` advanced while `lastDailyReportedDate` is stale.
- SDK service-stop order is genuinely reverse-of-registration (verified in `openclaw/dist/services-px5NopI_.js:48` — `running.toReversed()`), so the `register-before-retention` comment in `src/index.ts:548-551` is correct, not a guess.
- `notifications.ts` log strings are byte-identical to pre-refactor for both HTTP-status and network-error branches.
- Test suite has gaps for re-entrancy, weekly-only fire, ISO-week year boundary, and DST. Re-entrancy is fixable and worth testing; DST is hard to test without forcing process tz.

## Findings

### H1 — Re-entrant `tick()` can double-post the same window
**`src/services/report-pusher.ts:111-115, 130-147, 172-196`**

`setInterval` does not serialize async handlers. If tick N fails attempt 0 and is sleeping `retryDelayMs` (default 30 s) and a webhook outage stretches longer than 5 min, tick N+1 fires while tick N still holds the in-flight retry. Because `state.lastDailyReportedDate` is only advanced *after* a successful POST (line 157), tick N+1 sees `lastDailyReportedDate !== targetDay`, enters `fireDaily(targetDay)` again, and starts a second concurrent POST chain. If the server then comes back, both chains succeed and the same window is delivered twice (with two different `lastPushAt` writes racing on `state.lastPushAt`, and only the loser's `service_health` row persisted).

Repro: set `retryDelayMs = 10_000_000` (or stub the network to hang past `POST_TIMEOUT_MS * 2 + tickIntervalMs`), let tick N enter retry sleep, then call `svc.tick()` a second time before the sleep resolves — both will read `lastDailyReportedDate === <yesterday-1>` and both will POST. The existing `aborts an in-flight retry when stop() is called` test (line 1101 in the diff) already proves this re-entrant path is exposed.

**Fix:** guard `tick()` with a `private inFlight = false` flag (set at entry, cleared in `finally`); if already in-flight, return early.

### H2 — Exception in `fireDaily` / `fireWeekly` becomes unhandled rejection and leaves `service_health` inconsistent
**`src/services/report-pusher.ts:130-147, 149-169`**

`tick()` has a `try { … } finally { refreshNextFireTimes(); persist(); }` but no `catch`. If `buildProjection` or `parseDate` throws (e.g. store query fails mid-tick, or a future change adds a new throw site), the throw propagates out through the `void this.tick()` at line 112 and surfaces as an unhandled promise rejection. Two consequences:

1. The `finally` block still persists `state` — and `refreshNextFireTimes()` will advance `nextDailyAt`/`nextWeeklyAt` even though `lastDailyReportedDate` is unchanged. That is internally consistent (retry next tick) but `nextDailyAt` is no longer meaningful as a "next-fire" hint since the failure will be re-attempted on the *next interval*, not at the displayed instant.
2. On Node ≥15 unhandled rejections terminate the process by default; in plugin host the behavior depends on the host's process flags. Either way it's noisy.

`parseDate` cannot actually throw here because `dayMostRecentlyCompleted` synthesises the YYYY-MM-DD via `formatYmd` (line 263) — but `buildProjection` can throw on store I/O. The hazard is reachable.

**Fix:** wrap the try block body in a `try { … } catch (err) { log.error(`reportPusher tick failed: ${msg}`); this.state.lastPushError = msg; }` *inside* the existing try, before the `finally`. Keep `finally` for persist().

### M1 — Stop+restart of the service is broken by single-shot `AbortController`
**`src/services/report-pusher.ts:63, 117-123, 130-132`**

`abortController` is created once in the field initializer and never re-created. After `stop()` aborts it, a subsequent `start()` schedules a new interval but every `tick()` exits immediately at line 132 (`if (signal.aborted) return`) and `postWithRetry`'s first iteration short-circuits at line 175. Services are intended to be start-once, so this is unreachable in production, but the test harness exercises start→stop→… in `beforeEach`, and any future test that does start→stop→start on a single instance will silently no-op. Defense-in-depth: recreate the controller at the top of `start()`.

### M2 — `weekMostRecentlyCompleted` uses ms-subtraction across a tz boundary
**`src/services/report-pusher.ts:232-239`**

`time-window.ts:154-162` warns that ms-subtraction misaligns across DST; this site uses `new Date(w.fromIso).getTime() - 86_400_000`. The contract is "land somewhere inside the previous ISO week," and that contract still holds in both DST directions:

- Spring forward (Sun 02→03): Mon 00:00 local minus 24 h lands at Sun 01:00 local — still inside last week.
- Fall back (Sun 03→02): Mon 00:00 local minus 24 h lands at Sun 23:00 local — still inside last week.

The result feeds `weekStringFor`, which only inspects the calendar date, so the off-by-one hour is invisible. It is correct *by coincidence*, not by construction. Recommend switching to `subtractCalendarDays(w.fromIso, 1, this.tz)` for consistency with the rest of the codebase and to make the DST safety explicit, not implicit.

### M3 — `dayMostRecentlyCompleted` round-trips through ISO and re-parses, losing the tz channel
**`src/services/report-pusher.ts:220-226`**

The chain is `todayInTz → parseDate → subtractCalendarDays → new Date(iso) → formatYmd`. `subtractCalendarDays` returns an ISO string with offset (UTC `Z` or local-offset depending on tz); `new Date(iso)` re-parses to a moment-in-time; `formatYmd` then reads `getUTCDate()` or `getDate()` depending on `this.tz`. For `tz=utc` and `tz=local` on a non-DST day this is correct. On a spring-forward day in `tz=local`, `subtractCalendarDays` returns the prior local midnight serialised through `toISOString` (UTC), and re-reading with `getFullYear/getMonth/getDate` yields the correct prior-day calendar values because the moment is still inside the prior local day. Verified safe. Flagged only as architectural smell — replacing with a direct day-arg subtraction on a single `Date` would remove four conversions and the implicit assumption. No behavioural change required.

### L1 — `service_health` row written before any push on `start()` masks "never ran" from `health()` callers
**`src/services/report-pusher.ts:106-109`**

`start()` writes a row with both date markers populated and both `lastPushAt`/`lastPushError` `undefined`. External callers that read `service_health` cannot distinguish "fresh start, never tried to push" from "running fine, no push needed yet today." Minor — current readers all interpret `lastPushAt === undefined` correctly. Add a `startedAt` or similar if a future caller needs the distinction.

### L2 — Test gap: weekly fire is only covered alongside daily fire
**`test/services/report-pusher.test.ts:1024-1039`**

The only `fireWeekly` test (line 1024) jumps `Wed → Mon 00:01 UTC`, which makes *both* daily and weekly fire in the same tick. There is no isolated weekly-only test (e.g. start with `lastWeeklyReportedWeek` deliberately stale and `lastDailyReportedDate` already current). If `fireDaily` ever threw before `fireWeekly` (see H2), the bug would be invisible to the existing weekly assertion because the test depends on daily succeeding first.

### L3 — Test gap: ISO-week year boundary (`2026-01-01` is in `2025-W53`)
**`test/services/report-pusher.test.ts` (no such test) and `src/services/report-pusher.ts:270-282`**

`weekStringFor` is an inline reimplementation of `isoWeekYear`+`isoWeek` from `time-window.ts`. It is duplicated rather than re-exported, and no test pins year-rollover behavior (e.g. asking for the most-recently-completed week on `2026-01-04T01:00Z`, when "this week" is `2026-W01` and "last week" is `2025-W53`). Suggest either re-using the exported `isoWeek`/`isoWeekYear` helpers from `time-window.ts` or adding a year-boundary test.

### L4 — Test gap: re-entrancy and DST
**`test/services/report-pusher.test.ts`**

No test exercises a second `tick()` started while a first is in retry sleep (would surface H1 directly). DST is not testable without forcing the process tz at spawn time (`TZ=America/New_York node --test ...`), which the suite doesn't do — flag as known-uncoverable in this harness; consider a CI matrix entry that runs the tests under `TZ=America/Los_Angeles` for the next spring-forward Sunday in fixture data.

## Out of scope but worth flagging

- The pre-existing `parseDate` for `tz="local"` uses `fromLocal.toISOString()` (line 60 of `time-window.ts`), which produces a UTC-Z string from a local-anchored Date. The string round-trips correctly via `new Date(iso)`, but the *appearance* of the string is misleading (`2026-05-13T07:00:00.000Z` for a US-Pacific local midnight). Not a bug in this branch — pre-existing — but readers of `service_health.nextDailyAt` may be confused that "local" nextDailyAt is reported in UTC.
- `notifications.ts` and `report-pusher.ts` now both call `postJsonWebhook` but use different error-message formats (`Notification webhook returned X: Y` vs `webhook X: Y`). Intentional per the PR (incident logs vs operator-facing health field), just noting for future consolidation.
- `formatDigestBlocks` hard-codes `fmtUsd` to 4 decimal places (`$0.1234`). Fine for sub-cent LLM costs; readers eyeballing $50 daily spends will see `$50.0000`. Stylistic only — out of scope.
