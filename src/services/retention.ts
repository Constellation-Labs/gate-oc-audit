import type { AuditStore } from "../store/audit-store.js";

const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_MAX_SIZE_MB = 500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class RetentionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private store: AuditStore;
  private retentionDays: number;
  private maxSizeMb: number;

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

  private runPrune(): void {
    try {
      const deleted = this.store.prune(this.retentionDays, this.maxSizeMb);
      if (deleted > 0) {
        console.info(`[audit-plugin] Pruned ${deleted} expired events`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] Retention prune failed:", message);
    }
  }
}
