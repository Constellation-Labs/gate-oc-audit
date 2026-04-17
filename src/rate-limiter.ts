import type { AuditStore } from "./store/audit-store.js";
import type { AuditEvent, AuditEventInsert } from "./types/events.js";
import type { AnchorService } from "./services/de-anchor.js";
import type { SmtService } from "./services/smt-service.js";

const DEFAULT_MAX_EVENTS_PER_SEC = 100;
const DEFAULT_BUFFER_CAPACITY = 10_000;
const DRAIN_INTERVAL_MS = 100;

/** Categories preserved at full fidelity even when coalescing. */
const FULL_FIDELITY_CATEGORIES = new Set(["system", "config", "security", "cron"]);

interface CoalescedGroup {
  eventType: string;
  category: string;
  count: number;
  firstDescription: string;
  totalDurationMs: number;
  firstTimestamp: number;
}

export class RateLimiter {
  private store: AuditStore;
  private deAnchor: AnchorService | undefined;
  private smtService: SmtService | undefined;
  private maxPerSec: number;
  private bufferCapacity: number;
  private buffer: AuditEventInsert[] = [];
  private windowEvents = 0;
  private windowStart = Date.now();
  private drainTimer: ReturnType<typeof setInterval> | undefined;

  constructor(store: AuditStore, config: Record<string, unknown> = {}) {
    this.store = store;
    this.maxPerSec = typeof config.rateLimitPerSec === "number"
      ? config.rateLimitPerSec
      : DEFAULT_MAX_EVENTS_PER_SEC;
    this.bufferCapacity = typeof config.rateLimitBufferSize === "number"
      ? config.rateLimitBufferSize
      : DEFAULT_BUFFER_CAPACITY;
    console.info(`[audit-plugin:rate-limiter] Initialized — maxPerSec: ${this.maxPerSec}, bufferCapacity: ${this.bufferCapacity}`);
  }

  setDeAnchor(deAnchor: AnchorService): void {
    this.deAnchor = deAnchor;
  }

  setSmtService(smt: SmtService): void {
    this.smtService = smt;
  }

  append(insert: AuditEventInsert): AuditEvent | undefined {
    const now = Date.now();

    // Reset window if a second has passed
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowEvents = 0;
    }

    // Under threshold: write directly
    if (this.windowEvents < this.maxPerSec && this.buffer.length === 0) {
      this.windowEvents++;
      const result = this.store.append(insert);
      if (result) {
        this.smtService?.onEventAppended(result);
        this.deAnchor?.notifyAppend();
      }
      return result;
    }

    // Over threshold: buffer the event
    if (this.buffer.length === 0) {
      console.warn(`[audit-plugin:rate-limiter] Rate limit hit (${this.windowEvents}/${this.maxPerSec}/s), buffering events`);
    }
    if (this.buffer.length < this.bufferCapacity) {
      this.buffer.push(insert);
    } else {
      // Buffer full — coalesce and drain
      this.coalesceBuffer();
      if (this.buffer.length < this.bufferCapacity) {
        this.buffer.push(insert);
      }
      // If still full after coalescing, drop the event (shouldn't happen in practice)
    }

    // Start drain timer if not running
    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => this.drainBuffer(), DRAIN_INTERVAL_MS);
      this.drainTimer.unref();
    }

    return undefined;
  }

  /** Drain buffered events when throughput drops below limit. */
  private drainBuffer(): void {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowEvents = 0;
    }

    let drained = 0;
    while (drained < this.buffer.length && this.windowEvents < this.maxPerSec) {
      const result = this.store.append(this.buffer[drained]);
      if (result) {
        this.smtService?.onEventAppended(result);
        this.deAnchor?.notifyAppend();
      }
      this.windowEvents++;
      drained++;
    }

    if (drained > 0) {
      this.buffer = this.buffer.slice(drained);
    }

    if (this.buffer.length === 0 && this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  /**
   * Coalesce consecutive tool events in the buffer into summary records.
   * Session, config, security, and cron events are preserved at full fidelity.
   */
  private coalesceBuffer(): void {
    const coalesced: AuditEventInsert[] = [];
    let currentGroup: CoalescedGroup | undefined;
    let groupInserts: AuditEventInsert[] = [];

    for (const insert of this.buffer) {
      // Full-fidelity categories are never coalesced
      if (FULL_FIDELITY_CATEGORIES.has(insert.category)) {
        if (currentGroup && groupInserts.length > 0) {
          coalesced.push(this.flushGroup(currentGroup, groupInserts));
          currentGroup = undefined;
          groupInserts = [];
        }
        coalesced.push(insert);
        continue;
      }

      // Same event type — accumulate into group
      if (currentGroup && currentGroup.eventType === insert.eventType) {
        currentGroup.count++;
        const dur = (insert.metadata?.durationMs as number) ?? 0;
        currentGroup.totalDurationMs += dur;
        groupInserts.push(insert);
        continue;
      }

      // Different event type — flush previous group
      if (currentGroup && groupInserts.length > 0) {
        coalesced.push(this.flushGroup(currentGroup, groupInserts));
      }

      // Start new group
      const dur = (insert.metadata?.durationMs as number) ?? 0;
      currentGroup = {
        eventType: insert.eventType,
        category: insert.category,
        count: 1,
        firstDescription: insert.description,
        totalDurationMs: dur,
        firstTimestamp: Date.now(),
      };
      groupInserts = [insert];
    }

    // Flush final group
    if (currentGroup && groupInserts.length > 0) {
      coalesced.push(this.flushGroup(currentGroup, groupInserts));
    }

    this.buffer = coalesced;
  }

  private flushGroup(group: CoalescedGroup, inserts: AuditEventInsert[]): AuditEventInsert {
    // Single event — no coalescing needed
    if (inserts.length === 1) return inserts[0];

    // Multiple events — create summary
    const durationStr = group.totalDurationMs > 0
      ? `, ${(group.totalDurationMs / 1000).toFixed(1)}s total duration`
      : "";

    return {
      source: inserts[0].source,
      sessionId: inserts[0].sessionId,
      orgId: inserts[0].orgId,
      userId: inserts[0].userId,
      eventType: inserts[0].eventType,
      category: inserts[0].category,
      description: `${group.count} ${group.eventType} events${durationStr}`,
      metadata: {
        coalesced: true,
        eventCount: group.count,
        eventType: group.eventType,
        totalDurationMs: group.totalDurationMs,
        firstDescription: group.firstDescription,
      },
    };
  }

  /** Flush remaining buffer synchronously (e.g., on shutdown). */
  flush(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
    for (const event of this.buffer) {
      const result = this.store.append(event);
      if (result) {
        this.smtService?.onEventAppended(result);
        this.deAnchor?.notifyAppend();
      }
    }
    this.buffer = [];
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }
}
