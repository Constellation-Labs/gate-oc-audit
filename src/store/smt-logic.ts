/**
 * SMT Logic — Pure functions for insert, epoch tracking, and conversation chains.
 *
 * Adapted from ded-smt-service/index.ts. Uses DED SDK for canonicalization
 * and hashing to ensure cross-compatibility.
 */

import { createRequire } from "module";
import type {
  SeqNos,
  ConversationChains,
  EpochEntries,
  LeafValues,
  ChainEntry,
  InsertOptions,
  InsertResult,
  InsertError,
} from "../types/smt.js";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
  hashDocument: (content: string | Buffer) => string;
};

/** Epoch duration in ms (1 hour) */
export const EPOCH_DURATION_MS = 1000 * 60 * 60;

export function getCurrentEpoch(): number {
  return Math.floor(Date.now() / EPOCH_DURATION_MS);
}

/**
 * Per-tree monotonic leaf counter. NOTE the seqNo-to-audit-event relationship
 * is NOT 1:1: a single audit event with a censored variant consumes TWO
 * consecutive seqNos (one for the raw leaf, one for the censored leaf — see
 * `insertEntry`). An event with no censored variant consumes one. This is
 * self-consistent (each SMT leaf has a unique seqNo), but any future
 * import/migration path that reconstructs `seqNos` from audit-event sequence
 * numbers must NOT assume one seqNo per audit event.
 */
export function getNextSeqNo(seqNos: SeqNos, treeKey: string): number {
  // `??` (not `||`): a future migration that pre-populates `seqNos` with
  // `treeKey -> 0` from an imported snapshot would otherwise double-issue
  // seq 1 because `0 || 0 + 1 === 1` looks the same as the "absent" case.
  const next = (seqNos.get(treeKey) ?? 0) + 1;
  seqNos.set(treeKey, next);
  return next;
}

export function getChainPrev(
  conversationChains: ConversationChains,
  treeKey: string,
  conversationId: string,
): string | null {
  const treeChains = conversationChains.get(treeKey);
  if (!treeChains) return null;
  const chain = treeChains.get(conversationId);
  if (!chain || chain.length === 0) return null;
  return chain[chain.length - 1].rawHash;
}

export function recordChainEntry(
  conversationChains: ConversationChains,
  treeKey: string,
  conversationId: string,
  entry: ChainEntry,
): void {
  let treeChains = conversationChains.get(treeKey);
  if (!treeChains) {
    treeChains = new Map();
    conversationChains.set(treeKey, treeChains);
  }
  const chain = treeChains.get(conversationId) || [];
  chain.push(entry);
  treeChains.set(conversationId, chain);
}

export function trackEpochEntry(
  epochEntries: EpochEntries,
  treeKey: string,
  epoch: number,
  rawHash: string,
): void {
  let treeEpochs = epochEntries.get(treeKey);
  if (!treeEpochs) {
    treeEpochs = new Map();
    epochEntries.set(treeKey, treeEpochs);
  }
  const hashes = treeEpochs.get(epoch) || [];
  hashes.push(rawHash);
  treeEpochs.set(epoch, hashes);
}

/**
 * Insert one (raw) or two (raw + censored) leaves into the SMT with structured values.
 */
export function insertEntry(
  store: {
    getEntryCount(): number;
    add(k: string, v: string): void;
    getRoot(): string;
  },
  opts: InsertOptions,
): InsertResult | InsertError {
  const {
    eventId,
    treeKey,
    rawHash,
    censoredHash,
    conversationId,
    timestamp,
    maxTreeSize,
    seqNos,
    conversationChains,
    epochEntries,
  } = opts;

  // An event with a censored variant adds TWO leaves (raw + censored), so the
  // capacity check must reserve room for both up front. Checking `>= maxTreeSize`
  // only would admit the raw leaf at maxTreeSize-1 and then push the tree to
  // maxTreeSize+1 with the censored leaf. Reject before issuing any seqNo so the
  // counter isn't advanced for leaves that won't be admitted.
  const leavesToAdd = censoredHash ? 2 : 1;
  if (store.getEntryCount() + leavesToAdd > maxTreeSize) {
    return { error: `Tree ${treeKey} has reached max size (${maxTreeSize})` };
  }

  const seqNo = getNextSeqNo(seqNos, treeKey);
  const chainPrev = getChainPrev(conversationChains, treeKey, conversationId);
  const epoch = getCurrentEpoch();

  const rawLeafValue: string = sdk.canonicalize({
    timestamp,
    seqNo,
    auditEventId: eventId,
    hashType: "raw",
    chainPrev,
  });

  const rawLeafHash = sdk.hashDocument(rawLeafValue);
  store.add(rawHash, rawLeafHash);
  if (opts.leafValues) opts.leafValues.set(rawHash, rawLeafValue);
  trackEpochEntry(epochEntries, treeKey, epoch, rawHash);
  recordChainEntry(conversationChains, treeKey, conversationId, {
    rawHash,
    timestamp,
    seqNo,
    auditEventId: eventId,
  });

  let censoredLeafValue: string | undefined;
  if (censoredHash) {
    const censoredSeqNo = getNextSeqNo(seqNos, treeKey);
    censoredLeafValue = sdk.canonicalize({
      timestamp,
      seqNo: censoredSeqNo,
      auditEventId: eventId,
      hashType: "censored",
      chainPrev,
    });
    const censoredLeafHash = sdk.hashDocument(censoredLeafValue);
    store.add(censoredHash, censoredLeafHash);
    if (opts.leafValues) opts.leafValues.set(censoredHash, censoredLeafValue);
    trackEpochEntry(epochEntries, treeKey, epoch, censoredHash);
    // Track the censored leaf in the conversation chain too. Without this
    // entry, pruneEpoch only sweeps raw leaves by chain membership and the
    // censored leaf would stay in leafValues after a prune — bounded
    // impact (cache only) but it lets getChain callers see both leaves of
    // each event.
    recordChainEntry(conversationChains, treeKey, conversationId, {
      rawHash: censoredHash,
      timestamp,
      seqNo: censoredSeqNo,
      auditEventId: eventId,
    });
  }

  return {
    rawKey: rawHash,
    ...(censoredHash ? { censoredKey: censoredHash } : {}),
    root: store.getRoot(),
    entryCount: store.getEntryCount(),
    auditEventId: eventId,
    seqNo,
    chainPrev,
    rawLeafValue,
    ...(censoredLeafValue ? { censoredLeafValue } : {}),
  };
}
