import {definePluginEntry} from "openclaw/plugin-sdk/plugin-entry";
import {routeLogsToStderr} from "openclaw/plugin-sdk/runtime";
import {AuditStore} from "./store/audit-store.js";
import {registerHooks} from "./hooks.js";
import {cliAnomaliesHandler, cliAuditHandler, cliAuditUiHandler, cliExportHandler, cliReportHandler, cliReportSessionHandler, cliReportCronHandler, cliInventoryHandler, cliSmtHandler, cliStatusHandler, cliSpendHandler, cliVerifyHandler, type AuditAnomaliesOptions, type AuditExportOptions, type AuditReportOptions, type AuditReportCronOptions, type AuditReportSessionOptions, type AuditSpendOptions, type AuditStatusOptions} from "./cli.js";
import {cliGateInstallHandler, cliGateStatusHandler, cliGateTestHandler, type AuditGateInstallOptions, type AuditGateStatusOptions, type AuditGateTestOptions} from "./cli-gate.js";
import {INVENTORY_KINDS} from "./services/inventory.js";
import {resolveOpenclawDir} from "./util/openclaw-paths.js";
import {RetentionService} from "./services/retention.js";
import {ReportPusherService} from "./services/report-pusher.js";
import {ConfigWatcher} from "./services/config-watcher.js";
import {createDeAnchorService, resolveExplorerBaseUrl} from "./services/de-anchor.js";
import type {AnchorService} from "./services/de-anchor.js";
import {createGatewayPublisher, drainForShutdown, selectMostRecentAnchorAtOrBefore, GATEWAY_HEALTH_NAME} from "./services/gateway-publisher.js";
import type {GatewayPublisher} from "./services/gateway-publisher.js";
import {NotificationService} from "./services/notifications.js";
import {SmtService} from "./services/smt-service.js";
import {Verifier} from "./services/verifier.js";
import {ToolScanner} from "./scanner.js";
import {RateLimiter} from "./rate-limiter.js";
import {FileWatcher} from "./services/file-watcher.js";
import {GatewayStopCapture} from "./gateway-stop-capture.js";
import {registerAuditUiRoutes} from "./ui/routes.js";
import {resolveAuditUiUrl, resolveGatewayBaseUrl} from "./util/gateway-url.js";
import {log, smtLog} from "./util/logger.js";
import {createRequire} from "node:module";

const requireFromHere = createRequire(import.meta.url);
const pluginPkg = requireFromHere("../package.json") as { name: string; version: string };
const PLUGIN_NAME = pluginPkg.name;
const PLUGIN_VERSION = pluginPkg.version;

/**
 * Handler-style tool definition accepted by the OpenClaw plugin runtime.
 * The SDK types export AgentTool (label + execute) but registerTool also
 * accepts this shape at runtime. Kept here to avoid scattering `as any`.
 */
interface PluginHandlerTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (params: Record<string, unknown>) => unknown;
}

