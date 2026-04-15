/**
 * SMT Logic — Pure functions for insert, epoch tracking, and conversation chains.
 *
 * Adapted from ded-smt-service/index.ts. Uses DED SDK for canonicalization
 * and hashing to ensure cross-compatibility.
 */

import { createRequire } from "module";
import { uuidv7 } from "uuidv7";
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

export function getNextSeqNo(seqNos: SeqNos, treeKey: string): number {
  const next = (seqNos.get(treeKey) || 0) + 1;
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

  if (store.getEntryCount() >= maxTreeSize) {
    return { error: `Tree ${treeKey} has reached max size (${maxTreeSize})` };
  }

  const auditEventId = uuidv7();
  const seqNo = getNextSeqNo(seqNos, treeKey);
  const chainPrev = getChainPrev(conversationChains, treeKey, conversationId);
  const epoch = getCurrentEpoch();

  const rawLeafValue: string = sdk.canonicalize({
    timestamp,
    seqNo,
    auditEventId,
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
    auditEventId,
  });

  let censoredLeafValue: string | undefined;
  if (censoredHash) {
    const censoredSeqNo = getNextSeqNo(seqNos, treeKey);
    censoredLeafValue = sdk.canonicalize({
      timestamp,
      seqNo: censoredSeqNo,
      auditEventId,
      hashType: "censored",
      chainPrev,
    });
    const censoredLeafHash = sdk.hashDocument(censoredLeafValue);
    store.add(censoredHash, censoredLeafHash);
    if (opts.leafValues) opts.leafValues.set(censoredHash, censoredLeafValue);
    trackEpochEntry(epochEntries, treeKey, epoch, censoredHash);
  }

  return {
    rawKey: rawHash,
    ...(censoredHash ? { censoredKey: censoredHash } : {}),
    root: store.getRoot(),
    entryCount: store.getEntryCount(),
    auditEventId,
    seqNo,
    chainPrev,
    rawLeafValue,
    ...(censoredLeafValue ? { censoredLeafValue } : {}),
  };
}
