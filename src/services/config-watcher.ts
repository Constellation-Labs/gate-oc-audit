import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import type { AuditStore } from "../store/audit-store.js";
import type { RateLimiter } from "../rate-limiter.js";
import type { ToolScanner } from "../scanner.js";
import type { NotificationService } from "./notifications.js";
import type { EventType, ConfigChangeType, ConfigChangeMetadata, ScanFinding } from "../types/events.js";
import { fileHash } from "../util/fs.js";
import { extractPluginMetadata, listExtensionsPluginDirs, resolveOpenclawDir } from "../util/openclaw-paths.js";
import { readWorkspaceDir } from "../util/host-config.js";
import { WORKSPACE_BOOTSTRAP_FILES, skillRoots } from "./inventory.js";
import { jobsJsonPath } from "./cron-manifests.js";
import {log} from "../util/logger.js";

interface ManifestEntry {
  contentHash: string;
  filePath: string;
}

interface WatchedDir {
  path: string;
  manifestType: ManifestType;
}

type ManifestType = "skills" | "tools" | "workspace" | "cron";

const MANIFEST_TO_EVENT: Record<ManifestType, EventType> = {
  skills: "config.skill_changed",
  tools: "config.tool_changed",
  workspace: "config.workspace_changed",
  cron: "config.cron_changed",
};

