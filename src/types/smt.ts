import type { SmtProof } from "../store/smt-store.js";

export type { SmtProof };

/** Monotonic insert counter per tree */
export type SeqNos = Map<string, number>;

/** Conversation chain entry */
export interface ChainEntry {
  rawHash: string;
  timestamp: number;
  seqNo: number;
  auditEventId: string;
}

/** Conversation chains: treeKey -> conversationId -> ordered entries */
export type ConversationChains = Map<string, Map<string, ChainEntry[]>>;

/** Epoch -> raw hashes committed in that epoch, per tree */
export type EpochEntries = Map<string, Map<number, string[]>>;

/** Exported proofs after prune, per tree */
export type ExportedProofs = Map<string, Map<number, object[]>>;

/** Leaf value store: hash -> structured JSON */
export type LeafValues = Map<string, string>;

export interface InsertOptions {
  treeKey: string;
  rawHash: string;
  censoredHash: string | null;
  conversationId: string;
  timestamp: number;
  maxTreeSize: number;
  seqNos: SeqNos;
  conversationChains: ConversationChains;
  epochEntries: EpochEntries;
  leafValues?: LeafValues;
}

export interface InsertResult {
  rawKey: string;
  censoredKey?: string;
  root: string;
  entryCount: number;
  auditEventId: string;
  seqNo: number;
  chainPrev: string | null;
  rawLeafValue: string;
  censoredLeafValue?: string;
}

export interface InsertError {
  error: string;
}

export interface SmtConfig {
  treeKey: string;
  maxTreeSize: number;
  checkpointDir: string;
  checkpointIntervalMs: number;
  epochDurationMs: number;
  pruneAfterEpochs: number;
  storageCapBytes: number;
  snapshotPassphrase: string;
}
