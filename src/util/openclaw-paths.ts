import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface OpenclawPathConfig {
  openclawDir?: unknown;
}

export function resolveOpenclawDir(config: OpenclawPathConfig): string {
  const fromConfig = typeof config.openclawDir === "string" ? config.openclawDir : undefined;
  const raw = fromConfig ?? resolve(process.env.HOME ?? ".", ".openclaw");
  return resolve(raw);
}

export function canonicalizeOpenclawDir(openclawDir: string): string {
  // Resolve the trust root through symlinks once at entry so downstream
  // path comparisons (and realpath-based escape checks) are stable.
  try {
    return realpathSync(openclawDir);
  } catch {
    return resolve(openclawDir);
  }
}

export function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isLink(join(dir, e.name)))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

interface PluginManifestShape {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  main?: unknown;
}

interface PackageJsonShape {
  name?: unknown;
  version?: unknown;
  main?: unknown;
}

function readJsonIfExists<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface PluginMetadata {
  id: string;
  name: string;
  version?: string;
  entryFile?: string;
}

export function extractPluginMetadata(dir: string): PluginMetadata {
  const dirName = basename(dir);
  const pluginManifest = readJsonIfExists<PluginManifestShape>(join(dir, "openclaw.plugin.json"));
  const pkg = readJsonIfExists<PackageJsonShape>(join(dir, "package.json"));

  const id = nonEmptyString(pluginManifest?.id) ?? dirName;
  const name = nonEmptyString(pluginManifest?.name)
    ?? nonEmptyString(pkg?.name)
    ?? dirName;
  const version = nonEmptyString(pluginManifest?.version)
    ?? nonEmptyString(pkg?.version);
  const entryRel = nonEmptyString(pluginManifest?.main) ?? nonEmptyString(pkg?.main);
  const entryFile = entryRel ? resolve(dir, entryRel) : undefined;

  return { id, name, version, entryFile };
}

export function listExtensionsPluginDirs(openclawDir: string): string[] {
  return listSubdirs(join(openclawDir, "extensions"));
}

export function listNodeModulesPluginDirs(projectRoot: string): string[] {
  const nodeModules = join(projectRoot, "node_modules");
  if (!existsSync(nodeModules)) return [];
  const out: string[] = [];
  let topLevel: { name: string; isDirectory(): boolean }[];
  try {
    topLevel = readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of topLevel) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (e.name.startsWith("@")) {
      let scoped: { name: string; isDirectory(): boolean }[];
      try {
        scoped = readdirSync(join(nodeModules, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (!s.isDirectory()) continue;
        const dir = join(nodeModules, e.name, s.name);
        if (existsSync(join(dir, "openclaw.plugin.json"))) out.push(dir);
      }
    } else {
      const dir = join(nodeModules, e.name);
      if (existsSync(join(dir, "openclaw.plugin.json"))) out.push(dir);
    }
  }
  return out;
}