export default (() => {
    // These references are valid only while their underlying handles are open.
    // retention.stop() closes the store and must reset them so the next
    // register(api) rebuilds against a fresh api instead of resurrecting a
    // closed store. Any future singleton cached here needs the same reset.
    let _registered = false;
    let _store: AuditStore | undefined;
    let _limiter: RateLimiter | undefined;
    let _gatewayStopCapture: GatewayStopCapture | undefined;

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
                    // CLI handlers only read; open the DB read-only so a running
                    // gateway (writer) and the CLI can coexist via SQLite WAL.
                    // The eager full-mode registration below reassigns `store`
                    // to a writer instance before any hook fires.
                    store = new AuditStore(dbPath, { readOnly: true });
                }
                return store;
            }

            function getSmtService(): SmtService {
                if (!smtService) {
                    smtService = new SmtService(config);
                    // Wire the store so skippedSeqs can be persisted to the
                    // tamper-resistant `service_health` table (in the audit DB)
                    // instead of the file-system checkpoint dir.
                    smtService.setStore(getStore());
                }
                return smtService;
            }

            function getNotifier(): NotificationService {
                if (!notifier) {
                    const webhookUrl = typeof config.notificationWebhook === "string"
                        ? config.notificationWebhook
                        : undefined;
                    notifier = new NotificationService(webhookUrl, {
                        allowPrivateHost: config.webhookAllowPrivateHost === true,
                    });
                }
                return notifier;
            }

            function resolveCollectOpts(): { openclawDir: string; projectRoot: string } {
                return { openclawDir: resolveOpenclawDir(config), projectRoot: process.cwd() };
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
                    .command("status")
                    .description("Runtime health snapshot (storage, integrity, anchor, gateway, inventory)")
                    .option("--json", "Emit the snapshot as JSON (single line)")
                    .action((opts: AuditStatusOptions) =>
                        cliStatusHandler(getStore(), getSmtService(), config, PLUGIN_NAME, PLUGIN_VERSION, opts),
                    );

                audit
                    .command("ui")
                    .description("Print the audit UI URL")
                    .action(() => cliAuditUiHandler());

                audit
                    .command("export [format]")
                    .description("Export audit logs as JSON (NDJSON) or CSV. Each row includes the DE anchor reference for the covering checkpoint when one exists.")
                    .option("--type <type>", "Filter by event type")
                    .option("--category <category>", "Filter by category")
                    .option("--session <id>", "Filter by session ID")
                    .option("--from <iso>", "Lower bound on createdAt (ISO 8601, inclusive)")
                    .option("--to <iso>", "Upper bound on createdAt (ISO 8601, inclusive)")
                    .option("--security-only", "Restrict to security/config/system categories")
                    .option("--limit <n>", "Cap the number of rows emitted")
                    .option("--include-content", "Include full decompressed content in output")
                    .action((format: string | undefined, opts: AuditExportOptions) =>
                        cliExportHandler(getStore(), format, opts),
                    );

                // Inventory subcommands
                const inventory = audit
                    .command("inventory")
                    .description("Inventory installed plugins/skills/tools/soul/crons")
                    .option("--json", "Emit JSON instead of a human-readable table")
                    .action((opts: { json?: boolean }) =>
                        cliInventoryHandler(getStore(), "summary", opts, resolveCollectOpts()),
                    );

                for (const kind of INVENTORY_KINDS) {
                    inventory
                        .command(kind)
                        .description(`List installed ${kind}`)
                        .option("--json", "Emit JSON instead of a human-readable table")
                        .action((opts: { json?: boolean }) =>
                            cliInventoryHandler(getStore(), kind, opts, resolveCollectOpts()),
                        );
                }

                // Report subcommands (daily / weekly digest)
                const report = audit.command("report").description("Daily / weekly audit digest with anomaly detectors");

                report
                    .command("daily")
                    .description("Generate a daily activity digest")
                    .option("--date <yyyy-mm-dd>", "Date to report on (default: today)")
                    .option("--tz <local|utc>", "Timezone for the date boundary (default: utc)")
                    .option("--json", "Emit the projection as JSON (single line)")
                    .option("--html", "Emit the projection as a self-contained HTML document")
                    .option("--dup-window-sec <n>", "Duplicate-outbound detector window (default: 60)")
                    .option("--lookback-days <n>", "First-seen-tool lookback window (default: 30)")
                    .option("--top-tools <n>", "Cap for the Top tools section (default: 10)")
                    .action((opts: AuditReportOptions) => cliReportHandler(getStore(), "daily", opts, resolveCollectOpts()));

                report
                    .command("weekly")
                    .description("Generate a weekly activity digest (ISO 8601 week)")
                    .option("--week <yyyy-Www>", "ISO week to report on (default: this week)")
                    .option("--tz <local|utc>", "Timezone for the week boundary (default: utc)")
                    .option("--json", "Emit the projection as JSON (single line)")
                    .option("--html", "Emit the projection as a self-contained HTML document")
                    .option("--dup-window-sec <n>", "Duplicate-outbound detector window (default: 60)")
                    .option("--lookback-days <n>", "First-seen-tool lookback window (default: 30)")
                    .option("--top-tools <n>", "Cap for the Top tools section (default: 10)")
                    .action((opts: AuditReportOptions) => cliReportHandler(getStore(), "weekly", opts, resolveCollectOpts()));

                report
                    .command("cron <job-id>")
                    .description("Per-cron rollup — one row per execution for a given jobId")
                    .option("--last <n>", "Limit to the N most recent executions (default: 20, max: 1000)")
                    .option("--json", "Emit the rollup as JSON (single line)")
                    .option("--html", "Emit the rollup as a self-contained HTML document")
                    .action((jobId: string, opts: AuditReportCronOptions) =>
                        cliReportCronHandler(getStore(), jobId, opts, resolveCollectOpts()),
                    );

                audit
                    .command("anomalies")
                    .description("Anomaly surface over an arbitrary time window")
                    .option("--since <dur|iso>", "Window start: duration (Nm|Nh|Nd) or ISO 8601 instant (default: 24h)")
                    .option("--until <dur|iso>", "Window end: duration (Nm|Nh|Nd) or ISO 8601 instant (default: now)")
                    .option("--tz <local|utc>", "Timezone for the period label (default: utc)")
                    .option("--json", "Emit the view as JSON (single line)")
                    .option("--html", "Emit the view as a self-contained HTML document")
                    .option("--dup-window-sec <n>", "Duplicate-outbound detector window (default: 60)")
                    .option("--lookback-days <n>", "First-seen-tool lookback window (default: 30)")
                    .option("--denial-window-sec <n>", "Denial-spike cluster window (default: 300)")
                    .option("--denial-threshold <n>", "Min denials per cluster (default: 5)")
                    .option("--drop-window-sec <n>", "Gateway-drop-spike cluster window (default: 300)")
                    .option("--drop-threshold <n>", "Min drop milestones per cluster (default: 3)")
                    .action((opts: AuditAnomaliesOptions) =>
                        cliAnomaliesHandler(getStore(), getSmtService(), opts),
                    );

                report
                    .command("session <sessionId>")
                    .description("Per-conversation rollup: timeline, dedup, tools, cost, outbound, integrity")
                    .option("--raw", "Return the un-deduplicated row stream (forensic)")
                    .option("--json", "Emit the projection as JSON (single line)")
                    .option("--limit <n>", "Show the last N events of the session (default: all, capped at 50000)")
                    .option("--include-metadata", "Include raw event metadata in --json output (off by default; may contain tool args)")
                    .action((sessionId: string, opts: AuditReportSessionOptions) =>
                        cliReportSessionHandler(getStore(), getSmtService(), sessionId, opts),
                    );

                // Spend rollup (PRD R11)
                audit
                    .command("spend")
                    .description("LLM-spend rollup grouped by provider, model, day, or session")
                    .option("--by <bucket>", "Group rows by provider|model|day|session (default: model). For 'model', the bucket label is `provider/model` so cross-provider model name collisions don't merge.")
                    .option("--since <dur|iso>", "Window start: duration (Nm|Nh|Nd) or ISO 8601 instant (default: 24h)")
                    .option("--until <dur|iso>", "Window end: duration (Nm|Nh|Nd) or ISO 8601 instant (default: now)")
                    .option("--tz <local|utc>", "Timezone for the period label (default: utc). Note: --by day buckets are always UTC dates regardless of this flag.")
                    .option("--limit <n>", "Cap on the number of buckets returned (default: 1000, max: 100000). When the cap trims a result, `truncated: true` appears in all outputs.")
                    .option("--json", "Emit the rollup as JSON (single line)")
                    .action((opts: AuditSpendOptions) => cliSpendHandler(getStore(), opts));

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
                    .action((opts) => cliSmtHandler(getSmtService(), "verify-proof", opts, getStore()));

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

                // Gate (swarm-deck) install + diagnostics
                const gate = audit.command("gate").description("Set up and verify the connection to a Constellation Gate (swarm-deck)");

                gate
                    .command("install")
                    .description("Install/update the Gate connection in ~/.openclaw/config.json")
                    .option("--url <url>", "Gate base URL (https://…)")
                    .option("--api-key <key>", "Gate API key (sk-gw-…). Prefer --api-key-stdin or $OPENCLAW_GATE_API_KEY in CI; flag values leak to ps/argv and shell history.")
                    .option("--api-key-stdin", "Read the API key from stdin (one line)")
                    .option("--no-broker", "Skip registering Gate as an LLM provider under models.providers.gate")
                    .option("--allow-private-host", "Allow https:// URLs to private/link-local hosts")
                    .option("--skip-probe", "Skip the live connection check before writing config")
                    .option("--yes", "Non-interactive mode — fail on missing inputs instead of prompting")
                    .option("--json", "Emit a single-line JSON result")
                    .action((opts: AuditGateInstallOptions) => cliGateInstallHandler(opts));

                gate
                    .command("status")
                    .description("Show the current Gate connection from openclaw config (no network calls)")
                    .option("--json", "Emit the status as JSON")
                    .action((opts: AuditGateStatusOptions) => cliGateStatusHandler(opts));

                gate
                    .command("test")
                    .description("Probe the configured Gate URL with the saved API key")
                    .option("--url <url>", "Override the configured URL for this probe. When set, --api-key (or --api-key-stdin / $OPENCLAW_GATE_API_KEY) is required — the saved key is never sent to a non-configured URL.")
                    .option("--api-key <key>", "Override the configured API key for this probe")
                    .option("--api-key-stdin", "Read the override API key from stdin (one line)")
                    .option("--allow-private-host", "Allow https:// URLs to private/link-local hosts")
                    .option("--timeout-ms <n>", "Per-request timeout (default 10000)")
                    .option("--json", "Emit the probe result as JSON")
                    .action((opts: AuditGateTestOptions) => cliGateTestHandler(opts));
            }, {
                descriptors: [
                    {name: "audit", description: "View and manage audit trail", hasSubcommands: true},
                ],
            });

            // Only "full" mode runs the gateway: opens a writer, starts hooks
            // and services. Other modes (cli-metadata, discovery, setup-only,
            // setup-runtime) need the CLI registrars above but must not open
            // a second writer on the audit DB — that would race the running
            // gateway for the SQLite reserved lock. CLI handlers fall back to
            // the read-only branch in getStore().
            if (api.registrationMode !== "full") {
                // CLI dispatch context — keep subsystem-logger output off stdout
                // so command output (audit export JSON, smt trees lines, etc.)
                // stays parseable by jq / awk in scripts.
                routeLogsToStderr();
                return;
            }

            // Guard against double creation of services — openclaw may load the plugin multiple times.
            // Hooks must be re-registered on every api instance because events may be dispatched
            // through any of them.
            if (_registered) {
                if (_store && _limiter && _gatewayStopCapture) {
                    registerHooks(api, _store, _limiter, config, _gatewayStopCapture);
                }
                log.warn("Re-registered hooks on new api instance");
                return;
            }
            _registered = true;

            // --- Full registration: hooks, services, tools ---

            const dbPath = typeof config.dbPath === "string" ? config.dbPath : undefined;
            store = new AuditStore(dbPath);
            smtService = new SmtService(config);
            // Wire the writable store so skippedSeqs persists to the audit DB
            // (tamper-resistant) instead of the SMT checkpoint dir JSON.
            smtService.setStore(store);

            const limiter = new RateLimiter(store, config);
            limiter.setSmtService(smtService);
            _store = store;
            _limiter = limiter;
            // Captures gateway.stop via either the openclaw hook or a signal
            // fallback — see GatewayStopCapture for why both paths exist.
            const gatewayStopCapture = new GatewayStopCapture(store);
            gatewayStopCapture.setSmtService(smtService);
            gatewayStopCapture.installSignalFallback();
            _gatewayStopCapture = gatewayStopCapture;
            // Hooks are re-registered on every API instance (see guard above);
            // tools below are only registered here, on the first call.
            registerHooks(api, store, limiter, config, gatewayStopCapture);

            // LLM cost tracking via diagnostic events (separate subscription path)
            import("openclaw/plugin-sdk").then(({onDiagnosticEvent}) => {
                if (typeof onDiagnosticEvent !== "function") return;
                onDiagnosticEvent((evt: Record<string, unknown>) => {
                    if (evt.type !== "model.usage") return;
                    try {
                        //note that this is not redacted
                        limiter.append({
                            eventType: "prompt.response",
                            category: "prompt",
                            description: `LLM usage: ${evt.provider}/${evt.model}`,
                            metadata: {
                                provider: evt.provider,
                                model: evt.model,
                                inputTokens: (evt as any).usage?.input,
                                outputTokens: (evt as any).usage?.output,
                                // Match the hooks.ts producer key shape so session-projection
                                // and spend-rollup see one canonical name. The store's spend
                                // SQL still COALESCEs the legacy `cacheTokens` key from rows
                                // written before this fix landed.
                                cacheReadTokens: (evt as any).usage?.cacheRead,
                                cacheWriteTokens: (evt as any).usage?.cacheWrite,
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
            notifier = new NotificationService(webhookUrl, {
                allowPrivateHost: config.webhookAllowPrivateHost === true,
            });
            const scanner = new ToolScanner();

            // Capture as const for use in closures below — avoids non-null assertions
            const activeStore = store;
            const activeSmt = smtService;
            const activeNotifier = notifier;

            // Declared here so the tool handler closures can reference it;
            // constructed later in the "Background services" section.
            let deAnchor: AnchorService | undefined;

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
                        if (!deAnchor?.isActive()) {
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
                        if (!deAnchor?.isActive()) {
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
            } satisfies PluginHandlerTool as any);

            // `restore_snapshot` is intentionally absent from the agent-callable
            // action enum below: it overwrites the SMT working state, so an agent
            // that could call it could rewrite the structure the verifier uses to
            // detect tampering — defeating the plugin's tamper-evidence
            // guarantee against the exact actor it exists to constrain. The
            // corresponding SmtService.restoreSnapshot method stays so a future
            // CLI/admin surface can expose it under operator-issued authority.
            api.registerTool({
                name: "audit_smt",
                description: "Sparse Merkle Tree audit \u2014 generate proofs, verify integrity, take snapshots",
                parameters: {
                    type: "object",
                    properties: {
                        action: {
                            type: "string",
                            enum: [
                                "root", "proof", "verify", "trees", "stats",
                                "chain", "prune_epoch", "exported_proofs",
                                "snapshot",
                            ],
                            description: "Action to perform",
                        },
                        tree: {type: "string", description: "Tree identifier"},
                        hash: {type: "string", description: "SHA-256 hash for proof/verify"},
                        proof: {type: "object", description: "Proof object for verify action"},
                        conversationId: {type: "string", description: "Conversation ID for chain action"},
                        epoch: {type: "number", description: "Epoch number for prune_epoch"},
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
                            const knownRoots = smt.getKnownRoots(getStore().getCheckpointedRoots());
                            const result = smt.verifyProofWithRoots(proof, knownRoots);
                            switch (result.status) {
                                case "valid":
                                    return {valid: true};
                                case "unverifiable":
                                    return {valid: false, unverifiable: true, error: result.reason};
                                case "invalid":
                                    return {valid: false, error: result.reason};
                            }
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
                        default:
                            return {error: `Unknown action: ${action}`};
                    }
                },
            } satisfies PluginHandlerTool as any);

            // --- Background services ---

            log.info(`Registering services (registrationMode: ${api.registrationMode})`);

            const retention = new RetentionService(activeStore, config);
            const reportWebhookUrl = typeof config.reportWebhook === "string"
                ? config.reportWebhook
                : undefined;
            const reportPusher = new ReportPusherService(activeStore, reportWebhookUrl, {
                openclawDir: resolveOpenclawDir(config),
                allowPrivateHost: config.webhookAllowPrivateHost === true,
            });
            const configWatcher = new ConfigWatcher(activeStore, limiter, scanner, activeNotifier, config);
            deAnchor = createDeAnchorService(activeStore, config, activeNotifier);
            deAnchor.setSmtService(activeSmt);
            limiter.setDeAnchor(deAnchor);

            const gatewayPublisher: GatewayPublisher = createGatewayPublisher(config, {
                onDropMilestone: (cumulativeDropped: number) => {
                    // Record a synthetic local audit event so a downstream
                    // verifier can detect the gap between locally-stored
                    // events and what the gateway received. Bypass the
                    // rate-limiter (and therefore the publisher's notifyAppend)
                    // to avoid recursion when buffer is full.
                    const result = activeStore.append({
                        eventType: "gateway.dropped",
                        category: "gateway",
                        description: `Gateway buffer full — ${cumulativeDropped} event(s) dropped cumulatively`,
                        metadata: {cumulativeDropped},
                    });
                    if (result) activeSmt.onEventAppended(result);
                },
                computeHashes: (event) => ({
                    rawHash: activeSmt.computeRawHash(event),
                    censoredHash: activeSmt.computeCensoredHash(event),
                }),
                // The function name is "AtOrBefore", not "Covering" — events past
                // this checkpoint's sequenceEnd are filtered gateway-side. See the
                // selectMostRecentAnchorAtOrBefore docstring.
                latestAnchoredCheckpoint: (maxSequence) =>
                    selectMostRecentAnchorAtOrBefore(activeStore.getCheckpoints(), maxSequence),
                onHealthUpdate: (h) => {
                    try {
                        activeStore.upsertServiceHealth(GATEWAY_HEALTH_NAME, h);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : "Unknown error";
                        log.warn(`gateway service_health upsert failed: ${msg}`);
                    }
                },
            });
            limiter.setGatewayPublisher(gatewayPublisher);

            api.registerService({
                id: "constellation-audit-plugin:smt",
                async start() {
                    log.info("Service smt start() called");
                    await activeSmt.start();
                    // Replay events the SMT hasn't seen yet (delta since last checkpoint)
                    const lastSeq = activeSmt.getLastInsertedSequence();
                    const pending = activeStore.countSince(lastSeq + 1);
                    if (pending > 0) {
                        const replayed = activeSmt.replayEvents(
                            (offset, limit) => activeStore.query({
                                afterSequence: lastSeq,
                                limit,
                                offset,
                                order: "asc",
                                includeContent: true,
                            }),
                            pending,
                        );
                        smtLog.info(`Replayed ${replayed} event(s) since seq ${lastSeq}`);
                    }
                },
                async stop() {
                    await activeSmt.stop();
                },
            });

            // Register *before* retention so that on shutdown (which the host
            // typically runs in reverse registration order) the pusher's
            // in-flight tick and retry timer are cancelled before retention.stop
            // closes the underlying store.
            api.registerService({
                id: "constellation-audit-plugin:report-pusher",
                start() {
                    reportPusher.start();
                },
                stop() {
                    reportPusher.stop();
                },
            });

            api.registerService({
                id: "constellation-audit-plugin:retention",
                start() {
                    retention.start();
                },
                stop() {
                    // Detach signal handlers first so a SIGTERM/SIGINT arriving
                    // mid-shutdown can't fire captureSignal against an
                    // already-closed store.
                    _gatewayStopCapture?.detachSignalListeners();
                    retention.stop();
                    limiter.flush();
                    activeStore.close();
                    _registered = false;
                    _store = undefined;
                    _limiter = undefined;
                    _gatewayStopCapture = undefined;
                },
            });

            api.registerService({
                id: "constellation-audit-plugin:config-watcher",
                async start() {
                    await configWatcher.start();
                },
                async stop() {
                    await configWatcher.stop();
                },
            });

            api.registerService({
                id: "constellation-audit-plugin:de-anchor",
                async start() {
                    await deAnchor.start();
                },
                async stop() {
                    await deAnchor.stop();
                },
            });

            api.registerService({
                id: "constellation-audit-plugin:gateway-publisher",
                async start() {
                    await gatewayPublisher.start();
                },
                async stop() {
                    gatewayPublisher.stop();
                    await drainForShutdown(gatewayPublisher);
                },
            });

            const fileWatcher = new FileWatcher(activeStore, limiter, config);

            api.registerService({
                id: "constellation-audit-plugin:file-watcher",
                async start() {
                    await fileWatcher.start();
                },
                async stop() {
                    await fileWatcher.stop();
                },
            });

            const verifier = new Verifier(activeStore, activeSmt);
            const deExplorerBaseUrl = (() => {
                const env = typeof config.deEnv === "string"
                  && (config.deEnv === "test" || config.deEnv === "integration" || config.deEnv === "mainnet")
                    ? config.deEnv
                    : "mainnet";
                return resolveExplorerBaseUrl(env);
            })();
            registerAuditUiRoutes(api, activeStore, activeSmt, verifier, {
                deBaseUrl: deExplorerBaseUrl,
                isNonLoopback: () => resolveGatewayBaseUrl().nonLoopback,
                allowExportOnNonLoopback: config.allowExportOnNonLoopback === true,
                allowVerifyOnNonLoopback: config.allowVerifyOnNonLoopback === true,
                openclawDir: resolveOpenclawDir(config),
            });

            api.registerService({
                id: "constellation-audit-plugin:ui-server",
                start() {
                    const info = resolveGatewayBaseUrl();
                    log.info(`Audit UI: ${resolveAuditUiUrl()}`);
                    if (info.nonLoopback) {
                        log.warn(
                            `Gateway is bound to "${info.bindMode}" — the audit UI is exposed beyond loopback ` +
                            `and currently has no auth check. Bind the gateway to loopback or add auth before ` +
                            `running on a shared network.`,
                        );
                    }
                },
            });
        },
    });
})();
