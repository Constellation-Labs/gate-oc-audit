import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../../src/util/hash.js";

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

