import {createRequire} from "module";
import {randomUUID} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {uuidv7} from "uuidv7";
import type {AuditStore} from "../store/audit-store.js";
import type {NotificationService} from "./notifications.js";
import type {SmtService} from "./smt-service.js";
import {deAnchorLog} from "../util/logger.js";

const require2 = createRequire(import.meta.url);
const dedCore = require2("@constellation-network/digital-evidence-sdk") as typeof import("@constellation-network/digital-evidence-sdk");
const {DedClient, DedApiError} = require2("@constellation-network/digital-evidence-sdk/network") as typeof import("@constellation-network/digital-evidence-sdk/network");

const DEFAULT_EVENT_THRESHOLD = 100;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMER_MIN_EVENTS = 1;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_BASE_MS = 30 * 1000;
const CIRCUIT_BREAKER_MAX_MS = 5 * 60 * 1000;
const DE_ENV_URLS = {
    integration: "https://lb-integrationnet.ded-ingestion.constellationnetwork.net/v1",
    mainnet: "https://lb-mainnet.ded-ingestion.constellationnetwork.net/v1",
} as const;
export const DE_EXPLORER_URLS = {
    integration: "https://staging.digitalevidence.constellationnetwork.net",
    mainnet: "https://digitalevidence.constellationnetwork.io",
} as const;
export type DeEnv = "test" | keyof typeof DE_ENV_URLS;
const DEFAULT_DE_ENV: DeEnv = "mainnet";
const DE_TEST_URL_ENV_VAR = "DE_TEST_URL";
const FETCH_TIMEOUT_MS = 15_000;

export function isDeEnv(v: string): v is DeEnv {
    return v === "test" || v === "integration" || v === "mainnet";
}

/**
 * Validate a URL intended for use as the DE base URL in `deEnv=test` mode.
 * Accepts only http(s) against loopback hosts (localhost, 127.0.0.1, ::1).
 * Throws a descriptive Error on anything else.
 */
export function validateTestUrl(url: string): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`${DE_TEST_URL_ENV_VAR} is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${DE_TEST_URL_ENV_VAR} must use http:// or https:// (got ${parsed.protocol})`);
    }
    const host = parsed.hostname;
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    if (!loopback) {
        throw new Error(`${DE_TEST_URL_ENV_VAR} must point at loopback (localhost, 127.0.0.1, or [::1]); got ${host}`);
    }
}

/**
 * Resolve the DE base URL for a given environment.
 * - `integration` / `mainnet`: static map.
 * - `test`: reads DE_TEST_URL env var, validates it; throws if missing or invalid.
 */
export function resolveBaseUrl(env: DeEnv): string {
    if (env === "test") {
        const url = process.env[DE_TEST_URL_ENV_VAR];
        if (!url || url.length === 0) {
            throw new Error(`deEnv="test" requires the ${DE_TEST_URL_ENV_VAR} environment variable to be set`);
        }
        validateTestUrl(url);
        return url;
    }
    return DE_ENV_URLS[env];
}

/**
 * Public-facing Digital Evidence explorer base URL for a given environment.
 * Returns undefined for `test` mode (no public explorer exists for local
 * loopback DE servers).
 */
export function resolveExplorerBaseUrl(env: DeEnv): string | undefined {
    if (env === "test") return undefined;
    return DE_EXPLORER_URLS[env];
}

type SubmitFn = (submissions: unknown[]) => Promise<{ accepted: boolean; hash: string; eventId?: string; errors?: string[] }[]>;
type VerifyFn = (hash: string) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Public interface — used by rate-limiter and index.ts
// ---------------------------------------------------------------------------

export interface AnchorHealth {
    isActive: boolean;
    consecutiveFailures: number;
    /** Wall-clock deadline (ms epoch) until which the circuit breaker is open. 0 if never tripped. */
    circuitOpenUntil: number;
    /** ISO timestamp of the most recently committed checkpoint, or undefined if none. */
    lastAnchorAt: string | undefined;
    /** DE tx hash for the most recent checkpoint, or null when DE accepted with no hash, or undefined if no checkpoint yet. */
    lastTxHash: string | null | undefined;
    /** Count of checkpoints created since the start of the current UTC day. */
    anchoredToday: number;
    /** Count of audit events with sequence > lastCheckpoint.sequenceEnd (i.e. waiting to be anchored). */
    pendingSinceLastCheckpoint: number;
}

