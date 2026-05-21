import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type { AuditStore } from "../store/audit-store.js";
import { fileHash } from "../util/fs.js";
import {
  canonicalizeOpenclawDir,
  extractPluginMetadata,
  listExtensionsPluginDirs,
  listNodeModulesPluginDirs,
} from "../util/openclaw-paths.js";
import { jobsJsonPath, readJobsJson } from "./cron-manifests.js";

export type InventoryKind = "plugins" | "skills" | "tools" | "soul" | "crons";
export type ManifestType = "plugins" | "skills" | "tools" | "soul" | "cron";

export const INVENTORY_KINDS: readonly InventoryKind[] = ["plugins", "skills", "tools", "soul", "crons"];

export type InventorySource = "extensions" | "node_modules" | "skills" | "tools" | "openclaw_root";

export interface InventoryItem {
  id: string;
  kind: InventoryKind;
  name: string;
  version?: string;
  path: string;
  source: InventorySource;
  contentHash?: string;
  capturedAt?: string;
  filesystemMtime?: string;
  capturedInManifests: boolean;
}

export interface InventorySummary {
  plugins: number;
  skills: number;
  tools: number;
  soul: number;
  crons: number;
}

export interface InventoryReport {
  summary: InventorySummary;
  plugins?: InventoryItem[];
  skills?: InventoryItem[];
  tools?: InventoryItem[];
  soul?: InventoryItem[];
  crons?: InventoryItem[];
}

export interface CollectOptions {
  openclawDir: string;
  projectRoot?: string;
}

const WALK_MAX_DEPTH = 10;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeStatMtime(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function listSubdirsNoLinks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !isSymlink(join(dir, e.name)))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const visit = (path: string, depth: number): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory() && SKIP_DIR_NAMES.has(e.name)) continue;
      const child = join(path, e.name);
      if (isSymlink(child)) continue;
      if (e.isDirectory()) {
        if (depth < WALK_MAX_DEPTH) visit(child, depth + 1);
      } else if (e.isFile()) {
        out.push(child);
      }
    }
  };
  visit(dir, 0);
  return out;
}

function listRootFilesMatching(dir: string, marker: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.includes(marker) && !isSymlink(join(dir, e.name)))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

// Neutralise CR/LF/ANSI/control chars in attacker-controlled strings before
// they hit operator terminals or JSON sinks consumed via `jq -r`. Mirrors the
// existing CSV-export defence in src/ui/export.ts.
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;
export function sanitizeOutput(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(CONTROL_CHAR_RE, "?");
}

function s(v: string | undefined): string | undefined {
  return v === undefined ? undefined : sanitizeOutput(v);
}

interface ManifestRow {
  id: string;
  contentHash: string;
  filePath: string | null;
  capturedAt: string;
}

function indexByFilePath(rows: ManifestRow[]): Map<string, ManifestRow> {
  const m = new Map<string, ManifestRow>();
  for (const r of rows) {
    if (r.filePath) m.set(r.filePath, r);
  }
  return m;
}

function manifestTypeFor(kind: InventoryKind): ManifestType {
  return kind === "crons" ? "cron" : kind;
}

function orphanSource(kind: InventoryKind): InventorySource {
  switch (kind) {
    case "plugins": return "extensions";
    case "skills": return "skills";
    case "tools": return "tools";
    case "soul":
    case "crons": return "openclaw_root";
  }
}

function orphanIdFromManifestId(manifestId: string, kind: InventoryKind): string {
  const prefix = `${manifestTypeFor(kind)}:`;
  return manifestId.startsWith(prefix) ? manifestId.slice(prefix.length) : manifestId;
}

