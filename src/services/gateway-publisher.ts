import type { AuditEvent } from "../types/events.js";
import {gatewayPublisherLog} from "../util/logger.js";

const DEFAULT_BATCH_SIZE = 50;
const MIN_BATCH_SIZE = 1;
// Spec §11.3 caps batch at 100 events. Clamp gatewayBatchSize so a
// misconfigured config can never push us past the gateway's MAX_EVENTS_PER_REQUEST.
const MAX_BATCH_SIZE = 100;
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
const RATE_LIMIT_MAX_MS = 5 * 60 * 1000;

const INGEST_PATH = "/api/v1/audit/ingest";

/**
 * Strip control chars (CR/LF/tab/escape/DEL) and cap to `maxBytes` bytes so
 * gateway-controlled response bodies can't forge log lines or blow the log
 * budget with multi-byte content. Multi-byte chars at the boundary are
 * truncated cleanly rather than producing a partial code unit.
 */
function sanitizeForLog(raw: string, maxBytes: number): string {
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, " ");
  const buf = Buffer.from(stripped, "utf8");
  if (buf.byteLength <= maxBytes) return stripped;
  return buf.subarray(0, maxBytes).toString("utf8");
}

type SendResult =
  | { kind: "ok"; accepted: number; duplicateCount: number; highestSequence?: number }
  | { kind: "rateLimited"; retryAfterMs: number }
  | { kind: "payloadTooLarge" }
  | { kind: "error"; message: string };

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
  /** True when flushNow is currently a no-op — either circuit-open OR a 429-mandated rate-limit pause is in effect. */
  isPaused(): boolean;
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
  isPaused(): boolean { return false; }
  shutdownDeadlineMs(): number { return 0; }
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** DNS root-form trailing dot ("127.0.0.1." == "127.0.0.1"). Strip before matching. */
function normalizeHost(host: string): string {
  const trimmed = host.endsWith(".") ? host.slice(0, -1) : host;
  return trimmed.toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv4-mapped IPv6 loopback: ::ffff:127.x.x.x
  if (/^\[?::ffff:127(\.\d{1,3}){3}\]?$/.test(h)) return true;
  return false;
}

