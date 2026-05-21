/**
 * Canonical plugin identifier. Mirrors the `id` field in
 * `openclaw.plugin.json` (the manifest is authoritative). Service-level
 * identifiers under `index.ts` extend this with `:<service>` suffixes
 * — those stay as literals at their declaration sites for grep-ability.
 *
 * Centralised so the config writer, the install/status reader, and the
 * plugin entry point can't drift on a rename.
 */
export const PLUGIN_ID = "constellation-audit-plugin";