function appendOrphans(items: InventoryItem[], manifestByPath: Map<string, ManifestRow>, kind: InventoryKind): InventoryItem[] {
  const seen = new Set<string>();
  for (const it of items) seen.add(it.path);
  for (const [path, manifest] of manifestByPath) {
    if (seen.has(path)) continue;
    if (existsSync(path)) continue;
    items.push({
      id: s(orphanIdFromManifestId(manifest.id, kind))!,
      kind,
      name: s(basename(path, extname(path)) || path)!,
      path: "",
      source: orphanSource(kind),
      contentHash: manifest.contentHash,
      capturedAt: manifest.capturedAt,
      capturedInManifests: true,
    });
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return items;
}

function pluginItem(dir: string, source: InventorySource, manifestByPath: Map<string, ManifestRow>): InventoryItem {
  const meta = extractPluginMetadata(dir);
  const manifest = meta.entryFile ? manifestByPath.get(meta.entryFile) : undefined;
  return {
    id: s(meta.id)!,
    kind: "plugins",
    name: s(meta.name)!,
    version: s(meta.version),
    path: dir,
    source,
    contentHash: manifest?.contentHash,
    capturedAt: manifest?.capturedAt,
    filesystemMtime: safeStatMtime(dir),
    capturedInManifests: !!manifest,
  };
}

export function collectPlugins(store: AuditStore, opts: CollectOptions): InventoryItem[] {
  const manifestByPath = indexByFilePath(store.getManifestsByType("plugins"));
  const fromExtensions = listExtensionsPluginDirs(opts.openclawDir);

  let items: InventoryItem[];
  if (fromExtensions.length > 0) {
    items = fromExtensions.map((d) => pluginItem(d, "extensions", manifestByPath));
  } else {
    items = listNodeModulesPluginDirs(opts.projectRoot ?? process.cwd())
      .map((d) => pluginItem(d, "node_modules", manifestByPath));
  }
  return appendOrphans(items, manifestByPath, "plugins");
}

function countPlugins(opts: CollectOptions): number {
  const count = listExtensionsPluginDirs(opts.openclawDir).length;
  if (count > 0) return count;
  return listNodeModulesPluginDirs(opts.projectRoot ?? process.cwd()).length;
}

function relativeId(baseDir: string, file: string): string {
  const rel = relative(baseDir, file);
  const noExt = rel.endsWith(extname(rel)) ? rel.slice(0, rel.length - extname(rel).length) : rel;
  // Normalise Windows-style separators if they ever appear (path.relative on
  // POSIX won't introduce them, but normalising keeps ids portable).
  return noExt.split(/[\\/]/).join("/");
}

function collectFilesUnderDir(
  store: AuditStore,
  kind: "skills" | "tools",
  baseDir: string,
  source: InventorySource,
): InventoryItem[] {
  const manifestByPath = indexByFilePath(store.getManifestsByType(kind));
  const items: InventoryItem[] = [];
  for (const file of walkFiles(baseDir)) {
    const manifest = manifestByPath.get(file);
    const hash = manifest?.contentHash ?? fileHash(file);
    const id = relativeId(baseDir, file);
    items.push({
      id: s(id)!,
      kind,
      name: s(basename(file, extname(file)))!,
      path: file,
      source,
      contentHash: hash,
      capturedAt: manifest?.capturedAt,
      filesystemMtime: safeStatMtime(file),
      capturedInManifests: !!manifest,
    });
  }
  return appendOrphans(items, manifestByPath, kind);
}

export function collectSkills(store: AuditStore, opts: CollectOptions): InventoryItem[] {
  return collectFilesUnderDir(store, "skills", join(opts.openclawDir, "skills"), "skills");
}

export function collectTools(store: AuditStore, opts: CollectOptions): InventoryItem[] {
  return collectFilesUnderDir(store, "tools", join(opts.openclawDir, "tools"), "tools");
}

function collectRootScopedFiles(
  store: AuditStore,
  kind: "soul" | "crons",
  marker: string,
  opts: CollectOptions,
): InventoryItem[] {
  const manifestType = manifestTypeFor(kind);
  const manifestByPath = indexByFilePath(store.getManifestsByType(manifestType));
  const items: InventoryItem[] = [];
  for (const file of listRootFilesMatching(opts.openclawDir, marker)) {
    const manifest = manifestByPath.get(file);
    const hash = manifest?.contentHash ?? fileHash(file);
    const name = basename(file);
    const stem = name.split(marker)[0] ?? name;
    items.push({
      id: s(stem)!,
      kind,
      name: s(stem)!,
      path: file,
      source: "openclaw_root",
      contentHash: hash,
      capturedAt: manifest?.capturedAt,
      filesystemMtime: safeStatMtime(file),
      capturedInManifests: !!manifest,
    });
  }
  return appendOrphans(items, manifestByPath, kind);
}

export function collectSoul(store: AuditStore, opts: CollectOptions): InventoryItem[] {
  return collectRootScopedFiles(store, "soul", ".soul.", opts);
}

function collectCronsFromJobsJson(store: AuditStore, opts: CollectOptions): InventoryItem[] {
  const path = jobsJsonPath(opts.openclawDir);
  if (!existsSync(path)) return [];
  const jobs = readJobsJson(opts.openclawDir);
  if (jobs.length === 0) return [];
  const manifestByPath = indexByFilePath(store.getManifestsByType("cron"));
  const manifest = manifestByPath.get(path);
  const hash = manifest?.contentHash ?? fileHash(path);
  const mtime = safeStatMtime(path);
  return jobs.map((j) => ({
    id: s(j.name)!,
    kind: "crons" as const,
    name: s(j.name)!,
    path,
    source: "openclaw_root" as const,
    contentHash: hash,
    capturedAt: manifest?.capturedAt,
    filesystemMtime: mtime,
    capturedInManifests: !!manifest,
  }));
}

export function collectCrons(store: AuditStore, opts: CollectOptions): InventoryItem[] {
  // openclaw's canonical cron store is `<openclawDir>/cron/jobs.json` (a
  // single file with a jobs[] array); legacy `<id>.cron.*.json` per-file
  // manifests are still surfaced for back-compat. jobs.json wins on id
  // collisions so the inventory matches `audit report` semantics.
  const fromJobs = collectCronsFromJobsJson(store, opts);
  const knownIds = new Set(fromJobs.map((it) => it.id));
  const fromFiles = collectRootScopedFiles(store, "crons", ".cron.", opts)
    .filter((it) => !knownIds.has(it.id));
  const merged = [...fromJobs, ...fromFiles];
  merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return merged;
}

function countSummary(store: AuditStore, opts: CollectOptions): InventorySummary {
  function countWith(kind: "skills" | "tools" | "soul" | "crons", live: number): number {
    let orphans = 0;
    for (const r of store.getManifestsByType(manifestTypeFor(kind))) {
      if (r.filePath && !existsSync(r.filePath)) orphans++;
    }
    return live + orphans;
  }
  const liveSkills = walkFiles(join(opts.openclawDir, "skills")).length;
  const liveTools = walkFiles(join(opts.openclawDir, "tools")).length;
  const liveSoul = listRootFilesMatching(opts.openclawDir, ".soul.").length;
  const legacyCronStems = new Set(
    listRootFilesMatching(opts.openclawDir, ".cron.")
      .map((file) => basename(file).split(".cron.")[0])
      .filter((stem): stem is string => !!stem),
  );
  const jobsJsonCount = existsSync(jobsJsonPath(opts.openclawDir))
    ? readJobsJson(opts.openclawDir).filter((j) => !legacyCronStems.has(j.name)).length
    : 0;
  const liveCrons = legacyCronStems.size + jobsJsonCount;
  return {
    plugins: countPlugins(opts),
    skills: countWith("skills", liveSkills),
    tools: countWith("tools", liveTools),
    soul: countWith("soul", liveSoul),
    crons: countWith("crons", liveCrons),
  };
}

export function collectInventory(
  store: AuditStore,
  kind: InventoryKind | "summary",
  opts: CollectOptions,
): InventoryReport {
  // Canonicalise the trust root through symlinks once so a config that points
  // at a symlinked path can't bypass downstream filesystem checks.
  const resolvedDir = existsSync(opts.openclawDir)
    ? canonicalizeOpenclawDir(opts.openclawDir)
    : resolve(opts.openclawDir);
  const resolved: CollectOptions = { ...opts, openclawDir: resolvedDir };

  if (kind === "summary") {
    return { summary: countSummary(store, resolved) };
  }

  const items =
    kind === "plugins" ? collectPlugins(store, resolved) :
    kind === "skills" ? collectSkills(store, resolved) :
    kind === "tools" ? collectTools(store, resolved) :
    kind === "soul" ? collectSoul(store, resolved) :
    collectCrons(store, resolved);

  const summary: InventorySummary = { plugins: 0, skills: 0, tools: 0, soul: 0, crons: 0 };
  summary[kind] = items.length;

  return {
    summary,
    ...(kind === "plugins" ? { plugins: items } : {}),
    ...(kind === "skills" ? { skills: items } : {}),
    ...(kind === "tools" ? { tools: items } : {}),
    ...(kind === "soul" ? { soul: items } : {}),
    ...(kind === "crons" ? { crons: items } : {}),
  };
}

