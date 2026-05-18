import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectGatewayDropSpike,
  detectDenialSpike,
  detectInstallEvents,
  type DetectorEvent,
} from "../../src/reports/detectors.js";
import { parseInstant, parseSince } from "../../src/reports/time-window.js";

function evt(over: Partial<DetectorEvent> & { eventType: string }): DetectorEvent {
  return {
    id: "id-" + Math.random().toString(36).slice(2),
    sequence: 0,
    createdAt: "2026-05-18T20:57:00.000Z",
    metadata: {},
    ...over,
  };
}

describe("detectGatewayDropSpike", () => {
  it("flags a cluster of >= threshold milestones inside windowSec", () => {
    const findings = detectGatewayDropSpike(
      [
        evt({ eventType: "gateway.dropped", sequence: 1, createdAt: "2026-05-18T20:57:00.000Z", metadata: { cumulativeDropped: 8 } }),
        evt({ eventType: "gateway.dropped", sequence: 2, createdAt: "2026-05-18T20:58:00.000Z", metadata: { cumulativeDropped: 32 } }),
        evt({ eventType: "gateway.dropped", sequence: 3, createdAt: "2026-05-18T20:59:00.000Z", metadata: { cumulativeDropped: 128 } }),
      ],
      300,
      3,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].count, 3);
    assert.equal(findings[0].droppedDelta, 120);
  });

  it("ignores non-gateway.dropped events", () => {
    const findings = detectGatewayDropSpike(
      [
        evt({ eventType: "gateway.start", sequence: 1, createdAt: "2026-05-18T20:57:00.000Z" }),
        evt({ eventType: "gateway.start", sequence: 2, createdAt: "2026-05-18T20:57:30.000Z" }),
        evt({ eventType: "gateway.start", sequence: 3, createdAt: "2026-05-18T20:58:00.000Z" }),
      ],
      300,
      3,
    );
    assert.deepEqual(findings, []);
  });

  it("does not flag when below threshold", () => {
    const findings = detectGatewayDropSpike(
      [
        evt({ eventType: "gateway.dropped", sequence: 1, createdAt: "2026-05-18T20:57:00.000Z" }),
        evt({ eventType: "gateway.dropped", sequence: 2, createdAt: "2026-05-18T20:57:30.000Z" }),
      ],
      300,
      3,
    );
    assert.deepEqual(findings, []);
  });

  it("splits clusters when the gap exceeds the window", () => {
    const findings = detectGatewayDropSpike(
      [
        evt({ eventType: "gateway.dropped", sequence: 1, createdAt: "2026-05-18T20:00:00.000Z" }),
        evt({ eventType: "gateway.dropped", sequence: 2, createdAt: "2026-05-18T20:01:00.000Z" }),
        evt({ eventType: "gateway.dropped", sequence: 3, createdAt: "2026-05-18T20:02:00.000Z" }),
        evt({ eventType: "gateway.dropped", sequence: 4, createdAt: "2026-05-18T23:00:00.000Z" }),
        evt({ eventType: "gateway.dropped", sequence: 5, createdAt: "2026-05-18T23:01:00.000Z" }),
        evt({ eventType: "gateway.dropped", sequence: 6, createdAt: "2026-05-18T23:02:00.000Z" }),
      ],
      300,
      3,
    );
    assert.equal(findings.length, 2);
  });

  it("bounds the cluster span by windowSec, not just consecutive-pair gaps", () => {
    // Four drops, each 5 minutes apart. With windowSec=300, every consecutive
    // gap exactly equals the window, so a gap-only loop would coalesce them
    // into one 15-minute cluster mislabelled "3+ drops in 300s". The span
    // bound must cut the cluster off at the first event that pushes total
    // duration past windowSec.
    const findings = detectGatewayDropSpike(
      [
        evt({ eventType: "gateway.dropped", sequence: 1, createdAt: "2026-05-18T20:00:00.000Z", metadata: { cumulativeDropped: 1 } }),
        evt({ eventType: "gateway.dropped", sequence: 2, createdAt: "2026-05-18T20:05:00.000Z", metadata: { cumulativeDropped: 2 } }),
        evt({ eventType: "gateway.dropped", sequence: 3, createdAt: "2026-05-18T20:10:00.000Z", metadata: { cumulativeDropped: 3 } }),
        evt({ eventType: "gateway.dropped", sequence: 4, createdAt: "2026-05-18T20:15:00.000Z", metadata: { cumulativeDropped: 4 } }),
      ],
      300,
      3,
    );
    // With span bound, no cluster of 3 events can fit in 300s (since the
    // closest 3 span 600s), so nothing should fire.
    assert.equal(findings.length, 0);
  });
});

