import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { AuditStore } from "../../src/store/audit-store.js";
import { ReportPusherService } from "../../src/services/report-pusher.js";
import type { AuditEventInsert } from "../../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-pusher-")), "test.db");
}

interface WebhookRig {
  baseUrl: string;
  received: Array<{ body: string }>;
  setHandler: (h: (req: IncomingMessage, res: ServerResponse) => void) => void;
  destroy: () => Promise<void>;
}

async function createWebhookRig(): Promise<WebhookRig> {
  const received: WebhookRig["received"] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    received.push({ body: Buffer.concat(chunks).toString("utf-8") });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    setHandler: (h) => { handler = h; },
    destroy: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Stable instants used by the time-travel tests. Wednesday 2026-05-13 was
// picked deliberately so "last week" is unambiguously 2026-W19 in both UTC
// and any sensible offset.
const WED_MORNING_UTC = new Date("2026-05-13T10:00:00Z");
const THU_JUST_AFTER_MIDNIGHT_UTC = new Date("2026-05-14T00:01:00Z");
const MON_AFTER_MIDNIGHT_UTC = new Date("2026-05-18T00:01:00Z");

describe("ReportPusherService — disabled paths", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("does nothing when webhook URL is undefined", async () => {
    const svc = new ReportPusherService(store, undefined, { tz: "utc", now: () => WED_MORNING_UTC });
    svc.start();
    await svc.tick();
    svc.stop();
    assert.equal(store.getServiceHealth("report-pusher"), undefined);
  });

  it("disables itself on a malformed URL", async () => {
    const svc = new ReportPusherService(store, "not a url", { tz: "utc", now: () => WED_MORNING_UTC });
    svc.start();
    await svc.tick();
    svc.stop();
    assert.equal(store.getServiceHealth("report-pusher"), undefined);
  });

  it("disables itself on a disallowed protocol", async () => {
    const svc = new ReportPusherService(store, "file:///etc/passwd", { tz: "utc", now: () => WED_MORNING_UTC });
    svc.start();
    await svc.tick();
    svc.stop();
    assert.equal(store.getServiceHealth("report-pusher"), undefined);
  });
});

describe("ReportPusherService — daily fire", () => {
  let dbPath: string;
  let store: AuditStore;
  let rig: WebhookRig;
  let nowRef: { current: Date };

  before(async () => { rig = await createWebhookRig(); });
  after(async () => { await rig.destroy(); });

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    rig.received.length = 0;
    rig.setHandler((_req, res) => { res.statusCode = 200; res.end("ok"); });
    nowRef = { current: WED_MORNING_UTC };
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("does not push on first tick — yesterday is already marked as reported on start", async () => {
    const svc = new ReportPusherService(store, rig.baseUrl, { tz: "utc", now: () => nowRef.current });
    svc.start();
    await svc.tick();
    svc.stop();
    assert.equal(rig.received.length, 0, "no push expected right after start");
  });

  it("fires a daily digest after the local midnight boundary crosses", async () => {
    const svc = new ReportPusherService(store, rig.baseUrl, { tz: "utc", now: () => nowRef.current });
    svc.start();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();

    assert.equal(rig.received.length, 1, "exactly one push expected on the first post-midnight tick");
    const body = JSON.parse(rig.received[0]!.body) as Record<string, unknown>;
    assert.ok(typeof body.text === "string", "fallback text is present");
    assert.ok(Array.isArray(body.blocks), "blocks are present");
    const proj = body.projection as { schemaVersion: number; period: { kind: string; label: string } };
    assert.equal(proj.schemaVersion, 1);
    assert.equal(proj.period.kind, "daily");
    // The reported window is the calendar day that just ended.
    assert.equal(proj.period.label, "2026-05-13 UTC");
  });

  it("does not re-fire on a second tick within the same day", async () => {
    const svc = new ReportPusherService(store, rig.baseUrl, { tz: "utc", now: () => nowRef.current });
    svc.start();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    nowRef.current = new Date("2026-05-14T08:00:00Z"); // later same day
    await svc.tick();
    svc.stop();
    assert.equal(rig.received.length, 1, "second tick on same day must not refire");
  });

  it("only pushes the most recent missed day after a long downtime (no backfill spam)", async () => {
    const svc = new ReportPusherService(store, rig.baseUrl, { tz: "utc", now: () => nowRef.current });
    svc.start();
    // Jump forward 3 days. We expect a single push for the most recent
    // completed day, not three pushes.
    nowRef.current = new Date("2026-05-17T10:00:00Z");
    await svc.tick();
    svc.stop();
    assert.equal(rig.received.length, 1);
    const proj = (JSON.parse(rig.received[0]!.body) as { projection: { period: { label: string } } }).projection;
    assert.equal(proj.period.label, "2026-05-16 UTC", "should report the day immediately before now");
  });

  it("persists service_health with lastPushAt + nextDailyAt", async () => {
    const svc = new ReportPusherService(store, rig.baseUrl, { tz: "utc", now: () => nowRef.current });
    svc.start();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();

    const row = store.getServiceHealth("report-pusher");
    assert.ok(row, "expected service_health row");
    const h = row!.payload as Record<string, unknown>;
    assert.equal(h.lastDailyReportedDate, "2026-05-13");
    assert.ok(typeof h.lastPushAt === "string");
    assert.equal(h.lastDailyError, undefined);
    assert.equal(h.lastWeeklyError, undefined);
    assert.ok(typeof h.nextDailyAt === "string");
  });
});

