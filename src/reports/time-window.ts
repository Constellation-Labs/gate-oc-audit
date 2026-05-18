/**
 * Date / ISO-week parsing for `audit report daily|weekly`. Returns a
 * half-open ISO 8601 interval [fromIso, toIso) so the underlying SQL stays
 * `created_at >= @fromIso AND created_at < @toIso` — the same DST-friendly
 * semantics in both the `local` and `utc` branches.
 */

export type TimeZoneMode = "local" | "utc";
export type PeriodKind = "daily" | "weekly" | "since";

/** Narrow aliases so callers like `buildProjection` can reject "since" windows at compile time. */
export type DailyWindow = TimeWindow & { kind: "daily" };
export type WeeklyWindow = TimeWindow & { kind: "weekly" };
export type SinceWindow = TimeWindow & { kind: "since" };

export interface TimeWindow {
  /** "daily", "weekly", or "since" — passed through so callers don't need to re-decide. */
  kind: PeriodKind;
  /** Inclusive lower bound, ISO 8601 with offset (`...Z` for utc, local-offset for local). */
  fromIso: string;
  /** Exclusive upper bound, same format as fromIso. */
  toIso: string;
  /** Human label for the window ("2026-05-18 UTC", "Week 2026-W20 (Mon–Sun) UTC"). */
  label: string;
  /** Original tz mode the caller asked for. */
  tz: TimeZoneMode;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

/**
 * Parse `YYYY-MM-DD` and return the [00:00, next 00:00) window for that date
 * in the requested time zone. In `local` mode the boundaries snap to the
 * machine's local midnight, so a 25-hour DST fall-back day produces a
 * 25-hour window (and conversely a 23-hour spring-forward day produces 23).
 */
export function parseDate(dateStr: string, tz: TimeZoneMode): DailyWindow {
  const m = DATE_RE.exec(dateStr);
  if (!m) throw new Error(`--date must be YYYY-MM-DD (got "${dateStr}")`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`--date is not a valid date (got "${dateStr}")`);
  }
  // Sanity-check that the calendar actually has this day (e.g., reject Feb 30).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`--date is not a valid date (got "${dateStr}")`);
  }

  if (tz === "utc") {
    const from = new Date(Date.UTC(year, month - 1, day));
    const to = new Date(from.getTime() + 86_400_000);
    return { kind: "daily", fromIso: from.toISOString(), toIso: to.toISOString(), label: `${dateStr} UTC`, tz };
  }
  // local: Date(y, m-1, d) reads the constructor args as local. Adding 1 to the
  // day argument (rather than +86_400_000) lets JS resolve DST transitions
  // correctly — the next local midnight may be 23, 24, or 25 hours away.
  const fromLocal = new Date(year, month - 1, day);
  const toLocal = new Date(year, month - 1, day + 1);
  return {
    kind: "daily",
    fromIso: fromLocal.toISOString(),
    toIso: toLocal.toISOString(),
    label: `${dateStr} local`,
    tz,
  };
}

/**
 * Parse ISO 8601 week notation `YYYY-Www` (week 1 = the week containing Jan
 * 4 = the first week with a Thursday). Returns [Mon 00:00, next Mon 00:00).
 */
export function parseWeek(weekStr: string, tz: TimeZoneMode): WeeklyWindow {
  const m = WEEK_RE.exec(weekStr);
  if (!m) throw new Error(`--week must be YYYY-Www (got "${weekStr}")`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) {
    throw new Error(`--week number must be between 01 and 53 (got "${weekStr}")`);
  }

  // ISO 8601: week 1 contains January 4. Find the Monday of that week, then
  // step forward (week-1) weeks.
  if (tz === "utc") {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dow = jan4.getUTCDay() || 7; // Sunday → 7
    const week1Monday = new Date(jan4.getTime() - (dow - 1) * 86_400_000);
    const from = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
    if (isoWeek(from, "utc") !== week || isoWeekYear(from, "utc") !== year) {
      throw new Error(`--week ${weekStr} is not a valid ISO week`);
    }
    const to = new Date(from.getTime() + 7 * 86_400_000);
    return {
      kind: "weekly",
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      label: `Week ${weekStr} (Mon–Sun) UTC`,
      tz,
    };
  }
  // local
  const jan4Local = new Date(year, 0, 4);
  const dow = jan4Local.getDay() || 7;
  // Step by day-arg arithmetic so DST shifts inside the week resolve naturally.
  const week1Monday = new Date(year, 0, 4 - (dow - 1));
  const from = new Date(
    week1Monday.getFullYear(),
    week1Monday.getMonth(),
    week1Monday.getDate() + (week - 1) * 7,
  );
  if (isoWeek(from, "local") !== week || isoWeekYear(from, "local") !== year) {
    throw new Error(`--week ${weekStr} is not a valid ISO week`);
  }
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
  return {
    kind: "weekly",
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    label: `Week ${weekStr} (Mon–Sun) local`,
    tz,
  };
}

