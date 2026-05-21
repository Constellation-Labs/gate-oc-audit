import type { AuditStore } from "../store/audit-store.js";
import type { TimeZoneMode } from "../reports/time-window.js";
import {
  parseDate,
  parseWeek,
  subtractCalendarDays,
  todayInTz,
  thisWeekInTz,
} from "../reports/time-window.js";
import type { AuditProjection } from "../reports/projection.js";
import { buildProjection } from "../reports/projection.js";
import { formatDigestBlocks } from "../reports/format-blocks.js";
import { isUnsafeWebhookUrl, postJsonWebhook } from "../util/webhook.js";
import { log } from "../util/logger.js";
import { createHash } from "node:crypto";

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const POST_TIMEOUT_MS = 10_000;

export const REPORT_PUSHER_HEALTH_NAME = "report-pusher";

export interface ReportPusherHealth {
  /** Next instant a daily push will fire (ISO 8601). Computed on demand. */
  nextDailyAt: string;
  /** Next instant a weekly push will fire (ISO 8601). Computed on demand. */
  nextWeeklyAt: string;
  /** ISO of the most recent successful push (daily or weekly). */
  lastPushAt: string | undefined;
  /** Last daily-phase error message; cleared when a daily push succeeds.
   *  Kept separate from weekly so a successful weekly doesn't mask a daily
   *  failure (and vice versa). */
  lastDailyError: string | undefined;
  /** Last weekly-phase error message; cleared when a weekly push succeeds. */
  lastWeeklyError: string | undefined;
  /** YYYY-MM-DD of the last reported daily window, or undefined if none yet. */
  lastDailyReportedDate: string | undefined;
  /** YYYY-Www of the last reported weekly window, or undefined if none yet. */
  lastWeeklyReportedWeek: string | undefined;
}

/** In-memory state — what we mutate. `next*At` are derived in `health()`,
 *  not stored, so there's no cache to keep in sync. */
type ReportPusherState = Omit<ReportPusherHealth, "nextDailyAt" | "nextWeeklyAt">;

export interface ReportPusherOptions {
  /** Time zone for calendar-boundary math. Defaults to "local". */
  tz?: TimeZoneMode;
  /** Override for tests. */
  tickIntervalMs?: number;
  /** Override for tests. */
  retryDelayMs?: number;
  /** Override for tests — clock source. */
  now?: () => Date;
  /** Openclaw root used to populate `cron.configured`. Omit to keep
   *  configured cron manifests out of webhook payloads. */
  openclawDir?: string;
  /** Allow posting digests to a private/link-local host. Off by default;
   *  gates the same SSRF policy the gateway publisher applies. */
  allowPrivateHost?: boolean;
}

/**
 * Push daily / weekly audit projections to a webhook on calendar boundaries.
 *
 * Cadence: a tick every 5 minutes checks "has the most-recently-completed
 * day (resp. week) changed since the last successful push?" If yes, build
 * the projection for that window and POST it. Poll-and-check (vs.
 * `setTimeout` to the exact boundary) is deliberately resilient to laptop
 * sleep / clock jumps — a missed midnight is detected on the next tick
 * after resume rather than slept through.
 *
 * Channel separation from NotificationService is intentional (PRD R13):
 * incident pokes and periodic digests go to different webhooks so operators
 * can route them independently.
 */
export class ReportPusherService {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Recreated in `start()` so a stop/start cycle works (the field-init
   *  controller is aborted by `stop()` and would otherwise stay aborted). */
  private abortController = new AbortController();
  /** Re-entrancy guard: setInterval doesn't serialize async handlers, and a
   *  retry sleep can push a tick past the next interval boundary. */
  private inFlightTick = false;
  private state: ReportPusherState = {
    lastPushAt: undefined,
    lastDailyError: undefined,
    lastWeeklyError: undefined,
    lastDailyReportedDate: undefined,
    lastWeeklyReportedWeek: undefined,
  };
  private disabled = false;
  private readonly tz: TimeZoneMode;
  private readonly tickIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;
  private readonly openclawDir: string | undefined;

  constructor(
    private store: AuditStore,
    private webhookUrl: string | undefined,
    opts: ReportPusherOptions = {},
  ) {
    this.tz = opts.tz ?? "local";
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
    this.openclawDir = opts.openclawDir;

    if (!this.webhookUrl) {
      this.disabled = true;
      return;
    }
    const reason = isUnsafeWebhookUrl(this.webhookUrl, { allowPrivateHost: opts.allowPrivateHost === true });
    if (reason) {
      log.warn(`reportWebhook URL rejected (${reason}); digest push disabled`);
      this.webhookUrl = undefined;
      this.disabled = true;
    }
  }

