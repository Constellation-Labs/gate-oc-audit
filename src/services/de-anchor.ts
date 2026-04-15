import {createRequire} from "module";
import {randomUUID} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {uuidv7} from "uuidv7";
import type {AuditStore} from "../store/audit-store.js";
import type {NotificationService} from "./notifications.js";
import type {SmtService} from "./smt-service.js";

const require2 = createRequire(import.meta.url);
const dedCore = require2("@constellation-network/digital-evidence-sdk") as typeof import("@constellation-network/digital-evidence-sdk");
const {DedClient} = require2("@constellation-network/digital-evidence-sdk/network") as typeof import("@constellation-network/digital-evidence-sdk/network");

const DEFAULT_EVENT_THRESHOLD = 100;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_BASE_MS = 30 * 1000;
const CIRCUIT_BREAKER_MAX_MS = 5 * 60 * 1000;
const DE_MAINNET_API = "https://de-api.constellationnetwork.io/v1";
const FETCH_TIMEOUT_MS = 15_000;

type SubmitFn = (submissions: unknown[]) => Promise<{ accepted: boolean; hash?: string; eventId?: string; errors?: string[] }[]>;
type VerifyFn = (hash: string) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Public interface — used by rate-limiter and index.ts
// ---------------------------------------------------------------------------

export interface AnchorService {
    isActive(): boolean;
    setSmtService(smt: SmtService): void;
    start(): Promise<void>;
    stop(): void;
    notifyAppend(): void;
    anchorIfNeeded(): Promise<void>;
}

// ---------------------------------------------------------------------------
// No-op implementation — logs a warning, every method is a stub
// ---------------------------------------------------------------------------

export class NoOpAnchorService implements AnchorService {
    constructor(reason: string) {
        console.error(`[audit-plugin:de-anchor] ${reason}, anchoring disabled`);
    }

    isActive(): boolean {
        return false;
    }

    setSmtService(): void { /* no-op */ }

    async start(): Promise<void> { /* no-op */ }

    stop(): void { /* no-op */ }

    notifyAppend(): void { /* no-op */ }

    async anchorIfNeeded(): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Base class — shared anchoring logic (circuit breaker, threshold, checkpoints)
// ---------------------------------------------------------------------------

interface ActiveAnchorConfig {
    store: AuditStore;
    notifier?: NotificationService;
    deApiUrl: string;
    deOrgId: string;
    deTenantId: string;
    deSigningKey: string;
    eventThreshold: number;
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

    private readonly deApiUrl: string;
    private readonly deOrgId: string;
    private readonly deTenantId: string;
    private readonly deSigningKey: string;
    private readonly eventThreshold: number;
    private readonly intervalMs: number;
    private readonly submitFn: SubmitFn;
    private readonly verifyFn: VerifyFn | undefined;
    private readonly authLabel: string;

    private consecutiveFailures = 0;
    private circuitOpenCount = 0;
    private circuitOpenUntil = 0;
    private appendsSinceLastCheckpoint = 0;