function isoWeek(d: Date, tz: TimeZoneMode): number {
  // Copy to a Thursday in the same ISO week (ISO weeks are anchored on Thu).
  const t = tz === "utc"
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (tz === "utc" ? t.getUTCDay() : t.getDay()) || 7;
  if (tz === "utc") t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  else t.setDate(t.getDate() + 4 - dayNum);
  const yearStart = tz === "utc"
    ? new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
    : new Date(t.getFullYear(), 0, 1);
  const diffMs = t.getTime() - yearStart.getTime();
  return Math.ceil((diffMs / 86_400_000 + 1) / 7);
}

function isoWeekYear(d: Date, tz: TimeZoneMode): number {
  const t = tz === "utc"
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (tz === "utc" ? t.getUTCDay() : t.getDay()) || 7;
  if (tz === "utc") t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  else t.setDate(t.getDate() + 4 - dayNum);
  return tz === "utc" ? t.getUTCFullYear() : t.getFullYear();
}

/**
 * Subtract `days` calendar days from an ISO 8601 instant, respecting the
 * given time zone. UTC: arithmetic on `getUTCDate()`. Local: arithmetic on
 * `getDate()`. The day-arg form lets JS resolve month/year rollovers and
 * DST transitions correctly — `lookbackDays * 86_400_000` ms-subtraction
 * would otherwise misalign the prior window across a DST boundary.
 */
export function subtractCalendarDays(iso: string, days: number, tz: TimeZoneMode): string {
  const d = new Date(iso);
  if (tz === "utc") {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - days,
                             d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())).toISOString();
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days,
                  d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).toISOString();
}

/** Default to "today" in the requested time zone. `now` is injectable for tests. */
export function todayInTz(tz: TimeZoneMode, now: Date = new Date()): string {
  if (tz === "utc") {
    return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  }
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Default to "this ISO week" in the requested time zone. `now` is injectable for tests. */
export function thisWeekInTz(tz: TimeZoneMode, now: Date = new Date()): string {
  return `${isoWeekYear(now, tz)}-W${pad2(isoWeek(now, tz))}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const DURATION_RE = /^(\d+)(m|h|d)$/;
// Catches `1z`, `7w`, etc. — anything that *looks* like a duration but uses
// an unsupported unit suffix, so we can give a targeted error instead of
// punting the user to the offset-shaped ISO branch.
const DURATION_LIKE_RE = /^\d+[a-zA-Z]+$/;

/**
 * Parse a "moment" — either a duration suffix relative to `now` (`15m`,
 * `1h`, `24h`, `7d`) or an ISO 8601 instant with explicit offset (`Z` or
 * `±HH:MM`). Returns an ISO 8601 string in UTC (`...Z`). Local-clock ISO
 * strings without offset are rejected so window boundaries are unambiguous.
 */
// Cap durations at ~1000 years. Above this, n * unitMs overflows safe-integer
// math and `new Date(...).toISOString()` either returns nonsense or throws
// `RangeError: Invalid time value` — neither is a useful CLI failure mode.
const MAX_DURATION_MS = 365_000 * 86_400_000;

export function parseInstant(input: string, now: Date = new Date()): string {
  const dur = DURATION_RE.exec(input);
  if (dur) {
    const n = Number(dur[1]);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`duration must be a positive integer (got "${input}")`);
    }
    const unitMs = dur[2] === "m" ? 60_000 : dur[2] === "h" ? 3_600_000 : 86_400_000;
    const totalMs = n * unitMs;
    if (!Number.isFinite(totalMs) || totalMs > MAX_DURATION_MS) {
      throw new Error(`duration exceeds maximum supported range (~1000 years; got "${input}")`);
    }
    return new Date(now.getTime() - totalMs).toISOString();
  }
  if (DURATION_LIKE_RE.test(input)) {
    throw new Error(`duration suffix must be m, h, or d (got "${input}")`);
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(input)) {
    throw new Error(
      `instant must be a duration (Nm|Nh|Nd) or ISO 8601 with explicit offset (got "${input}")`,
    );
  }
  const t = Date.parse(input);
  if (!Number.isFinite(t)) {
    throw new Error(`could not parse ISO 8601 instant "${input}"`);
  }
  return new Date(t).toISOString();
}

/**
 * Build a "since" window: `[parseInstant(since), parseInstant(until ?? now))`.
 * The label is the literal pair so the report shows exactly what the operator
 * asked for, not normalized ISO strings.
 */
export function parseSince(
  since: string,
  until: string | undefined,
  tz: TimeZoneMode,
  now: Date = new Date(),
): SinceWindow {
  const fromIso = parseInstant(since, now);
  const toIso = until === undefined ? now.toISOString() : parseInstant(until, now);
  if (toIso <= fromIso) {
    // Echo the original literals alongside the parsed ISOs so a user passing
    // `--since 1h --until 2h` sees both that the durations were swapped and
    // what they resolved to. Without the literals the error reads as two
    // wall-clock instants with no hint that "2h" means "two hours ago".
    const untilLabel = until === undefined ? "(now)" : until;
    throw new Error(
      `--until (${untilLabel} → ${toIso}) must be strictly after --since (${since} → ${fromIso})`,
    );
  }
  const label = `${fromIso} → ${toIso} (${tz})`;
  return { kind: "since", fromIso, toIso, label, tz };
}