/** Bootstrap files we track live, by basename, for O(1) membership checks. */
const WORKSPACE_FILE_SET = new Set<string>(WORKSPACE_BOOTSTRAP_FILES);

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
  private limiter: RateLimiter;
  private scanner: ToolScanner;
  private notifier: NotificationService;
  private watcher: { close(): Promise<void>; on(event: string, listener: (...args: any[]) => void): any } | undefined;
  private manifest = new Map<string, ManifestEntry>();
  private watchedDirs: WatchedDir[];
  private openclawDir: string;
  private workspaceDir: string;
  private jobsJsonPath!: string;

  constructor(
    store: AuditStore,
    limiter: RateLimiter,
    scanner: ToolScanner,
    notifier: NotificationService,
    config: Record<string, unknown> = {},
  ) {
    this.store = store;
    this.limiter = limiter;
    this.scanner = scanner;
    this.notifier = notifier;

    this.openclawDir = resolveOpenclawDir(config);
    this.workspaceDir = resolve(readWorkspaceDir(this.openclawDir));

    // Skills load from several roots by precedence (workspace, project/personal
    // agent, managed/local, extra dirs) — watch them all so a skill change in
    // any of them is audited, mirroring the inventory's collectSkills.
    this.watchedDirs = [
      ...skillRoots(this.openclawDir).map((r) => ({
        path: resolve(r.dir),
        manifestType: "skills" as const,
      })),
      { path: resolve(this.openclawDir, "tools"), manifestType: "tools" },
    ];
    this.jobsJsonPath = resolve(jobsJsonPath(this.openclawDir));
  }

  async start(): Promise<void> {
    let chokidar: typeof import("chokidar");
    try {
      chokidar = await import("chokidar");
    } catch {
      log.warn("chokidar not available, config watching disabled");
      return;
    }

    this.loadManifestFromStore();
    this.syncPluginsManifest();

    const watchPaths: string[] = [];
    for (const wd of this.watchedDirs) {
      if (existsSync(wd.path)) watchPaths.push(wd.path);
    }
    if (existsSync(this.openclawDir)) {
      watchPaths.push(this.openclawDir);
    }
    // Workspace bootstrap files (SOUL.md, AGENTS.md, …) live at the workspace
    // root, which is normally <openclawDir>/workspace (already covered above)
    // but can be relocated via agents.defaults.workspace — watch it explicitly.
    if (existsSync(this.workspaceDir)) {
      watchPaths.push(this.workspaceDir);
    }

    if (watchPaths.length === 0) {
      log.warn("No config paths found to watch");
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
        // Allow the workspace bootstrap files (SOUL.md, AGENTS.md, …) but only
        // when they sit directly in the workspace root — the workspace also
        // holds skills/, memory/*.md, etc. that we must not treat as bootstrap.
        const resolved = resolve(filePath);
        if (WORKSPACE_FILE_SET.has(basename(resolved)) && dirname(resolved) === this.workspaceDir) {
          return false;
        }
        // In the root openclaw dir, allow cron filename markers and the
        // canonical openclaw cron store at `<root>/cron/jobs.json` (chokidar's
        // depth>=1 walk surfaces it from the subdirectory).
        if (resolved === this.jobsJsonPath) return false;
        const name = basename(filePath);
        if (name.includes(".cron.")) return false;
        return true;
      },
    });

    this.watcher.on("add", (filePath: string) => this.handleChange(filePath, "added"));
    this.watcher.on("change", (filePath: string) => this.handleChange(filePath, "modified"));
    this.watcher.on("unlink", (filePath: string) => this.handleChange(filePath, "removed"));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = undefined;
      // chokidar's close() only awaits fs handle closers, not the event
      // emission queue. Queued handleChange callbacks can still fire after
      // this await resolves; they're safe today because the host stops
      // watchers before retention.stop closes the store.
      await watcher.close().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`config watcher close failed: ${msg}`);
      });
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
          log.error(`Failed to delete config manifest: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        const hash = fileHash(resolvedPath);
        if (hash === undefined) return;
        if (existing?.contentHash === hash) return;

        this.manifest.set(resolvedPath, { contentHash: hash, filePath: resolvedPath });
        try { this.store.upsertManifest(`${manifestType}:${resolvedPath}`, manifestType, hash, resolvedPath); } catch (err) {
          log.error(`Failed to upsert config manifest: ${err instanceof Error ? err.message : err}`);
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

      this.limiter.append({
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
          this.limiter.append({
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
        log.error(`Notification error: ${err instanceof Error ? err.message : err}`);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`Config change handler error: ${message}`);
    }
  }

  private resolveManifestType(filePath: string): ManifestType | undefined {
    for (const wd of this.watchedDirs) {
      if (filePath.startsWith(wd.path + sep)) {
        return wd.manifestType;
      }
    }
    if (filePath === this.jobsJsonPath) return "cron";
    const name = basename(filePath);
    if (WORKSPACE_FILE_SET.has(name) && dirname(filePath) === this.workspaceDir) return "workspace";
    if (name.includes(".cron.")) return "cron";
    return undefined;
  }

  private isCodeFile(filePath: string): boolean {
    return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
  }

  private loadManifestFromStore(): void {
    try {
      const configTypes: ManifestType[] = ["skills", "tools", "workspace", "cron"];
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

  // Plugins are coarser-grained than skills/tools (one row per plugin keyed
  // by its resolved entry file). A chokidar per-file watch would write
  // O(files-per-plugin) rows, so we sync once on start and reconcile vanished
  // plugins. The inventory CLI joins against these rows by entry-file path.
  private syncPluginsManifest(): void {
    try {
      const existing = new Map<string, string>();
      for (const row of this.store.getManifestsByType("plugins")) {
        if (row.filePath) existing.set(row.filePath, row.contentHash);
      }

      const seen = new Set<string>();
      for (const dir of listExtensionsPluginDirs(this.openclawDir)) {
        const meta = extractPluginMetadata(dir);
        if (!meta.entryFile || !existsSync(meta.entryFile)) continue;
        const hash = fileHash(meta.entryFile);
        if (!hash) continue;
        seen.add(meta.entryFile);
        if (existing.get(meta.entryFile) !== hash) {
          this.store.upsertManifest(`plugins:${meta.entryFile}`, "plugins", hash, meta.entryFile);
        }
      }

      for (const [path] of existing) {
        if (seen.has(path)) continue;
        if (existsSync(path)) continue;
        try { this.store.deleteManifest(`plugins:${path}`); } catch (err) {
          log.error(`Failed to delete plugin manifest: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      log.error(`Plugin manifest sync error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