describe("detectDenialSpike", () => {
  it("clusters denials and tallies by tool + top reason", () => {
    const findings = detectDenialSpike(
      [
        evt({ eventType: "tool.denied", sequence: 1, createdAt: "2026-05-18T20:57:00.000Z", metadata: { toolName: "exec", reason: "Denied by user" } }),
        evt({ eventType: "tool.denied", sequence: 2, createdAt: "2026-05-18T20:57:10.000Z", metadata: { toolName: "exec", reason: "Denied by user" } }),
        evt({ eventType: "tool.denied", sequence: 3, createdAt: "2026-05-18T20:57:20.000Z", metadata: { toolName: "write", reason: "Denied by user" } }),
        evt({ eventType: "tool.denied", sequence: 4, createdAt: "2026-05-18T20:57:30.000Z", metadata: { toolName: "exec", reason: "Approval timed out" } }),
        evt({ eventType: "tool.denied", sequence: 5, createdAt: "2026-05-18T20:57:40.000Z", metadata: { toolName: "exec", reason: "Denied by user" } }),
      ],
      300,
      5,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].count, 5);
    assert.equal(findings[0].byTool[0].toolName, "exec");
    assert.equal(findings[0].byTool[0].count, 4);
    assert.equal(findings[0].topReason, "Denied by user");
  });

  it("does not flag below threshold", () => {
    const findings = detectDenialSpike(
      [
        evt({ eventType: "tool.denied", sequence: 1, createdAt: "2026-05-18T20:57:00.000Z", metadata: { toolName: "exec" } }),
        evt({ eventType: "tool.denied", sequence: 2, createdAt: "2026-05-18T20:57:10.000Z", metadata: { toolName: "exec" } }),
      ],
      300,
      5,
    );
    assert.deepEqual(findings, []);
  });

  it("ignores tool.invoked / tool.result events", () => {
    const findings = detectDenialSpike(
      [
        evt({ eventType: "tool.invoked", sequence: 1, createdAt: "2026-05-18T20:57:00.000Z" }),
        evt({ eventType: "tool.invoked", sequence: 2, createdAt: "2026-05-18T20:57:10.000Z" }),
        evt({ eventType: "tool.invoked", sequence: 3, createdAt: "2026-05-18T20:57:20.000Z" }),
      ],
      300,
      2,
    );
    assert.deepEqual(findings, []);
  });

  it("bounds the cluster span by windowSec, not just consecutive-pair gaps", () => {
    // Five denials spaced 60s apart — total span 240s, fits in window=300s.
    // Add a sixth 60s later → span 300s, still fits (boundary inclusive).
    // A seventh 60s after that → span 360s, must NOT join the cluster.
    const findings = detectDenialSpike(
      [
        evt({ eventType: "tool.denied", sequence: 1, createdAt: "2026-05-18T20:00:00.000Z", metadata: { toolName: "exec" } }),
        evt({ eventType: "tool.denied", sequence: 2, createdAt: "2026-05-18T20:01:00.000Z", metadata: { toolName: "exec" } }),
        evt({ eventType: "tool.denied", sequence: 3, createdAt: "2026-05-18T20:02:00.000Z", metadata: { toolName: "exec" } }),
        evt({ eventType: "tool.denied", sequence: 4, createdAt: "2026-05-18T20:03:00.000Z", metadata: { toolName: "exec" } }),
        evt({ eventType: "tool.denied", sequence: 5, createdAt: "2026-05-18T20:04:00.000Z", metadata: { toolName: "exec" } }),
        evt({ eventType: "tool.denied", sequence: 6, createdAt: "2026-05-18T20:05:00.000Z", metadata: { toolName: "exec" } }),
        evt({ eventType: "tool.denied", sequence: 7, createdAt: "2026-05-18T20:06:00.000Z", metadata: { toolName: "exec" } }),
      ],
      300,
      5,
    );
    // First cluster must stop at seq=6 (span 300s) — seq=7 starts a new
    // cluster that fails the threshold of 5.
    assert.equal(findings.length, 1);
    assert.equal(findings[0].count, 6);
    assert.equal(findings[0].lastAt, "2026-05-18T20:05:00.000Z");
  });
});

