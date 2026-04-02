import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEventHash, canonicalize } from "../../src/util/hash.js";

describe("canonicalize", () => {
  it("produces deterministic output regardless of key order", () => {
    const a = canonicalize({ a: 1, b: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 1, b: 2 });
    assert.equal(a, b);
  });

  it("handles nested objects with stable key ordering", () => {
    const a = canonicalize({ outer: { z: 1, a: 2 } });
    const b = canonicalize({ outer: { a: 2, z: 1 } });
    assert.equal(a, b);
  });

  it("treats array order as significant", () => {
    const a = canonicalize({ items: [1, 2, 3] });
    const b = canonicalize({ items: [3, 2, 1] });
    assert.notEqual(a, b);
  });

  it("handles empty object", () => {
    assert.equal(canonicalize({}), "{}");
  });

  it("handles circular references without throwing", () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular.self = circular;

    const result = canonicalize(circular);
    assert.ok(result.includes("[Circular]"));
  });

  it("produces deterministic output for circular references", () => {
    const a: Record<string, unknown> = { name: "test" };
    a.self = a;
    const b: Record<string, unknown> = { name: "test" };
    b.self = b;

    assert.equal(canonicalize(a), canonicalize(b));
  });
});

describe("computeEventHash", () => {
  const baseFields = {
    id: "00000000-0000-7000-8000-000000000001",
    sequence: 1,
    previousHash: "GENESIS",
    source: "openclaw-plugin",
    sessionId: "s1",
    eventType: "session.start",
    category: "system",
    description: "test",
    metadataCanonical: canonicalize({ test: true }),
  };

  it("produces a 64-char hex SHA-256 digest", () => {
    const hash = computeEventHash(baseFields);
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash(baseFields);
    assert.equal(a, b);
  });

  it("changes when metadataCanonical changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({
      ...baseFields,
      metadataCanonical: canonicalize({ test: false }),
    });
    assert.notEqual(a, b);
  });

  it("changes when eventType changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, eventType: "session.end" });
    assert.notEqual(a, b);
  });

  it("changes when description changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, description: "different" });
    assert.notEqual(a, b);
  });

  it("changes when category changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, category: "tool" });
    assert.notEqual(a, b);
  });

  it("changes when source changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, source: "gateway" });
    assert.notEqual(a, b);
  });

  it("changes when sessionId changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, sessionId: "s2" });
    assert.notEqual(a, b);
  });

  it("changes when id changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, id: "00000000-0000-7000-8000-000000000002" });
    assert.notEqual(a, b);
  });

  it("changes when sequence changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, sequence: 2 });
    assert.notEqual(a, b);
  });

  it("changes when previousHash changes", () => {
    const a = computeEventHash(baseFields);
    const b = computeEventHash({ ...baseFields, previousHash: "abcdef1234567890" });
    assert.notEqual(a, b);
  });

  it("handles undefined optional fields", () => {
    const hash = computeEventHash({
      id: "00000000-0000-7000-8000-000000000001",
      sequence: 1,
      previousHash: "GENESIS",
      source: "openclaw-plugin",
      eventType: "session.start",
      category: "system",
      description: "test",
      metadataCanonical: canonicalize({}),
    });
    assert.equal(hash.length, 64);
  });
});
