import type { AuditStore } from "../store/audit-store.js";
import type { TimeZoneMode } from "../reports/time-window.js";
import {
  parseDate,
  parseWeek,
  subtractCalendarDays,
  todayInTz,
  thisWeekInTz,
} from "../reports/time-window.js";
import { buildProjection } from "../reports/projection.js";
import { formatDigestBlocks } from "../reports/format-blocks.js";
import { isUnsafeWebhookUrl, postJsonWebhook } from "../util/webhook.js";
import { log } from "../util/logger.js";

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const POST_TIMEOUT_MS = 10_000;

export const REPORT_PUSHER_HEALTH_NAME = "report-pusher";

export interface ReportPusherHealth {
  /** Next instant a daily push will fire (ISO 8601). */
  nextDailyAt: string | undefined;
  /** Next instant a weekly push will fire (ISO 8601). */
  nextWeeklyAt: string | undefined;
  /** ISO of the most recent successful push (daily or weekly). */
  lastPushAt: string | undefined;
  /** Last error message; cleared on success. */
  lastPushError: string | undefined;
  /** YYYY-MM-DD of the last reported daily window, or undefined if none yet. */
  lastDailyReportedDate: string | undefined;
  /** YYYY-Www of the last reported weekly window, or undefined if none yet. */
  lastWeeklyReportedWeek: string | undefined;
}

export interface ReportPusherOptions {
  /** Time zone for calendar-boundary math. Defaults to "local". */
  tz?: TimeZoneMode;
  /** Override for tests. */
  tickIntervalMs?: number;
  /** Override for tests. */
  retryDelayMs?: number;
  /** Override for tests — clock source. */
  now?: () => Date;
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
  private abortController = new AbortController();
  private state: ReportPusherHealth = {
    nextDailyAt: undefined,
    nextWeeklyAt: undefined,
    lastPushAt: undefined,
    lastPushError: undefined,
    lastDailyReportedDate: undefined,
    lastWeeklyReportedWeek: undefined,
  };
  private disabled = false;
  private readonly tz: TimeZoneMode;
  private readonly tickIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;

  constructor(
    private store: AuditStore,
    private webhookUrl: string | undefined,
    opts: ReportPusherOptions = {},
  ) {
    this.tz = opts.tz ?? "local";
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.now = opts.now ?? (() => new Date());

    if (!this.webhookUrl) {
      this.disabled = true;
      return;
    }
    const reason = isUnsafeWebhookUrl(this.webhookUrl);
    if (reason) {
      log.warn(`reportWebhook URL rejected (${reason}); digest push disabled`);
      this.webhookUrl = undefined;
      this.disabled = true;
    }
  }

  start(): void {
    if (this.disabled) return;
    // Initialise the "last reported" markers to *yesterday/last week* so the
    // first tick doesn't immediately push a stale window. Anything earlier
    // than this is treated as a missed report and only the most recent
    // missed window is pushed (no backfill spam after a long downtime).
    this.state.lastDailyReportedDate = this.dayMostRecentlyCompleted();
    this.state.lastWeeklyReportedWeek = this.weekMostRecentlyCompleted();
    this.refreshNextFireTimes();
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
    return { ...this.state };
  }

  /** Public for tests — runs one tick synchronously. */
  async tick(): Promise<void> {
    if (this.disabled || !this.webhookUrl) return;
    if (this.abortController.signal.aborted) return;

    try {
      const targetDay = this.dayMostRecentlyCompleted();
      if (this.state.lastDailyReportedDate !== targetDay) {
        await this.fireDaily(targetDay);
      }
      const targetWeek = this.weekMostRecentlyCompleted();
      if (this.state.lastWeeklyReportedWeek !== targetWeek) {
        await this.fireWeekly(targetWeek);
      }
    } finally {
      this.refreshNextFireTimes();
      this.persist();
    }
  }

  private async fireDaily(date: string): Promise<void> {
    const window = parseDate(date, this.tz);
    const projection = buildProjection(this.store, window);
    const payload = {
      ...formatDigestBlocks(projection),
      projection,
    };
    const ok = await this.postWithRetry(payload);
    if (ok) this.state.lastDailyReportedDate = date;
  }

