import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeHealthVerdict } from "../../src/control-ui/health.js";
import type { StatusSnapshot, AnomalyView } from "../../src/control-ui/api.js";

function cleanSnapshot(): StatusSnapshot {
  return {
    schemaVersion: 3,
    header: { pluginName: "audit", pluginVersion: "0.0.0", machineId: "m1", generatedAt: "2026-06-08T00:00:00Z" },
    storage: { dbSizeMb: 1, maxSizeMb: 100, eventCount: 10, oldestEventAt: null, oldestEventAgeDays: null, retentionDays: 30, nextPruneAt: null },
    integrity: {
      sequenceAtHead: 10, smtTreeCount: 1, smtTreeKeys: ["default"], smtRoot: "abc",
      smtEntryCount: 10, smtNodeCount: 20, lastInsertedSequence: 10,
      lastCheckpoint: null, pendingSinceLastCheckpoint: 0, conversationAccess: "enabled",
    },
    anchor: {
      configured: true, isActive: true, circuitOpen: false, consecutiveFailures: 0,
      anchoredToday: 1, lastAnchorAt: "2026-06-08T00:00:00Z", lastTxHash: "0xabc", pendingSinceLastCheckpoint: 0,
    },
    fileWatch: { patternsWatched: 3, patternsIgnored: 1, recentChanges24h: 0 },
    inventory: { plugins: 1, skills: 2, tools: 3, crons: 0 },
    securityScan: { lastScanAt: "2026-06-08T00:00:00Z", highFindings: 0, mediumFindings: 0 },
    degraded: false,
  };
}

function cleanAnomalies(): AnomalyView {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-08T00:00:00Z",
    period: { fromIso: "2026-06-07T00:00:00Z", toIso: "2026-06-08T00:00:00Z", label: "24h", tz: "utc" },
    detectorConfig: { dupWindowSec: 60, lookbackDays: 30, denialWindowSec: 60, denialThreshold: 5 },
    counts: { totalEventsInWindow: 10, capped: false },
    anomalies: {
      duplicateOutbound: [],
      firstSeenTools: [],
      denialSpikes: [],
      installEvents: [],
      integrityViolations: { notFoundOnDe: [], pendingVerification: [], tamperedEvents: [], note: null },
    },
    degraded: false,
  };
}

// Minimal stand-ins for the finding shapes — only `.length` is read by the verdict.
const stub = { sequence: 1, id: "e1", createdAt: "2026-06-08T00:00:00Z" } as never;

describe("computeHealthVerdict", () => {
  it("returns ok when snapshot and anomalies are clean", () => {
    const v = computeHealthVerdict(cleanSnapshot(), cleanAnomalies());
    assert.equal(v.level, "ok");
    assert.equal(v.issues.length, 0);
    assert.equal(v.notes.length, 0);
  });

  for (const [name, mutate] of [
    ["degraded store", (s: StatusSnapshot) => { s.degraded = true; }],
    ["anchor circuit open", (s: StatusSnapshot) => { s.anchor.circuitOpen = true; }],
    ["high security findings", (s: StatusSnapshot) => { s.securityScan.highFindings = 2; }],
  ] as const) {
    it(`returns err on ${name}`, () => {
      const s = cleanSnapshot();
      mutate(s);
      assert.equal(computeHealthVerdict(s, cleanAnomalies()).level, "err");
    });
  }

  it("returns err on tampered events and notFoundOnDe", () => {
    const tampered = cleanAnomalies();
    tampered.anomalies.integrityViolations.tamperedEvents = [stub];
    assert.equal(computeHealthVerdict(cleanSnapshot(), tampered).level, "err");

    const notFound = cleanAnomalies();
    notFound.anomalies.integrityViolations.notFoundOnDe = [stub];
    assert.equal(computeHealthVerdict(cleanSnapshot(), notFound).level, "err");
  });

  for (const [name, mutate] of [
    ["anchor failures", (s: StatusSnapshot) => { s.anchor.consecutiveFailures = 2; }],
    ["medium security findings", (s: StatusSnapshot) => { s.securityScan.mediumFindings = 1; }],
    ["conversation access silent", (s: StatusSnapshot) => { s.integrity.conversationAccess = "enabled-but-silent"; }],
  ] as const) {
    it(`returns warn on ${name}`, () => {
      const s = cleanSnapshot();
      mutate(s);
      assert.equal(computeHealthVerdict(s, cleanAnomalies()).level, "warn");
    });
  }

  for (const [name, mutate] of [
    ["denial spikes", (a: AnomalyView) => { a.anomalies.denialSpikes = [stub]; }],
    ["duplicate outbound", (a: AnomalyView) => { a.anomalies.duplicateOutbound = [stub]; }],
    ["capped scan", (a: AnomalyView) => { a.counts.capped = true; }],
  ] as const) {
    it(`returns warn on ${name}`, () => {
      const a = cleanAnomalies();
      mutate(a);
      assert.equal(computeHealthVerdict(cleanSnapshot(), a).level, "warn");
    });
  }

  it("stays ok for pendingVerification-only and informational findings", () => {
    const a = cleanAnomalies();
    a.anomalies.integrityViolations.pendingVerification = [stub];
    a.anomalies.installEvents = [stub];
    a.anomalies.firstSeenTools = ["new.tool"];
    assert.equal(computeHealthVerdict(cleanSnapshot(), a).level, "ok");
  });

  it("degrades to snapshot-only with a note when anomalies are unavailable", () => {
    const v = computeHealthVerdict(cleanSnapshot(), null);
    assert.equal(v.level, "ok");
    assert.ok(v.notes.some((n) => n.includes("Anomaly scan unavailable")));
  });

  it("notes unconfigured anchoring without raising the level", () => {
    const s = cleanSnapshot();
    s.anchor.configured = false;
    const v = computeHealthVerdict(s, cleanAnomalies());
    assert.equal(v.level, "ok");
    assert.ok(v.notes.some((n) => n.includes("not configured")));
  });

  it("reports the worst level when warn and err coexist", () => {
    const s = cleanSnapshot();
    s.anchor.consecutiveFailures = 1; // warn
    s.degraded = true; // err
    const v = computeHealthVerdict(s, cleanAnomalies());
    assert.equal(v.level, "err");
    assert.ok(v.issues.length >= 2);
  });
});
