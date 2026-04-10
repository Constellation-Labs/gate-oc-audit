import {definePluginEntry} from "openclaw/plugin-sdk/plugin-entry";
import {AuditStore} from "./store/audit-store.js";
import {registerHooks} from "./hooks.js";
import {cliAuditHandler, cliExportHandler, cliSmtHandler, cliVerifyHandler} from "./cli.js";
import {RetentionService} from "./services/retention.js";
import {ConfigWatcher} from "./services/config-watcher.js";
import {DeAnchorService} from "./services/de-anchor.js";
import {NotificationService} from "./services/notifications.js";
import {SmtService} from "./services/smt-service.js";
import {ToolScanner} from "./scanner.js";
import {RateLimiter} from "./rate-limiter.js";

export default (() => {
    let _registered = false;
    let _store: AuditStore | undefined;
    let _limiter: RateLimiter | undefined;

    return definePluginEntry({
        id: "constellation-audit-plugin",
        name: "@constellation-network/openclaw-audit-plugin",
        description: "Constellation Network Tamper-evident audit trail with SMT proofs and Digital Evidence anchoring",

        register(api) {
            const config = api.pluginConfig ?? {};

            // --- CLI (registered first so cli-metadata mode can discover commands) ---

            // Lazily initialized — only created when a CLI action actually runs
            let store: AuditStore | undefined;
            let smtService: SmtService | undefined;
            let notifier: NotificationService | undefined;

            function getStore(): AuditStore {
                if (!store) {
                    const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
                    store = new AuditStore(dbPath);
                }
                return store;
            }

            function getSmtService(): SmtService {
                if (!smtService) smtService = new SmtService(config);
                return smtService;
            }

            function getNotifier(): NotificationService {
                if (!notifier) {
                    const webhookUrl = typeof config.notificationWebhook === "string"
                        ? config.notificationWebhook
                        : undefined;
                    notifier = new NotificationService(webhookUrl);
                }
                return notifier;
            }

            api.registerCli(({program}) => {
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
                    .action((opts) => cliAuditHandler(getStore(), opts));

                audit
                    .command("verify")
                    .description("Verify SMT integrity and DE checkpoints")
                    .action(() => cliVerifyHandler(getSmtService(), getStore(), getNotifier()));

                audit
                    .command("export [format]")
                    .description("Export audit logs as JSON or CSV")
                    .option("--type <type>", "Filter by event type")
                    .option("--category <category>", "Filter by category")
                    .option("--session <id>", "Filter by session ID")
                    .option("--limit <n>", "Max events to export")
                    .action((format: string | undefined, opts: Record<string, string>) =>
                        cliExportHandler(getStore(), format, opts),
                    );

                // SMT subcommands
                const smt = audit.command("smt").description("Sparse Merkle Tree operations");

                smt
                    .command("root")
                    .description("Show current SMT root")
                    .option("--tree <key>", "Tree identifier")
                    .action((opts) => cliSmtHandler(getSmtService(), "root", opts));

                smt
                    .command("proof <hash>")
                    .description("Generate inclusion/exclusion proof")
                    .option("--tree <key>", "Tree identifier")
                    .action((hash: string, opts) => cliSmtHandler(getSmtService(), "proof", {...opts, hash}));

                smt
                    .command("verify")
                    .description("Verify an SMT proof")
                    .requiredOption("--proof <json>", "Proof JSON")
                    .action((opts) => cliSmtHandler(getSmtService(), "verify-proof", opts));

                smt
                    .command("trees")
                    .description("List all SMT trees")
                    .action(() => cliSmtHandler(getSmtService(), "trees", {}));

                smt
                    .command("chain <conversationId>")
                    .description("Show conversation chain")
                    .option("--tree <key>", "Tree identifier")
                    .action((conversationId: string, opts) =>
                        cliSmtHandler(getSmtService(), "chain", {...opts, conversationId}),
                    );
            }, {
                descriptors: [
                    {name: "audit", description: "View and manage audit trail", hasSubcommands: true},
                ],
            });

            // In cli-metadata mode, only command descriptors are needed
            if (api.registrationMode === "cli-metadata") return;

            // Guard against double creation of services — openclaw may load the plugin multiple times.
            // Hooks must be re-registered on every api instance because events may be dispatched
            // through any of them.
            if (_registered) {
                if (_store && _limiter) {
                    registerHooks(api, _store, _limiter);
                }
                console.error("[audit-plugin] Already registered, re-registered hooks on new api instance");
                return;
            }
            _registered = true;

            // --- Full registration: hooks, services, tools ---

            const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
            store = new AuditStore(dbPath);
            smtService = new SmtService(config);

            const limiter = new RateLimiter(store, config);
            limiter.setSmtService(smtService);
            _store = store;
            _limiter = limiter;
            registerHooks(api, store, limiter);

            // LLM cost tracking via diagnostic events (separate subscription path)
            import("openclaw/plugin-sdk").then(({onDiagnosticEvent}) => {
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

            const webhookUrl = typeof config.notificationWebhook === "string"
                ? config.notificationWebhook
                : undefined;
            notifier = new NotificationService(webhookUrl);
            const scanner = new ToolScanner();

            // Capture as const for use in closures below — avoids non-null assertions
            const activeStore = store;
            const activeSmt = smtService;
            const activeNotifier = notifier;

            // Declared here so the tool handler closures can reference it;
            // constructed later in the "Background services" section.
            let deAnchor!: DeAnchorService;

            // --- Agent-callable tools ---

            // registerTool accepts handler-style tools at runtime; cast to satisfy strict types
            api.registerTool({
                name: "audit_de_setup",
                description: "Check Digital Evidence anchoring configuration status and provide setup instructions",
                parameters: {},
                handler: () => {
                    const hasApiKey = typeof config.deApiKey === "string" && config.deApiKey.length > 0;
                    const hasOrgId = typeof config.deOrgId === "string" && config.deOrgId.length > 0;
                    const hasTenantId = typeof config.deTenantId === "string" && config.deTenantId.length > 0;
                    const hasWalletKeyFile = typeof config.deWalletKeyFile === "string" && config.deWalletKeyFile.length > 0;

                    if (hasApiKey && hasOrgId && hasTenantId) {
                        if (!deAnchor.isActive()) {
                            return {
                                status: "misconfigured",
                                method: "API key",
                                message: "Digital Evidence anchoring failed to initialize despite valid config. Check plugin logs.",
                            };
                        }
                        return {
                            status: "configured",
                            method: "API key",
                            message: "Digital Evidence anchoring is active via API key.",
                        };
                    }

                    if (hasApiKey) {
                        const missing = [!hasOrgId && "deOrgId", !hasTenantId && "deTenantId"].filter(Boolean).join(", ");
                        return {
                            status: "misconfigured",
                            method: "API key",
                            message: `Digital Evidence anchoring is disabled: deApiKey is set but ${missing} missing.`,
                        };
                    }

                    if (hasWalletKeyFile) {
                        if (!deAnchor.isActive()) {
                            return {
                                status: "misconfigured",
                                method: "x402 wallet",
                                message: "Digital Evidence anchoring failed to initialize: wallet key file or x402 SDK could not be loaded. Check plugin logs.",
                            };
                        }
                        return {
                            status: "configured",
                            method: "x402 wallet",
                            message: "Digital Evidence anchoring is active via x402 wallet payments.",
                        };
                    }

                    return {
                        status: "not_configured",
                        message: [
                            "Digital Evidence anchoring is not configured.",
                            "",
                            "Option 1: API key (simplest)",
                            "  1. Create account at https://evidence.constellationnetwork.io",
                            "  2. Generate an API key from your dashboard",
                            '  3. Add to config: "deApiKey": "your-key", "deOrgId": "...", "deTenantId": "..."',
                            "",
                            "Option 2: Wallet key file (x402 micropayments)",
                            "  1. Create a file containing your SECP256K1 private key (64-char hex)",
                            '  2. Add to config: "deWalletKeyFile": "/path/to/wallet.key"',
                            "  3. orgId and tenantId are derived automatically from the wallet address",
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
                        tree: {type: "string", description: "Tree identifier"},
                        hash: {type: "string", description: "SHA-256 hash for proof/verify"},
                        proof: {type: "object", description: "Proof object for verify action"},
                        conversationId: {type: "string", description: "Conversation ID for chain action"},
                        epoch: {type: "number", description: "Epoch number for prune_epoch"},
                        snapshot: {type: "object", description: "Snapshot object for restore"},
                    },
                    required: ["action"],
                },
                handler: (params: Record<string, unknown>) => {
                    const smt = getSmtService();
                    const action = params.action as string;
                    const treeKey = params.tree as string | undefined;

                    switch (action) {
                        case "root": {
                            const result = smt.getRoot(treeKey);
                            return result ?? {error: "Tree not found"};
                        }
                        case "proof": {
                            const hash = params.hash as string;
                            if (!hash) return {error: "hash is required"};
                            const proof = smt.createProof(hash, treeKey);
                            return proof ? {proof} : {error: "Tree not found"};
                        }
                        case "verify": {
                            const proof = params.proof as any;
                            if (!proof) return {error: "proof is required"};
                            return {valid: smt.verifyProof(proof)};
                        }
                        case "trees": {
                            return {trees: smt.listTrees()};
                        }
                        case "stats": {
                            const result = smt.getRoot(treeKey);
                            return result ?? {error: "Tree not found"};
                        }
                        case "chain": {
                            if (!treeKey) return {error: "tree is required"};
                            const convId = params.conversationId as string;
                            if (!convId) return {error: "conversationId is required"};
                            return {chain: smt.getChain(treeKey, convId)};
                        }
                        case "prune_epoch": {
                            if (!treeKey) return {error: "tree is required"};
                            const epoch = params.epoch as number;
                            if (epoch === undefined) return {error: "epoch is required"};
                            return smt.pruneEpoch(treeKey, epoch);
                        }
                        case "exported_proofs": {
                            if (!treeKey) return {error: "tree is required"};
                            const epoch = params.epoch as number | undefined;
                            return smt.getExportedProofs(treeKey, epoch);
                        }
                        case "snapshot": {
                            if (!treeKey) return {error: "tree is required"};
                            return smt.createSnapshot(treeKey);
                        }
                        case "restore_snapshot": {
                            if (!treeKey) return {error: "tree is required"};
                            const snapshot = params.snapshot as any;
                            if (!snapshot) return {error: "snapshot is required"};
                            return smt.restoreSnapshot(treeKey, snapshot);
                        }
                        default:
                            return {error: `Unknown action: ${action}`};
                    }
                },
            } as any);

            // --- Background services ---

            console.error(`[audit-plugin] Registering services (registrationMode: ${api.registrationMode})`);

            const retention = new RetentionService(activeStore, config);
            const configWatcher = new ConfigWatcher(activeStore, scanner, activeNotifier, config);
            deAnchor = new DeAnchorService(activeStore, config, activeNotifier);
            deAnchor.setSmtService(activeSmt);
            limiter.setDeAnchor(deAnchor);

            api.registerService({
                id: "constellation-audit-plugin:smt",
                async start() {
                    console.error("[audit-plugin] Service smt start() called");
                    await activeSmt.start();
                    // Replay stored events if the SMT tree is empty (e.g. missed checkpoint)
                    const eventCount = activeStore.count();
                    if (activeSmt.listTrees().length === 0 && eventCount > 0) {
                        const events = activeStore.query({limit: eventCount, order: "asc"});
                        const replayed = activeSmt.replayEvents(events);
                        console.error(`[audit-plugin:smt] Replayed ${replayed} stored event(s) into SMT`);
                    }
                },
                async stop() {
                    await activeSmt.stop();
                },
            });

            api.registerService({
                id: "constellation-audit-plugin:retention",
                start() {
                    retention.start();
                },
                stop() {
                    retention.stop();
                    limiter.flush();
                    activeStore.close();
                },
            });

            api.registerService({
                id: "constellation-audit-plugin:config-watcher",
                async start() {
                    await configWatcher.start();
                },
                stop() {
                    configWatcher.stop();
                },
            });

            api.registerService({
                id: "constellation-audit-plugin:de-anchor",
                async start() {
                    await deAnchor.start();
                },
                stop() {
                    deAnchor.stop();
                },
            });
        },
    });
})();
