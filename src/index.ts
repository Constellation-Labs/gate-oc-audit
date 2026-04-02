import type { OpenClawPluginApi } from "./types/openclaw-sdk.js";
import { AuditStore } from "./store/audit-store.js";
import { registerHooks } from "./hooks.js";

export default {
  id: "constellation-audit",
  name: "Constellation Audit Trail",
  description: "Tamper-evident audit trail with Digital Evidence anchoring",

  register(api: OpenClawPluginApi) {
    const config = api.config.plugins.entries["constellation-audit"]?.config ?? {};
    const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
    const store = new AuditStore(dbPath);

    registerHooks(api, store);
  },
};
