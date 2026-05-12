import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AuditStore } from "../store/audit-store.js";
import type { RateLimiter } from "../rate-limiter.js";
import type { ConfigChangeType, FileChangeMetadata } from "../types/events.js";
import { fileHash, fileSizeBytes } from "../util/fs.js";
import {log} from "../util/logger.js";

const MANIFEST_TYPE = "file_watch";

const GLOB_CHARS = /[*?{[]/;

/**
 * Extract the base directory from a glob pattern (the part before the first
 * glob character). For plain paths, returns the path itself if it's a
 * directory, or its parent.
 */
function globParent(pattern: string): string {
  const resolved = resolve(pattern);
  const idx = resolved.search(GLOB_CHARS);
  if (idx === -1) {
    try {
      if (statSync(resolved).isDirectory()) return resolved;
    } catch { /* doesn't exist yet */ }
    return resolve(resolved, "..");
  }
  const prefix = resolved.slice(0, idx);
  const lastSep = prefix.lastIndexOf(sep);
  if (lastSep <= 0) return resolve(".");
  // Preserve drive root on Windows (e.g. "C:\") and filesystem root on POSIX
  return lastSep === prefix.indexOf(sep) ? prefix.slice(0, lastSep + 1) : prefix.slice(0, lastSep);
}

interface ManifestEntry {
  contentHash: string;
  filePath: string;
}

export class FileWatcher {
  private store: AuditStore;
  private limiter: RateLimiter;
  private watcher: { close(): Promise<void>; on(event: string, listener: (...args: any[]) => void): any } | undefined;
  private manifest = new Map<string, ManifestEntry>();
  private patterns: string[];
  private ignorePatterns: string[];
  private pollIntervalMs: number;
  private usePolling: boolean;

  constructor(
    store: AuditStore,
    limiter: RateLimiter,
    config: Record<string, unknown> = {},
  ) {
    this.store = store;
    this.limiter = limiter;
    this.patterns = Array.isArray(config.fileWatchPatterns)
      ? (config.fileWatchPatterns as string[]).filter((p) => typeof p === "string")
      : [];
    this.ignorePatterns = Array.isArray(config.fileWatchIgnorePatterns)
      ? (config.fileWatchIgnorePatterns as string[]).filter((p) => typeof p === "string")
      : [];
    this.pollIntervalMs = typeof config.fileWatchIntervalMs === "number"
      ? Math.max(100, config.fileWatchIntervalMs)
      : 1000;
    this.usePolling = typeof config.fileWatchUsePolling === "boolean"
      ? config.fileWatchUsePolling
      : false;
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    if (this.patterns.length === 0) return;

    let chokidar: typeof import("chokidar");
    try {
      chokidar = await import("chokidar");
    } catch {
      log.warn("chokidar not available, file watching disabled");
      return;
    }

    let isMatch: (path: string, pattern: string, options?: { dot?: boolean }) => boolean;
    try {
      const mod = await import("picomatch");
      // picomatch v4 CJS: dynamic import wraps the module — isMatch lives on .default
      const pm = mod.default ?? mod;
      isMatch = pm.isMatch ?? pm;
      if (typeof isMatch !== "function") throw new Error("isMatch not found");
    } catch {
      log.warn("picomatch not available, file watching disabled");
      return;
    }

    this.loadManifestFromStore();

    // Pre-resolve patterns and build matchers once, so the ignored callback
    // only needs a cheap closure lookup per file.
    const resolvedPatterns = this.patterns.map((p) => resolve(p));
    const matchers = resolvedPatterns.map((p) => (filePath: string) => isMatch(filePath, p, { dot: true }));

    const resolvedIgnore = this.ignorePatterns.map((p) => resolve(p));
    const ignoreMatchers = resolvedIgnore.map((p) => (filePath: string) => isMatch(filePath, p, { dot: true }));

    // Pre-resolve base directories so the watched set is known up front.
    const baseDirs = [...new Set(resolvedPatterns.map(globParent))].filter((d) => existsSync(d));

    if (baseDirs.length === 0) {
      log.warn("No existing directories found for file watch patterns");
      return;
    }

    this.watcher = chokidar.watch(baseDirs, {
      ignoreInitial: true,
      persistent: true,
      depth: 5,
      usePolling: this.usePolling,
      interval: this.pollIntervalMs,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (filePath: string, stats) => {
        if (stats?.isDirectory()) return false;
        if (!stats) return false; // first pass, no stats yet — let through
        const r = resolve(filePath);
        if (ignoreMatchers.some((m) => m(r))) return true;
        return !matchers.some((m) => m(r));
      },
    });

    this.watcher.on("add", (filePath: string) => this.handleChange(filePath, "added"));
    this.watcher.on("change", (filePath: string) => this.handleChange(filePath, "modified"));
    this.watcher.on("unlink", (filePath: string) => this.handleChange(filePath, "removed"));
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = undefined;
    }
  }

  private handleChange(filePath: string, rawChangeType: ConfigChangeType): void {
    try {
      const resolvedPath = resolve(filePath);
      const existing = this.manifest.get(resolvedPath);
      let effectiveChangeType = rawChangeType;

      if (rawChangeType === "removed") {
        if (!existing) return;
        this.manifest.delete(resolvedPath);
        try { this.store.deleteManifest(`${MANIFEST_TYPE}:${resolvedPath}`); } catch (err) {
          log.error(`Failed to delete file watch manifest: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        const hash = fileHash(resolvedPath);
        if (hash === undefined) return; // file disappeared between event and read
        if (existing?.contentHash === hash) return; // no actual change

        this.manifest.set(resolvedPath, { contentHash: hash, filePath: resolvedPath });
        try { this.store.upsertManifest(`${MANIFEST_TYPE}:${resolvedPath}`, MANIFEST_TYPE, hash, resolvedPath); } catch (err) {
          log.error(`Failed to upsert file watch manifest: ${err instanceof Error ? err.message : err}`);
        }

        if (!existing) effectiveChangeType = "added";
      }

      const changeMeta: FileChangeMetadata = {
        filePath: resolvedPath,
        changeType: effectiveChangeType,
        contentHash: effectiveChangeType === "removed"
          ? (existing?.contentHash ?? "")
          : this.manifest.get(resolvedPath)!.contentHash,
        previousHash: existing?.contentHash,
        fileSize: effectiveChangeType === "removed" ? undefined : fileSizeBytes(resolvedPath),
      };

      this.limiter.append({
        eventType: "system.file_changed",
        category: "system",
        description: `file ${effectiveChangeType}: ${resolvedPath}`,
        metadata: { ...changeMeta },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`File change handler error: ${message}`);
    }
  }

  private loadManifestFromStore(): void {
    try {
      for (const row of this.store.getManifestsByType(MANIFEST_TYPE)) {
        if (row.filePath) {
          this.manifest.set(row.filePath, {
            contentHash: row.contentHash,
            filePath: row.filePath,
          });
        }
      }
    } catch {
      // Start with empty manifest
    }
  }
}