  start(): void {
    if (this.disabled) return;
    if (this.timer) return; // idempotent — second start() is a no-op.
    // Reset the abort signal so a prior stop()'s abort doesn't bleed into
    // this run and short-circuit every retry sleep on the first try.
    this.abortController = new AbortController();
    // Restore persisted markers first so a hot reload / openclaw re-register
    // doesn't re-push the previous calendar day on the first tick. After
    // restore the markers either match the persisted state or fall back
    // to "yesterday/last week" for a fresh install — anything earlier is
    // treated as a missed report and only the most-recent missed window
    // is pushed (no backfill spam after a long downtime).
    this.restoreState();
    if (this.state.lastDailyReportedDate === undefined) {
      this.state.lastDailyReportedDate = this.dayMostRecentlyCompleted();
    }
    if (this.state.lastWeeklyReportedWeek === undefined) {
      this.state.lastWeeklyReportedWeek = this.weekMostRecentlyCompleted();
    }
    this.persist();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abortController.abort();
  }

  health(): ReportPusherHealth {
    // Computing next-fire times on demand keeps `health()` consistent with
    // the wall clock even when the last tick was a while ago.
    return {
      ...this.state,
      nextDailyAt: this.computeNextDailyAt(),
      nextWeeklyAt: this.computeNextWeeklyAt(),
    };
  }

  /** Public for tests — runs one tick synchronously. */
  async tick(): Promise<void> {
    if (this.disabled || !this.webhookUrl) return;
    if (this.abortController.signal.aborted) return;
    if (this.inFlightTick) return;
    this.inFlightTick = true;
    try {
      // Daily and weekly are independent reports — a failure in one must
      // not suppress the other. Per-phase try/catch keeps them isolated;
      // per-phase error fields (`lastDailyError` / `lastWeeklyError`) keep
      // a success in one phase from clobbering the other's failure.
      await this.runPhase("daily", async () => {
        const targetDay = this.dayMostRecentlyCompleted();
        if (this.state.lastDailyReportedDate !== targetDay) {
          await this.fireDaily(targetDay);
        }
      });
      await this.runPhase("weekly", async () => {
        const targetWeek = this.weekMostRecentlyCompleted();
        if (this.state.lastWeeklyReportedWeek !== targetWeek) {
          await this.fireWeekly(targetWeek);
        }
      });
    } finally {
      // Clear the re-entrancy flag *first* so a throw from `persist()` (or
      // any future finally work) can't strand the service in a permanently
      // "in flight" state. persist() has its own try/catch.
      this.inFlightTick = false;
      this.persist();
    }
  }

