import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** openclaw keys per-plugin hook policy by the plugin's manifest id. */
const AUDIT_PLUGIN_ID = "openclaw-audit-plugin";

/** Hard cap on the host config we parse, mirroring the manifest reader in
 *  openclaw-paths.ts. The file is host-owned and normally a few KB. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

interface HostConfigShape {
  plugins?: {
    entries?: Record<string, { hooks?: { allowConversationAccess?: unknown } }>;
  };
}

/**
 * Read the host opt-in
 * `plugins.entries.openclaw-audit-plugin.hooks.allowConversationAccess` from
 * `<openclawDir>/openclaw.json` — the file the setup wizard writes.
 *
 * openclaw stores this flag as a *sibling* of the plugin's own `config` block,
 * so it never appears on the `config` object openclaw hands the plugin. Status
 * and UI must therefore read it from the host config file directly rather than
 * from the plugin config. Returns false on any read/parse error.
 */
export function readAllowConversationAccess(openclawDir: string): boolean {
  if (!openclawDir) return false;
  try {
    const path = join(openclawDir, "openclaw.json");
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return false;
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as HostConfigShape;
    return cfg.plugins?.entries?.[AUDIT_PLUGIN_ID]?.hooks?.allowConversationAccess === true;
  } catch {
    return false;
  }
}