describe("ReportPusherService — weekly fire", () => {
  let dbPath: string;
  let store: AuditStore;
  let rig: WebhookRig;
  let nowRef: { current: Date };

  before(async () => { rig = await createWebhookRig(); });
  after(async () => { await rig.destroy(); });

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    rig.received.length = 0;
    rig.setHandler((_req, res) => { res.statusCode = 200; res.end("ok"); });
    nowRef = { current: WED_MORNING_UTC };
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("handles the ISO week-year rollover (2020-W53 → 2021-W01) correctly", async () => {
    // 2020 has 53 ISO weeks; 2021-W01 starts Mon 2021-01-04. The week
    // immediately before that is 2020-W53 (NOT 2020-W52). This is the
    // failure mode the inline weekStringFor copy invited — keep it covered.
    const startDeepInW53 = new Date("2020-12-30T10:00:00Z");
    const jumpToNextMon = new Date("2021-01-04T00:01:00Z");
    const local: { current: Date } = { current: startDeepInW53 };
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => local.current,
    });
    svc.start();
    local.current = jumpToNextMon;
    await svc.tick();
    svc.stop();

    const weekly = rig.received
      .map((r) => JSON.parse(r.body) as { projection: { period: { kind: string; label: string } } })
      .find((p) => p.projection.period.kind === "weekly");
    assert.ok(weekly, "expected a weekly push across the year boundary");
    assert.match(weekly!.projection.period.label, /2020-W53/);
  });

  it("fires a weekly digest when the Monday-midnight boundary crosses", async () => {
    const svc = new ReportPusherService(store, rig.baseUrl, { tz: "utc", now: () => nowRef.current });
    svc.start();
    // Jump from mid-week to early Monday — both the daily marker and the
    // weekly marker should advance, producing two pushes in one tick.
    nowRef.current = MON_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();

    const weekly = rig.received
      .map((r) => JSON.parse(r.body) as { projection: { period: { kind: string; label: string } } })
      .find((p) => p.projection.period.kind === "weekly");
    assert.ok(weekly, "expected at least one weekly push");
    assert.equal(weekly!.projection.period.label, "Week 2026-W20 (Mon–Sun) UTC");
  });
});

describe("ReportPusherService — failure handling", () => {
  let dbPath: string;
  let store: AuditStore;
  let rig: WebhookRig;
  let nowRef: { current: Date };

  before(async () => { rig = await createWebhookRig(); });
  after(async () => { await rig.destroy(); });

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    rig.received.length = 0;
    nowRef = { current: WED_MORNING_UTC };
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("retries once on transient failure and clears lastDailyError on success", async () => {
    let calls = 0;
    rig.setHandler((_req, res) => {
      calls++;
      if (calls === 1) { res.statusCode = 503; res.end(); }
      else { res.statusCode = 200; res.end("ok"); }
    });
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current, retryDelayMs: 10,
    });
    svc.start();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();

    assert.equal(calls, 2, "expected one retry");
    const h = store.getServiceHealth("report-pusher")!.payload as Record<string, unknown>;
    assert.equal(h.lastDailyError, undefined);
    assert.equal(h.lastDailyReportedDate, "2026-05-13");
  });

  it("gives up after the retry and persists lastDailyError; does NOT advance the day marker", async () => {
    rig.setHandler((_req, res) => { res.statusCode = 503; res.statusMessage = "Service Unavailable"; res.end(); });
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current, retryDelayMs: 10,
    });
    svc.start();
    const initialDate = (store.getServiceHealth("report-pusher")!.payload as Record<string, unknown>)
      .lastDailyReportedDate as string;
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();

    const h = store.getServiceHealth("report-pusher")!.payload as Record<string, unknown>;
    assert.match(h.lastDailyError as string, /503/);
    // Weekly is current (Wed→Thu doesn't cross a Mon boundary) so its error
    // field must NOT be set — daily failure must not leak across phases.
    assert.equal(h.lastWeeklyError, undefined);
    // Marker stays on its previous value so the next tick will retry the
    // same window rather than silently skipping it.
    assert.equal(h.lastDailyReportedDate, initialDate);
  });

  it("aborts an in-flight retry when stop() is called", async () => {
    rig.setHandler((_req, res) => { res.statusCode = 503; res.end(); });
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current, retryDelayMs: 10_000, // long retry window
    });
    svc.start();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    const tickPromise = svc.tick();
    // Stop immediately — the in-flight retry sleep should be cancelled.
    svc.stop();
    const start = Date.now();
    await tickPromise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `expected fast abort, got ${elapsed}ms`);
  });
});

