import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findConfiguredCron,
  formatCronSchedule,
  listConfiguredCrons,
} from "../../src/services/cron-manifests.js";

describe("cron-manifests: listConfiguredCrons", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-crons-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when the directory does not exist", () => {
    assert.deepEqual(listConfiguredCrons(join(dir, "nope")), []);
  });

  it("returns [] when the directory has no .cron.*.json files", () => {
    writeFileSync(join(dir, "unrelated.json"), "{}");
    writeFileSync(join(dir, "foo.soul.json"), "{}");
    assert.deepEqual(listConfiguredCrons(dir), []);
  });

  it("parses every supported schedule kind (at / every / cron)", () => {
    writeFileSync(
      join(dir, "alpha.cron.json"),
      JSON.stringify({ schedule: { kind: "at", at: "2026-06-01T09:00:00Z" } }),
    );
    writeFileSync(
      join(dir, "beta.cron.json"),
      JSON.stringify({ schedule: { kind: "every", everyMs: 60_000, anchorMs: 5 } }),
    );
    writeFileSync(
      join(dir, "gamma.cron.json"),
      JSON.stringify({ schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC", staggerMs: 250 } }),
    );
    const items = listConfiguredCrons(dir);
    assert.equal(items.length, 3);
    // Sort order is locale-aware (a, b, g).
    assert.deepEqual(
      items.map((c) => c.name),
      ["alpha", "beta", "gamma"],
    );
    assert.deepEqual(items[0].schedule, { kind: "at", at: "2026-06-01T09:00:00Z" });
    assert.deepEqual(items[1].schedule, { kind: "every", everyMs: 60_000, anchorMs: 5 });
    assert.deepEqual(items[2].schedule, {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "UTC",
      staggerMs: 250,
    });
  });

  it("falls back to kind=unknown for unparseable / mismatched documents", () => {
    writeFileSync(join(dir, "missing-fields.cron.json"), JSON.stringify({ schedule: { kind: "at" } }));
    writeFileSync(join(dir, "scalar.cron.json"), JSON.stringify({ schedule: "weekly" }));
    writeFileSync(join(dir, "no-schedule.cron.json"), JSON.stringify({ name: "x" }));
    const items = listConfiguredCrons(dir);
    const byName = Object.fromEntries(items.map((c) => [c.name, c.schedule]));
    assert.equal(byName["missing-fields"].kind, "unknown");
    assert.equal(byName["scalar"].kind, "unknown");
    assert.equal(byName["no-schedule"].kind, "unknown");
  });

  it("returns kind=unknown raw=<unreadable> for invalid JSON", () => {
    writeFileSync(join(dir, "broken.cron.json"), "not-json{");
    const items = listConfiguredCrons(dir);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      name: "broken",
      schedule: { kind: "unknown", raw: "<unreadable>" },
    });
  });

  it("rejects symlinked manifests so attacker entries can't redirect the read", () => {
    const target = join(dir, "real.json");
    writeFileSync(target, JSON.stringify({ schedule: { kind: "cron", expr: "0 0 * * *" } }));
    symlinkSync(target, join(dir, "spoof.cron.json"));
    const items = listConfiguredCrons(dir);
    assert.equal(items.length, 0);
  });

  it("rejects non-.json files matching the .cron. substring (no .bak, no .disabled)", () => {
    writeFileSync(join(dir, "daily.cron.json"), JSON.stringify({ schedule: { kind: "at", at: "now" } }));
    writeFileSync(join(dir, "stale.cron.json.bak"), "ignored");
    writeFileSync(join(dir, "disabled.cron.json.disabled"), "ignored");
    const items = listConfiguredCrons(dir);
    assert.deepEqual(
      items.map((c) => c.name),
      ["daily"],
    );
  });

  it("ignores subdirectories so plugin scaffolds named *.cron.json/ don't surface", () => {
    mkdirSync(join(dir, "shaped.cron.json"));
    assert.deepEqual(listConfiguredCrons(dir), []);
  });

  it("caps reads at 64 KiB and returns kind=unknown raw=<oversize> instead", () => {
    // 128 KiB of valid-looking JSON content — well over MAX_MANIFEST_BYTES.
    const huge = "{" + "\"pad\":\"" + "x".repeat(128 * 1024) + "\"}";
    writeFileSync(join(dir, "huge.cron.json"), huge);
    const items = listConfiguredCrons(dir);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      name: "huge",
      schedule: { kind: "unknown", raw: "<oversize>" },
    });
  });

  it("sanitises CR/LF/ANSI from schedule strings so report sinks can't be hijacked", () => {
    writeFileSync(
      join(dir, "evil.cron.json"),
      JSON.stringify({
        schedule: { kind: "cron", expr: "0 9 * * *\r\n  Configured: pwned", tz: "UTC[31m" },
      }),
    );
    const item = listConfiguredCrons(dir)[0];
    assert.equal(item.schedule.kind, "cron");
    if (item.schedule.kind !== "cron") return;
    assert.ok(!/[\r\n]/.test(item.schedule.expr), `expr still contains CR/LF: ${item.schedule.expr}`);
    assert.ok(!/[\x00-\x1f]/.test(item.schedule.tz!), `tz still contains control chars`);
  });
});

describe("cron-manifests: findConfiguredCron", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-crons-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the matching manifest by stem", () => {
    writeFileSync(
      join(dir, "job-x.cron.json"),
      JSON.stringify({ schedule: { kind: "every", everyMs: 1000 } }),
    );
    writeFileSync(
      join(dir, "job-y.cron.json"),
      JSON.stringify({ schedule: { kind: "every", everyMs: 2000 } }),
    );
    const m = findConfiguredCron(dir, "job-y");
    assert.deepEqual(m, { name: "job-y", schedule: { kind: "every", everyMs: 2000 } });
  });

  it("returns null when no manifest matches", () => {
    writeFileSync(join(dir, "only.cron.json"), JSON.stringify({ schedule: { kind: "at", at: "x" } }));
    assert.equal(findConfiguredCron(dir, "missing"), null);
  });
});

describe("cron-manifests: formatCronSchedule", () => {
  it("renders each schedule kind compactly", () => {
    assert.equal(formatCronSchedule({ kind: "at", at: "2026-06-01T09:00:00Z" }), "at 2026-06-01T09:00:00Z");
    assert.equal(formatCronSchedule({ kind: "every", everyMs: 60_000 }), "every 60000ms");
    assert.equal(formatCronSchedule({ kind: "cron", expr: "0 9 * * *" }), "cron 0 9 * * *");
    assert.equal(
      formatCronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
      "cron 0 9 * * * (UTC)",
    );
    assert.equal(
      formatCronSchedule({ kind: "unknown", raw: "weekly" }),
      "unknown (weekly)",
    );
  });

  it("truncates the unknown-raw blob to 80 chars to keep the output compact", () => {
    const big = "z".repeat(200);
    const out = formatCronSchedule({ kind: "unknown", raw: big });
    // "unknown (" + 80 z's + ")"
    assert.equal(out.length, "unknown (".length + 80 + ")".length);
  });
});
