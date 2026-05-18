import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { AuditStore } from "../../src/store/audit-store.js";
import { ReportPusherService } from "../../src/services/report-pusher.js";

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
    assert.equal(h.lastPushError, undefined);
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

  it("retries once on transient failure and clears lastPushError on success", async () => {
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
    assert.equal(h.lastPushError, undefined);
    assert.equal(h.lastDailyReportedDate, "2026-05-13");
  });

  it("gives up after the retry and persists lastPushError; does NOT advance the day marker", async () => {
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
    assert.match(h.lastPushError as string, /503/);
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
});
