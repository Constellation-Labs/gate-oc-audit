import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** openclaw keys per-plugin hook policy by the plugin's manifest id. */
const AUDIT_PLUGIN_ID = "gate-oc-audit";

/** Hard cap on the host config we parse, mirroring the manifest reader in
 *  openclaw-paths.ts. The file is host-owned and normally a few KB. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

interface HostConfigShape {
  plugins?: {
    entries?: Record<string, { hooks?: { allowConversationAccess?: unknown } }>;
  };
  agents?: {
    defaults?: { workspace?: unknown };
  };
  skills?: {
    load?: { extraDirs?: unknown };
  };
}

function expandHome(path: string): string {
  return path.replace(/^~/, process.env.HOME ?? ".");
}

function readHostConfig(openclawDir: string): HostConfigShape | undefined {
  if (!openclawDir) return undefined;
  try {
    const path = join(openclawDir, "openclaw.json");
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return undefined;
    return JSON.parse(readFileSync(path, "utf-8")) as HostConfigShape;
  } catch {
    return undefined;
  }
}

/**
 * Read the host opt-in
 * `plugins.entries.gate-oc-audit.hooks.allowConversationAccess` from
 * `<openclawDir>/openclaw.json` — the file the setup wizard writes.
 *
 * openclaw stores this flag as a *sibling* of the plugin's own `config` block,
 * so it never appears on the `config` object openclaw hands the plugin. Status
 * and UI must therefore read it from the host config file directly rather than
 * from the plugin config. Returns false on any read/parse error.
 *
 * LIMITATION: the host config is read with plain `JSON.parse` (see
 * readHostConfig), NOT a JSON5 parser. If the operator wrote openclaw.json in
 * JSON5 (comments, trailing commas, unquoted keys), parsing fails and this
 * returns false — i.e. a genuine `allowConversationAccess: true` opt-in can be
 * misread as "not opted in." Keep the file strict JSON for the flag to take
 * effect.
 */
export function readAllowConversationAccess(openclawDir: string): boolean {
  const cfg = readHostConfig(openclawDir);
  return cfg?.plugins?.entries?.[AUDIT_PLUGIN_ID]?.hooks?.allowConversationAccess === true;
}

/**
 * Resolve openclaw's agent workspace directory — where the bootstrap files
 * (SOUL.md, AGENTS.md, …) live. openclaw reads this from
 * `agents.defaults.workspace` in `<openclawDir>/openclaw.json`, defaulting to
 * `<openclawDir>/workspace`. A leading `~` is expanded against $HOME.
 *
 * Like readAllowConversationAccess, this uses plain `JSON.parse` (not a JSON5
 * parser), so a config with comments/trailing commas/unquoted keys fails to
 * parse and we fall back to the default `<openclawDir>/workspace`.
 */
export function readWorkspaceDir(openclawDir: string): string {
  const fallback = join(openclawDir, "workspace");
  const configured = readHostConfig(openclawDir)?.agents?.defaults?.workspace;
  if (typeof configured !== "string" || configured.length === 0) return fallback;
  return expandHome(configured);
}

/**
 * Extra skill directories configured under `skills.load.extraDirs` in
 * `<openclawDir>/openclaw.json` (lowest skill-load precedence). Leading `~` is
 * expanded against $HOME. Returns [] when unset or unparseable — same
 * plain-JSON.parse caveat as readWorkspaceDir (a JSON5 file fails to parse).
 */
export function readSkillsExtraDirs(openclawDir: string): string[] {
  const extra = readHostConfig(openclawDir)?.skills?.load?.extraDirs;
  if (!Array.isArray(extra)) return [];
  return extra.filter((d): d is string => typeof d === "string" && d.length > 0).map(expandHome);
}
