import { createRequire } from "module";
import { randomUUID } from "node:crypto";
import { uuidv7 } from "uuidv7";
import type { AuditStore } from "../store/audit-store.js";
import type { NotificationService } from "./notifications.js";
import type { SmtService } from "./smt-service.js";

const require2 = createRequire(import.meta.url);
const dedCore = require2("@constellation-network/digital-evidence-sdk") as {
  generateFingerprint: (options: DedGenerateOptions, privateKey: string) => Promise<unknown>;
  generateKeyPair: () => { privateKey: string; publicKey: string };
  hashDocument: (content: string | Buffer) => string;
};
const { DedClient } = require2("@constellation-network/digital-evidence-sdk/network") as {
  DedClient: new (config: { baseUrl: string; apiKey?: string; timeout?: number }) => DedClientInstance;
};

interface DedClientInstance {
  fingerprints: {
    submit: (submissions: unknown[]) => Promise<DedSubmitResult[]>;
    getByHash: (hash: string) => Promise<{ data: unknown }>;
  };
}

interface DedSubmitResult {
  eventId?: string;
  hash?: string;
  accepted: boolean;
  errors?: string[];
}

interface DedGenerateOptions {
  orgId: string;
  tenantId: string;
  eventId: string;
  documentId: string;
  documentRef: string;
  timestamp: Date;
  includeMetadata?: boolean;
  tags?: Record<string, string>;
}

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
  private deApiKey: string | undefined;
  private x402Payment: string | undefined;
  private deOrgId: string;
  private deTenantId: string;
  private deSigningKey: string;
  private eventThreshold: number;
  private intervalMs: number;

  private dedClient: DedClientInstance | undefined;

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
    this.deApiKey = typeof config.deApiKey === "string" ? config.deApiKey : undefined;
    this.x402Payment = typeof config.x402Payment === "string" ? config.x402Payment : undefined;
    this.deOrgId = typeof config.deOrgId === "string" ? config.deOrgId : "";
    this.deTenantId = typeof config.deTenantId === "string" ? config.deTenantId : "";
    this.eventThreshold =
      typeof config.deEventThreshold === "number" ? config.deEventThreshold : DEFAULT_EVENT_THRESHOLD;
    this.intervalMs =
      typeof config.deIntervalMs === "number" ? config.deIntervalMs : DEFAULT_INTERVAL_MS;

    // Signing key — use configured key or generate an ephemeral one
    if (typeof config.deSigningKey === "string" && config.deSigningKey.length > 0) {
      this.deSigningKey = config.deSigningKey;
    } else {
      const kp = dedCore.generateKeyPair();
      this.deSigningKey = kp.privateKey;
      console.error("[audit-plugin:de-anchor] No signing key configured, generated ephemeral key pair");
    }

    // Initialize DedClient eagerly so anchorIfNeeded() works without start()
    if (this.deApiKey && this.deOrgId && this.deTenantId) {
      const baseUrl = this.deApiUrl.replace(/\/v1\/?$/, "");
      this.dedClient = new DedClient({ baseUrl, apiKey: this.deApiKey, timeout: FETCH_TIMEOUT_MS });
    }
  }

  setSmtService(smt: SmtService): void {
    this.smtService = smt;
  }

  async start(): Promise<void> {
    if (!this.deApiKey && !this.x402Payment) {
      console.error("[audit-plugin:de-anchor] No DE API key or x402 payment configured, anchoring disabled");
      return;
    }

    if (!this.deOrgId || !this.deTenantId) {
      console.error("[audit-plugin:de-anchor] deOrgId and deTenantId are required for anchoring, disabled");
      return;
    }

    const method = this.deApiKey ? "API key" : "x402 payment";
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
    if (!this.deApiKey && !this.x402Payment) return;

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
      if (eventCount < this.eventThreshold) {
        console.error(`[audit-plugin:de-anchor] Below threshold (${eventCount}/${this.eventThreshold}), skipping`);
        return;
      }

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
    if (!this.dedClient) return;

    try {
      const checkpoints = this.store.getCheckpoints();

      for (const cp of checkpoints) {
        if (cp.deTxHash) {
          try {
            const detail = await this.dedClient.fingerprints.getByHash(cp.smtRoot);
            if (!detail) {
              console.error(`[audit-plugin:de-anchor] Verification failed for checkpoint ${cp.id}`);
              this.notifier
                ?.notifyDeAnchorDivergence(cp.id, cp.smtRoot, "not found on DE")
                .catch(() => {});
            }
          } catch {
            // Don't fail startup on DE API errors
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin:de-anchor] Checkpoint verification error:", message);
    }
  }

  private async submitFingerprint(smtRoot: string): Promise<string | null> {
    if (!this.dedClient) {
      throw new Error("DedClient not initialized");
    }

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

    const results = await this.dedClient.fingerprints.submit([submission]);
    const result = results[0];

    if (!result?.accepted) {
      throw new Error(`DE rejected fingerprint: ${result?.errors?.join(", ") ?? "unknown reason"}`);
    }

    return result.hash ?? result.eventId ?? null;
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
