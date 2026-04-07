import { uuidv7 } from "uuidv7";
import type { AuditStore } from "../store/audit-store.js";
import type { NotificationService } from "./notifications.js";
import type { SmtService } from "./smt-service.js";

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
  private eventThreshold: number;
  private intervalMs: number;

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
    this.eventThreshold =
      typeof config.deEventThreshold === "number" ? config.deEventThreshold : DEFAULT_EVENT_THRESHOLD;
    this.intervalMs =
      typeof config.deIntervalMs === "number" ? config.deIntervalMs : DEFAULT_INTERVAL_MS;
  }

  setSmtService(smt: SmtService): void {
    this.smtService = smt;
  }

  async start(): Promise<void> {
    if (!this.deApiKey && !this.x402Payment) {
      console.error("[audit-plugin] No DE API key or x402 payment configured, anchoring disabled");
      return;
    }

    await this.verifyCheckpoints();
    await this.anchorIfNeeded();
    this.timer = setInterval(() => this.anchorIfNeeded(), this.intervalMs);
    this.timer.unref();
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
      if (!smtRoot) return;

      const seqEnd = startSeq + eventCount - 1;

      const txHash = await this.submitFingerprint(smtRoot);

      const checkpointId = uuidv7();
      this.store.insertCheckpoint(checkpointId, startSeq, seqEnd, smtRoot, eventCount, txHash);

      this.consecutiveFailures = 0;
      this.appendsSinceLastCheckpoint = 0;
      console.error(
        `[audit-plugin] Anchored SMT root (${eventCount} events, seq ${startSeq}-${seqEnd}) to DE: ${txHash ?? "submitted"}`,
      );
    } catch (err) {
      this.recordFailure();
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] DE anchor failed:", message);
    }
  }

  async verifyCheckpoints(): Promise<void> {
    try {
      const checkpoints = this.store.getCheckpoints();

      for (const cp of checkpoints) {
        if (cp.deTxHash && (this.deApiKey || this.x402Payment)) {
          try {
            const verified = await this.verifyFingerprint(cp.smtRoot);
            if (!verified) {
              console.error(`[audit-plugin] DE verification failed for checkpoint ${cp.id}`);
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
      console.error("[audit-plugin] Checkpoint verification error:", message);
    }
  }

  private async submitFingerprint(smtRoot: string): Promise<string | null> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.deApiKey) {
      headers["X-API-Key"] = this.deApiKey;
    } else if (this.x402Payment) {
      headers["X-PAYMENT"] = this.x402Payment;
    }

    const response = await fetch(`${this.deApiUrl}/fingerprints`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        hash: smtRoot,
        metadata: {
          source: "openclaw-audit-plugin",
          type: "smt-root",
          timestamp: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`DE API returned ${response.status}: ${response.statusText}`);
    }

    const body = (await response.json()) as { hash?: string; eventId?: string };
    return body.hash ?? body.eventId ?? null;
  }

  private async verifyFingerprint(smtRoot: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (this.deApiKey) headers["X-API-Key"] = this.deApiKey;

    const response = await fetch(`${this.deApiUrl}/fingerprints/${smtRoot}/proof`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    return response.ok;
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
        `[audit-plugin] DE circuit breaker open — will retry after ${CIRCUIT_BREAKER_RESET_MS / 1000}s`,
      );
    }
  }
}
