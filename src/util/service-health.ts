import type { AuditStore } from "../store/audit-store.js";

/**
 * Read a persisted service-health payload by name and cast it to the expected
 * shape, or `undefined` when no row exists. Shared by the CLI status handler
 * (src/cli.ts) and its HTTP mirror (src/ui/routes.ts) so the two stay in lockstep.
 */
export function readHealth<T>(store: AuditStore, name: string): T | undefined {
  const row = store.getServiceHealth(name);
  if (!row) return undefined;
  return row.payload as T;
}