function isPrivateOrLinkLocalIp(host: string): boolean {
  const h = normalizeHost(host);
  // 0.0.0.0/8 — "unspecified" / wildcard; on most OSes binds to all
  // interfaces including loopback, so treat as private to avoid leaking
  // outbound POSTs to whichever interface the OS picks.
  if (/^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
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
  const v6 = h.replace(/^\[|\]$/g, "");
  if (v6.startsWith("fe80:") || v6.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}(:|::)/.test(v6)) return true;
  // IPv4-mapped IPv6 to private/link-local addresses (::ffff:10.x, etc.)
  const mapped = v6.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (mapped) {
    const a = Number(mapped[1]);
    const b = Number(mapped[2]);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/**
 * Reject ambiguous numeric-encoded IPv4 (decimal "2130706433", hex
 * "0x7f000001", octal "0177.0.0.1"). Some resolvers decode these to
 * loopback/private addresses; we don't want to play whack-a-mole, so we
 * just refuse non-dotted-quad numeric hosts up-front.
 */
function isNumericIpEncoding(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return false;
  // Pure decimal/hex integer, or dotted parts with hex/octal segments
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(h)) return true;
  if (/\.0x[0-9a-f]+/i.test(h)) return true;
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
  if (isNumericIpEncoding(host)) {
    return { ok: false, reason: `numeric IP encoding ${host} (use dotted-quad form)` };
  }
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
 * SMT-anchored checkpoint payload mirrored from the plugin's local
 * `audit_checkpoint` rows. Sent as the optional `smtCheckpoint` envelope
 * field — gateway upserts it into `plugin_audit_checkpoints` and links
 * every covered event row.
 */
export interface SmtCheckpointPayload {
  smtRoot: string;
  sequenceStart: number;
  sequenceEnd: number;
  deTxHash: string;
  createdAt: string;
}

/** Stateless function producing the SMT-leaf hashes the gateway expects per event. */
export type ComputeHashesFn = (event: AuditEvent) => { rawHash: string; censoredHash: string };

/**
 * Returns the most recent DE-anchored checkpoint whose range covers the
 * batch's highest sequence, or null when no anchor covers it yet.
 */
export type LatestAnchoredCheckpointFn = (maxSequence: number) => SmtCheckpointPayload | null;

/**
 * Structural input for `selectAnchorCovering` — kept generic so the helper
 * doesn't pull `CheckpointRecord` into the publisher's import graph.
 */
interface AnchorCandidate {
  smtRoot: string;
  sequenceStart: number;
  sequenceEnd: number;
  deTxHash: string | null;
  createdAt: string;
}

/**
 * Picks the most recent DE-anchored checkpoint whose `sequenceStart` is on
 * or before `maxSequence`. Full coverage (`sequenceEnd >= maxSequence`) is
 * *not* required: in steady state new events accumulate past the latest
 * anchor, so a strict coverage check would mean the envelope's
 * `smtCheckpoint` almost never ships. The gateway's controller does its
 * own per-event coverage filter (see `audit-ingest.controller.ts`:
 * `event.sequence >= smtCheckpoint.sequenceStart && <= sequenceEnd`), so
 * events past the anchor's `sequenceEnd` land gateway-side as
 * anchor-pending regardless of what the plugin attaches. Returns null
 * when no anchored checkpoint exists yet at all.
 */
export function selectAnchorCovering(
  checkpoints: readonly AnchorCandidate[],
  maxSequence: number,
): SmtCheckpointPayload | null {
  let best: SmtCheckpointPayload | null = null;
  for (const cp of checkpoints) {
    if (cp.deTxHash === null) continue;
    if (cp.sequenceStart > maxSequence) continue;
    if (best && best.sequenceEnd >= cp.sequenceEnd) continue;
    best = {
      smtRoot: cp.smtRoot,
      sequenceStart: cp.sequenceStart,
      sequenceEnd: cp.sequenceEnd,
      deTxHash: cp.deTxHash,
      createdAt: cp.createdAt,
    };
  }
  return best;
}

/**
 * Dependencies for the active publisher. Wired by the plugin entry point
 * so the publisher can compute SMT hashes, look up anchor state, and
 * record buffer-full drops without owning a direct reference to the
 * store/SMT.
 */
export interface GatewayPublisherDeps {
  /**
   * Invoked when the cumulative drop count crosses an exponential milestone
   * (1, 10, 100, 1000, …). Implementations should record a synthetic
   * `gateway.dropped` event in the local store so a downstream verifier can
   * detect the gap. Must NOT call back into the publisher (recursion risk).
   */
  onDropMilestone?(cumulativeDropped: number): void;
  /**
   * Optional at the type level for ergonomics, but the factory returns a
   * NoOp publisher when omitted — the gateway's DTO requires both
   * `rawHash` and `censoredHash` on every event, so a missing producer
   * would mean sending guaranteed-400 payloads. Production wires this to
   * `SmtService.computeRawHash` / `computeCensoredHash`.
   */
  computeHashes?: ComputeHashesFn;
  /**
   * Optional: attaches a DE-anchored `smtCheckpoint` to each batch when
   * available. Anchor-pending batches simply omit the field; the gateway
   * persists those rows with `last_checkpoint_id = NULL` and will backfill
   * them when the matching checkpoint arrives on a later batch.
   */
  latestAnchoredCheckpoint?: LatestAnchoredCheckpointFn;
}

interface ActiveConfig {
  ingestUrl: string;
  apiKey: string;
  batchSize: number;
  intervalMs: number;
  timeoutMs: number;
  bufferCapacity: number;
  shutdownDeadlineMs: number;
  maxPayloadBytes: number;
  computeHashes: ComputeHashesFn;
  latestAnchoredCheckpoint?: LatestAnchoredCheckpointFn;
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
  // Server-acknowledged watermark from 200 `highestSequence`. In-memory only —
  // resets to 0 on restart. Used by future progress tracking; not load-bearing
  // for correctness (the gateway dedupes on event.id regardless).
  private highestSequence = 0;
  // Wall-clock deadline (ms) until which we must not POST, set by a 429
  // response's retryAfterMs. Distinct from the circuit breaker (which is
  // tripped by consecutive transport/5xx failures).
  private rateLimitedUntil = 0;
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
    if (this.isPaused()) return;

    // Marker is assigned in the same synchronous tick the flushOne() call
    // starts in, so any re-entrant flushNow sees inFlightPromise set before
    // it can race the buffer splice that runs synchronously inside flushOne.
    const pending = this.flushOne();
    this.inFlightPromise = pending;
    let succeeded = false;
    try {
      succeeded = await pending;
    } finally {
      this.inFlightPromise = undefined;
    }

    // If events accumulated during the in-flight POST (or simply more than one
    // batch was buffered), drain the next one immediately rather than waiting
    // for the timer tick. Only chain on success — on failure the circuit /
    // requeue logic above handles backoff. Schedule AFTER inFlightPromise is
    // cleared so the queued flushNow can actually run a new flush.
    if (succeeded && this.buffer.length >= this.cfg.batchSize && !this.isPaused()) {
      queueMicrotask(() => {
        this.flushNow().catch(() => { /* errors logged inside */ });
      });
    }
  }

  private async flushOne(): Promise<boolean> {
    const batch = this.buffer.splice(0, this.cfg.batchSize);
    try {
      const outcome = await this.sendWithSplit(batch);
      if (outcome.requeue.length > 0) {
        // sendWithSplit already logged the reason and updated rate-limit / circuit
        // state; we only need to put the unaccepted suffix back so it retries on
        // the next tick. `accepted` events are dropped here because the gateway
        // already received them.
        this.buffer.unshift(...outcome.requeue);
      }
      return outcome.requeue.length === 0;
    } catch (err) {
      // computeHashes / latestAnchoredCheckpoint / buildPayload can throw
      // synchronously. Without this guard the batch is already spliced out of
      // the buffer and the rejection would unwind into the swallowed
      // flushNow().catch(() => {}) site, silently dropping outbound audit events.
      const message = err instanceof Error ? err.message : "Unknown error";
      this.recordFailure();
      gatewayPublisherLog.error(
        `Publish pipeline threw (${batch.length} events requeued): ${message}`,
      );
      this.buffer.unshift(...batch);
      return false;
    }
  }

  /**
   * Send one batch, recursively halving on 413 (PAYLOAD_TOO_LARGE) or on a
   * local maxPayloadBytes overflow. Returns the unaccepted suffix in
   * `outcome.requeue`; an empty `requeue` means the entire batch was
   * delivered (or unrecoverably dropped because a single event was oversized).
   * The caller only requeues the suffix so successfully-delivered halves
   * aren't re-sent on a transient failure of a later half.
   */
  private async sendWithSplit(batch: AuditEvent[]): Promise<{ requeue: AuditEvent[] }> {
    if (batch.length === 0) return { requeue: [] };

    const payload = this.buildPayload(batch);
    if (payload.kind === "drop") {
      gatewayPublisherLog.error(
        `dropping batch of ${batch.length}: ${payload.reason}`,
      );
      return { requeue: [] };
    }
    if (payload.kind === "oversize") {
      // Local cap exceeded BEFORE we even try the network. Split if possible.
      if (batch.length === 1) {
        gatewayPublisherLog.error(
          `dropping single event ${batch[0].id}: serialized size exceeds local maxPayloadBytes (${this.cfg.maxPayloadBytes})`,
        );
        return { requeue: [] };
      }
      return this.splitAndSend(batch);
    }

    const result = await this.send(payload.body);
    switch (result.kind) {
      case "ok":
        if (result.highestSequence !== undefined && result.highestSequence > this.highestSequence) {
          this.highestSequence = result.highestSequence;
        }
        this.consecutiveFailures = 0;
        this.circuitOpenCount = 0;
        return { requeue: [] };
      case "payloadTooLarge":
        if (batch.length === 1) {
          gatewayPublisherLog.error(
            `dropping single event ${batch[0].id}: gateway rejected as PAYLOAD_TOO_LARGE`,
          );
          return { requeue: [] };
        }
        gatewayPublisherLog.warn(
          `Gateway returned 413 for batch of ${batch.length}; splitting and retrying`,
        );
        return this.splitAndSend(batch);
      case "rateLimited": {
        const wait = Math.min(Math.max(result.retryAfterMs, 0), RATE_LIMIT_MAX_MS);
        this.rateLimitedUntil = Date.now() + wait;
        gatewayPublisherLog.warn(
          `Gateway rate-limited; pausing ${wait}ms (batch of ${batch.length} requeued)`,
        );
        return { requeue: batch.slice() };
      }
      case "error":
        this.recordFailure();
        gatewayPublisherLog.error(
          `Publish failed (${batch.length} events requeued): ${result.message}`,
        );
        return { requeue: batch.slice() };
    }
  }

  private async splitAndSend(batch: AuditEvent[]): Promise<{ requeue: AuditEvent[] }> {
    const half = Math.floor(batch.length / 2);
    const first = batch.slice(0, half);
    const second = batch.slice(half);
    // Deliver each half independently and track which one failed. If the
    // second half is rate-limited or errors, only the second half is
    // requeued — the first half was already accepted by the gateway, so
    // re-sending it would needlessly load the dedupe path (and would also
    // burn a retry slot if the gateway has a transient bug only on the
    // second half).
    const first_out = await this.sendWithSplit(first);
    if (first_out.requeue.length > 0) {
      // First half didn't fully succeed. Don't even try the second half yet —
      // the publisher is likely paused / rate-limited / circuit-tripped, so
      // attempting more sends just races the backoff window. Requeue both.
      return { requeue: [...first_out.requeue, ...second] };
    }
    const second_out = await this.sendWithSplit(second);
    return { requeue: second_out.requeue };
  }

  /**
   * Build the JSON payload for one POST per the SMT-envelope contract.
   * Each event is projected to the gateway's DTO shape — `orgId` and
   * `syncedAt` are dropped (gateway `forbidNonWhitelisted` rejects unknown
   * fields), and the local-only `contentHash`/`previousHash` chain is
   * replaced with the SMT-leaf `rawHash` + `censoredHash` the gateway
   * recomputes server-side. When a DE-anchored checkpoint fully covers
   * the batch's highest sequence, it's attached as the optional
   * `smtCheckpoint` envelope field.
   *
   * Returns a tagged result so the caller can distinguish:
   *  - `ok` → POST the body
   *  - `oversize` → serialized batch exceeds maxPayloadBytes; route to splitAndSend
   *  - `drop` → permanent failure (e.g. machineId mismatch); drop the batch
   *    without requeue rather than retrying forever.
   */
  private buildPayload(batch: AuditEvent[]):
    | { kind: "ok"; body: string }
    | { kind: "oversize" }
    | { kind: "drop"; reason: string }
  {
    const machineId = batch[0].machineId;
    // Single-machineId-per-batch invariant: an AuditStore instance has one
    // machineId, and the rate-limiter never intermingles events from
    // multiple stores. Enforce it explicitly so a future refactor (multi-
    // tenant test rig, replay tooling) can't silently produce envelopes
    // whose top-level machineId doesn't match individual events. This is a
    // permanent invariant violation, not transient — drop rather than retry.
    for (const event of batch) {
      if (event.machineId !== machineId) {
        return {
          kind: "drop",
          reason: `batch mixes machineIds (envelope=${machineId}, event=${event.machineId})`,
        };
      }
    }
    const events = batch.map((event) => {
      const { rawHash, censoredHash } = this.cfg.computeHashes(event);
      return {
        id: event.id,
        sequence: event.sequence,
        source: event.source,
        machineId: event.machineId,
        sessionId: event.sessionId,
        userId: event.userId,
        eventType: event.eventType,
        category: event.category,
        description: event.description,
        metadata: event.metadata,
        content: event.content,
        rawHash,
        censoredHash,
        createdAt: event.createdAt,
        receivedAt: event.receivedAt,
      };
    });

    let smtCheckpoint: SmtCheckpointPayload | undefined;
    const lookup = this.cfg.latestAnchoredCheckpoint;
    if (lookup) {
      const maxSeq = Math.max(...batch.map((e) => e.sequence));
      smtCheckpoint = lookup(maxSeq) ?? undefined;
    }

    const envelope = smtCheckpoint
      ? { machineId, events, smtCheckpoint }
      : { machineId, events };
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body, "utf8") > this.cfg.maxPayloadBytes) {
      return { kind: "oversize" };
    }
    return { kind: "ok", body };
  }

  private async send(body: string): Promise<SendResult> {
    let response: Response;
    try {
      response = await fetch(this.cfg.ingestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Api-Key": this.cfg.apiKey,
        },
        body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { kind: "error", message };
    }

    if (response.ok) {
      const parsed = await this.safeParseJson(response);
      const accepted = typeof parsed?.accepted === "number" ? parsed.accepted : 0;
      const duplicateCount = typeof parsed?.duplicateCount === "number"
        ? parsed.duplicateCount
        : (typeof parsed?.deduped === "number" ? parsed.deduped : 0);
      const highestSequence = typeof parsed?.highestSequence === "number"
        ? parsed.highestSequence
        : undefined;
      return { kind: "ok", accepted, duplicateCount, highestSequence };
    }

    if (response.status === 429) {
      const parsed = await this.safeParseJson(response);
      const retryAfterMs = typeof parsed?.retryAfterMs === "number"
        ? parsed.retryAfterMs
        : this.parseRetryAfterHeader(response.headers.get("retry-after"));
      return { kind: "rateLimited", retryAfterMs: retryAfterMs ?? 30_000 };
    }

    if (response.status === 413) {
      // Drain body for connection reuse but ignore the parsed shape.
      await this.safeParseJson(response);
      return { kind: "payloadTooLarge" };
    }

    // Surface the response body in the error so contract drift (400 from a
    // schema mismatch, 401 from a bad key, etc.) self-explains without a
    // round-trip through gateway logs. Bounded to keep log lines sane.
    // Sanitization: a compromised/misbehaving gateway can stuff CR/LF or
    // ANSI escapes into the body and forge fake log lines downstream — we
    // strip control chars and slice by *bytes* (not chars) so 4-byte emoji
    // can't blow the budget.
    const errBody = await this.readResponseBodySafe(response);
    const suffix = errBody ? `: ${sanitizeForLog(errBody, 500)}` : "";
    return { kind: "error", message: `Gateway returned ${response.status} ${response.statusText}${suffix}` };
  }

  private async readResponseBodySafe(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  private async safeParseJson(response: Response): Promise<Record<string, unknown> | undefined> {
    try {
      const text = await response.text();
      if (text.length === 0) return undefined;
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  // `Retry-After: <seconds>` per RFC 7231. HTTP-date form (RFC 1123) is rare
  // for 429 and not supported here; gateways that need precision should use
  // the spec's `retryAfterMs` body field instead.
  private parseRetryAfterHeader(raw: string | null): number | undefined {
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.floor(seconds * 1000);
  }

  isPaused(): boolean {
    return this.isCircuitOpen() || Date.now() < this.rateLimitedUntil;
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

  if (typeof deps.computeHashes !== "function") {
    return new NoOpGatewayPublisher(
      "computeHashes dep missing — gateway requires rawHash/censoredHash on every event",
    );
  }

  // Surface http:// (cleartext) misconfiguration loudly even when allowed (loopback dev).
  if (url.toLowerCase().startsWith("http://")) {
    gatewayPublisherLog.warn(
      "gatewayUrl uses http:// — API key will be transmitted in cleartext (allowed only because host is loopback)",
    );
  }

  const ingestUrl = url.replace(/\/+$/, "") + INGEST_PATH;
  // batchSize is both floor- and ceiling-clamped: floor protects against 0/0.5
  // (would spin), ceiling enforces the spec's 100-event cap so a misconfigured
  // gatewayBatchSize can never produce a batch the gateway will 413-reject.
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    clampNumber(config.gatewayBatchSize, MIN_BATCH_SIZE, DEFAULT_BATCH_SIZE),
  );
  const intervalMs = clampNumber(config.gatewayIntervalMs, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const timeoutMs = clampNumber(config.gatewayTimeoutMs, MIN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const bufferCapacity = clampNumber(config.gatewayBufferCapacity, MIN_BUFFER_CAPACITY, DEFAULT_BUFFER_CAPACITY);
  const shutdownDeadlineMs = clampNumber(
    config.gatewayShutdownDeadlineMs, MIN_SHUTDOWN_DEADLINE_MS, DEFAULT_SHUTDOWN_DEADLINE_MS,
  );
  const maxPayloadBytes = clampNumber(
    config.gatewayMaxPayloadBytes, MIN_MAX_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD_BYTES,
  );

  return new ActiveGatewayPublisher({
    ingestUrl,
    apiKey,
    batchSize,
    intervalMs,
    timeoutMs,
    bufferCapacity,
    shutdownDeadlineMs,
    maxPayloadBytes,
    computeHashes: deps.computeHashes,
    latestAnchoredCheckpoint: deps.latestAnchoredCheckpoint,
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
    && !publisher.isPaused()
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
      : publisher.isPaused()
        ? "rate-limited"
        : Date.now() >= deadline
          ? "shutdown deadline reached"
          : "iteration cap reached";
    gatewayPublisherLog.warn(
      `abandoning ${remaining} buffered event(s) on shutdown — ${reason}`,
    );
  }
}
