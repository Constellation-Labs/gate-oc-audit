import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SmtService } from "../src/services/smt-service.js";
import type { AuditEvent } from "../src/types/events.js";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: crypto.randomUUID(),
    sequence: 1,
    source: "openclaw-plugin",
    machineId: "test-machine",
    eventType: "session.start",
    category: "system",
    description: "test",
    metadata: { test: true },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeService(): SmtService {
  return new SmtService({
    smt: {
      checkpointIntervalMs: 0,
      pruneAfterEpochs: 0,
      checkpointDir: `/tmp/smt-bug-test-${process.pid}-${Date.now()}`,
    },
  });
}

describe("BUG: T-08 - replaying same events produces different SMT root", () => {
  it("two services processing identical events must produce the same root", () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      makeEvent({ id: `event-${i}`, sequence: i + 1 }),
    );

    const svc1 = makeService();
    const svc2 = makeService();

    for (const event of events) {
      svc1.onEventAppended(event);
    }
    for (const event of events) {
      svc2.onEventAppended(event);
    }

    const root1 = svc1.getCurrentSmtRoot();
    const root2 = svc2.getCurrentSmtRoot();

    assert.ok(root1, "svc1 should have a root");
    assert.ok(root2, "svc2 should have a root");
    assert.equal(
      root1,
      root2,
      "Replaying the same events must produce the same SMT root. " +
        "Currently fails because insertEntry() generates a fresh UUID for auditEventId " +
        "instead of using the event's actual id.",
    );
  });
});
