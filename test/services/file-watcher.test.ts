import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../../src/store/audit-store.js";
import { FileWatcher } from "../../src/services/file-watcher.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import type { AuditEvent } from "../../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-filewatch-")), "test.db");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FileWatcher", () => {
  let dbPath: string;
  let store: AuditStore;
  let limiter: RateLimiter;
  let watchDir: string;
  let activeWatcher: FileWatcher | undefined;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    limiter = new RateLimiter(store);

    watchDir = mkdtempSync(join(tmpdir(), "filewatch-dir-"));
  });

  afterEach(() => {
    activeWatcher?.stop();
    activeWatcher = undefined;
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
    rmSync(watchDir, { recursive: true, force: true });
  });

  it("does nothing when no patterns configured", async () => {
    activeWatcher = new FileWatcher(store, limiter, {});
    await activeWatcher.start();
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    assert.equal(events.length, 0);
  });

  it("does not fire events for pre-existing files on startup", async () => {
    writeFileSync(join(watchDir, "existing.txt"), "already here");

    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
      fileWatchIntervalMs: 100,
      fileWatchUsePolling: true,
    });
    await activeWatcher.start();
    await sleep(1500);
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    assert.equal(events.length, 0, "Should not fire events for pre-existing files");
  });

  it("detects new file", async () => {
    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
      fileWatchIntervalMs: 100,
      fileWatchUsePolling: true,
    });
    await activeWatcher.start();
    await sleep(500);

    writeFileSync(join(watchDir, "hello.txt"), "hello world");
    await sleep(2000);
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    assert.ok(events.length > 0, "Should have logged a file change event");
    assert.ok(events.some((e: AuditEvent) => e.eventType === "system.file_changed"));

    const added = events.find(
      (e: AuditEvent) => (e.metadata as Record<string, unknown>).changeType === "added",
    );
    assert.ok(added, "Should have an 'added' event");
    assert.ok((added!.metadata as Record<string, unknown>).contentHash, "Should include contentHash");
    assert.ok((added!.metadata as Record<string, unknown>).fileSize, "Should include fileSize");
  });

  it("detects modified file", async () => {
    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
      fileWatchIntervalMs: 100,
      fileWatchUsePolling: true,
    });
    await activeWatcher.start();
    await sleep(500);

    // Create file while watcher is running
    writeFileSync(join(watchDir, "data.txt"), "version 1");
    await sleep(2000);

    // Modify it
    writeFileSync(join(watchDir, "data.txt"), "version 2");
    await sleep(2000);
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    const modified = events.filter(
      (e: AuditEvent) => (e.metadata as Record<string, unknown>).changeType === "modified",
    );
    assert.ok(modified.length > 0, "Should have detected modification");
    assert.ok((modified[0].metadata as Record<string, unknown>).previousHash, "Should include previousHash");
  });

  it("detects removed file", async () => {
    const filePath = join(watchDir, "temp.txt");

    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
      fileWatchIntervalMs: 100,
      fileWatchUsePolling: true,
    });
    await activeWatcher.start();
    await sleep(500);

    // Create then remove while watcher is running
    writeFileSync(filePath, "content");
    await sleep(2000);

    rmSync(filePath);
    await sleep(2000);
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    const removed = events.filter(
      (e: AuditEvent) => (e.metadata as Record<string, unknown>).changeType === "removed",
    );
    assert.ok(removed.length > 0, "Should have detected removal");
  });

  it("respects ignore patterns", async () => {
    mkdirSync(join(watchDir, "ignored"), { recursive: true });

    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
      fileWatchIgnorePatterns: [join(watchDir, "ignored", "**")],
      fileWatchIntervalMs: 100,
      fileWatchUsePolling: true,
    });
    await activeWatcher.start();
    await sleep(500);

    writeFileSync(join(watchDir, "ignored", "secret.txt"), "should be ignored");
    await sleep(2000);
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    const ignoredEvents = events.filter(
      (e: AuditEvent) => ((e.metadata as Record<string, unknown>).filePath as string)?.includes("ignored"),
    );
    assert.equal(ignoredEvents.length, 0, "Should not have events for ignored files");
  });

  it("deduplicates identical content", async () => {
    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
      fileWatchIntervalMs: 100,
      fileWatchUsePolling: true,
    });
    await activeWatcher.start();
    await sleep(500);

    // Create file while watcher is running
    writeFileSync(join(watchDir, "stable.txt"), "unchanged content");
    await sleep(2000);

    // Re-write the same content
    writeFileSync(join(watchDir, "stable.txt"), "unchanged content");
    await sleep(2000);
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    const stableEvents = events.filter(
      (e: AuditEvent) => ((e.metadata as Record<string, unknown>).filePath as string)?.includes("stable.txt"),
    );
    // Only the initial "added" event, no "modified" since hash is the same
    assert.equal(stableEvents.length, 1, "Should only have one event (initial add)");
    assert.equal(
      (stableEvents[0].metadata as Record<string, unknown>).changeType,
      "added",
    );
  });

  it("clamps pollIntervalMs to minimum of 100", async () => {
    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
      fileWatchIntervalMs: 0,
      fileWatchUsePolling: true,
    });
    await activeWatcher.start();
    await sleep(500);

    writeFileSync(join(watchDir, "fast.txt"), "content");
    await sleep(2000);
    activeWatcher.stop();

    const events = store.query({ category: "system" });
    assert.ok(events.length > 0, "Should still detect files with clamped interval");
  });

  it("stop is idempotent", async () => {
    activeWatcher = new FileWatcher(store, limiter, {
      fileWatchPatterns: [join(watchDir, "**")],
    });
    await activeWatcher.start();
    activeWatcher.stop();
    activeWatcher.stop(); // should not throw
  });
});