export interface AnchorService {
    isActive(): boolean;
    setSmtService(smt: SmtService): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    notifyAppend(): void;
    /**
     * Anchor the current SMT root to DE if enough events have accumulated.
     * @param minEvents Floor for anchoring. When omitted, uses `deEventThreshold`
     *   (the same value used by the event-count trigger in `notifyAppend`).
     *   Timer ticks pass `deTimerMinEvents` (default 1) to allow anchoring
     *   smaller batches on a schedule.
     */
    anchorIfNeeded(minEvents?: number): Promise<void>;
    /**
     * Runtime health snapshot for the local reporting layer (Local Reporting PRD R6).
     * Combines in-memory state (consecutiveFailures, circuitOpenUntil) with DB-derived
     * facts (last checkpoint, anchored-today count, pending events).
     */
    health(): AnchorHealth;
}

/** ISO timestamp at the start of today's UTC day (00:00:00Z). */
function startOfUtcDayIso(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export const ANCHOR_HEALTH_NAME = "anchor";
export const ANCHOR_NOT_FOUND_HEALTH_NAME = "anchor-not-found";

// ---------------------------------------------------------------------------
// No-op implementation — logs a warning, every method is a stub
// ---------------------------------------------------------------------------

export class NoOpAnchorService implements AnchorService {
    constructor(reason: string) {
        deAnchorLog.info(`${reason}, anchoring disabled`);
    }

    isActive(): boolean {
        return false;
    }

    setSmtService(): void { /* no-op */ }

    async start(): Promise<void> { /* no-op */ }

    async stop(): Promise<void> { /* no-op */ }

    notifyAppend(): void { /* no-op */ }

    async anchorIfNeeded(_minEvents?: number): Promise<void> { /* no-op */ }

    health(): AnchorHealth {
        return {
            isActive: false,
            consecutiveFailures: 0,
            circuitOpenUntil: 0,
            lastAnchorAt: undefined,
            lastTxHash: undefined,
            anchoredToday: 0,
            pendingSinceLastCheckpoint: 0,
        };
    }
}

// ---------------------------------------------------------------------------
// Base class — shared anchoring logic (circuit breaker, threshold, checkpoints)
// ---------------------------------------------------------------------------

interface ActiveAnchorConfig {
    store: AuditStore;
    notifier?: NotificationService;
    deEnv: DeEnv;
    deApiUrl: string;
    deOrgId: string;
    deTenantId: string;
    deSigningKey: string;
    eventThreshold: number;
    timerMinEvents: number;
    intervalMs: number;
    submitFn: SubmitFn;
    verifyFn?: VerifyFn;
    authLabel: string;
}

class ActiveAnchorService implements AnchorService {
    private readonly store: AuditStore;
    private readonly notifier: NotificationService | undefined;
    private smtService: SmtService | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;

    private readonly deEnv: DeEnv;
    private readonly deApiUrl: string;
    private readonly deOrgId: string;
    private readonly deTenantId: string;
    private readonly deSigningKey: string;
    private readonly eventThreshold: number;
    private readonly timerMinEvents: number;
    private readonly intervalMs: number;
    private readonly submitFn: SubmitFn;
    private readonly verifyFn: VerifyFn | undefined;
    private readonly authLabel: string;

    private consecutiveFailures = 0;
    private circuitOpenCount = 0;
    private circuitOpenUntil = 0;
    private appendsSinceLastCheckpoint = 0;
    private anchorPromise: Promise<void> | undefined;
    private stopped = false;

    // Checkpoint IDs we've already notified about as "not found on DE". The
    // 404 path leaves `verified_at` NULL so verification keeps retrying, but
    // the notification surface should only fire once per checkpoint across
    // restarts — persisted in `service_health` (see persistNotFoundCheckpointIds).
    private notedNotFoundCheckpointIds = new Set<string>();

    constructor(cfg: ActiveAnchorConfig) {
        this.store = cfg.store;
        this.notifier = cfg.notifier;
        this.deEnv = cfg.deEnv;
        this.deApiUrl = cfg.deApiUrl;
        this.deOrgId = cfg.deOrgId;
        this.deTenantId = cfg.deTenantId;
        this.deSigningKey = cfg.deSigningKey;
        this.eventThreshold = cfg.eventThreshold;
        this.timerMinEvents = cfg.timerMinEvents;
        this.intervalMs = cfg.intervalMs;
        this.submitFn = cfg.submitFn;
        this.verifyFn = cfg.verifyFn;
        this.authLabel = cfg.authLabel;
    }

    isActive(): boolean {
        return true;
    }

    setSmtService(smt: SmtService): void {
        this.smtService = smt;
    }

    async start(): Promise<void> {
        deAnchorLog.info(`plugin initialized: env=${this.deEnv} baseUrl=${this.deApiUrl}`);
        deAnchorLog.info(`Starting — auth: ${this.authLabel}, threshold: ${this.eventThreshold}, timerMin: ${this.timerMinEvents}, interval: ${this.intervalMs}ms`);

        this.restoreNotFoundCheckpointIds();
        await this.verifyCheckpoints();
        await this.anchorIfNeeded(this.timerMinEvents);
        this.persistHealth();
        this.timer = setInterval(() => {
            this.anchorIfNeeded(this.timerMinEvents).catch(() => {});
        }, this.intervalMs);
        this.timer.unref();
        deAnchorLog.info("Started successfully");
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.anchorPromise) {
            await this.anchorPromise.catch(() => {});
        }
    }

    notifyAppend(): void {
        if (this.stopped) return;
        this.appendsSinceLastCheckpoint++;
        if (this.appendsSinceLastCheckpoint >= this.eventThreshold) {
            deAnchorLog.info(`Threshold reached (${this.appendsSinceLastCheckpoint}/${this.eventThreshold}), triggering anchor`);
            this.anchorIfNeeded().catch(() => {});
        }
    }

    async anchorIfNeeded(minEvents: number = this.eventThreshold): Promise<void> {
        if (this.stopped) return;
        if (this.anchorPromise) return this.anchorPromise;
        if (this.isCircuitOpen()) {
            const waitMs = this.circuitOpenUntil - Date.now();
            deAnchorLog.warn(`anchor skipped — circuit breaker open (${this.consecutiveFailures} consecutive failures, retry in ${Math.max(0, Math.round(waitMs / 1000))}s)`);
            return;
        }

        this.anchorPromise = this.doAnchor(minEvents).finally(() => {
            this.anchorPromise = undefined;
        });
        return this.anchorPromise;
    }

    private async doAnchor(minEvents: number): Promise<void> {
        try {
            const lastCheckpoint = this.store.getLastCheckpoint();
            const startSeq = lastCheckpoint ? lastCheckpoint.sequenceEnd + 1 : 1;

            // One SQL statement so the count and max sequence reflect the same
            // table snapshot. A separate countSince + maxSequenceSince pair could
            // race with a concurrent retention prune — the count would observe
            // the un-pruned rows and the max would observe the empty table.
            const { count: eventCount, maxSeq: seqEnd } = this.store.countAndMaxSince(startSeq);
            // No-op tick: don't clobber the counter that drives notifyAppend's
            // threshold-cross dispatch. The reset belongs on the path where an
            // anchor attempt actually happened, not on every 5-minute heartbeat.
            if (eventCount < minEvents) return;

            const smtRoot = this.smtService?.getCurrentSmtRoot();
            if (!smtRoot) {
                deAnchorLog.warn("No SMT root available, skipping anchor");
                return;
            }

            if (seqEnd === undefined) {
                // Defensive: countAndMaxSince guarantees `maxSeq` is defined
                // whenever `count > 0`, so a undefined `seqEnd` here would mean
                // the store invariants broke. Log and bail without recording an
                // attempt — the counter stays untouched so notifyAppend can
                // still drive the next dispatch.
                deAnchorLog.error("countAndMaxSince returned undefined max despite positive count, skipping anchor");
                return;
            }

            deAnchorLog.info(`Submitting fingerprint — root: ${smtRoot.slice(0, 16)}…, events: ${eventCount}, seq: ${startSeq}-${seqEnd}`);
            const txHash = await this.submitFingerprint(smtRoot);

            const checkpointId = uuidv7();
            this.store.insertCheckpoint(checkpointId, startSeq, seqEnd, smtRoot, eventCount, txHash);

            this.consecutiveFailures = 0;
            this.circuitOpenCount = 0;
            deAnchorLog.info(
                `Anchored SMT root (${eventCount} events, seq ${startSeq}-${seqEnd}) to DE: ${txHash}`,
            );
            this.persistHealth();
            // Reset only after a successful anchor consumed events. Earlier
            // unconditional reset in `finally` clobbered the threshold-cross
            // path: every no-op timer tick zeroed the counter before
            // notifyAppend could trip it.
            this.appendsSinceLastCheckpoint = 0;
        } catch (err) {
            this.recordFailure();
            const message = err instanceof Error ? err.message : "Unknown error";
            deAnchorLog.error(`Anchor failed: ${message}`);
            // Reset on failure too, but only because an attempt was made: keeps
            // notifyAppend from re-firing on every append while DE is down. The
            // timer with timerMinEvents=1 carries retry cadence.
            this.appendsSinceLastCheckpoint = 0;
        }
    }

    private async verifyCheckpoints(): Promise<void> {
        if (!this.verifyFn) return;

        try {
            const checkpoints = this.store.getUnverifiedCheckpoints();
            const verifyFn = this.verifyFn;
            const notifier = this.notifier;
            const store = this.store;

            await Promise.all(
                checkpoints.map(async (cp) => {
                    const deTxHash = cp.deTxHash as string;
                    try {
                        await verifyFn(deTxHash);
                        store.markCheckpointVerified(cp.id);
                    } catch (err) {
                        if (err instanceof DedApiError && (err as {status: number}).status === 404) {
                            deAnchorLog.error(`Verification failed for checkpoint ${cp.id}: ${deTxHash} not found on DE`);
                            // Dedup the not-found notification across restarts via service_health,
                            // and leave verified_at NULL — marking verified on a 404 would lie about
                            // the checkpoint's state. If DE is later restored, verification re-runs
                            // on next startup as intended.
                            if (this.notedNotFoundCheckpointIds.has(cp.id)) return;
                            this.notedNotFoundCheckpointIds.add(cp.id);
                            this.persistNotFoundCheckpointIds();
                            notifier
                                ?.notifyDeAnchorNotFound(cp.id, cp.smtRoot)
                                .catch((notifyErr: unknown) => {
                                    const msg = notifyErr instanceof Error ? notifyErr.message : "Unknown error";
                                    deAnchorLog.warn(`not-found notification failed for checkpoint ${cp.id}: ${msg}`);
                                });
                            return;
                        }
                        // Transient error: leave verified_at NULL so we retry on next startup.
                        const msg = err instanceof Error ? err.message : "Unknown error";
                        deAnchorLog.warn(`verify API call failed for checkpoint ${cp.id}: ${msg}`);
                    }
                }),
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            deAnchorLog.error(`Checkpoint verification error: ${message}`);
        }
    }

    private async submitFingerprint(smtRoot: string): Promise<string> {
        const submission = await dedCore.generateFingerprint(
            {
                orgId: this.deOrgId,
                tenantId: this.deTenantId,
                eventId: randomUUID(),
                documentId: "openclaw-smt-root",
                documentRef: smtRoot,
                timestamp: new Date(),
                includeMetadata: true,
                tags: {source: "openclaw-audit-plugin", type: "smt-root"},
            },
            this.deSigningKey,
        );

        const results = await this.submitFn([submission]);
        const result = results[0];
        if (!result?.accepted) {
            const reason = result?.errors?.join(", ") ?? "unknown reason";
            deAnchorLog.warn(`DE rejected fingerprint — root: ${smtRoot.slice(0, 16)}…, reason: ${reason}, response: ${JSON.stringify(result)}`);
            throw new Error(`DE rejected fingerprint: ${reason}`);
        }
        return result.hash;
    }

    private isCircuitOpen(): boolean {
        if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
        if (Date.now() >= this.circuitOpenUntil) {
            // Allow one retry attempt — consecutiveFailures stays high so
            // recordFailure can escalate circuitOpenCount if it fails again.
            this.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD - 1;
            return false;
        }
        return true;
    }

    private recordFailure(): void {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            const delayMs = Math.min(CIRCUIT_BREAKER_BASE_MS * 2 ** this.circuitOpenCount, CIRCUIT_BREAKER_MAX_MS);
            this.circuitOpenCount++;
            this.circuitOpenUntil = Date.now() + delayMs;
            deAnchorLog.warn(
                `Circuit breaker open — will retry after ${delayMs / 1000}s`,
            );
        }
        this.persistHealth();
    }

    health(): AnchorHealth {
        const lastCheckpoint = this.store.getLastCheckpoint();
        const startOfDay = startOfUtcDayIso();
        const anchoredToday = this.store.countCheckpointsSince(startOfDay);
        const pending = lastCheckpoint ? this.store.countSince(lastCheckpoint.sequenceEnd + 1) : 0;

        return {
            isActive: true,
            consecutiveFailures: this.consecutiveFailures,
            circuitOpenUntil: this.circuitOpenUntil,
            lastAnchorAt: lastCheckpoint?.createdAt,
            lastTxHash: lastCheckpoint ? lastCheckpoint.deTxHash : undefined,
            anchoredToday,
            pendingSinceLastCheckpoint: pending,
        };
    }

    private persistHealth(): void {
        try {
            this.store.upsertServiceHealth(ANCHOR_HEALTH_NAME, this.health());
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            deAnchorLog.warn(`failed to persist service_health: ${msg}`);
        }
    }

    // Persist the not-found dedup set in the audit DB's service_health table
    // so the same checkpoint doesn't re-fire the notification on every
    // restart. Persistence failure logs but does not propagate; the
    // in-memory set still suppresses repeats for this process lifetime.
    private persistNotFoundCheckpointIds(): void {
        try {
            this.store.upsertServiceHealth(
                ANCHOR_NOT_FOUND_HEALTH_NAME,
                Array.from(this.notedNotFoundCheckpointIds),
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            deAnchorLog.warn(`failed to persist anchor not-found set: ${msg}`);
        }
    }

    private restoreNotFoundCheckpointIds(): void {
        try {
            const row = this.store.getServiceHealth(ANCHOR_NOT_FOUND_HEALTH_NAME);
            if (!row || !Array.isArray(row.payload)) return;
            this.notedNotFoundCheckpointIds = new Set(
                (row.payload as unknown[]).filter(
                    (id): id is string => typeof id === "string",
                ),
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            deAnchorLog.warn(`failed to restore anchor not-found set: ${msg}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Shared config parsing
// ---------------------------------------------------------------------------

function parseBaseConfig(config: Record<string, unknown>) {
    const envKey: DeEnv = typeof config.deEnv === "string" && isDeEnv(config.deEnv)
        ? config.deEnv
        : DEFAULT_DE_ENV;
    return {
        deEnv: envKey,
        deApiUrl: resolveBaseUrl(envKey),
        eventThreshold: typeof config.deEventThreshold === "number" ? config.deEventThreshold : DEFAULT_EVENT_THRESHOLD,
        timerMinEvents: Math.max(1, typeof config.deTimerMinEvents === "number" ? config.deTimerMinEvents : DEFAULT_TIMER_MIN_EVENTS),
        intervalMs: typeof config.deIntervalMs === "number" ? config.deIntervalMs : DEFAULT_INTERVAL_MS,
    };
}

function resolveSigningKey(config: Record<string, unknown>): string {
    if (typeof config.deSigningKey === "string" && config.deSigningKey.length > 0) {
        return config.deSigningKey;
    }
    const kp = dedCore.generateKeyPair();
    deAnchorLog.warn("No signing key configured, generated ephemeral key pair");
    return kp.privateKey;
}

// ---------------------------------------------------------------------------
// API key implementation
// ---------------------------------------------------------------------------

export class ApiKeyAnchorService extends ActiveAnchorService {
    constructor(
        store: AuditStore,
        config: Record<string, unknown>,
        notifier?: NotificationService,
    ) {
        const base = parseBaseConfig(config);
        const deApiKey = config.deApiKey as string;
        const deOrgId = config.deOrgId as string;
        const deTenantId = config.deTenantId as string;
        const deSigningKey = resolveSigningKey(config);

        const baseUrl = base.deApiUrl.replace(/\/v1\/?$/, "");
        const client = new DedClient({baseUrl, apiKey: deApiKey, timeout: FETCH_TIMEOUT_MS});

        super({
            store,
            notifier,
            deEnv: base.deEnv,
            deApiUrl: base.deApiUrl,
            deOrgId,
            deTenantId,
            deSigningKey,
            eventThreshold: base.eventThreshold,
            timerMinEvents: base.timerMinEvents,
            intervalMs: base.intervalMs,
            submitFn: (s) => client.fingerprints.submit(s),
            verifyFn: (h) => client.fingerprints.getByHash(h),
            authLabel: "API key",
        });
    }
}

// ---------------------------------------------------------------------------
// Wallet (x402) implementation
// ---------------------------------------------------------------------------

export class WalletAnchorService extends ActiveAnchorService {
    constructor(
        store: AuditStore,
        keyFilePath: string,
        config: Record<string, unknown>,
        notifier?: NotificationService,
    ) {
        const base = parseBaseConfig(config);

        let rawKey = readFileSync(keyFilePath, "utf-8").trim().replace(/^0x/, "");
        if (!dedCore.isValidPrivateKey(rawKey)) {
            throw new Error("Wallet key file contains invalid private key (expected 64-char hex)");
        }

        const {DedX402Client, createEthersSigner} = require2(
            "@constellation-network/digital-evidence-sdk-x402",
        ) as typeof import("@constellation-network/digital-evidence-sdk-x402");
        const {ethers} = require2("ethers") as { ethers: { Wallet: new (privateKey: string) => unknown } };

        const wallet = new ethers.Wallet(`0x${rawKey}`);
        const baseUrl = base.deApiUrl.replace(/\/v1\/?$/, "");
        const client = new DedX402Client({
            baseUrl,
            signer: createEthersSigner(wallet),
            signingPrivateKey: rawKey,
            timeout: FETCH_TIMEOUT_MS,
        });

        const submitFn: SubmitFn = async (s) => {
            const res = await client.fingerprints.submit(s);
            if (res.kind === "payment_required") {
                throw new Error("x402 payment required but could not be fulfilled");
            }
            if (res.kind !== "result") {
                deAnchorLog.warn(`x402 submit returned unexpected kind="${res.kind}"`);
                throw new Error(`x402 submit returned unexpected kind="${res.kind}"`);
            }
            return res.data;
        };

        super({
            store,
            notifier,
            deEnv: base.deEnv,
            deApiUrl: base.deApiUrl,
            deOrgId: client.orgId,
            deTenantId: client.tenantId,
            deSigningKey: rawKey,
            eventThreshold: base.eventThreshold,
            timerMinEvents: base.timerMinEvents,
            intervalMs: base.intervalMs,
            submitFn,
            verifyFn: (h) => client.fingerprints.getByHash(h),
            authLabel: "x402 wallet",
        });

        deAnchorLog.info(`Wallet loaded (address: ${client.walletAddress}), auth: x402`);
    }
}

// ---------------------------------------------------------------------------
// Factory — picks the right class based on config
// ---------------------------------------------------------------------------

export function createDeAnchorService(
    store: AuditStore,
    config: Record<string, unknown>,
    notifier?: NotificationService,
): AnchorService {
    const deApiKey = typeof config.deApiKey === "string" ? config.deApiKey : undefined;
    const hasOrgId = typeof config.deOrgId === "string" && config.deOrgId.length > 0;
    const hasTenantId = typeof config.deTenantId === "string" && config.deTenantId.length > 0;
    const deWalletKeyFile = typeof config.deWalletKeyFile === "string" ? config.deWalletKeyFile : undefined;

    if (deApiKey && hasOrgId && hasTenantId) {
        if (deWalletKeyFile) {
            deAnchorLog.warn("Both deApiKey and deWalletKeyFile configured, API key takes precedence");
        }
        return new ApiKeyAnchorService(store, config, notifier);
    }

    if (deApiKey) {
        const missing = [!hasOrgId && "deOrgId", !hasTenantId && "deTenantId"].filter(Boolean).join(" and ");
        return new NoOpAnchorService(`deApiKey provided but ${missing} missing`);
    }

    if (deWalletKeyFile) {
        if (!existsSync(deWalletKeyFile)) {
            return new NoOpAnchorService("wallet key file not found");
        }
        try {
            return new WalletAnchorService(store, deWalletKeyFile, config, notifier);
        } catch (err) {
            // Scrub filesystem error details (codes like ENOENT/EACCES include the path);
            // surface logical errors (e.g. invalid hex key) which don't carry fs codes.
            const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
            const msg = code ? "wallet key file unreadable" : (err instanceof Error ? err.message : "Unknown error");
            return new NoOpAnchorService(`Failed to initialize wallet: ${msg}`);
        }
    }

    return new NoOpAnchorService("No DE credentials configured");
}
