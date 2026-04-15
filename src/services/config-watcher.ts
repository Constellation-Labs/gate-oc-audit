import { readFileSync, existsSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import type { AuditStore } from "../store/audit-store.js";
import type { ToolScanner } from "../scanner.js";
import type { NotificationService } from "./notifications.js";
import type { EventType, ConfigChangeType, ConfigChangeMetadata, ScanFinding } from "../types/events.js";
import { fileHash } from "../util/fs.js";

interface ManifestEntry {
  contentHash: string;
  filePath: string;
}

interface WatchedDir {
  path: string;
  manifestType: ManifestType;
}

type ManifestType = "skills" | "tools" | "soul" | "cron";

const MANIFEST_TO_EVENT: Record<ManifestType, EventType> = {
  skills: "config.skill_changed",
  tools: "config.tool_changed",
  soul: "config.soul_changed",
  cron: "config.cron_changed",
};

const CODE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".mts", ".cts"]);

function fileLinesCount(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

export class ConfigWatcher {
  private store: AuditStore;
  private scanner: ToolScanner;
  private notifier: NotificationService;
  private watcher: { close(): Promise<void>; on(event: string, listener: (...args: any[]) => void): any } | undefined;
  private manifest = new Map<string, ManifestEntry>();
  private watchedDirs: WatchedDir[];
  private openclawDir: string;

  constructor(
    store: AuditStore,
    scanner: ToolScanner,
    notifier: NotificationService,
    config: Record<string, unknown> = {},
  ) {
    this.store = store;
    this.scanner = scanner;
    this.notifier = notifier;

    this.openclawDir = typeof config.openclawDir === "string"
      ? resolve(config.openclawDir)
      : resolve(process.env.HOME ?? ".", ".openclaw");

    this.watchedDirs = [
      { path: resolve(this.openclawDir, "skills"), manifestType: "skills" },
      { path: resolve(this.openclawDir, "tools"), manifestType: "tools" },
    ];
  }

  async start(): Promise<void> {
    let chokidar: typeof import("chokidar");
    try {
      chokidar = await import("chokidar");
    } catch {
      console.error("[audit-plugin] chokidar not available, config watching disabled");
      return;
    }

    this.loadManifestFromStore();

    const watchPaths: string[] = [];
    for (const wd of this.watchedDirs) {
      if (existsSync(wd.path)) watchPaths.push(wd.path);
    }
    if (existsSync(this.openclawDir)) {
      watchPaths.push(this.openclawDir);
    }

    if (watchPaths.length === 0) {
      console.error("[audit-plugin] No config paths found to watch");
      return;
    }

    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: false,
      persistent: true,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (filePath: string, stats) => {
        // Always allow directories
        if (stats?.isDirectory()) return false;
        if (!extname(filePath) && !stats) return false; // first pass, no stats yet
        // Allow everything under skills/ and tools/
        for (const wd of this.watchedDirs) {
          if (filePath.startsWith(wd.path + sep) || filePath === wd.path) return false;
        }
        // In the root openclaw dir, only allow soul and cron files
        const name = basename(filePath);
        if (name.includes(".soul.") || name.includes(".cron.")) return false;
        return true;
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
      const manifestType = this.resolveManifestType(resolvedPath);
      if (!manifestType) return;

      const existing = this.manifest.get(resolvedPath);
      let effectiveChangeType = rawChangeType;

      if (rawChangeType === "removed") {
        if (!existing) return;
        this.manifest.delete(resolvedPath);
        try { this.store.deleteManifest(`${manifestType}:${resolvedPath}`); } catch (err) {
          console.error("[audit-plugin] Failed to delete config manifest:", err instanceof Error ? err.message : err);
        }
      } else {
        const hash = fileHash(resolvedPath);
        if (hash === undefined) return;
        if (existing?.contentHash === hash) return;

        this.manifest.set(resolvedPath, { contentHash: hash, filePath: resolvedPath });
        try { this.store.upsertManifest(`${manifestType}:${resolvedPath}`, manifestType, hash, resolvedPath); } catch (err) {
          console.error("[audit-plugin] Failed to upsert config manifest:", err instanceof Error ? err.message : err);
        }

        if (!existing) effectiveChangeType = "added";
      }

      const artifactName = basename(filePath, extname(filePath));
      const eventType = MANIFEST_TO_EVENT[manifestType];

      let diffSummary: string | undefined;
      if (effectiveChangeType === "added") {
        const lines = fileLinesCount(resolvedPath);
        diffSummary = `New file (${lines} lines)`;
      } else if (effectiveChangeType === "modified") {
        const lines = fileLinesCount(resolvedPath);
        diffSummary = `Source updated (${lines} lines)`;
      } else {
        diffSummary = "File removed";
      }
      if (diffSummary && diffSummary.length > 2048) {
        diffSummary = diffSummary.slice(0, 2048);
      }

      const changeMeta: ConfigChangeMetadata = {
        artifactName,
        artifactType: manifestType,
        changeType: effectiveChangeType,
        filePath: resolvedPath,
        contentHash: effectiveChangeType === "removed"
          ? (existing?.contentHash ?? "")
          : this.manifest.get(resolvedPath)!.contentHash,
        previousHash: existing?.contentHash,
        diffSummary,
      };

      this.store.append({
        eventType,
        category: "config",
        description: `${manifestType} ${effectiveChangeType}: ${artifactName}`,
        metadata: { ...changeMeta },
      });

      // Run scanner on code files for add/modify
      let scanFindings: ScanFinding[] | undefined;
      if (effectiveChangeType !== "removed" && this.isCodeFile(resolvedPath)) {
        scanFindings = this.scanner.scan(resolvedPath);
        if (scanFindings.length > 0) {
          this.store.append({
            eventType: "security.scan_result",
            category: "security",
            description: `Scan: ${scanFindings.length} finding(s) in ${artifactName}`,
            metadata: {
              toolName: artifactName,
              filePath: resolvedPath,
              findings: scanFindings,
            },
          });
        }
      }

      this.notifier.notifyConfigChange(changeMeta, scanFindings).catch((err) => {
        console.error("[audit-plugin] Notification error:", err);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] Config change handler error:", message);
    }
  }

  private resolveManifestType(filePath: string): ManifestType | undefined {
    for (const wd of this.watchedDirs) {
      if (filePath.startsWith(wd.path + sep)) {
        return wd.manifestType;
      }
    }
    const name = basename(filePath);
    if (name.includes(".soul.")) return "soul";
    if (name.includes(".cron.")) return "cron";
    return undefined;
  }

  private isCodeFile(filePath: string): boolean {
    return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
  }

  private loadManifestFromStore(): void {
    try {
      const configTypes: ManifestType[] = ["skills", "tools", "soul", "cron"];
      for (const mt of configTypes) {
        for (const row of this.store.getManifestsByType(mt)) {
          if (row.filePath) {
            this.manifest.set(row.filePath, {
              contentHash: row.contentHash,
              filePath: row.filePath,
            });
          }
        }
      }
    } catch {
      // Start with empty manifest
    }
  }
}
