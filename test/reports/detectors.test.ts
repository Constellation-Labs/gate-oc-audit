import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectDuplicateOutbound, detectFirstSeenTools, type MessageSentRow } from "../../src/reports/detectors.js";

function row(over: Partial<MessageSentRow> = {}): MessageSentRow {
  return {
    id: "id-" + Math.random().toString(36).slice(2),
    sequence: 0,
    createdAt: "2026-05-18T20:57:00.000Z",
    channel: "slack",
    recipient: "#ops",
    content: "ping",
    ...over,
  };
}

describe("detectDuplicateOutbound", () => {
  it("flags a pair with identical content to same channel+recipient within window", () => {
    const findings = detectDuplicateOutbound(
      [
        row({ sequence: 100, createdAt: "2026-05-18T20:57:00.000Z" }),
        row({ sequence: 101, createdAt: "2026-05-18T20:57:30.000Z" }),
      ],
      60,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].events.length, 2);
    assert.equal(findings[0].deltaSeconds, 30);
  });

  it("does not flag when content differs", () => {
    const findings = detectDuplicateOutbound(
      [
        row({ sequence: 1, createdAt: "2026-05-18T20:57:00.000Z", content: "a" }),
        row({ sequence: 2, createdAt: "2026-05-18T20:57:30.000Z", content: "b" }),
      ],
      60,
    );
    assert.equal(findings.length, 0);
  });

  it("does not flag when same content goes to different channels", () => {
    const findings = detectDuplicateOutbound(
      [
        row({ sequence: 1, channel: "slack", createdAt: "2026-05-18T20:57:00.000Z" }),
        row({ sequence: 2, channel: "discord", createdAt: "2026-05-18T20:57:10.000Z" }),
      ],
      60,
    );
    assert.equal(findings.length, 0);
  });

  it("does not flag when gap exceeds the window", () => {
    const findings = detectDuplicateOutbound(
      [
        row({ sequence: 1, createdAt: "2026-05-18T20:57:00.000Z" }),
        row({ sequence: 2, createdAt: "2026-05-18T20:58:30.000Z" }),
      ],
      60,
    );
    assert.equal(findings.length, 0);
  });

  it("emits separate findings for runs separated by a long gap", () => {
    const findings = detectDuplicateOutbound(
      [
        row({ sequence: 1, createdAt: "2026-05-18T20:57:00.000Z" }),
        row({ sequence: 2, createdAt: "2026-05-18T20:57:30.000Z" }),
        row({ sequence: 3, createdAt: "2026-05-18T22:00:00.000Z" }),
        row({ sequence: 4, createdAt: "2026-05-18T22:00:15.000Z" }),
      ],
      60,
    );
    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((f) => f.events.map((e) => e.sequence)),
      [
        [1, 2],
        [3, 4],
      ],
    );
  });

  it("handles 3+ duplicates inside one run as a single finding", () => {
    const findings = detectDuplicateOutbound(
      [
        row({ sequence: 1, createdAt: "2026-05-18T20:57:00.000Z" }),
        row({ sequence: 2, createdAt: "2026-05-18T20:57:20.000Z" }),
        row({ sequence: 3, createdAt: "2026-05-18T20:57:40.000Z" }),
      ],
      60,
    );
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0].events.map((e) => e.sequence), [1, 2, 3]);
  });

  it("returns empty for fewer than two events", () => {
    assert.deepEqual(detectDuplicateOutbound([], 60), []);
    assert.deepEqual(detectDuplicateOutbound([row()], 60), []);
  });
});

describe("detectFirstSeenTools", () => {
  it("returns names in today's list missing from the prior set", () => {
    const out = detectFirstSeenTools(["bash", "exec", "git", "exec"], ["exec", "bash"]);
    assert.deepEqual(out, ["git"]);
  });

  it("does not flag exec when present in prior", () => {
    const out = detectFirstSeenTools(["exec"], ["exec", "git"]);
    assert.deepEqual(out, []);
  });

  it("preserves insertion order from today and dedups", () => {
    const out = detectFirstSeenTools(["b", "a", "b", "c"], []);
    assert.deepEqual(out, ["b", "a", "c"]);
  });
});
