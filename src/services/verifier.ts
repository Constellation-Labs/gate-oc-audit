/**
 * Chain integrity verifier.
 *
 * Recomputes the SMT root from a clean state by replaying audit_events row
 * by row, and compares the recomputed root against the smt_root stored in
 * audit_checkpoint at each anchored boundary. Because the replay reads the
 * audit_event table directly (not the in-memory SMT), tampering with any
 * row makes the replay diverge from the anchored root.
 */

import type { AuditStore } from "../store/audit-store.js";
import type { SmtService } from "./smt-service.js";
import type { AuditEvent } from "../types/events.js";
import type {
  SeqNos,
  ConversationChains,
  EpochEntries,
  LeafValues,
} from "../types/smt.js";
import { SmtStore } from "../store/smt-store.js";
import { insertEntry } from "../store/smt-logic.js";

const REPLAY_TREE_KEY = "verify";
const BATCH = 1000;

export interface VerifyMismatch {
  checkpointId: string;
  sequenceStart: number;
  sequenceEnd: number;
  /** First/last sequences whose current content no longer hashes to a leaf
   *  in the live SMT. Only set for root-mismatch; events-missing has no rows
   *  to scan. */
  tamperedStart?: number;
  tamperedEnd?: number;
  expectedRoot: string;
  computedRoot: string;
  createdAt: string;
  inWindow: boolean;
  reason: "root-mismatch" | "events-missing";
}

export type VerifyResult =
  | {
      status: "verified";
      checkpointsChecked: number;
      lastAnchoredSequence: number;
      lastAnchoredCreatedAt: string;
      durationMs: number;
    }
  | {
      status: "mismatch-at-interval";
      mismatchAt: VerifyMismatch;
      checkpointsChecked: number;
      durationMs: number;
    }
  | {
      status: "anchor-pending";
      lastAnchoredSequence: number | null;
      lastAnchoredCreatedAt: string | null;
      checkpointsChecked: number;
      durationMs: number;
    };

export interface VerifyParams {
  from: string;
  to: string;
}

export class Verifier {
  constructor(
    private readonly store: AuditStore,
    private readonly smtService: SmtService,
  ) {}

  verifyRange({ from, to }: VerifyParams): VerifyResult {
    const start = Date.now();

    const anchored = this.store
      .getCheckpoints()
      .filter((cp) => cp.deTxHash !== null)
      .sort((a, b) => a.sequenceStart - b.sequenceStart);

    const last = anchored[anchored.length - 1];

    // No anchored checkpoint covers the upper bound `to`: nothing to verify
    // against yet. We still attempt a replay-and-compare for any earlier
    // anchored checkpoints; if any of them mismatch we report that. If they
    // all match (or there are none), the trailing portion is anchor-pending.
    const lastCoversTo = last !== undefined && last.createdAt >= to;

    if (anchored.length === 0) {
      return {
        status: "anchor-pending",
        lastAnchoredSequence: null,
        lastAnchoredCreatedAt: null,
        checkpointsChecked: 0,
        durationMs: Date.now() - start,
      };
    }

    const maxSeq = last!.sequenceEnd;
    const replay = this.replayUpTo(maxSeq, anchored, from, to);

    if (replay.kind === "mismatch") {
      return {
        status: "mismatch-at-interval",
        mismatchAt: replay.mismatch,
        checkpointsChecked: replay.checkpointsChecked,
        durationMs: Date.now() - start,
      };
    }

    if (!lastCoversTo) {
      return {
        status: "anchor-pending",
        lastAnchoredSequence: last!.sequenceEnd,
        lastAnchoredCreatedAt: last!.createdAt,
        checkpointsChecked: replay.checkpointsChecked,
        durationMs: Date.now() - start,
      };
    }

    return {
      status: "verified",
      checkpointsChecked: replay.checkpointsChecked,
      lastAnchoredSequence: last!.sequenceEnd,
      lastAnchoredCreatedAt: last!.createdAt,
      durationMs: Date.now() - start,
    };
  }

