import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatDigestBlocks } from "../../src/reports/format-blocks.js";
import type { AuditProjection } from "../../src/reports/projection.js";

function sampleProjection(overrides: Partial<AuditProjection> = {}): AuditProjection {
  const base: AuditProjection = {
    schemaVersion: 1,
    generatedAt: "2026-05-18T00:05:00Z",
    period: {
      kind: "daily",
      fromIso: "2026-05-17T00:00:00Z",
      toIso: "2026-05-18T00:00:00Z",
      label: "2026-05-17",
      tz: "utc",
    },
    detectorConfig: {
      duplicateOutboundWindowSec: 60,
      firstSeenLookbackDays: 30,
    },
    activity: { totalEvents: 42, byCategory: [{ category: "agent", count: 30 }, { category: "tool", count: 12 }] },
    cron: { executed: 5, failed: 1, byEventType: [{ eventType: "cron.executed", count: 5 }, { eventType: "cron.failed", count: 1 }] },
    topTools: [
      { toolName: "Read", invocations: 25 },
      { toolName: "Write", invocations: 8 },
    ],
    llmSpend: { totalCalls: 17, totalCostUsd: 0.1234, byModel: [] },
    outboundMessaging: { totalSent: 3, byChannel: [{ channel: "slack", count: 3 }] },
    anomalies: { duplicateOutbound: [], duplicateOutboundTruncated: false, firstSeenTools: [] },
    integrity: {
      lastSequence: 42,
      lastEventId: "01HXYZ",
      lastEventCreatedAt: "2026-05-17T23:59:00Z",
      lastEventContentHash: "abc123",
      lastCheckpoint: {
        checkpointId: "cp-1",
        deTxHash: "0xdeadbeefcafe1234",
        smtRoot: "0xfeed",
        sequenceStart: 1,
        sequenceEnd: 42,
        createdAt: "2026-05-17T23:59:00Z",
      },
    },
  };
  return { ...base, ...overrides };
}

describe("formatDigestBlocks", () => {
  it("emits a fallback text plus a header block with top-line counts", () => {
    const out = formatDigestBlocks(sampleProjection());
    assert.match(out.text, /Daily audit report — 2026-05-17/);
    assert.match(out.text, /42 events/);
    assert.match(out.text, /1 cron failures/);
    assert.match(out.text, /\$0\.1234/);

    const header = out.blocks[0]!.text.text;
    assert.match(header, /Daily audit report/);
    assert.match(header, /Events: 42/);
    assert.match(header, /Cron failed: 1/);
    assert.match(header, /LLM calls: 17/);
    assert.match(header, /Outbound: 3/);
  });

  it("uses Weekly in the header when period.kind is weekly", () => {
    const out = formatDigestBlocks(
      sampleProjection({
        period: { kind: "weekly", fromIso: "2026-05-11T00:00:00Z", toIso: "2026-05-18T00:00:00Z", label: "2026-W20", tz: "utc" },
      }),
    );
    assert.match(out.text, /Weekly audit report — 2026-W20/);
  });

  it("renders the top tools block when topTools is non-empty", () => {
    const out = formatDigestBlocks(sampleProjection());
    const block = out.blocks.find((b) => b.text.text.startsWith("*Top tools*"));
    assert.ok(block, "expected a Top tools block");
    assert.match(block!.text.text, /`Read` ×25/);
    assert.match(block!.text.text, /`Write` ×8/);
  });

  it("omits the top tools block when topTools is empty", () => {
    const out = formatDigestBlocks(sampleProjection({ topTools: [] }));
    assert.ok(!out.blocks.some((b) => b.text.text.startsWith("*Top tools*")));
  });

  it("renders anomalies block when duplicates or first-seen tools exist", () => {
    const out = formatDigestBlocks(sampleProjection({
      anomalies: {
        duplicateOutbound: [{
          channel: "telegram",
          recipient: "@x",
          contentSha256: "deadbeef",
          deltaSeconds: 0.5,
          events: [
            { id: "e1", sequence: 10, createdAt: "2026-05-17T20:00:00Z" },
            { id: "e2", sequence: 11, createdAt: "2026-05-17T20:00:00.5Z" },
          ],
        }],
        duplicateOutboundTruncated: false,
        firstSeenTools: ["NewTool"],
      },
    }));
    const block = out.blocks.find((b) => b.text.text.startsWith("*Anomalies*"));
    assert.ok(block, "expected an Anomalies block");
    assert.match(block!.text.text, /1 duplicate outbound/);
    assert.match(block!.text.text, /first-seen tool.*`NewTool`/);
  });

  it("flags truncated dedup detector even when no duplicates were surfaced", () => {
    const out = formatDigestBlocks(sampleProjection({
      anomalies: { duplicateOutbound: [], duplicateOutboundTruncated: true, firstSeenTools: [] },
    }));
    const block = out.blocks.find((b) => b.text.text.startsWith("*Anomalies*"));
    assert.ok(block);
    assert.match(block!.text.text, /detector hit its row cap/);
  });

  it("omits the anomalies block when nothing is anomalous", () => {
    const out = formatDigestBlocks(sampleProjection());
    assert.ok(!out.blocks.some((b) => b.text.text.startsWith("*Anomalies*")));
  });

  it("shortens first-seen tool list past 10 items with a +N more suffix", () => {
    const tools = Array.from({ length: 13 }, (_, i) => `tool${i}`);
    const out = formatDigestBlocks(sampleProjection({
      anomalies: { duplicateOutbound: [], duplicateOutboundTruncated: false, firstSeenTools: tools },
    }));
    const block = out.blocks.find((b) => b.text.text.startsWith("*Anomalies*"))!;
    assert.match(block.text.text, /\+3 more/);
    assert.ok(block.text.text.includes("`tool0`"));
    assert.ok(!block.text.text.includes("`tool10`"));
  });

  it("renders the integrity footer with anchored checkpoint", () => {
    const out = formatDigestBlocks(sampleProjection());
    const block = out.blocks[out.blocks.length - 1]!;
    assert.match(block.text.text, /Last event: #42/);
    assert.match(block.text.text, /seq 1–42, anchored/);
  });

  it("renders integrity footer when no checkpoint exists yet", () => {
    const out = formatDigestBlocks(sampleProjection({
      integrity: {
        lastSequence: 5,
        lastEventId: "id",
        lastEventCreatedAt: "2026-05-17T12:00:00Z",
        lastEventContentHash: "x",
        lastCheckpoint: null,
      },
    }));
    const block = out.blocks[out.blocks.length - 1]!;
    assert.match(block.text.text, /Last checkpoint: _\(none yet\)_/);
  });

  it("renders integrity footer when the store is empty", () => {
    const out = formatDigestBlocks(sampleProjection({
      integrity: { lastSequence: null, lastEventId: null, lastEventCreatedAt: null, lastEventContentHash: null, lastCheckpoint: null },
    }));
    const block = out.blocks[out.blocks.length - 1]!;
    assert.match(block.text.text, /\(no events in store\)/);
  });
});