  private async fireWeekly(week: string): Promise<void> {
    const window = parseWeek(week, this.tz);
    const projection = buildProjection(this.store, window);
    const payload = {
      ...formatDigestBlocks(projection),
      projection,
    };
    const ok = await this.postWithRetry(payload);
    if (ok) this.state.lastWeeklyReportedWeek = week;
  }

  /** One immediate attempt + one delayed retry on transient failure. */
  private async postWithRetry(payload: unknown): Promise<boolean> {
    if (!this.webhookUrl) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.abortController.signal.aborted) return false;
      const result = await postJsonWebhook(this.webhookUrl, payload, { timeoutMs: POST_TIMEOUT_MS });
      if (result.ok) {
        this.state.lastPushAt = this.now().toISOString();
        this.state.lastPushError = undefined;
        return true;
      }
      const errMsg = result.status !== undefined
        ? `webhook ${result.status}: ${result.error}`
        : `webhook failed: ${result.error}`;
      this.state.lastPushError = errMsg;
      if (attempt === 0) {
        log.warn(`reportWebhook attempt failed (${errMsg}); retrying in ${this.retryDelayMs}ms`);
        const aborted = await this.delayOrAbort(this.retryDelayMs);
        if (aborted) return false;
        continue;
      }
      log.error(`reportWebhook gave up after retry: ${errMsg}`);
      return false;
    }
    return false;
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
    const todayStr = todayInTz(this.tz, this.now());
    // Subtract one calendar day from "today 00:00" to land on yesterday.
    const today = parseDate(todayStr, this.tz);
    const yesterdayIso = subtractCalendarDays(today.fromIso, 1, this.tz);
    return formatYmd(new Date(yesterdayIso), this.tz);
  }

  /**
   * Most recently completed ISO week in the configured tz as YYYY-Www. If
   * called on Monday 00:30 local, returns last week.
   */
  private weekMostRecentlyCompleted(): string {
    const thisWeek = thisWeekInTz(this.tz, this.now());
    const w = parseWeek(thisWeek, this.tz);
    // Step back one day from this week's start (Mon 00:00) to land in the
    // previous ISO week, then ask which week that instant is in.
    const lastWeekInside = new Date(new Date(w.fromIso).getTime() - 86_400_000);
    return weekStringFor(lastWeekInside, this.tz);
  }

  private refreshNextFireTimes(): void {
    // Next daily fire = next local 00:00 strictly after now.
    const todayStr = todayInTz(this.tz, this.now());
    const todayWindow = parseDate(todayStr, this.tz);
    this.state.nextDailyAt = todayWindow.toIso;

    // Next weekly fire = next local Monday 00:00 strictly after now.
    const thisWeek = thisWeekInTz(this.tz, this.now());
    const thisWeekWindow = parseWeek(thisWeek, this.tz);
    this.state.nextWeeklyAt = thisWeekWindow.toIso;
  }

  private persist(): void {
    try {
      this.store.upsertServiceHealth(REPORT_PUSHER_HEALTH_NAME, this.state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log.warn(`failed to persist report-pusher service_health: ${msg}`);
    }
  }
}

function formatYmd(d: Date, tz: TimeZoneMode): string {
  if (tz === "utc") {
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function weekStringFor(d: Date, tz: TimeZoneMode): string {
  const t = tz === "utc"
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (tz === "utc" ? t.getUTCDay() : t.getDay()) || 7;
  if (tz === "utc") t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  else t.setDate(t.getDate() + 4 - dayNum);
  const year = tz === "utc" ? t.getUTCFullYear() : t.getFullYear();
  const yearStart = tz === "utc" ? new Date(Date.UTC(year, 0, 1)) : new Date(year, 0, 1);
  const diffMs = t.getTime() - yearStart.getTime();
  const week = Math.ceil((diffMs / 86_400_000 + 1) / 7);
  return `${year}-W${pad2(week)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
