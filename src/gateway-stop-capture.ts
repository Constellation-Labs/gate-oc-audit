import type { AuditStore } from "./store/audit-store.js";

/**
 * Captures the `gateway.stop` audit event reliably across openclaw shutdown
 * timing variability.
 *
 * Two paths converge here:
 *
 *   - Hook path: openclaw's `gateway_stop` plugin hook (preferred). Carries
 *     the daemon's own `reason` string and runs through the rate limiter so
 *     SMT/anchor side-effects fire. Used when openclaw's async shutdown
 *     reaches `runGlobalGatewayStopSafely` before the process exits.
 *
 *   - Signal path: `process.once("SIGTERM"/"SIGINT")` fallback. Runs
 *     synchronously inside the signal callback before any await yields, so
 *     the row lands in the WAL even when openclaw's async shutdown is
 *     preempted (observed in CI: container can exit ~250ms after SIGTERM
 *     with no further log lines past "received SIGTERM; shutting down").
 *     Bypasses the limiter to write straight to the store.
 *
 * `tryClaim()` deduplicates: whichever path runs first writes the row, the
 * other returns without writing.
 */
export class GatewayStopCapture {
  private recorded = false;
  private sigtermHandler: (() => void) | undefined;
  private sigintHandler: (() => void) | undefined;

  constructor(private readonly store: AuditStore) {}

  /**
   * Reserve the gateway.stop slot. Returns true on the first call (caller
   * should write the row), false thereafter.
   */
  tryClaim(): boolean {
    if (this.recorded) return false;
    this.recorded = true;
    return true;
  }

  /**
   * Attach SIGTERM/SIGINT listeners. Idempotent — safe to call repeatedly,
   * including across openclaw plugin re-registrations against fresh api
   * instances; only the first call attaches listeners.
   */
  installSignalFallback(): void {
    if (this.sigtermHandler) return;
    this.sigtermHandler = () => this.captureSignal("SIGTERM");
    this.sigintHandler = () => this.captureSignal("SIGINT");
    process.once("SIGTERM", this.sigtermHandler);
    process.once("SIGINT", this.sigintHandler);
  }

  /**
   * Detach process listeners. Production doesn't need this — the daemon
   * exits once shutdown completes. Tests reuse the process across cases and
   * use this to avoid listener accumulation pointing at closed stores.
   */
  detachSignalListeners(): void {
    if (this.sigtermHandler) process.off("SIGTERM", this.sigtermHandler);
    if (this.sigintHandler) process.off("SIGINT", this.sigintHandler);
    this.sigtermHandler = undefined;
    this.sigintHandler = undefined;
  }

  private captureSignal(signal: "SIGTERM" | "SIGINT"): void {
    if (!this.tryClaim()) return;
    try {
      this.store.append({
        eventType: "gateway.stop",
        category: "gateway",
        description: `Gateway stopped: ${signal}`,
        metadata: { reason: signal },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] failed to record gateway.stop on signal:", msg);
    }
  }
}