describe("detectInstallEvents", () => {
  it("flags scanCritical > 0 as elevated", () => {
    const out = detectInstallEvents([
      evt({
        eventType: "system.install",
        sequence: 1,
        metadata: {
          targetType: "plugin",
          targetName: "untrusted",
          version: "1.2.3",
          requestMode: "install",
          scanStatus: "critical",
          scanCritical: 2,
          scanWarn: 1,
        },
      }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].elevated, true);
    assert.equal(out[0].targetName, "untrusted");
    assert.equal(out[0].version, "1.2.3");
  });

  it("does not flag an ok-status install with no critical findings", () => {
    const out = detectInstallEvents([
      evt({
        eventType: "system.install",
        sequence: 1,
        metadata: { targetType: "skill", targetName: "linter", scanStatus: "ok", scanCritical: 0 },
      }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].elevated, false);
  });

  it("falls back to <unknown> for missing metadata fields", () => {
    const out = detectInstallEvents([
      evt({ eventType: "system.install", sequence: 1, metadata: {} }),
    ]);
    assert.equal(out[0].targetType, "<unknown>");
    assert.equal(out[0].targetName, "<unknown>");
    assert.equal(out[0].version, null);
    assert.equal(out[0].elevated, false);
  });

  it("passes through only system.install events", () => {
    const out = detectInstallEvents([
      evt({ eventType: "system.install", sequence: 1, metadata: { targetType: "x", targetName: "y" } }),
      evt({ eventType: "system.install_hook_unavailable", sequence: 2, metadata: {} }),
    ]);
    assert.equal(out.length, 1);
  });
});


describe("parseInstant", () => {
  const now = new Date("2026-05-18T12:00:00.000Z");

  it("parses Nm duration relative to now", () => {
    assert.equal(parseInstant("15m", now), "2026-05-18T11:45:00.000Z");
  });

  it("parses Nh duration relative to now", () => {
    assert.equal(parseInstant("24h", now), "2026-05-17T12:00:00.000Z");
  });

  it("parses Nd duration relative to now", () => {
    assert.equal(parseInstant("7d", now), "2026-05-11T12:00:00.000Z");
  });

  it("parses ISO 8601 instant with Z", () => {
    assert.equal(parseInstant("2026-05-17T00:00:00.000Z", now), "2026-05-17T00:00:00.000Z");
  });

  it("parses ISO 8601 instant with offset", () => {
    assert.equal(parseInstant("2026-05-17T00:00:00-05:00", now), "2026-05-17T05:00:00.000Z");
  });

  it("rejects ISO strings without offset", () => {
    assert.throws(() => parseInstant("2026-05-17T00:00:00", now), /explicit offset/);
  });

  it("rejects malformed inputs", () => {
    assert.throws(() => parseInstant("garbage", now), /explicit offset/);
    assert.throws(() => parseInstant("0h", now), /positive integer/);
  });

  it("rejects durations larger than the supported range", () => {
    // Far past Date's representable range — would overflow to a RangeError
    // from .toISOString() without the magnitude check.
    assert.throws(() => parseInstant("99999999999d", now), /exceeds maximum supported range/);
    assert.throws(() => parseInstant("100000000d", now), /exceeds maximum supported range/);
  });
});

describe("parseSince", () => {
  const now = new Date("2026-05-18T12:00:00.000Z");

  it("builds a window from since duration to now", () => {
    const w = parseSince("24h", undefined, "utc", now);
    assert.equal(w.kind, "since");
    assert.equal(w.fromIso, "2026-05-17T12:00:00.000Z");
    assert.equal(w.toIso, "2026-05-18T12:00:00.000Z");
  });

  it("uses --until when given", () => {
    const w = parseSince("2026-05-17T00:00:00Z", "2026-05-18T00:00:00Z", "utc", now);
    assert.equal(w.fromIso, "2026-05-17T00:00:00.000Z");
    assert.equal(w.toIso, "2026-05-18T00:00:00.000Z");
  });

  it("rejects --until <= --since", () => {
    assert.throws(() => parseSince("1h", "2h", "utc", now), /must be strictly after/);
  });

  it("error message echoes the original literals so swapped durations are readable", () => {
    assert.throws(
      () => parseSince("1h", "2h", "utc", now),
      (err: Error) => /--since \(1h →/.test(err.message) && /--until \(2h →/.test(err.message),
    );
  });
});
