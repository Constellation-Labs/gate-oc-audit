import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../../src/store/audit-store.js";
import { collectInventory } from "../../src/services/inventory.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-inv-db-")), "test.db");
}

describe("inventory: collectInventory", () => {
  let dbPath: string;
  let store: AuditStore;
  let openclawDir: string;
  let projectRoot: string;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    openclawDir = mkdtempSync(join(tmpdir(), "audit-inv-oc-"));
    projectRoot = mkdtempSync(join(tmpdir(), "audit-inv-proj-"));
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
    rmSync(openclawDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("lists extension directories as plugins with version from package.json", () => {
    const pluginDir = join(openclawDir, "extensions", "sample-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "sample-plugin", version: "1.2.3", main: "index.js" }));
    writeFileSync(join(pluginDir, "index.js"), "module.exports = {};");

    const report = collectInventory(store, "plugins", { openclawDir, projectRoot });
    assert.equal(report.summary.plugins, 1);
    assert.ok(report.plugins);
    assert.equal(report.plugins!.length, 1);
    const [item] = report.plugins!;
    assert.equal(item.id, "sample-plugin");
    assert.equal(item.name, "sample-plugin");
    assert.equal(item.version, "1.2.3");
    assert.equal(item.source, "extensions");
    assert.equal(item.path, pluginDir);
    assert.equal(item.capturedInManifests, false);
  });

  it("joins skill files with config_manifests when a row exists", () => {
    const skillFile = join(openclawDir, "skills", "alpha.ts");
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, "export function run() {}");

    store.upsertManifest(`skills:${skillFile}`, "skills", "abc123", skillFile);

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    assert.equal(report.summary.skills, 1);
    const [item] = report.skills!;
    assert.equal(item.id, "alpha");
    assert.equal(item.contentHash, "abc123");
    assert.equal(item.capturedInManifests, true);
    assert.ok(item.capturedAt);
  });

  it("hashes uncaptured skill files on demand", () => {
    const skillFile = join(openclawDir, "skills", "beta.ts");
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, "// no manifest row");

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    const [item] = report.skills!;
    assert.equal(item.capturedInManifests, false);
    assert.ok(item.contentHash && item.contentHash.length === 64, "contentHash should be sha256 hex");
    assert.equal(item.capturedAt, undefined);
  });

  it("lists soul and cron files at openclaw root", () => {
    writeFileSync(join(openclawDir, "primary.soul.yaml"), "name: primary");
    writeFileSync(join(openclawDir, "nightly.cron.yaml"), "schedule: 0 0 * * *");

    const soulReport = collectInventory(store, "soul", { openclawDir, projectRoot });
    assert.equal(soulReport.summary.soul, 1);
    assert.equal(soulReport.soul![0].id, "primary");
    assert.ok(soulReport.soul![0].contentHash);

    const cronReport = collectInventory(store, "crons", { openclawDir, projectRoot });
    assert.equal(cronReport.summary.crons, 1);
    assert.equal(cronReport.crons![0].id, "nightly");
  });

  it("lists openclaw cron jobs from cron/jobs.json (one item per job, shared file path)", () => {
    mkdirSync(join(openclawDir, "cron"));
    writeFileSync(
      join(openclawDir, "cron", "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          { id: "daily-report", schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" } },
          { id: "interval-job", schedule: { kind: "every", everyMs: 60_000 } },
        ],
      }),
    );

    const report = collectInventory(store, "crons", { openclawDir, projectRoot });
    assert.equal(report.summary.crons, 2);
    const ids = report.crons!.map((c) => c.id).sort();
    assert.deepEqual(ids, ["daily-report", "interval-job"]);
    const expectedPath = join(openclawDir, "cron", "jobs.json");
    for (const item of report.crons!) {
      assert.equal(item.path, expectedPath);
      assert.equal(item.source, "openclaw_root");
      assert.ok(item.contentHash && item.contentHash.length === 64);
    }
    const hashes = new Set(report.crons!.map((c) => c.contentHash));
    assert.equal(hashes.size, 1, "all items share the jobs.json content hash");
  });

  it("merges jobs.json with legacy .cron.*.json files; jobs.json wins on id collision", () => {
    mkdirSync(join(openclawDir, "cron"));
    writeFileSync(
      join(openclawDir, "cron", "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [{ id: "shared", schedule: { kind: "every", everyMs: 1000 } }],
      }),
    );
    writeFileSync(
      join(openclawDir, "shared.cron.yaml"),
      "schedule: { kind: every, everyMs: 9999 }",
    );
    writeFileSync(join(openclawDir, "legacy-only.cron.yaml"), "schedule: { kind: at }");

    const report = collectInventory(store, "crons", { openclawDir, projectRoot });
    assert.equal(report.summary.crons, 2);
    const byId = Object.fromEntries(report.crons!.map((c) => [c.id, c.path]));
    assert.equal(byId["shared"], join(openclawDir, "cron", "jobs.json"));
    assert.ok(byId["legacy-only"].endsWith("legacy-only.cron.yaml"));
  });

  it("surfaces orphan manifest rows when files no longer exist", () => {
    const ghost = join(openclawDir, "skills", "ghost.ts");
    // Do NOT create the file. Just seed the manifest.
    store.upsertManifest(`skills:${ghost}`, "skills", "deadbeef", ghost);

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    assert.equal(report.skills!.length, 1);
    const [item] = report.skills!;
    assert.equal(item.path, "");
    assert.equal(item.capturedInManifests, true);
    assert.equal(item.contentHash, "deadbeef");
    assert.equal(item.id, ghost);
  });

  it("falls back to node_modules when ~/.openclaw/extensions is empty", () => {
    const pluginDir = join(projectRoot, "node_modules", "fake-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "openclaw.plugin.json"), JSON.stringify({ id: "fake", name: "fake-plugin", version: "0.0.1" }));
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "fake-plugin", version: "0.0.1" }));

    const report = collectInventory(store, "plugins", { openclawDir, projectRoot });
    assert.equal(report.summary.plugins, 1);
    assert.equal(report.plugins![0].source, "node_modules");
    assert.equal(report.plugins![0].id, "fake");
  });

  it("falls back to node_modules under scoped packages", () => {
    const pluginDir = join(projectRoot, "node_modules", "@scope", "scoped-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "openclaw.plugin.json"), JSON.stringify({ name: "@scope/scoped-plugin", version: "2.0.0" }));

    const report = collectInventory(store, "plugins", { openclawDir, projectRoot });
    assert.equal(report.summary.plugins, 1);
    assert.equal(report.plugins![0].name, "@scope/scoped-plugin");
  });

  it("prefers ~/.openclaw/extensions over node_modules when both exist", () => {
    const realPlugin = join(openclawDir, "extensions", "real-one");
    mkdirSync(realPlugin, { recursive: true });
    writeFileSync(join(realPlugin, "package.json"), JSON.stringify({ name: "real-one", version: "1.0.0" }));

    const nmPlugin = join(projectRoot, "node_modules", "ignored-one");
    mkdirSync(nmPlugin, { recursive: true });
    writeFileSync(join(nmPlugin, "openclaw.plugin.json"), JSON.stringify({ name: "ignored-one" }));

    const report = collectInventory(store, "plugins", { openclawDir, projectRoot });
    assert.equal(report.summary.plugins, 1);
    assert.equal(report.plugins![0].id, "real-one");
    assert.equal(report.plugins![0].source, "extensions");
  });

  it("summary counts cover all five lenses including orphans", () => {
    mkdirSync(join(openclawDir, "extensions", "p1"), { recursive: true });
    mkdirSync(join(openclawDir, "skills"), { recursive: true });
    writeFileSync(join(openclawDir, "skills", "s1.ts"), "x");
    mkdirSync(join(openclawDir, "tools"), { recursive: true });
    writeFileSync(join(openclawDir, "tools", "t1.ts"), "x");
    writeFileSync(join(openclawDir, "x.soul.yaml"), "x");
    writeFileSync(join(openclawDir, "y.cron.yaml"), "x");

    // Orphan: manifest row for a missing tool file
    const missingTool = join(openclawDir, "tools", "removed.ts");
    store.upsertManifest(`tools:${missingTool}`, "tools", "h", missingTool);

    const report = collectInventory(store, "summary", { openclawDir, projectRoot });
    assert.deepEqual(report.summary, { plugins: 1, skills: 1, tools: 2, soul: 1, crons: 1 });
    // Summary-only report should not include per-item arrays
    assert.equal(report.plugins, undefined);
    assert.equal(report.skills, undefined);
  });

  it("returns items sorted by id for stable output", () => {
    mkdirSync(join(openclawDir, "skills"), { recursive: true });
    writeFileSync(join(openclawDir, "skills", "zeta.ts"), "x");
    writeFileSync(join(openclawDir, "skills", "alpha.ts"), "x");
    writeFileSync(join(openclawDir, "skills", "mike.ts"), "x");

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    const ids = report.skills!.map((i) => i.id);
    assert.deepEqual(ids, ["alpha", "mike", "zeta"]);
  });

  it("walks nested skill subdirectories and uses path-relative ids", () => {
    const nested = join(openclawDir, "skills", "outer", "inner");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "deep.ts"), "x");

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    assert.equal(report.summary.skills, 1);
    // Path-relative id prevents collisions between same-named files in
    // different subdirectories.
    assert.equal(report.skills![0].id, "outer/inner/deep");
    assert.equal(report.skills![0].name, "deep");
  });

  it("path-relative ids keep same-named files in different subdirs distinct", () => {
    const a = join(openclawDir, "skills", "groupA");
    const b = join(openclawDir, "skills", "groupB");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "foo.ts"), "// A");
    writeFileSync(join(b, "foo.ts"), "// B");

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    assert.equal(report.summary.skills, 2);
    const ids = report.skills!.map((i) => i.id);
    assert.deepEqual(ids, ["groupA/foo", "groupB/foo"]);
  });

  it("skips symlinks inside skills/", () => {
    const skills = join(openclawDir, "skills");
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "real.ts"), "real");
    const sensitive = mkdtempSync(join(tmpdir(), "audit-inv-sensitive-"));
    writeFileSync(join(sensitive, "secret.txt"), "do not hash me");
    try {
      symlinkSync(sensitive, join(skills, "linked-out"), "dir");
      symlinkSync(join(sensitive, "secret.txt"), join(skills, "linked-file.ts"), "file");

      const report = collectInventory(store, "skills", { openclawDir, projectRoot });
      const paths = report.skills!.map((i) => i.path);
      assert.equal(paths.length, 1);
      assert.ok(paths[0]!.endsWith("real.ts"), `expected only real.ts, got ${paths.join(", ")}`);
    } finally {
      rmSync(sensitive, { recursive: true, force: true });
    }
  });

  it("skips dotfiles and node_modules in skill walks", () => {
    const skills = join(openclawDir, "skills");
    mkdirSync(join(skills, "node_modules"), { recursive: true });
    writeFileSync(join(skills, "node_modules", "pkg.ts"), "x");
    writeFileSync(join(skills, ".DS_Store"), "x");
    writeFileSync(join(skills, "real.ts"), "x");

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    assert.equal(report.summary.skills, 1);
    assert.equal(report.skills![0].id, "real");
  });

  it("sanitises control characters in plugin metadata fields", () => {
    const dir = join(openclawDir, "extensions", "evil");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "ok\r\nfake-row 9.9.9",
      version: "1.0\x1b[2K0",
    }));

    const report = collectInventory(store, "plugins", { openclawDir, projectRoot });
    const [item] = report.plugins!;
    assert.ok(!item.name.includes("\r"));
    assert.ok(!item.name.includes("\n"));
    assert.ok(item.name.includes("\\r"));
    assert.ok(!item.version!.includes("\x1b"));
  });

  it("orphan id strips manifest_type prefix and never echoes raw path", () => {
    const ghost = join(openclawDir, "skills", "ghost.ts");
    store.upsertManifest(`skills:${ghost}`, "skills", "deadbeef", ghost);

    const report = collectInventory(store, "skills", { openclawDir, projectRoot });
    const [item] = report.skills!;
    assert.equal(item.path, "");
    // id is the manifest id with the manifest_type prefix stripped,
    // not a raw fallback to the filesystem path.
    assert.equal(item.id, ghost);
    assert.ok(!item.id.startsWith("skills:"));
  });
});
