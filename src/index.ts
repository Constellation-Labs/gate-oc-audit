import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AuditStore } from "./store/audit-store.js";
import { registerHooks } from "./hooks.js";
import { cliAuditHandler, cliVerifyHandler, cliExportHandler, cliSmtHandler } from "./cli.js";
import { RetentionService } from "./services/retention.js";
import { ConfigWatcher } from "./services/config-watcher.js";
import { DeAnchorService } from "./services/de-anchor.js";
import { NotificationService } from "./services/notifications.js";
import { SmtService } from "./services/smt-service.js";
import { ToolScanner } from "./scanner.js";
import { RateLimiter } from "./rate-limiter.js";

export default definePluginEntry({
  id: "constellation-audit-plugin",
  name: "@constellation-network/openclaw-audit-plugin",
  description: "Constellation Network Tamper-evident audit trail with SMT proofs and Digital Evidence anchoring",

  register(api) {
    const config = api.pluginConfig ?? {};
    const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
    const store = new AuditStore(dbPath);

    const smtService = new SmtService(config);

    const limiter = new RateLimiter(store, config);
    limiter.setSmtService(smtService);
    registerHooks(api, store, limiter);

    // LLM cost tracking via diagnostic events (separate subscription path)
    import("openclaw/plugin-sdk").then(({ onDiagnosticEvent }) => {
      if (typeof onDiagnosticEvent !== "function") return;
      onDiagnosticEvent((evt: Record<string, unknown>) => {
        if (evt.type !== "model.usage") return;
        try {
          limiter.append({
            eventType: "prompt.response",
            category: "prompt",
            description: `LLM usage: ${evt.provider}/${evt.model}`,
            metadata: {
              provider: evt.provider,
              model: evt.model,
              inputTokens: (evt as any).usage?.input,
              outputTokens: (evt as any).usage?.output,
              cacheTokens: (evt as any).usage?.cacheRead,
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
        .description("Verify SMT integrity and DE checkpoints")
        .action(() => cliVerifyHandler(smtService, store, notifier));

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

      // SMT subcommands
      const smt = audit.command("smt").description("Sparse Merkle Tree operations");

      smt
        .command("root")
        .description("Show current SMT root")
        .option("--tree <key>", "Tree identifier")
        .action((opts) => cliSmtHandler(smtService, "root", opts));

      smt
        .command("proof <hash>")
        .description("Generate inclusion/exclusion proof")
        .option("--tree <key>", "Tree identifier")
        .action((hash: string, opts) => cliSmtHandler(smtService, "proof", { ...opts, hash }));

      smt
        .command("verify")
        .description("Verify an SMT proof")
        .requiredOption("--proof <json>", "Proof JSON")
        .action((opts) => cliSmtHandler(smtService, "verify-proof", opts));

      smt
        .command("trees")
        .description("List all SMT trees")
        .action(() => cliSmtHandler(smtService, "trees", {}));

      smt
        .command("chain <conversationId>")
        .description("Show conversation chain")
        .option("--tree <key>", "Tree identifier")
        .action((conversationId: string, opts) =>
          cliSmtHandler(smtService, "chain", { ...opts, conversationId }),
        );
    }, {
      descriptors: [
        { name: "audit", description: "View and manage audit trail", hasSubcommands: true },
      ],
    });

    // --- Agent-callable tools ---

    // registerTool accepts handler-style tools at runtime; cast to satisfy strict types
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
    } as any);

    api.registerTool({
      name: "audit_smt",
      description: "Sparse Merkle Tree audit \u2014 generate proofs, verify integrity, manage snapshots",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "root", "proof", "verify", "trees", "stats",
              "chain", "prune_epoch", "exported_proofs",
              "snapshot", "restore_snapshot",
            ],
            description: "Action to perform",
          },
          tree: { type: "string", description: "Tree identifier" },
          hash: { type: "string", description: "SHA-256 hash for proof/verify" },
          proof: { type: "object", description: "Proof object for verify action" },
          conversationId: { type: "string", description: "Conversation ID for chain action" },
          epoch: { type: "number", description: "Epoch number for prune_epoch" },
          snapshot: { type: "object", description: "Snapshot object for restore" },
        },
        required: ["action"],
      },
      handler: (params: Record<string, unknown>) => {
        const action = params.action as string;
        const treeKey = params.tree as string | undefined;

        switch (action) {
          case "root": {
            const result = smtService.getRoot(treeKey);
            return result ?? { error: "Tree not found" };
          }
          case "proof": {
            const hash = params.hash as string;
            if (!hash) return { error: "hash is required" };
            const proof = smtService.createProof(hash, treeKey);
            return proof ? { proof } : { error: "Tree not found" };
          }
          case "verify": {
            const proof = params.proof as any;
            if (!proof) return { error: "proof is required" };
            return { valid: smtService.verifyProof(proof) };
          }
          case "trees": {
            return { trees: smtService.listTrees() };
          }
          case "stats": {
            const result = smtService.getRoot(treeKey);
            return result ?? { error: "Tree not found" };
          }
          case "chain": {
            if (!treeKey) return { error: "tree is required" };
            const convId = params.conversationId as string;
            if (!convId) return { error: "conversationId is required" };
            return { chain: smtService.getChain(treeKey, convId) };
          }
          case "prune_epoch": {
            if (!treeKey) return { error: "tree is required" };
            const epoch = params.epoch as number;
            if (epoch === undefined) return { error: "epoch is required" };
            return smtService.pruneEpoch(treeKey, epoch);
          }
          case "exported_proofs": {
            if (!treeKey) return { error: "tree is required" };
            const epoch = params.epoch as number | undefined;
            return smtService.getExportedProofs(treeKey, epoch);
          }
          case "snapshot": {
            if (!treeKey) return { error: "tree is required" };
            return smtService.createSnapshot(treeKey);
          }
          case "restore_snapshot": {
            if (!treeKey) return { error: "tree is required" };
            const snapshot = params.snapshot as any;
            if (!snapshot) return { error: "snapshot is required" };
            return smtService.restoreSnapshot(treeKey, snapshot);
          }
          default:
            return { error: `Unknown action: ${action}` };
        }
      },
    } as any);

    // --- Background services ---

    const retention = new RetentionService(store, config);
    const configWatcher = new ConfigWatcher(store, scanner, notifier, config);
    const deAnchor = new DeAnchorService(store, config, notifier);
    deAnchor.setSmtService(smtService);
    limiter.setDeAnchor(deAnchor);

    api.registerService({
      id: "@constellation-network/openclaw-audit-plugin:smt",
      async start() {
        await smtService.start();
      },
      async stop() {
        await smtService.stop();
      },
    });

    api.registerService({
      id: "@constellation-network/openclaw-audit-plugin:retention",
      start() {
        retention.start();
      },
      stop() {
        retention.stop();
        limiter.flush();
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
