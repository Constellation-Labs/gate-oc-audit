import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, truncateSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileHash, MAX_HASHABLE_BYTES } from "../../src/util/fs.js";

describe("fileHash", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(dirname(scratch), { recursive: true, force: true });
      scratch = undefined;
    }
  });

  it("hashes a small file with sha256", () => {
    scratch = join(mkdtempSync(join(tmpdir(), "audit-fs-")), "small.txt");
    writeFileSync(scratch, "hello");
    const h = fileHash(scratch);
    assert.ok(h);
    assert.equal(h!.length, 64);
    // sha256("hello") is fixed and well-known.
    assert.equal(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("returns undefined for files larger than MAX_HASHABLE_BYTES", () => {
    scratch = join(mkdtempSync(join(tmpdir(), "audit-fs-")), "big.bin");
    // Sparse-grow the file past the cap without writing actual bytes.
    const fd = openSync(scratch, "w");
    closeSync(fd);
    truncateSync(scratch, MAX_HASHABLE_BYTES + 1);

    const h = fileHash(scratch);
    assert.equal(h, undefined);
  });

  it("returns undefined for a missing file", () => {
    const h = fileHash(join(tmpdir(), "audit-fs-does-not-exist", "no.txt"));
    assert.equal(h, undefined);
  });
});
