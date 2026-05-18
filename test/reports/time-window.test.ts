import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDate, parseWeek, todayInTz, thisWeekInTz, subtractCalendarDays } from "../../src/reports/time-window.js";

describe("parseDate", () => {
  it("parses YYYY-MM-DD in UTC into a 24h window", () => {
    const w = parseDate("2026-05-18", "utc");
    assert.equal(w.kind, "daily");
    assert.equal(w.fromIso, "2026-05-18T00:00:00.000Z");
    assert.equal(w.toIso, "2026-05-19T00:00:00.000Z");
    assert.equal(w.tz, "utc");
    assert.match(w.label, /UTC/);
  });

  it("parses YYYY-MM-DD in local tz with day-arg arithmetic (handles DST)", () => {
    // Window must be exactly one calendar day in the local zone, even if a
    // DST transition makes it 23 or 25 hours.
    const w = parseDate("2026-05-18", "local");
    assert.equal(w.kind, "daily");
    const from = new Date(w.fromIso);
    const to = new Date(w.toIso);
    assert.equal(from.getDate(), 18);
    assert.equal(to.getDate(), 19);
    assert.equal(w.tz, "local");
  });

  it("rejects malformed dates", () => {
    assert.throws(() => parseDate("2026-5-18", "utc"), /YYYY-MM-DD/);
    assert.throws(() => parseDate("not-a-date", "utc"), /YYYY-MM-DD/);
    assert.throws(() => parseDate("2026-13-01", "utc"), /valid date/);
    assert.throws(() => parseDate("2026-02-30", "utc"), /valid date/);
  });
});

describe("parseWeek", () => {
  it("parses YYYY-Www in UTC as Mon→Mon 7-day window", () => {
    const w = parseWeek("2026-W21", "utc");
    assert.equal(w.kind, "weekly");
    const from = new Date(w.fromIso);
    const to = new Date(w.toIso);
    // ISO Monday
    assert.equal(from.getUTCDay(), 1);
    assert.equal(to.getTime() - from.getTime(), 7 * 86_400_000);
    assert.equal(w.tz, "utc");
  });

  it("rejects bad week notation", () => {
    assert.throws(() => parseWeek("2026-21", "utc"), /YYYY-Www/);
    assert.throws(() => parseWeek("2026-W54", "utc"), /between 01 and 53/);
  });

  it("parses week 1 of 2026 to a UTC Monday", () => {
    const w = parseWeek("2026-W01", "utc");
    const from = new Date(w.fromIso);
    assert.equal(from.getUTCDay(), 1);
    // Week 1 must contain Jan 4
    const jan4 = new Date(Date.UTC(2026, 0, 4));
    assert.ok(from.getTime() <= jan4.getTime());
    assert.ok(from.getTime() + 7 * 86_400_000 > jan4.getTime());
  });

  it("rejects ISO weeks that do not exist in a given year", () => {
    // 2025 has 52 ISO weeks. W53 of 2025 should not exist.
    // (parseWeek validates by round-tripping through isoWeek/isoWeekYear.)
    assert.throws(() => parseWeek("2025-W53", "utc"), /not a valid ISO week/);
  });
});

describe("subtractCalendarDays", () => {
  it("subtracts calendar days in UTC across a month boundary", () => {
    const out = subtractCalendarDays("2026-05-18T00:00:00.000Z", 30, "utc");
    assert.equal(out, "2026-04-18T00:00:00.000Z");
  });

  it("subtracts calendar days across a year boundary in UTC", () => {
    const out = subtractCalendarDays("2026-01-15T12:00:00.000Z", 30, "utc");
    assert.equal(out, "2025-12-16T12:00:00.000Z");
  });

  it("subtracts calendar days in local tz (DST-tolerant)", () => {
    // 30 calendar days back from local midnight always lands on local midnight,
    // even if the wall-clock-elapsed time was 719 or 721 hours due to DST.
    const w = parseDate("2026-05-18", "local");
    const out = subtractCalendarDays(w.fromIso, 30, "local");
    // Round-trip: parsing the resulting local-midnight ISO and re-formatting it
    // should produce the original calendar arithmetic answer.
    const d = new Date(out);
    assert.equal(d.getDate(), 18);
    assert.equal(d.getMonth(), 3); // April (0-indexed)
  });
});

describe("today / this-week defaults", () => {
  it("todayInTz returns a YYYY-MM-DD string parseable by parseDate", () => {
    const s = todayInTz("utc");
    assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
    assert.doesNotThrow(() => parseDate(s, "utc"));
  });

  it("thisWeekInTz returns a YYYY-Www string parseable by parseWeek", () => {
    const s = thisWeekInTz("utc");
    assert.match(s, /^\d{4}-W\d{2}$/);
    assert.doesNotThrow(() => parseWeek(s, "utc"));
  });
});
