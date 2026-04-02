import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AuditStore } from "./store/audit-store.js";
import { registerHooks } from "./hooks.js";
import { cliAuditHandler, cliVerifyHandler, cliExportHandler } from "./cli.js";
import { RetentionService } from "./services/retention.js";

export default definePluginEntry({
  id: "constellation-audit",
  name: "Constellation Audit Trail",
  description: "Tamper-evident audit trail with Digital Evidence anchoring",

  register(api) {
    const config = api.pluginConfig ?? {};
    const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
    const store = new AuditStore(dbPath);

    registerHooks(api, store);

    api.registerCli(({ program }) => {
      const audit = program.command("audit").description("View and manage audit trail");

      audit
        .command("list")
        .description("View recent audit events")
        .option("--last <n>", "Show last N events")
        .option("--type <type>", "Filter by event type")
        .option("--category <category>", "Filter by category")
        .option("--session <id>", "Filter by session ID")
        .option("--limit <n>", "Max events to return")
        .option("--offset <n>", "Skip first N events")
        .action((opts) => cliAuditHandler(store, opts));

      audit
        .command("verify")
        .description("Verify Merkle chain integrity")
        .action(() => cliVerifyHandler(store));

      audit
        .command("export [format]")
        .description("Export audit logs as JSON or CSV")
        .option("--type <type>", "Filter by event type")
        .option("--category <category>", "Filter by category")
        .option("--session <id>", "Filter by session ID")
        .option("--limit <n>", "Max events to export")
        .action((format: string | undefined, opts: Record<string, string>) =>
          cliExportHandler(store, format, opts),
        );
    }, {
      descriptors: [
        { name: "audit", description: "View and manage audit trail", hasSubcommands: true },
      ],
    });

    const retention = new RetentionService(store, config);
    api.registerService({
      id: "constellation-audit-retention",
      start() {
        retention.start();
      },
      stop() {
        retention.stop();
      },
    });
  },
});