describe("ReportPusherService.health()", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("returns next fire times after start", () => {
    const svc = new ReportPusherService(store, "http://127.0.0.1:1/", {
      tz: "utc", now: () => WED_MORNING_UTC,
    });
    svc.start();
    const h = svc.health();
    svc.stop();
    // Next daily fire = the end of today's UTC window = Thu 00:00.
    assert.equal(h.nextDailyAt, "2026-05-14T00:00:00.000Z");
    // Next weekly fire = next Mon 00:00 UTC = 2026-05-18.
    assert.equal(h.nextWeeklyAt, "2026-05-18T00:00:00.000Z");
  });

  it("recomputes next fire times on demand (not stuck on the last-tick value)", () => {
    const nowRef = { current: WED_MORNING_UTC };
    const svc = new ReportPusherService(store, "http://127.0.0.1:1/", {
      tz: "utc", now: () => nowRef.current,
    });
    svc.start();
    // Advance the clock past the original `nextDailyAt` without a tick
    // happening. health() should reflect the new "end of today" instant.
    nowRef.current = new Date("2026-05-14T12:00:00Z");
    const h = svc.health();
    svc.stop();
    assert.equal(h.nextDailyAt, "2026-05-15T00:00:00.000Z");
  });
});

describe("ReportPusherService — re-entrancy + lifecycle", () => {
  let dbPath: string;
  let store: AuditStore;
  let rig: WebhookRig;
  let nowRef: { current: Date };

  before(async () => { rig = await createWebhookRig(); });
  after(async () => { await rig.destroy(); });

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    rig.received.length = 0;
    nowRef = { current: WED_MORNING_UTC };
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("does not double-push when a second tick fires while the first is mid-retry", async () => {
    let calls = 0;
    rig.setHandler((_req, res) => {
      calls++;
      // Both attempts of *each* tick fail-then-succeed: 503, 200, 503, 200…
      // If re-entrancy is broken we'll see 4 calls (two ticks × two attempts);
      // with the guard, only one tick runs and we see 2.
      if (calls % 2 === 1) { res.statusCode = 503; res.end(); }
      else { res.statusCode = 200; res.end("ok"); }
    });
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current, retryDelayMs: 50,
    });
    svc.start();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;

    // Fire two overlapping ticks. The first one will go: POST (503) → sleep(50ms) → POST (200) → ok.
    // The second tick, started before the first finishes, must short-circuit on inFlightTick.
    const tick1 = svc.tick();
    const tick2 = svc.tick();
    await Promise.all([tick1, tick2]);
    svc.stop();

    assert.equal(rig.received.length, 2, "exactly one tick should reach the wire (2 attempts)");
  });

  it("recovers from a thrown error inside the tick (sets lastDailyError, does not crash)", async () => {
    rig.setHandler((_req, res) => { res.statusCode = 200; res.end("ok"); });
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current,
    });
    svc.start();
    // Force a throw by closing the store underneath the pusher. buildProjection
    // will hit a finalised prepared statement.
    store.close();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    // tick() must not reject — runPhase catches the error and routes it to
    // the daily error field. persist() may itself fail because the store is
    // closed; that's logged but doesn't escape.
    await svc.tick();
    svc.stop();
    const h = svc.health();
    assert.ok(h.lastDailyError, "lastDailyError must be set after a failed daily phase");
    assert.match(h.lastDailyError!, /finalized|closed/i);
    assert.equal(h.lastWeeklyError, undefined, "weekly phase must not be implicated");
    // Re-open so afterEach's `store.close()` is idempotent against the
    // already-closed handle.
    store = new AuditStore(dbPath);
  });

  it("keeps lastDailyError and lastWeeklyError independent (no cross-phase clobber)", async () => {
    // Daily POST fails (both attempts 503), weekly POST succeeds. With the
    // per-phase error fields the daily failure must survive the weekly
    // success — otherwise operators lose visibility into the failure.
    let dailyCalls = 0;
    let weeklyCalls = 0;
    rig.setHandler((_req, res) => {
      // The rig already buffered the request body into `received` before
      // invoking us. Peek at the most recent entry to decide which phase
      // is calling.
      const last = rig.received[rig.received.length - 1]!;
      const body = JSON.parse(last.body) as { projection: { period: { kind: string } } };
      if (body.projection.period.kind === "daily") {
        dailyCalls++;
        res.statusCode = 503; res.statusMessage = "DailyDown"; res.end();
      } else {
        weeklyCalls++;
        res.statusCode = 200; res.end("ok");
      }
    });
    // Jump from Wed to Mon so both daily and weekly fire in the same tick.
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current, retryDelayMs: 10,
    });
    svc.start();
    nowRef.current = MON_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();

    assert.equal(dailyCalls, 2, "daily should retry once and give up");
    assert.equal(weeklyCalls, 1, "weekly should succeed on first try");
    const h = svc.health();
    assert.match(h.lastDailyError ?? "", /503/, "daily error must survive weekly success");
    assert.equal(h.lastWeeklyError, undefined, "weekly error must be clear after success");
    assert.ok(h.lastPushAt, "lastPushAt records the successful weekly push");
  });

  it("supports stop()→start() (AbortController is recreated)", async () => {
    rig.setHandler((_req, res) => { res.statusCode = 200; res.end("ok"); });
    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current,
    });
    svc.start();
    svc.stop();
    svc.start(); // After stop+start, the controller must NOT be aborted.
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();
    assert.equal(rig.received.length, 1, "tick after stop()→start() must still push");
  });

  it("idempotent start() — second call is a no-op", () => {
    const svc = new ReportPusherService(store, "http://127.0.0.1:1/", {
      tz: "utc", now: () => WED_MORNING_UTC, tickIntervalMs: 100_000,
    });
    svc.start();
    // Calling start() again must not throw or leak a second interval.
    // We can't directly observe the timer, but the contract is "calling
    // twice is safe" — the assertion is the absence of a throw.
    assert.doesNotThrow(() => svc.start());
    svc.stop();
  });
});

