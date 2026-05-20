import type { AuditStore } from "../store/audit-store.js";
import {log} from "../util/logger.js";

const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_MAX_SIZE_MB = 500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface RetentionHealth {
  /** ISO timestamp of the next scheduled prune tick, or undefined if not started. */
  nextPruneAt: string | undefined;
  /** Configured retention window in days (used as the time-based prune cutoff). */
  retentionDays: number;
  /** Configured DB size cap in MiB (used as the size-based prune trigger). */
  maxSizeMb: number;
}

export const RETENTION_HEALTH_NAME = "retention";

export class RetentionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private store: AuditStore;
  private retentionDays: number;
  private maxSizeMb: number;
  private _nextPruneAt: Date | undefined;

  constructor(
    store: AuditStore,
    config: Record<string, unknown> = {},
  ) {
    this.store = store;
    this.retentionDays =
      typeof config.localRetentionDays === "number" ? config.localRetentionDays : DEFAULT_RETENTION_DAYS;
    this.maxSizeMb =
      typeof config.localMaxSizeMb === "number" ? config.localMaxSizeMb : DEFAULT_MAX_SIZE_MB;
  }

  start(): void {
    this.runPrune();
    this.timer = setInterval(() => this.runPrune(), PRUNE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  nextPruneAt(): string | undefined {
    return this._nextPruneAt?.toISOString();
  }

  health(): RetentionHealth {
    return {
      nextPruneAt: this.nextPruneAt(),
      retentionDays: this.retentionDays,
      maxSizeMb: this.maxSizeMb,
    };
  }

  private runPrune(): void {
    this._nextPruneAt = new Date(Date.now() + PRUNE_INTERVAL_MS);
    try {
      const deleted = this.store.prune(this.retentionDays, this.maxSizeMb);
      if (deleted > 0) {
        log.info(`Pruned ${deleted} expired events`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`Retention prune failed: ${message}`);
    }
    try {
      this.store.upsertServiceHealth(RETENTION_HEALTH_NAME, this.health());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log.warn(`failed to persist retention service_health: ${msg}`);
    }
  }
}
