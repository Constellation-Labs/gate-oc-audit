import type { AuditEvent } from "../types/events.js";
import {gatewayPublisherLog} from "../util/logger.js";

const DEFAULT_BATCH_SIZE = 50;
const MIN_BATCH_SIZE = 1;
const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const DEFAULT_BUFFER_CAPACITY = 10_000;
const MIN_BUFFER_CAPACITY = 1;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;
const MIN_SHUTDOWN_DEADLINE_MS = 1_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 5_000_000;
const MIN_MAX_PAYLOAD_BYTES = 1024;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_BASE_MS = 30 * 1000;
const CIRCUIT_BREAKER_MAX_MS = 5 * 60 * 1000;

const INGEST_PATH = "/admin/audit/ingest";

// Strict allowlist for X-Gateway-Api-Key header value: ASCII printables minus
// whitespace, quotes, control chars, and CR/LF — preventing header injection.
// Covers RFC 7230 token chars, base64 (=, /), URL-safe (-, _, .), and a few
// ambiguous-but-common vendor key chars (~+).
const API_KEY_RE = /^[A-Za-z0-9!#$%&'*+\-./:=?^_`|~]+$/;
const API_KEY_MAX_LEN = 1024;

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
  /** Wall-clock deadline (ms) for the shutdown drain. */
  shutdownDeadlineMs(): number;
}

class NoOpGatewayPublisher implements GatewayPublisher {
  constructor(reason: string) {
    gatewayPublisherLog.info(`${reason}, gateway publishing disabled`);
  }
  isActive(): boolean { return false; }
  async start(): Promise<void> { /* no-op */ }
  stop(): void { /* no-op */ }
  notifyAppend(): void { /* no-op */ }
  async flushNow(): Promise<void> { /* no-op */ }
  bufferedCount(): number { return 0; }
  isCircuitOpen(): boolean { return false; }
  shutdownDeadlineMs(): number { return 0; }
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivateOrLinkLocalIp(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const lower = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}(:|::)/.test(lower)) return true;
  return false;
}

/**
 * Validate a configured gateway URL.
 * - Reject malformed URLs and non-http(s) protocols.
 * - Reject plain http:// to anything but loopback (cleartext API key risk).
 * - Reject https:// to private/link-local IPs unless `allowPrivateHost` is set
 *   (mitigates SSRF coercion via misconfigured config).
 */
export function validateGatewayUrl(raw: string, opts: { allowPrivateHost?: boolean } = {}): ValidationResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `disallowed protocol ${url.protocol}` };
  }
  const host = url.hostname;
  const loopback = isLoopbackHost(host);
  if (url.protocol === "http:" && !loopback) {
    return { ok: false, reason: "http:// requires loopback host (localhost, 127.0.0.1, [::1])" };
  }
  if (!loopback && !opts.allowPrivateHost && isPrivateOrLinkLocalIp(host)) {
    return { ok: false, reason: `private/link-local host ${host} (set gatewayAllowPrivateHost: true to allow)` };
  }
  return { ok: true };
}

export function validateGatewayApiKey(key: string): ValidationResult {
  if (key.length === 0) return { ok: false, reason: "empty" };
  if (key.length > API_KEY_MAX_LEN) return { ok: false, reason: `length > ${API_KEY_MAX_LEN}` };
  if (!API_KEY_RE.test(key)) return { ok: false, reason: "contains disallowed characters (whitespace/CR/LF/quotes)" };
  return { ok: true };
}

/**
 * Optional dependencies for the active publisher. Wired by the plugin entry
 * point so the publisher can record buffer-full drops as local audit events
 * without owning a reference to the store/SMT.
 */
export interface GatewayPublisherDeps {
  /**
   * Invoked when the cumulative drop count crosses an exponential milestone
   * (1, 10, 100, 1000, …). Implementations should record a synthetic
   * `gateway.dropped` event in the local store so a downstream verifier can
   * detect the gap. Must NOT call back into the publisher (recursion risk).
   */
  onDropMilestone?(cumulativeDropped: number): void;
}

interface ActiveConfig {
  ingestUrl: string;
  apiKey: string;
  batchSize: number;
  intervalMs: number;
  timeoutMs: number;
  bufferCapacity: number;
  shutdownDeadlineMs: number;
  includeContent: boolean;
  maxPayloadBytes: number;
}

class ActiveGatewayPublisher implements GatewayPublisher {
  private readonly cfg: ActiveConfig;
  private readonly deps: GatewayPublisherDeps;
  private buffer: AuditEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlightPromise: Promise<unknown> | undefined;
  private consecutiveFailures = 0;
  private circuitOpenCount = 0;
  private circuitOpenUntil = 0;
  private dropped = 0;
  private nextDropMilestone = 1;

