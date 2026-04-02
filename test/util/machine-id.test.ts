import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getMachineId } from "../../src/util/machine-id.js";

describe("getMachineId", () => {
  it("returns a 16-char hex string", () => {
    const id = getMachineId();
    assert.equal(id.length, 16);
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("returns the same value on subsequent calls (cached)", () => {
    const a = getMachineId();
    const b = getMachineId();
    assert.equal(a, b);
  });
});
