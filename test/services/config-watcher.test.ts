import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../../src/store/audit-store.js";
import { ConfigWatcher } from "../../src/services/config-watcher.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import { SmtService } from "../../src/services/smt-service.js";
import { ToolScanner } from "../../src/scanner.js";
import { NotificationService } from "../../src/services/notifications.js";
import type { AuditEvent } from "../../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-cfgwatch-")), "test.db");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ConfigWatcher", () => {
  let dbPath: string;
  let store: AuditStore;
  let limiter: RateLimiter;
  let openclawDir: string;
  let scanner: ToolScanner;
  let notifier: NotificationService;

  beforeEach(async () => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    limiter = new RateLimiter(store);
    scanner = new ToolScanner();
    notifier = new NotificationService(); // no webhook URL — won't send

    openclawDir = mkdtempSync(join(tmpdir(), "openclaw-dir-"));
    mkdirSync(join(openclawDir, "skills"), { recursive: true });
    mkdirSync(join(openclawDir, "tools"), { recursive: true });
  });

  afterEach(async () => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
    rmSync(openclawDir, { recursive: true, force: true });
  });

  it("detects new skill file", async () => {
    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    await watcher.start();

    // Give watcher time to initialize
    await sleep(500);

    writeFileSync(
      join(openclawDir, "skills", "test-skill.ts"),
      'export function run() { return "hello"; }',
    );

    // Wait for chokidar to detect the change
    await sleep(1500);
    watcher.stop();

    const events = store.query({ category: "config" });
    assert.ok(events.length > 0, "Should have logged a config change event");
    assert.ok(events.some((e: AuditEvent) => e.eventType === "config.skill_changed"));
  });

  it("detects modified tool file", async () => {
    // Create file before watcher starts
    writeFileSync(join(openclawDir, "tools", "my-tool.ts"), "version 1");

    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    await watcher.start();
    await sleep(500);

    // Modify the file
    writeFileSync(join(openclawDir, "tools", "my-tool.ts"), "version 2");
    await sleep(1500);
    watcher.stop();

    const events = store.query({ category: "config" });
    const modifiedEvents = events.filter(
      (e: AuditEvent) => e.eventType === "config.tool_changed" &&
        (e.metadata as Record<string, unknown>).changeType === "modified",
    );
    assert.ok(modifiedEvents.length > 0, "Should have detected modification");
  });

  it("runs scanner on code files and logs findings", async () => {
    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    await watcher.start();
    await sleep(500);

    // Write a suspicious skill
    const cpMod = ["child", "process"].join("_");
    writeFileSync(
      join(openclawDir, "skills", "evil.ts"),
      `const cp = require("${cpMod}");\ncp.run("rm -rf /");`,
    );

    await sleep(1500);
    watcher.stop();

    const scanEvents = store.query({ category: "security" });
    assert.ok(scanEvents.length > 0, "Should have logged scan results");
    assert.ok(scanEvents.some((e: AuditEvent) => e.eventType === "security.scan_result"));
  });

  it("updates config_manifests table", async () => {
    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    await watcher.start();
    await sleep(500);

    writeFileSync(join(openclawDir, "skills", "tracked.ts"), "content");
    await sleep(1500);
    watcher.stop();

    const manifests = store.getManifestsByType("skills");

    assert.ok(manifests.length > 0, "Should have entries in config_manifests");
    assert.ok(manifests.some((m) => m.id.includes("skills")));
  });

  it("detects removed file", async () => {
    const filePath = join(openclawDir, "skills", "temp.ts");
    writeFileSync(filePath, "content");

    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    await watcher.start();
    await sleep(500);

    rmSync(filePath);
    await sleep(1500);
    watcher.stop();

    const events = store.query({ category: "config" });
    const removedEvents = events.filter(
      (e: AuditEvent) => (e.metadata as Record<string, unknown>).changeType === "removed",
    );
    assert.ok(removedEvents.length > 0, "Should have detected removal");
  });

  it("stop is idempotent", async () => {
    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    await watcher.start();
    watcher.stop();
    watcher.stop(); // should not throw
  });

  it("syncs plugins manifest rows on start", async () => {
    const pluginDir = join(openclawDir, "extensions", "demo-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "demo-plugin", version: "0.1.0", main: "index.js" }),
    );
    writeFileSync(join(pluginDir, "index.js"), "module.exports = {};");

    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    try {
      await watcher.start();
      const manifests = store.getManifestsByType("plugins");
      assert.equal(manifests.length, 1);
      const entryFile = join(pluginDir, "index.js");
      assert.equal(manifests[0].filePath, entryFile);
      assert.equal(manifests[0].id, `plugins:${entryFile}`);
      assert.ok(manifests[0].contentHash.length === 64, "should write sha256 hash");
    } finally {
      watcher.stop();
    }
  });

  it("removes vanished plugin manifest rows on next start", async () => {
    // Seed a row for a plugin that doesn't exist on disk
    const orphan = join(openclawDir, "extensions", "removed-plugin", "index.js");
    store.upsertManifest(`plugins:${orphan}`, "plugins", "stale", orphan);

    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    try {
      await watcher.start();
      const manifests = store.getManifestsByType("plugins");
      assert.equal(manifests.length, 0, "stale row should be cleaned up");
    } finally {
      watcher.stop();
    }
  });

  it("does not scan non-code files", async () => {
    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    await watcher.start();
    await sleep(500);

    // Write a non-code file (e.g., markdown)
    writeFileSync(join(openclawDir, "skills", "readme.md"), `# Not code: ${"ev" + "al"}('x')`);
    await sleep(1500);
    watcher.stop();

    const scanEvents = store.query({ category: "security" });
    assert.equal(scanEvents.length, 0, "Should not scan non-code files");
  });

  it("config change events get SMT proofs", async () => {
    const smtCheckpointDir = join(mkdtempSync(join(tmpdir(), "smt-cfgwatch-")), "checkpoints");
    const smtService = new SmtService({
      smt: {
        checkpointIntervalMs: 0,
        pruneAfterEpochs: 0,
        checkpointDir: smtCheckpointDir,
      },
    });
    await smtService.start();
    limiter.setSmtService(smtService);

    const watcher = new ConfigWatcher(store, limiter, scanner, notifier, { openclawDir });
    try {
      await watcher.start();
      await sleep(500);

      writeFileSync(
        join(openclawDir, "skills", "proven-skill.ts"),
        'export function run() { return "proven"; }',
      );

      await sleep(1500);

      const events = store.query({ category: "config" });
      assert.ok(events.length > 0, "Should have config events");

      const configEvent = events.find((e: AuditEvent) => e.eventType === "config.skill_changed");
      assert.ok(configEvent, "Should have a skill_changed event");

      const rawHash = smtService.computeRawHash(configEvent!);
      const proof = smtService.createProof(rawHash);
      assert.ok(proof, "Should produce a proof for the config event");
      assert.equal(proof!.membership, true, "Proof should confirm membership");
      assert.equal(smtService.verifyProof(proof!), true, "Proof should verify");
    } finally {
      watcher.stop();
      await smtService.stop();
      rmSync(dirname(smtCheckpointDir), { recursive: true, force: true });
    }
  });
});
