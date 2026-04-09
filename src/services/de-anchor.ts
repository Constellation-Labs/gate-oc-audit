import { createRequire } from "module";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { uuidv7 } from "uuidv7";
import type { AuditStore } from "../store/audit-store.js";
import type { NotificationService } from "./notifications.js";
import type { SmtService } from "./smt-service.js";

const require2 = createRequire(import.meta.url);
const dedCore = require2("@constellation-network/digital-evidence-sdk") as typeof import("@constellation-network/digital-evidence-sdk");
const { DedClient } = require2("@constellation-network/digital-evidence-sdk/network") as typeof import("@constellation-network/digital-evidence-sdk/network");

const DEFAULT_EVENT_THRESHOLD = 100;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30 * 1000;
const DE_MAINNET_API = "https://de-api.constellationnetwork.io/v1";
const FETCH_TIMEOUT_MS = 15_000;

export class DeAnchorService {
  private store: AuditStore;
  private notifier: NotificationService | undefined;
  private smtService: SmtService | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  private deApiUrl: string;
  private deOrgId: string;
  private deTenantId: string;
  private deSigningKey: string;
  private eventThreshold: number;
  private intervalMs: number;

  private dedClient: InstanceType<typeof DedClient> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private x402Client: any;
  private authMethod: "api-key" | "x402" | undefined;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private appendsSinceLastCheckpoint = 0;

  constructor(
    store: AuditStore,
    config: Record<string, unknown> = {},
    notifier?: NotificationService,
  ) {
    this.store = store;
    this.notifier = notifier;
    this.deApiUrl = typeof config.deApiUrl === "string" ? config.deApiUrl : DE_MAINNET_API;
    const deApiKey = typeof config.deApiKey === "string" ? config.deApiKey : undefined;
    this.deOrgId = typeof config.deOrgId === "string" ? config.deOrgId : "";
    this.deTenantId = typeof config.deTenantId === "string" ? config.deTenantId : "";
    this.eventThreshold =
      typeof config.deEventThreshold === "number" ? config.deEventThreshold : DEFAULT_EVENT_THRESHOLD;
    this.intervalMs =
      typeof config.deIntervalMs === "number" ? config.deIntervalMs : DEFAULT_INTERVAL_MS;

    const deWalletKeyFile = typeof config.deWalletKeyFile === "string" ? config.deWalletKeyFile : undefined;

    if (deApiKey && this.deOrgId && this.deTenantId) {
      // Path A: API key auth
      if (deWalletKeyFile) {
        console.error("[audit-plugin:de-anchor] Both deApiKey and deWalletKeyFile configured, API key takes precedence");
      }
      if (typeof config.deSigningKey === "string" && config.deSigningKey.length > 0) {
        this.deSigningKey = config.deSigningKey;
      } else {
        const kp = dedCore.generateKeyPair();
        this.deSigningKey = kp.privateKey;
        console.error("[audit-plugin:de-anchor] No signing key configured, generated ephemeral key pair");
      }

      const baseUrl = this.deApiUrl.replace(/\/v1\/?$/, "");
      this.dedClient = new DedClient({ baseUrl, apiKey: deApiKey, timeout: FETCH_TIMEOUT_MS });
      this.authMethod = "api-key";
    } else if (deApiKey) {
      // API key provided but missing org/tenant
      this.deSigningKey = "";
      console.error("[audit-plugin:de-anchor] deApiKey provided but deOrgId and deTenantId are required, anchoring disabled");
    } else if (deWalletKeyFile) {
      // Path B: Wallet key file for x402 payments
      this.deSigningKey = "";
      this.initWalletClient(deWalletKeyFile);
    } else {
      this.deSigningKey = "";
    }
  }

