import type { AuditEvent } from "../types/events.js";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BUFFER_CAPACITY = 10_000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_BASE_MS = 30 * 1000;
const CIRCUIT_BREAKER_MAX_MS = 5 * 60 * 1000;

const INGEST_PATH = "/admin/audit/ingest";

export interface GatewayPublisher {
  isActive(): boolean;
  start(): Promise<void>;
  stop(): void;
  notifyAppend(event: AuditEvent): void;
  flushNow(): Promise<void>;
  /** Number of events buffered, awaiting POST. Drives shutdown drain loops. */
  bufferedCount(): number;
  /** True when consecutive failures have tripped the breaker — further flushNow calls are no-ops until backoff elapses. */
  isCircuitOpen(): boolean;
}

class NoOpGatewayPublisher implements GatewayPublisher {
  constructor(reason: string) {
    console.error(`[audit-plugin:gateway-publisher] ${reason}, gateway publishing disabled`);
  }
  isActive(): boolean { return false; }
  async start(): Promise<void> { /* no-op */ }
  stop(): void { /* no-op */ }
  notifyAppend(): void { /* no-op */ }
  async flushNow(): Promise<void> { /* no-op */ }
  bufferedCount(): number { return 0; }
  isCircuitOpen(): boolean { return false; }
}

function isUnsafeUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return "malformed URL"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `disallowed protocol ${url.protocol}`;
  return undefined;
}

interface ActiveConfig {
  ingestUrl: string;
  apiKey: string;
  batchSize: number;
  intervalMs: number;
  timeoutMs: number;
  bufferCapacity: number;
}

class ActiveGatewayPublisher implements GatewayPublisher {
  private readonly cfg: ActiveConfig;
  private buffer: AuditEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private consecutiveFailures = 0;
  private circuitOpenCount = 0;
  private circuitOpenUntil = 0;
  private dropped = 0;

  constructor(cfg: ActiveConfig) {
    this.cfg = cfg;
  }

  isActive(): boolean { return true; }

  async start(): Promise<void> {
    if (this.timer) return; // idempotent — repeated start() calls don't leak timers
    console.error(
      `[audit-plugin:gateway-publisher] Starting — url: ${this.cfg.ingestUrl}, batchSize: ${this.cfg.batchSize}, intervalMs: ${this.cfg.intervalMs}`,
    );
    this.timer = setInterval(() => {
      this.flushNow().catch(() => { /* errors logged inside */ });
    }, this.cfg.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  notifyAppend(event: AuditEvent): void {
    if (this.buffer.length >= this.cfg.bufferCapacity) {
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 100 === 0) {
        console.error(
          `[audit-plugin:gateway-publisher] Buffer full (${this.cfg.bufferCapacity}), dropped ${this.dropped} event(s) cumulatively`,
        );
      }
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.cfg.batchSize) {
      this.flushNow().catch(() => { /* errors logged inside */ });
    }
  }

  async flushNow(): Promise<void> {
    if (this.inFlight) return;
    if (this.buffer.length === 0) return;
    if (this.isCircuitOpen()) return;

    this.inFlight = true;
    const batch = this.buffer.splice(0, this.cfg.batchSize);
    let succeeded = false;
    try {
      await this.send(batch);
      this.consecutiveFailures = 0;
      this.circuitOpenCount = 0;
      succeeded = true;
    } catch (err) {
      this.recordFailure();
      this.buffer.unshift(...batch);
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[audit-plugin:gateway-publisher] Publish failed (${batch.length} events requeued): ${message}`);
    } finally {
      this.inFlight = false;
    }

    // If events accumulated during the in-flight POST (or simply more than one
    // batch was buffered), drain the next one immediately rather than waiting
    // for the timer tick. Only chain on success — on failure the circuit /
    // requeue logic above handles backoff.
    if (succeeded && this.buffer.length >= this.cfg.batchSize && !this.isCircuitOpen()) {
      // Schedule asynchronously so callers `await flushNow()` get a clean
      // single-batch boundary and don't see chained latency.
      queueMicrotask(() => {
        this.flushNow().catch(() => { /* errors logged inside */ });
      });
    }
  }

  private async send(events: AuditEvent[]): Promise<void> {
    const response = await fetch(this.cfg.ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Api-Key": this.cfg.apiKey,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Gateway returned ${response.status} ${response.statusText}`);
    }
  }

  isCircuitOpen(): boolean {
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
      const delayMs = Math.min(CIRCUIT_BREAKER_BASE_MS * 2 ** this.circuitOpenCount, CIRCUIT_BREAKER_MAX_MS);
      this.circuitOpenCount++;
      this.circuitOpenUntil = Date.now() + delayMs;
      console.error(
        `[audit-plugin:gateway-publisher] Circuit breaker open — will retry after ${delayMs / 1000}s`,
      );
    }
  }

  bufferedCount(): number { return this.buffer.length; }
}

export function createGatewayPublisher(config: Record<string, unknown>): GatewayPublisher {
  const enabledConfig = config.gatewayEnabled;
  const explicitlyDisabled = enabledConfig === false;
  if (explicitlyDisabled) return new NoOpGatewayPublisher("gatewayEnabled=false");

  const url = typeof config.gatewayUrl === "string" ? config.gatewayUrl : undefined;
  const apiKey = typeof config.gatewayApiKey === "string" ? config.gatewayApiKey : undefined;
  if (!url || !apiKey) {
    return new NoOpGatewayPublisher("gatewayUrl or gatewayApiKey not configured");
  }

  const reason = isUnsafeUrl(url);
  if (reason) {
    return new NoOpGatewayPublisher(`gatewayUrl rejected (${reason})`);
  }

  const ingestUrl = url.replace(/\/+$/, "") + INGEST_PATH;
  const batchSize = typeof config.gatewayBatchSize === "number" && config.gatewayBatchSize > 0
    ? Math.floor(config.gatewayBatchSize)
    : DEFAULT_BATCH_SIZE;
  const intervalMs = typeof config.gatewayIntervalMs === "number" && config.gatewayIntervalMs > 0
    ? Math.floor(config.gatewayIntervalMs)
    : DEFAULT_INTERVAL_MS;
  const timeoutMs = typeof config.gatewayTimeoutMs === "number" && config.gatewayTimeoutMs > 0
    ? Math.floor(config.gatewayTimeoutMs)
    : DEFAULT_TIMEOUT_MS;

  return new ActiveGatewayPublisher({
    ingestUrl,
    apiKey,
    batchSize,
    intervalMs,
    timeoutMs,
    bufferCapacity: DEFAULT_BUFFER_CAPACITY,
  });
}
