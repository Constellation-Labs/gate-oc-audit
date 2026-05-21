import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { readStdinLine, StdinTtyError } from "../../src/util/stdin.js";

/**
 * `process.stdin.isTTY` is a getter backed by the real file descriptor.
 * To exercise the TTY branch from a non-TTY test runner we shim the
 * property via `Object.defineProperty`; the `restore` callback puts
 * the original descriptor back so we don't leak state to other tests.
 */
function shimIsTty(value: boolean): () => void {
  const orig = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    get: () => value,
  });
  return () => {
    if (orig) Object.defineProperty(process.stdin, "isTTY", orig);
    else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
  };
}

describe("util/stdin: readStdinLine", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("throws StdinTtyError when stdin is a TTY", async () => {
    // Regression guard: the throw used to bubble past the CLI handler
    // and print a stack instead of the friendly "pipe the key in"
    // hint. Wrappers now catch StdinTtyError specifically.
    restore = shimIsTty(true);
    await assert.rejects(
      readStdinLine("openclaw audit gate install"),
      (err: unknown) => {
        assert.ok(err instanceof StdinTtyError, "expected StdinTtyError");
        assert.equal(err.code, "stdin-tty");
        assert.match(err.message, /--api-key-stdin requires the key to be piped in/);
        // Command-hint is interpolated into the friendly hint so the
        // operator sees the exact invocation they should have typed.
        assert.match(err.message, /openclaw audit gate install --api-key-stdin/);
        return true;
      },
    );
  });

  it("StdinTtyError sets a stable code for handlers to switch on", () => {
    const err = new StdinTtyError("hint");
    assert.equal(err.code, "stdin-tty");
    assert.equal(err.name, "StdinTtyError");
    assert.ok(err instanceof Error);
  });
});