describe("ReportPusherService — payload sanitization (F1)", () => {
  let dbPath: string;
  let store: AuditStore;
  let rig: WebhookRig;
  let nowRef: { current: Date };

  before(async () => { rig = await createWebhookRig(); });
  after(async () => { await rig.destroy(); });

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    rig.received.length = 0;
    rig.setHandler((_req, res) => { res.statusCode = 200; res.end("ok"); });
    nowRef = { current: WED_MORNING_UTC };
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("hashes recipients in duplicate-outbound findings before sending", async () => {
    // Append two byte-identical message.sent events to the same recipient
    // within the dedup window, in the day we'll report (yesterday relative
    // to THU_JUST_AFTER_MIDNIGHT_UTC = 2026-05-13 UTC).
    const dupInsert = (i: number): AuditEventInsert => ({
      eventType: "message.sent",
      category: "message",
      description: "send",
      metadata: { channel: "telegram", recipient: "+15551234567" },
      content: "hello",
      sessionId: `s${i}`,
    });
    const a = store.append(dupInsert(1))!;
    const b = store.append(dupInsert(2))!;
    // Stamp both events into the target day.
    store["db"].prepare("UPDATE audit_events SET created_at = ? WHERE id = ?")
      .run("2026-05-13T12:00:00.000Z", a.id);
    store["db"].prepare("UPDATE audit_events SET created_at = ? WHERE id = ?")
      .run("2026-05-13T12:00:05.000Z", b.id);

    const svc = new ReportPusherService(store, rig.baseUrl, {
      tz: "utc", now: () => nowRef.current,
    });
    svc.start();
    nowRef.current = THU_JUST_AFTER_MIDNIGHT_UTC;
    await svc.tick();
    svc.stop();

    assert.equal(rig.received.length, 1);
    const body = JSON.parse(rig.received[0]!.body) as {
      projection: { anomalies: { duplicateOutbound: Array<{ recipient: string }> } };
    };
    const dups = body.projection.anomalies.duplicateOutbound;
    assert.ok(dups.length > 0, "expected at least one duplicate-outbound finding");
    for (const d of dups) {
      assert.ok(d.recipient.startsWith("sha256:"),
        `recipient must be hashed; got ${d.recipient}`);
      assert.ok(!d.recipient.includes("+15551234567"),
        "raw phone number must not appear in the wire payload");
    }
  });
});
