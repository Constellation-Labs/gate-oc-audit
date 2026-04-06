import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AuditStore } from "./store/audit-store.js";
import { registerHooks } from "./hooks.js";
import { cliAuditHandler, cliVerifyHandler, cliExportHandler } from "./cli.js";
import { RetentionService } from "./services/retention.js";
import { ConfigWatcher } from "./services/config-watcher.js";
import { DeAnchorService } from "./services/de-anchor.js";
import { NotificationService } from "./services/notifications.js";
import { ToolScanner } from "./scanner.js";

export default definePluginEntry({
  id: "@constellation-network/openclaw-audit-plugin",
  name: "Constellation Audit Trail",
  description: "Tamper-evident audit trail with Digital Evidence anchoring",

  register(api) {
    const config = api.pluginConfig ?? {};
    const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
    const store = new AuditStore(dbPath);

    registerHooks(api, store);

    // --- Shared services ---

    const webhookUrl = typeof config.notificationWebhook === "string"
      ? config.notificationWebhook
      : undefined;
    const notifier = new NotificationService(webhookUrl);
    const scanner = new ToolScanner();

    // --- CLI ---

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

    // --- Background services ---

    const retention = new RetentionService(store, config);
    const configWatcher = new ConfigWatcher(store, scanner, notifier, config);
    const deAnchor = new DeAnchorService(store, config, notifier);

    api.registerService({
      id: "@constellation-network/openclaw-audit-plugin:retention",
      start() {
        retention.start();
      },
      stop() {
        retention.stop();
        // Close DB here — retention is registered first, so it stops last
        // (OpenClaw stops services in reverse registration order).
        store.close();
      },
    });

    api.registerService({
      id: "@constellation-network/openclaw-audit-plugin:config-watcher",
      async start() {
        await configWatcher.start();
      },
      stop() {
        configWatcher.stop();
      },
    });

    api.registerService({
      id: "@constellation-network/openclaw-audit-plugin:de-anchor",
      async start() {
        await deAnchor.start();
      },
      stop() {
        deAnchor.stop();
      },
    });
  },
});
