import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../src/store/audit-store.js";
import { GatewayStopCapture } from "../src/gateway-stop-capture.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "gateway-stop-capture-test-")), "test.db");
}

function getEvents(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT * FROM audit_events ORDER BY sequence")
    .all() as Array<{ event_type: string; description: string; metadata: string }>;
  db.close();
  return rows;
}

describe("GatewayStopCapture", () => {
  let dbPath: string;
  let store: AuditStore;
  let capture: GatewayStopCapture;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    capture = new GatewayStopCapture(store);
  });

  afterEach(() => {
    capture.detachSignalListeners();
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  describe("tryClaim", () => {
    it("returns true on the first call and false thereafter", () => {
      assert.equal(capture.tryClaim(), true);
      assert.equal(capture.tryClaim(), false);
      assert.equal(capture.tryClaim(), false);
    });
  });

  describe("installSignalFallback", () => {
    it("writes gateway.stop synchronously on SIGTERM", () => {
      capture.installSignalFallback();
      process.emit("SIGTERM");

      const events = getEvents(dbPath);
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "gateway.stop");
      assert.equal(JSON.parse(events[0].metadata).reason, "SIGTERM");
    });

    it("writes gateway.stop synchronously on SIGINT", () => {
      capture.installSignalFallback();
      process.emit("SIGINT");

      const events = getEvents(dbPath);
      assert.equal(events.length, 1);
      assert.equal(JSON.parse(events[0].metadata).reason, "SIGINT");
    });

    it("is idempotent — re-calling does not attach duplicate listeners", () => {
      capture.installSignalFallback();
      capture.installSignalFallback();
      capture.installSignalFallback();
      process.emit("SIGTERM");

      assert.equal(getEvents(dbPath).length, 1);
    });

    it("skips the signal write if the slot was already claimed by the hook path", () => {
      capture.installSignalFallback();
      // Caller (e.g. the gateway_stop hook handler) claims the slot first.
      assert.equal(capture.tryClaim(), true);
      process.emit("SIGTERM");

      // Signal listener saw the slot taken and did not write a second row.
      assert.equal(getEvents(dbPath).length, 0);
    });

    it("after a signal fires, re-install re-attaches only that signal (no duplicate listeners)", () => {
      // Measure deltas against any pre-existing listeners (node:test, etc).
      const baseTerm = process.listenerCount("SIGTERM");
      const baseInt = process.listenerCount("SIGINT");

      capture.installSignalFallback();
      assert.equal(process.listenerCount("SIGTERM") - baseTerm, 1);
      assert.equal(process.listenerCount("SIGINT") - baseInt, 1);

      // SIGTERM fires; Node auto-removes that `once` listener. SIGINT stays.
      process.emit("SIGTERM");
      assert.equal(process.listenerCount("SIGTERM") - baseTerm, 0);
      assert.equal(process.listenerCount("SIGINT") - baseInt, 1);

      // Re-install: SIGTERM re-attached, SIGINT not duplicated.
      capture.installSignalFallback();
      assert.equal(process.listenerCount("SIGTERM") - baseTerm, 1);
      assert.equal(process.listenerCount("SIGINT") - baseInt, 1);
    });
  });

  describe("detachSignalListeners", () => {
    it("removes attached listeners so subsequent signals are no-ops for this capture", () => {
      capture.installSignalFallback();
      capture.detachSignalListeners();
      process.emit("SIGTERM");

      assert.equal(getEvents(dbPath).length, 0);
    });
  });
});