  private initWalletClient(keyFilePath: string): void {
    if (!existsSync(keyFilePath)) {
      console.error(`[audit-plugin:de-anchor] Wallet key file not found: ${keyFilePath}`);
      return;
    }

    let rawKey: string;
    try {
      rawKey = readFileSync(keyFilePath, "utf-8").trim().replace(/^0x/, "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[audit-plugin:de-anchor] Failed to read wallet key file: ${msg}`);
      return;
    }

    if (!dedCore.isValidPrivateKey(rawKey)) {
      console.error("[audit-plugin:de-anchor] Wallet key file contains invalid private key (expected 64-char hex)");
      return;
    }

    try {
      const { DedX402Client, createEthersSigner } = require2(
        "@constellation-network/digital-evidence-sdk-x402",
      ) as typeof import("@constellation-network/digital-evidence-sdk-x402");
      const { ethers } = require2("ethers") as typeof import("ethers");

      const wallet = new ethers.Wallet(`0x${rawKey}`);
      const baseUrl = this.deApiUrl.replace(/\/v1\/?$/, "");
      const client = new DedX402Client({
        baseUrl,
        signer: createEthersSigner(wallet),
        signingPrivateKey: rawKey,
        timeout: FETCH_TIMEOUT_MS,
      });

      this.x402Client = client;
      this.deOrgId = client.orgId;
      this.deTenantId = client.tenantId;
      this.deSigningKey = rawKey;
      this.authMethod = "x402";
      console.error(`[audit-plugin:de-anchor] Wallet loaded (address: ${client.walletAddress}), auth: x402`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[audit-plugin:de-anchor] Failed to initialize x402 client: ${msg}`);
    }
  }

  setSmtService(smt: SmtService): void {
    this.smtService = smt;
  }

  async start(): Promise<void> {
    if (!this.authMethod) {
      console.error("[audit-plugin:de-anchor] No DE API key or wallet key file configured, anchoring disabled");
      return;
    }

    const method = this.authMethod === "api-key" ? "API key" : "x402 wallet";
    console.error(`[audit-plugin:de-anchor] Starting — auth: ${method}, url: ${this.deApiUrl}, threshold: ${this.eventThreshold}, interval: ${this.intervalMs}ms`);

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
    if (!this.authMethod) return;

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

      // Use SMT root as the integrity fingerprint
      const smtRoot = this.smtService?.getCurrentSmtRoot();
      if (!smtRoot) {
        console.error("[audit-plugin:de-anchor] No SMT root available, skipping anchor");
        return;
      }

      const seqEnd = startSeq + eventCount - 1;

      console.error(`[audit-plugin:de-anchor] Submitting fingerprint — root: ${smtRoot.slice(0, 16)}…, events: ${eventCount}, seq: ${startSeq}-${seqEnd}`);
      const txHash = await this.submitFingerprint(smtRoot);

      const checkpointId = uuidv7();
      this.store.insertCheckpoint(checkpointId, startSeq, seqEnd, smtRoot, eventCount, txHash);

      this.consecutiveFailures = 0;
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

  async verifyCheckpoints(): Promise<void> {
    const client = this.dedClient ?? this.x402Client;
    if (!client) return;

    try {
      const checkpoints = this.store.getCheckpoints();
      const notifier = this.notifier;

      await Promise.all(
        checkpoints
          .filter((cp) => cp.deTxHash)
          .map(async (cp) => {
            try {
              const detail = await client.fingerprints.getByHash(cp.smtRoot);
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
        tags: { source: "openclaw-audit-plugin", type: "smt-root" },
      },
      this.deSigningKey,
    );

    if (this.dedClient) {
      const results = await this.dedClient.fingerprints.submit([submission]);
      const result = results[0];
      if (!result?.accepted) {
        throw new Error(`DE rejected fingerprint: ${result?.errors?.join(", ") ?? "unknown reason"}`);
      }
      return result.hash ?? result.eventId ?? null;
    }

    if (this.x402Client) {
      const response = await this.x402Client.fingerprints.submit([submission]);
      if (response.kind === "payment_required") {
        throw new Error("x402 payment required but could not be fulfilled");
      }
      const results = response.kind === "result" ? response.data : response;
      const result = results[0];
      if (!result?.accepted) {
        throw new Error(`DE rejected fingerprint: ${result?.errors?.join(", ") ?? "unknown reason"}`);
      }
      return result.hash ?? result.eventId ?? null;
    }

    throw new Error("No DE client initialized");
  }

  private isCircuitOpen(): boolean {
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
    if (Date.now() >= this.circuitOpenUntil) {
      this.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD - 1;
      return false;
    }
    return true;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
      console.error(
        `[audit-plugin:de-anchor] Circuit breaker open — will retry after ${CIRCUIT_BREAKER_RESET_MS / 1000}s`,
      );
    }
  }
}