  constructor(cfg: ActiveConfig, deps: GatewayPublisherDeps = {}) {
    this.cfg = cfg;
    this.deps = deps;
  }

  isActive(): boolean { return true; }

  async start(): Promise<void> {
    if (this.timer) return; // idempotent — repeated start() calls don't leak timers
    gatewayPublisherLog.info(
      `Starting — url: ${this.cfg.ingestUrl}, batchSize: ${this.cfg.batchSize}, intervalMs: ${this.cfg.intervalMs}`,
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
      if (this.dropped >= this.nextDropMilestone) {
        gatewayPublisherLog.warn(
          `Buffer full (${this.cfg.bufferCapacity}), dropped ${this.dropped} event(s) cumulatively`,
        );
        try {
          this.deps.onDropMilestone?.(this.dropped);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          gatewayPublisherLog.warn(`onDropMilestone callback threw: ${msg}`);
        }
        // Exponential cadence: 1, 10, 100, 1000, … bounds log noise during
        // sustained outages while still surfacing magnitude.
        this.nextDropMilestone = this.nextDropMilestone < 10
          ? this.nextDropMilestone + 1
          : this.nextDropMilestone * 10;
      }
      return;
    }
    this.buffer.push(event);
    // Crossing batchSize triggers a fire-and-forget flush on the caller's hot
    // path (rate-limiter). For small batch sizes + high event rates this becomes
    // the dominant flush path, with the timer largely unused.
    if (this.buffer.length >= this.cfg.batchSize) {
      this.flushNow().catch(() => { /* errors logged inside */ });
    }
  }

  async flushNow(): Promise<void> {
    // If a flush is already in flight, await the existing promise so callers
    // (especially the shutdown drain) wait for actual progress instead of
    // spinning through dead iterations.
    if (this.inFlightPromise) {
      await this.inFlightPromise;
      return;
    }
    if (this.buffer.length === 0) return;
    if (this.isCircuitOpen()) return;

    const promise = this.flushOne();
    this.inFlightPromise = promise;
    let succeeded = false;
    try {
      succeeded = await promise;
    } finally {
      this.inFlightPromise = undefined;
    }

    // If events accumulated during the in-flight POST (or simply more than one
    // batch was buffered), drain the next one immediately rather than waiting
    // for the timer tick. Only chain on success — on failure the circuit /
    // requeue logic above handles backoff. Schedule AFTER inFlightPromise is
    // cleared so the queued flushNow can actually run a new flush.
    if (succeeded && this.buffer.length >= this.cfg.batchSize && !this.isCircuitOpen()) {
      queueMicrotask(() => {
        this.flushNow().catch(() => { /* errors logged inside */ });
      });
    }
  }

  private async flushOne(): Promise<boolean> {
    const batch = this.buffer.splice(0, this.cfg.batchSize);
    try {
      const payload = this.buildPayload(batch);
      if (payload === undefined) {
        // Oversized batch — drop with a warn log rather than requeueing
        // (a too-large batch will keep failing forever otherwise).
        gatewayPublisherLog.warn(
          `dropping batch of ${batch.length} event(s): payload exceeds ${this.cfg.maxPayloadBytes} bytes`,
        );
        return true;
      }
      await this.send(payload);
      this.consecutiveFailures = 0;
      this.circuitOpenCount = 0;
      return true;
    } catch (err) {
      this.recordFailure();
      this.buffer.unshift(...batch);
      const message = err instanceof Error ? err.message : "Unknown error";
      gatewayPublisherLog.error(`Publish failed (${batch.length} events requeued): ${message}`);
      return false;
    }
  }

  /**
   * Build the JSON payload for one POST. Returns `undefined` when the
   * serialized batch exceeds `maxPayloadBytes`.
   * - When `includeContent` is false (default), strips event `content` so the
   *   gateway doesn't receive prompt/tool-arg text by default.
   */
  private buildPayload(batch: AuditEvent[]): string | undefined {
    const sanitized = this.cfg.includeContent
      ? batch
      : batch.map((e) => {
          if (e.content === undefined) return e;
          const copy = { ...e };
          delete copy.content;
          return copy;
        });
    const body = JSON.stringify({ events: sanitized });
    if (Buffer.byteLength(body, "utf8") > this.cfg.maxPayloadBytes) return undefined;
    return body;
  }