  private replayUpTo(
    maxSeq: number,
    anchored: ReadonlyArray<{
      id: string;
      sequenceStart: number;
      sequenceEnd: number;
      smtRoot: string;
      createdAt: string;
    }>,
    from: string,
    to: string,
  ):
    | { kind: "ok"; checkpointsChecked: number }
    | { kind: "mismatch"; mismatch: VerifyMismatch; checkpointsChecked: number } {
    const store = new SmtStore();
    const seqNos: SeqNos = new Map();
    const conversationChains: ConversationChains = new Map();
    const epochEntries: EpochEntries = new Map();
    const leafValues: LeafValues = new Map();
    const machineId = this.smtService.getMachineId();

    let cpIdx = 0;
    let checkpointsChecked = 0;
    let lastSeqSeen = 0;
    let offset = 0;

    while (lastSeqSeen < maxSeq) {
      const batch = this.store.query({
        afterSequence: lastSeqSeen,
        limit: BATCH,
        order: "asc",
        includeContent: true,
      });
      if (batch.length === 0) {
        // Events expected but missing — every remaining anchored checkpoint
        // that has events beyond lastSeqSeen will fail to recompute. Report
        // the first such checkpoint as the mismatch.
        const missing = anchored.find((cp) => cp.sequenceEnd > lastSeqSeen);
        if (missing) {
          return {
            kind: "mismatch",
            mismatch: {
              checkpointId: missing.id,
              sequenceStart: missing.sequenceStart,
              sequenceEnd: missing.sequenceEnd,
              expectedRoot: missing.smtRoot,
              computedRoot: store.getRoot(),
              createdAt: missing.createdAt,
              inWindow: missing.createdAt >= from && missing.createdAt <= to,
              reason: "events-missing",
            },
            checkpointsChecked,
          };
        }
        break;
      }

      offset += batch.length;

      for (const event of batch) {
        if (event.sequence > maxSeq) break;
        this.applyEvent(store, event, machineId, {
          seqNos,
          conversationChains,
          epochEntries,
          leafValues,
        });
        lastSeqSeen = event.sequence;

        while (
          cpIdx < anchored.length &&
          anchored[cpIdx]!.sequenceEnd === lastSeqSeen
        ) {
          const cp = anchored[cpIdx]!;
          checkpointsChecked++;
          const computed = store.getRoot();
          if (computed !== cp.smtRoot) {
            const tampered = this.findTamperedRange();
            return {
              kind: "mismatch",
              mismatch: {
                checkpointId: cp.id,
                sequenceStart: cp.sequenceStart,
                sequenceEnd: cp.sequenceEnd,
                tamperedStart: tampered?.start,
                tamperedEnd: tampered?.end,
                expectedRoot: cp.smtRoot,
                computedRoot: computed,
                createdAt: cp.createdAt,
                inWindow: cp.createdAt >= from && cp.createdAt <= to,
                reason: "root-mismatch",
              },
              checkpointsChecked,
            };
          }
          cpIdx++;
        }
      }
    }

    return { kind: "ok", checkpointsChecked };
  }

  // Scan every event the SMT tracks and bracket the [first, last] sequence
  // whose current content no longer matches a stored leaf. Mirrors the
  // per-row rule classifyEvent applies on /api/events.
  private findTamperedRange(): { start: number; end: number } | undefined {
    const smtLastSeq = this.smtService.getLastInsertedSequence();
    let min: number | undefined;
    let max: number | undefined;
    let afterSeq = 0;
    while (true) {
      const batch = this.store.query({
        afterSequence: afterSeq,
        limit: BATCH,
        order: "asc",
        includeContent: true,
      });
      if (batch.length === 0) break;
      for (const event of batch) {
        if (event.sequence > smtLastSeq) {
          // Past the SMT's high-water mark — these are "untracked", not
          // tampered. Stop here; subsequent events are all beyond smtLastSeq.
          if (min === undefined || max === undefined) return undefined;
          return { start: min, end: max };
        }
        // Sequences the SMT intentionally skipped (frozen leaf, insert
        // rejected) are missing-by-design, not tampered.
        if (this.smtService.wasSkipped(event.sequence)) {
          afterSeq = event.sequence;
          continue;
        }
        const rawHash = this.smtService.computeRawHash(event);
        const found = this.smtService.findContainingTreeKey(rawHash);
        if (found === null) {
          if (min === undefined) min = event.sequence;
          max = event.sequence;
        }
        afterSeq = event.sequence;
      }
      if (batch.length < BATCH) break;
    }
    if (min === undefined || max === undefined) return undefined;
    return { start: min, end: max };
  }

  private applyEvent(
    store: SmtStore,
    event: AuditEvent,
    machineId: string,
    maps: {
      seqNos: SeqNos;
      conversationChains: ConversationChains;
      epochEntries: EpochEntries;
      leafValues: LeafValues;
    },
  ): void {
    const rawHash = this.smtService.computeRawHash(event);
    const censoredHash = this.smtService.computeCensoredHash(event);
    const conversationId = event.sessionId ?? machineId;
    const timestamp = Math.floor(new Date(event.createdAt).getTime() / 1000);

    insertEntry(store, {
      eventId: event.id,
      treeKey: REPLAY_TREE_KEY,
      rawHash,
      censoredHash,
      conversationId,
      timestamp,
      maxTreeSize: Number.MAX_SAFE_INTEGER,
      seqNos: maps.seqNos,
      conversationChains: maps.conversationChains,
      epochEntries: maps.epochEntries,
      leafValues: maps.leafValues,
    });
  }
}