    constructor(cfg: ActiveAnchorConfig) {
        this.store = cfg.store;
        this.notifier = cfg.notifier;
        this.deApiUrl = cfg.deApiUrl;
        this.deOrgId = cfg.deOrgId;
        this.deTenantId = cfg.deTenantId;
        this.deSigningKey = cfg.deSigningKey;
        this.eventThreshold = cfg.eventThreshold;
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
        console.error(`[audit-plugin:de-anchor] Starting — auth: ${this.authLabel}, url: ${this.deApiUrl}, threshold: ${this.eventThreshold}, interval: ${this.intervalMs}ms`);

        await this.verifyCheckpoints();
        await this.anchorIfNeeded();
        this.timer = setInterval(() => this.anchorIfNeeded(), this.intervalMs);
        this.timer.unref();
        console.error("[audit-plugin:de-anchor] Started successfully");
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    notifyAppend(): void {
        this.appendsSinceLastCheckpoint++;
        if (this.appendsSinceLastCheckpoint >= this.eventThreshold) {
            console.error(`[audit-plugin:de-anchor] Threshold reached (${this.appendsSinceLastCheckpoint}/${this.eventThreshold}), triggering anchor`);
            this.appendsSinceLastCheckpoint = 0;
            this.anchorIfNeeded().catch(() => {});
        }
    }

    async anchorIfNeeded(): Promise<void> {
        if (this.isCircuitOpen()) return;

        try {
            const lastCheckpoint = this.store.getLastCheckpoint();
            const startSeq = lastCheckpoint ? lastCheckpoint.sequenceEnd + 1 : 1;

            const eventCount = this.store.countSince(startSeq);
            if (eventCount < this.eventThreshold) return;

            const smtRoot = this.smtService?.getCurrentSmtRoot();
            if (!smtRoot) {
                console.error("[audit-plugin:de-anchor] No SMT root available, skipping anchor");
                return;
            }

            const seqEnd = this.store.maxSequenceSince(startSeq);
            if (seqEnd === undefined) return;

            console.error(`[audit-plugin:de-anchor] Submitting fingerprint — root: ${smtRoot.slice(0, 16)}…, events: ${eventCount}, seq: ${startSeq}-${seqEnd}`);
            const txHash = await this.submitFingerprint(smtRoot);

            const checkpointId = uuidv7();
            this.store.insertCheckpoint(checkpointId, startSeq, seqEnd, smtRoot, eventCount, txHash);

            this.consecutiveFailures = 0;
            this.circuitOpenCount = 0;
            this.appendsSinceLastCheckpoint = 0;
            console.error(
                `[audit-plugin:de-anchor] Anchored SMT root (${eventCount} events, seq ${startSeq}-${seqEnd}) to DE: ${txHash ?? "submitted"}`,
            );
        } catch (err) {
            this.recordFailure();
            const message = err instanceof Error ? err.message : "Unknown error";
            console.error("[audit-plugin:de-anchor] Anchor failed:", message);
        }
    }

    private async verifyCheckpoints(): Promise<void> {
        if (!this.verifyFn) return;

        try {
            const checkpoints = this.store.getCheckpoints();
            const verifyFn = this.verifyFn;
            const notifier = this.notifier;

            await Promise.all(
                checkpoints
                    .filter((cp) => cp.deTxHash)
                    .map(async (cp) => {
                        try {
                            const detail = await verifyFn(cp.smtRoot);
                            if (!detail) {
                                console.error(`[audit-plugin:de-anchor] Verification failed for checkpoint ${cp.id}`);
                                notifier
                                    ?.notifyDeAnchorDivergence(cp.id, cp.smtRoot, "not found on DE")
                                    .catch(() => {});
                            }
                        } catch {
                            // Don't fail startup on DE API errors
                        }
                    }),
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            console.error("[audit-plugin:de-anchor] Checkpoint verification error:", message);
        }
    }

    private async submitFingerprint(smtRoot: string): Promise<string | null> {
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
            throw new Error(`DE rejected fingerprint: ${result?.errors?.join(", ") ?? "unknown reason"}`);
        }
        return result.hash ?? result.eventId ?? null;
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
            console.error(
                `[audit-plugin:de-anchor] Circuit breaker open — will retry after ${delayMs / 1000}s`,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Shared config parsing
// ---------------------------------------------------------------------------

function parseBaseConfig(config: Record<string, unknown>) {
    return {
        deApiUrl: typeof config.deApiUrl === "string" ? config.deApiUrl : DE_MAINNET_API,
        eventThreshold: typeof config.deEventThreshold === "number" ? config.deEventThreshold : DEFAULT_EVENT_THRESHOLD,
        intervalMs: typeof config.deIntervalMs === "number" ? config.deIntervalMs : DEFAULT_INTERVAL_MS,
    };
}

function resolveSigningKey(config: Record<string, unknown>): string {
    if (typeof config.deSigningKey === "string" && config.deSigningKey.length > 0) {
        return config.deSigningKey;
    }
    const kp = dedCore.generateKeyPair();
    console.error("[audit-plugin:de-anchor] No signing key configured, generated ephemeral key pair");
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
            deApiUrl: base.deApiUrl,
            deOrgId,
            deTenantId,
            deSigningKey,
            eventThreshold: base.eventThreshold,
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
        const {ethers} = require2("ethers") as typeof import("ethers");

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
            return res.kind === "result" ? res.data : res;
        };

        super({
            store,
            notifier,
            deApiUrl: base.deApiUrl,
            deOrgId: client.orgId,
            deTenantId: client.tenantId,
            deSigningKey: rawKey,
            eventThreshold: base.eventThreshold,
            intervalMs: base.intervalMs,
            submitFn,
            verifyFn: (h) => client.fingerprints.getByHash(h),
            authLabel: "x402 wallet",
        });

        // Drop this scope's reference to the key — the value is already held by the base class and the wallet/client objects
        rawKey = "";

        console.error(`[audit-plugin:de-anchor] Wallet loaded (address: ${client.walletAddress}), auth: x402`);
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
            console.error("[audit-plugin:de-anchor] Both deApiKey and deWalletKeyFile configured, API key takes precedence");
        }
        return new ApiKeyAnchorService(store, config, notifier);
    }

    if (deApiKey) {
        const missing = [!hasOrgId && "deOrgId", !hasTenantId && "deTenantId"].filter(Boolean).join(" and ");
        return new NoOpAnchorService(`deApiKey provided but ${missing} missing`);
    }

    if (deWalletKeyFile) {
        if (!existsSync(deWalletKeyFile)) {
            return new NoOpAnchorService(`Wallet key file not found: ${deWalletKeyFile}`);
        }
        try {
            return new WalletAnchorService(store, deWalletKeyFile, config, notifier);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return new NoOpAnchorService(`Failed to initialize wallet: ${msg}`);
        }
    }

    return new NoOpAnchorService("No DE credentials configured");
}