  private async send(body: string): Promise<void> {
    const response = await fetch(this.cfg.ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Api-Key": this.cfg.apiKey,
      },
      body,
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
      gatewayPublisherLog.warn(
        `Circuit breaker open — will retry after ${delayMs / 1000}s`,
      );
    }
  }

  bufferedCount(): number { return this.buffer.length; }
  shutdownDeadlineMs(): number { return this.cfg.shutdownDeadlineMs; }
}

function clampNumber(value: unknown, min: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

export function createGatewayPublisher(
  config: Record<string, unknown>,
  deps: GatewayPublisherDeps = {},
): GatewayPublisher {
  const enabledConfig = config.gatewayEnabled;
  if (enabledConfig === false) return new NoOpGatewayPublisher("gatewayEnabled=false");
  if (enabledConfig !== undefined && typeof enabledConfig !== "boolean") {
    gatewayPublisherLog.warn(
      `gatewayEnabled is non-boolean (${typeof enabledConfig}); treating as default`,
    );
  }

  const url = typeof config.gatewayUrl === "string" ? config.gatewayUrl : undefined;
  const apiKey = typeof config.gatewayApiKey === "string" ? config.gatewayApiKey : undefined;
  if (!url || !apiKey) {
    return new NoOpGatewayPublisher("gatewayUrl or gatewayApiKey not configured");
  }

  const allowPrivateHost = config.gatewayAllowPrivateHost === true;
  const urlValidation = validateGatewayUrl(url, { allowPrivateHost });
  if (!urlValidation.ok) {
    return new NoOpGatewayPublisher(`gatewayUrl rejected (${urlValidation.reason})`);
  }

  const keyValidation = validateGatewayApiKey(apiKey);
  if (!keyValidation.ok) {
    return new NoOpGatewayPublisher(`gatewayApiKey rejected (${keyValidation.reason})`);
  }

  // Surface http:// (cleartext) misconfiguration loudly even when allowed (loopback dev).
  if (url.toLowerCase().startsWith("http://")) {
    gatewayPublisherLog.warn(
      "gatewayUrl uses http:// — API key will be transmitted in cleartext (allowed only because host is loopback)",
    );
  }

  const ingestUrl = url.replace(/\/+$/, "") + INGEST_PATH;
  const batchSize = clampNumber(config.gatewayBatchSize, MIN_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const intervalMs = clampNumber(config.gatewayIntervalMs, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const timeoutMs = clampNumber(config.gatewayTimeoutMs, MIN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const bufferCapacity = clampNumber(config.gatewayBufferCapacity, MIN_BUFFER_CAPACITY, DEFAULT_BUFFER_CAPACITY);
  const shutdownDeadlineMs = clampNumber(
    config.gatewayShutdownDeadlineMs, MIN_SHUTDOWN_DEADLINE_MS, DEFAULT_SHUTDOWN_DEADLINE_MS,
  );
  const maxPayloadBytes = clampNumber(
    config.gatewayMaxPayloadBytes, MIN_MAX_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD_BYTES,
  );
  const includeContent = config.gatewayIncludeContent === true;

  return new ActiveGatewayPublisher({
    ingestUrl,
    apiKey,
    batchSize,
    intervalMs,
    timeoutMs,
    bufferCapacity,
    shutdownDeadlineMs,
    includeContent,
    maxPayloadBytes,
  }, deps);
}

/**
 * Drain buffered events synchronously, bounded by both an iteration cap and a
 * wall-clock deadline. Designed for shutdown — exits early on circuit-open or
 * deadline expiry rather than blocking SIGTERM forever on a dead gateway.
 *
 * On unsuccessful drain (events still buffered or circuit open), logs a clear
 * WARN with the abandoned event count.
 */
export async function drainForShutdown(publisher: GatewayPublisher): Promise<void> {
  if (!publisher.isActive()) return;
  const deadline = Date.now() + publisher.shutdownDeadlineMs();
  let safetyCounter = 0;
  while (
    publisher.bufferedCount() > 0
    && !publisher.isCircuitOpen()
    && Date.now() < deadline
    && safetyCounter < 1000
  ) {
    await publisher.flushNow();
    safetyCounter++;
  }

  const remaining = publisher.bufferedCount();
  if (remaining > 0) {
    const reason = publisher.isCircuitOpen()
      ? "circuit breaker open"
      : Date.now() >= deadline
        ? "shutdown deadline reached"
        : "iteration cap reached";
    gatewayPublisherLog.warn(
      `abandoning ${remaining} buffered event(s) on shutdown — ${reason}`,
    );
  }
}
