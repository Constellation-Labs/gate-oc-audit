import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AuditStore } from "./store/audit-store.js";
import { registerHooks } from "./hooks.js";
import { cliAuditHandler, cliVerifyHandler, cliExportHandler } from "./cli.js";
import { RetentionService } from "./services/retention.js";
import { ConfigWatcher } from "./services/config-watcher.js";
import { DeAnchorService } from "./services/de-anchor.js";
import { NotificationService } from "./services/notifications.js";
import { ToolScanner } from "./scanner.js";
import { RateLimiter } from "./rate-limiter.js";

export default definePluginEntry({
  id: "@constellation-network/openclaw-audit-plugin",
  name: "Constellation Audit Trail",
  description: "Tamper-evident audit trail with Digital Evidence anchoring",

  register(api) {
    const config = api.pluginConfig ?? {};
    const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
    const store = new AuditStore(dbPath);

    const limiter = new RateLimiter(store, config);
    registerHooks(api, store, limiter);

    // LLM cost tracking via diagnostic events (separate subscription path)
    import("openclaw/plugin-sdk").then(({ onDiagnosticEvent }) => {
      if (typeof onDiagnosticEvent !== "function") return;
      onDiagnosticEvent("model.usage", (evt: Record<string, unknown>) => {
        try {
          limiter.append({
            eventType: "prompt.response",
            category: "prompt",
            description: `LLM usage: ${evt.provider}/${evt.model}`,
            metadata: {
              provider: evt.provider,
              model: evt.model,
              inputTokens: evt.inputTokens,
              outputTokens: evt.outputTokens,
              cacheTokens: evt.cacheTokens,
              durationMs: evt.durationMs,
              costUsd: evt.costUsd,
            },
          });
        } catch {
          // Fail-open: don't crash on diagnostic events
        }
      });
    }).catch(() => {
      // onDiagnosticEvent not available in this SDK version
    });

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
        .description("Verify Merkle chain integrity and DE checkpoints")
        .action(() => cliVerifyHandler(store, notifier));

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

    // --- Agent-callable tool for DE setup ---

    api.registerTool({
      name: "audit_de_setup",
      description: "Check Digital Evidence anchoring configuration status and provide setup instructions",
      parameters: {},
      handler: () => {
        const hasApiKey = typeof config.deApiKey === "string" && config.deApiKey.length > 0;
        const hasX402 = typeof config.x402Payment === "string" && config.x402Payment.length > 0;

        if (hasApiKey || hasX402) {
          const method = hasApiKey ? "API key" : "x402 micropayment";
          return {
            status: "configured",
            method,
            message: `Digital Evidence anchoring is active via ${method}.`,
          };
        }

        return {
          status: "not_configured",
          message: [
            "Digital Evidence anchoring is not configured.",
            "",
            "To enable tamper-evident audit trail anchoring:",
            "1. Create a free account at https://evidence.constellationnetwork.io",
            "2. Generate an API key from your dashboard",
            "3. Add it to your plugin config:",
            "",
            '   "deApiKey": "your-api-key-here"',
            "",
            "Alternatively, use x402 micropayments with a Constellation wallet:",
            '   "x402Payment": "your-payment-header"',
            "",
            "Anchoring cost: ~2 credits per fingerprint (negligible).",
          ].join("\n"),
        };
      },
    });

    // --- Background services ---

    const retention = new RetentionService(store, config);
    const configWatcher = new ConfigWatcher(store, scanner, notifier, config);
    const deAnchor = new DeAnchorService(store, config, notifier);
    limiter.setDeAnchor(deAnchor);

    api.registerService({
      id: "@constellation-network/openclaw-audit-plugin:retention",
      start() {
        retention.start();
      },
      stop() {
        retention.stop();
        limiter.flush();
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