  private async runPhase(label: "daily" | "weekly", fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // An abort isn't an error — stop() was called, the in-flight retry
      // resolved with aborted=true, and any further throw shape we add
      // later (e.g. signal.throwIfAborted) should not be surfaced as a
      // push failure to the operator.
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = sanitizeMessage(err instanceof Error ? err.message : "Unknown error");
      log.error(`reportWebhook ${label} tick failed: ${msg}`);
      this.setPhaseError(label, msg);
    }
  }

  private async fireDaily(date: string): Promise<void> {
    const window = parseDate(date, this.tz);
    // Sanitize before formatting so neither the chat blocks nor the JSON
    // arm can leak raw recipients — even if a future change adds recipient
    // rendering to format-blocks, both sides see the hashed value.
    const sanitized = sanitizeProjectionForWebhook(buildProjection(this.store, window, { openclawDir: this.openclawDir }));
    const payload = { ...formatDigestBlocks(sanitized), projection: sanitized };
    const result = await this.postWithRetry(payload);
    if (result.ok) {
      this.state.lastDailyReportedDate = date;
      this.state.lastDailyError = undefined;
    } else if (result.error) {
      this.state.lastDailyError = result.error;
    }
  }

  private async fireWeekly(week: string): Promise<void> {
    const window = parseWeek(week, this.tz);
    const sanitized = sanitizeProjectionForWebhook(buildProjection(this.store, window, { openclawDir: this.openclawDir }));
    const payload = { ...formatDigestBlocks(sanitized), projection: sanitized };
    const result = await this.postWithRetry(payload);
    if (result.ok) {
      this.state.lastWeeklyReportedWeek = week;
      this.state.lastWeeklyError = undefined;
    } else if (result.error) {
      this.state.lastWeeklyError = result.error;
    }
  }

  /** One immediate attempt + one delayed retry on transient failure.
   *  Returns the outcome; the caller decides which phase field to update. */
  private async postWithRetry(payload: unknown): Promise<{ ok: boolean; error?: string }> {
    if (!this.webhookUrl) return { ok: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.abortController.signal.aborted) return { ok: false };
      const result = await postJsonWebhook(this.webhookUrl, payload, { timeoutMs: POST_TIMEOUT_MS });
      if (result.ok) {
        this.state.lastPushAt = this.now().toISOString();
        return { ok: true };
      }
      const errMsg = result.status !== undefined
        ? `webhook ${result.status}: ${result.error}`
        : `webhook failed: ${result.error}`;
      if (attempt === 0) {
        log.warn(`reportWebhook attempt failed (${errMsg}); retrying in ${this.retryDelayMs}ms`);
        const aborted = await this.delayOrAbort(this.retryDelayMs);
        if (aborted) return { ok: false };
        continue;
      }
      log.error(`reportWebhook gave up after retry: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
    return { ok: false };
  }

  private setPhaseError(label: "daily" | "weekly", msg: string): void {
    if (label === "daily") this.state.lastDailyError = msg;
    else this.state.lastWeeklyError = msg;
  }

  /** Returns true if the wait was cut short by abort. */
  private delayOrAbort(ms: number): Promise<boolean> {
    const signal = this.abortController.signal;
    if (signal.aborted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      t.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Most recently completed calendar day in the configured tz, returned as
   * YYYY-MM-DD. At 2026-05-18T08:00 local this is "2026-05-17".
   */
  private dayMostRecentlyCompleted(): string {
    const todayWindow = parseDate(todayInTz(this.tz, this.now()), this.tz);
    const yesterdayIso = subtractCalendarDays(todayWindow.fromIso, 1, this.tz);
    return todayInTz(this.tz, new Date(yesterdayIso));
  }

  /**
   * Most recently completed ISO week in the configured tz as YYYY-Www. If
   * called on Monday 00:30 local, returns last week.
   */
  private weekMostRecentlyCompleted(): string {
    const thisWeekWindow = parseWeek(thisWeekInTz(this.tz, this.now()), this.tz);
    // Step back one calendar day from this week's Mon 00:00 to land inside
    // the previous ISO week, then ask which week that instant is in.
    // `subtractCalendarDays` is DST-correct in both tz modes.
    const lastWeekIso = subtractCalendarDays(thisWeekWindow.fromIso, 1, this.tz);
    return thisWeekInTz(this.tz, new Date(lastWeekIso));
  }

  private computeNextDailyAt(): string {
    return parseDate(todayInTz(this.tz, this.now()), this.tz).toIso;
  }

  private computeNextWeeklyAt(): string {
    return parseWeek(thisWeekInTz(this.tz, this.now()), this.tz).toIso;
  }

  private persist(): void {
    // Persist the same shape `health()` returns so the row stays consistent
    // with the live getter — operators reading service_health see the same
    // next-fire instants the live API would have served.
    try {
      this.store.upsertServiceHealth(REPORT_PUSHER_HEALTH_NAME, this.health());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log.warn(`failed to persist report-pusher service_health: ${msg}`);
    }
  }

  /**
   * Load the persisted state from service_health into this.state. Tolerates
   * a missing row , an unparseable payload, or
   * any field of the wrong shape — bad fields fall back to undefined so the
   * caller can initialise them from the calendar instead.
   */
  private restoreState(): void {
    try {
      const row = this.store.getServiceHealth(REPORT_PUSHER_HEALTH_NAME);
      if (!row || typeof row.payload !== "object" || row.payload === null) return;
      const p = row.payload as Record<string, unknown>;
      if (typeof p.lastDailyReportedDate === "string") {
        this.state.lastDailyReportedDate = p.lastDailyReportedDate;
      }
      if (typeof p.lastWeeklyReportedWeek === "string") {
        this.state.lastWeeklyReportedWeek = p.lastWeeklyReportedWeek;
      }
      if (typeof p.lastPushAt === "string") {
        this.state.lastPushAt = p.lastPushAt;
      }
      if (typeof p.lastDailyError === "string") {
        this.state.lastDailyError = p.lastDailyError;
      }
      if (typeof p.lastWeeklyError === "string") {
        this.state.lastWeeklyError = p.lastWeeklyError;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log.warn(`failed to restore report-pusher service_health: ${msg}`);
    }
  }
}

/**
 * Strip recipient identifiers from the projection before it leaves the
 * machine. For SMS/email/Telegram channels the raw `recipient` field is PII
 * (phone numbers, addresses, @handles); the audit DB has them locally for
 * the CLI `audit report`, but the webhook is a network-trust boundary.
 *
 * Hashing — not removing — preserves correlation ("same recipient as last
 * week") while making the value non-reversible.
 */
function sanitizeProjectionForWebhook(p: AuditProjection): AuditProjection {
  if (p.anomalies.duplicateOutbound.length === 0) return p;
  return {
    ...p,
    anomalies: {
      ...p.anomalies,
      duplicateOutbound: p.anomalies.duplicateOutbound.map((d) => ({
        ...d,
        recipient: hashRecipient(d.recipient),
      })),
    },
  };
}

function hashRecipient(recipient: string): string {
  return "sha256:" + createHash("sha256").update(recipient).digest("hex").slice(0, 16);
}

/** Strip CR/LF and cap length so a hostile webhook server can't inject
 *  log/header garbage via response.statusText or error.message. */
function sanitizeMessage(s: string): string {
  return s.replace(/[\r\n\t]/g, " ").slice(0, 200);
}
