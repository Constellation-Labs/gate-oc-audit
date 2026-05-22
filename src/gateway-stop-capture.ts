import type { AuditStore } from "./store/audit-store.js";
import type { SmtService } from "./services/smt-service.js";
import {log} from "./util/logger.js";

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
 *     Bypasses the rate limiter (so its async side-effects — gateway publish,
 *     DE anchor — don't try to run inside a synchronous signal callback), but
 *     still feeds the result into `SmtService.onEventAppended` so the leaf is
 *     present in the in-memory SMT before `SmtService.stop` checkpoints it
 *     to disk. The later async services (de-anchor) pick
 *     the row up on next startup via their own replay/backfill paths.
 *
 * `tryClaim()` deduplicates: whichever path runs first writes the row, the
 * other returns without writing.
 */
export class GatewayStopCapture {
  private recorded = false;
  private sigtermHandler: (() => void) | undefined;
  private sigintHandler: (() => void) | undefined;
  private smtService: SmtService | undefined;

  constructor(private readonly store: AuditStore) {}

  /**
   * Wire the SMT service so the signal-path write also updates the
   * in-memory tree. Optional — without it, the row only enters the SMT via
   * the next plugin start's replay path.
   */
  setSmtService(smt: SmtService): void {
    this.smtService = smt;
  }

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
   * instances. Each signal is gated independently so a re-call after one
   * signal has already fired (and Node auto-removed its `once` listener)
   * re-attaches that signal without duplicating the other.
   */
  installSignalFallback(): void {
    if (!this.sigtermHandler) {
      this.sigtermHandler = () => this.captureSignal("SIGTERM");
      process.once("SIGTERM", this.sigtermHandler);
    }
    if (!this.sigintHandler) {
      this.sigintHandler = () => this.captureSignal("SIGINT");
      process.once("SIGINT", this.sigintHandler);
    }
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
    // Shutdown-ordering invariant: the host's stop() chain in index.ts
    // calls detachSignalListeners() BEFORE retention.stop()'s
    // _store.close() runs. So by the time this body executes either the
    // store is still open (signal arrived during steady state) or this
    // listener was never invoked (detach already ran). If you re-order
    // the host stop() chain, preserve that detach-first rule or this
    // method will append against a closed store and surface a confusing
    // error in the SIGTERM/SIGINT log line.
    //
    // Mirror Node's auto-removal of `once` listeners in our own bookkeeping
    // so installSignalFallback() can re-attach this specific signal if it's
    // ever called again on the same instance.
    if (signal === "SIGTERM") this.sigtermHandler = undefined;
    else this.sigintHandler = undefined;
    if (!this.tryClaim()) return;
    try {
      const event = this.store.append({
        eventType: "gateway.stop",
        category: "gateway",
        description: `Gateway stopped: ${signal}`,
        metadata: { reason: signal },
      });
      // Update the in-memory SMT so SmtService.stop's final checkpoint
      // persists the leaf. onEventAppended is fully synchronous and
      // swallows its own errors, so it's safe to call inside the signal
      // callback.
      if (event && this.smtService) {
        this.smtService.onEventAppended(event);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log.error(`failed to record gateway.stop on signal: ${msg}`);
    }
  }
}
