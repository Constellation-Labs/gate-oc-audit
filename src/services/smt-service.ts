/**
 * SMT Service — Orchestrates SMT operations for the audit plugin.
 *
 * Every event appended to the audit store is also committed as dual-hash
 * (raw + censored) SMT leaves. Provides proof generation, epoch pruning,
 * snapshots, and background checkpointing.
 */

import { createRequire } from "module";
import { writeFile, readFile, rename } from "node:fs/promises";

import { join } from "node:path";
import { TreeManager, type TreeInfo } from "../store/smt-tree-manager.js";
import type { SmtProof } from "../store/smt-store.js";
import {
  insertEntry,
  getCurrentEpoch,
  EPOCH_DURATION_MS,
} from "../store/smt-logic.js";
import {
  createSnapshot as createSmtSnapshot,
  restoreSnapshot as restoreSmtSnapshot,
  type Snapshot,
} from "./smt-snapshot.js";
import type { AuditEvent } from "../types/events.js";
import type {
  SeqNos,
  ConversationChains,
  EpochEntries,
  ExportedProofs,
  LeafValues,
  ChainEntry,
  SmtConfig,
} from "../types/smt.js";
import { getMachineId } from "../util/machine-id.js";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
  hashDocument: (content: string | Buffer) => string;
};

const BYTES_PER_NODE = 128;

function resolveConfig(config: Record<string, unknown>): SmtConfig {
  const smt =
    typeof config.smt === "object" && config.smt !== null
      ? (config.smt as Record<string, unknown>)
      : {};
  return {
    treeKey: typeof smt.treeKey === "string" ? smt.treeKey : "auto",
    maxTreeSize:
      typeof smt.maxTreeSize === "number" ? smt.maxTreeSize : 500_000,
    checkpointDir:
      typeof smt.checkpointDir === "string"
        ? smt.checkpointDir.replace(/^~/, process.env.HOME ?? ".")
        : `${process.env.HOME ?? "."}/.openclaw/smt-checkpoints`,
    checkpointIntervalMs:
      typeof smt.checkpointIntervalMs === "number"
        ? smt.checkpointIntervalMs
        : 300_000,
    epochDurationMs:
      typeof smt.epochDurationMs === "number"
        ? smt.epochDurationMs
        : EPOCH_DURATION_MS,
    pruneAfterEpochs:
      typeof smt.pruneAfterEpochs === "number" ? smt.pruneAfterEpochs : 0,
    storageCapBytes:
      typeof smt.storageCapBytes === "number"
        ? smt.storageCapBytes
        : 500 * 1024 * 1024,
  };
}

export class SmtService {
  private manager = new TreeManager();
  private config: SmtConfig;
  private machineId: string;

  private seqNos: SeqNos = new Map();
  private conversationChains: ConversationChains = new Map();
  private epochEntries: EpochEntries = new Map();
  private exportedProofs: ExportedProofs = new Map();
  private leafValues: LeafValues = new Map();

  private lastInsertedSeq = 0;

  private checkpointTimer: ReturnType<typeof setInterval> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private checkpointInFlight: Promise<void> | undefined;
  private restored = false;
  private needsFirstCheckpoint = true;
  private suppressCheckpoints = false;

  constructor(config: Record<string, unknown>) {
    this.config = resolveConfig(config);
    this.machineId = getMachineId();
  }

  /**
   * Restore checkpoints from disk if not already done.
   * Called automatically by start(), but can also be called directly for CLI use.
   */
  async ensureReady(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    try {
      await this.manager.restoreAll(this.config.checkpointDir);
      await this.restoreMetadata();
      const trees = this.manager.listTrees();
      console.error(
        `[audit-plugin:smt] Restored ${trees.length} tree(s) from checkpoint`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin:smt] Checkpoint restore failed:", msg);
    }
  }

  async start(): Promise<void> {
    console.error(
      `[audit-plugin:smt] Starting — tree: ${this.config.treeKey}, maxSize: ${this.config.maxTreeSize}, checkpointDir: ${this.config.checkpointDir}, checkpointInterval: ${this.config.checkpointIntervalMs}ms`,
    );

    await this.ensureReady();

    if (this.config.checkpointIntervalMs > 0) {
      this.checkpointTimer = setInterval(
        () => this.checkpoint(),
        this.config.checkpointIntervalMs,
      );
      this.checkpointTimer.unref();
    }

    if (this.config.pruneAfterEpochs > 0) {
      this.pruneTimer = setInterval(
        () => this.autoPrune(),
        this.config.epochDurationMs,
      );
      this.pruneTimer.unref();
    }

    console.error("[audit-plugin:smt] Started successfully");
  }

  async stop(): Promise<void> {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    // Wait for any in-flight checkpoint to complete before running the final one
    if (this.checkpointInFlight) {
      await this.checkpointInFlight.catch(() => {});
      this.checkpointInFlight = undefined;
    }
    // Final checkpoint on shutdown — each step is independent so a tree
    // checkpoint failure doesn't prevent metadata from being persisted.
    try {
      await this.manager.checkpointAll(this.config.checkpointDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin:smt] Tree checkpoint failed:", msg);
    }
    try {
      await this.checkpointMetadata();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin:smt] Metadata checkpoint failed:", msg);
    }
  }

  private getTreeKey(): string {
    return this.config.treeKey === "auto"
      ? this.machineId
      : this.config.treeKey;
  }

  private estimateStorageBytes(): number {
    return this.manager.totalNodeCount() * BYTES_PER_NODE;
  }

  /**
   * Called after each successful audit store append.
   * Computes dual hashes and inserts into the SMT. Fail-open.
   */
  onEventAppended(event: AuditEvent): void {
    try {
      if (this.estimateStorageBytes() >= this.config.storageCapBytes) {
        console.error(
          "[audit-plugin:smt] Storage cap reached, skipping insert",
        );
        return;
      }

      const treeKey = this.getTreeKey();
      const store = this.manager.getOrCreate(treeKey);
      const timestamp = Math.floor(new Date(event.createdAt).getTime() / 1000);
      const conversationId = event.sessionId ?? this.machineId;

      const rawHash = this.computeRawHash(event);
      const censoredHash = this.computeCensoredHash(event);

      if (
        store.isFrozen(rawHash) ||
        (censoredHash && store.isFrozen(censoredHash))
      ) {
        return;
      }

      const result = insertEntry(store, {
        eventId: event.id,
        treeKey,
        rawHash,
        censoredHash,
        conversationId,
        timestamp,
        maxTreeSize: this.config.maxTreeSize,
        seqNos: this.seqNos,
        conversationChains: this.conversationChains,
        epochEntries: this.epochEntries,
        leafValues: this.leafValues,
      });

      if ("error" in result) {
        console.error(`[audit-plugin:smt] Insert rejected: ${result.error}`);
        return;
      }

      if (event.sequence > this.lastInsertedSeq) {
        this.lastInsertedSeq = event.sequence;
      }

      if (this.needsFirstCheckpoint && !this.suppressCheckpoints) {
        this.needsFirstCheckpoint = false;
        this.checkpoint();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin:smt] Insert failed:", msg);
    }
  }

  /**
   * Compute the raw hash for an event (for proof lookups).
   * Includes full event fields plus raw content — use for exact replay verification.
   */
  computeRawHash(event: AuditEvent): string {
    return sdk.hashDocument(
      "raw:" +
        sdk.canonicalize({
          id: event.id,
          sequence: event.sequence,
          eventType: event.eventType,
          category: event.category,
          description: event.description,
          metadata: event.metadata,
          content: event.content,
        }),
    );
  }

  /**
   * Compute the censored hash for an event (privacy-preserving proof lookups).
   * Includes only event type, category, and timestamp — no content or identity.
   */
  computeCensoredHash(event: AuditEvent): string {
    return sdk.hashDocument(
      "censored:" +
        sdk.canonicalize({
          id: event.id,
          eventType: event.eventType,
          category: event.category,
          createdAt: event.createdAt,
        }),
    );
  }

  createProof(hash: string, treeKey?: string): SmtProof | null {
    const key = treeKey ?? this.getTreeKey();
    const store = this.manager.get(key);
    if (!store) return null;
    const proof = store.createProof(hash);
    if (store.isFrozen(hash)) {
      return { ...proof, frozen: true };
    }
    return proof;
  }

  verifyProof(proof: SmtProof, expectedRoot?: string): boolean {
    if (expectedRoot !== undefined && proof.root !== expectedRoot) {
      return false;
    }
    const verifier = this.manager.getOrCreate("__verifier__");
    return verifier.verifyProof(proof);
  }

  getRoot(treeKey?: string): { root: string; entryCount: number } | null {
    const key = treeKey ?? this.getTreeKey();
    const store = this.manager.get(key);
    if (!store) return null;
    return { root: store.getRoot(), entryCount: store.getEntryCount() };
  }

  listTrees(): TreeInfo[] {
    return this.manager.listTrees().filter((t) => t.key !== "__verifier__");
  }

  getKnownRoots(checkpointedRoots?: Iterable<string>): Set<string> {
    const roots = new Set(this.listTrees().map((t) => t.root));
    if (checkpointedRoots) {
      for (const r of checkpointedRoots) roots.add(r);
    }
    return roots;
  }

  getChain(treeKey: string, conversationId: string): ChainEntry[] {
    const treeChains = this.conversationChains.get(treeKey);
    return treeChains?.get(conversationId) || [];
  }

  pruneEpoch(
    treeKey: string,
    epoch: number,
  ):
    | { pruned: number; proofsExported: number; root: string }
    | { error: string } {
    const store = this.manager.get(treeKey);
    if (!store) return { error: `Tree ${treeKey} not found` };

    const treeEpochs = this.epochEntries.get(treeKey);
    const hashes: string[] = treeEpochs?.get(epoch) || [];

    if (hashes.length === 0) {
      treeEpochs?.delete(epoch);
      return { pruned: 0, proofsExported: 0, root: store.getRoot() };
    }

    // Export proofs before freezing, annotated with frozen: true
    const proofs = hashes.map((h) => ({
      ...store.createProof(h),
      frozen: true,
    }));

    let treeExports = this.exportedProofs.get(treeKey);
    if (!treeExports) {
      treeExports = new Map();
      this.exportedProofs.set(treeKey, treeExports);
    }
    treeExports.set(epoch, proofs);

    // Freeze keys instead of deleting — root is unchanged
    for (const h of hashes) {
      store.freezeLeaf(h);
      this.leafValues.delete(h);
    }
    treeEpochs?.delete(epoch);

    // Clean up conversation chain entries that reference pruned hashes
    const prunedSet = new Set(hashes);
    const treeChains = this.conversationChains.get(treeKey);
    if (treeChains) {
      for (const [convId, chain] of treeChains) {
        const filtered = chain.filter((e) => !prunedSet.has(e.rawHash));
        if (filtered.length === 0) {
          treeChains.delete(convId);
        } else {
          treeChains.set(convId, filtered);
        }
      }
      if (treeChains.size === 0) {
        this.conversationChains.delete(treeKey);
      }
    }

    return {
      pruned: hashes.length,
      proofsExported: proofs.length,
      root: store.getRoot(),
    };
  }

  getExportedProofs(treeKey: string, epoch?: number): object {
    const treeExports = this.exportedProofs.get(treeKey);
    if (!treeExports || treeExports.size === 0) {
      return {
        tree: treeKey,
        exportedEpochs: [],
        message: "No exported proofs",
      };
    }
    if (epoch !== undefined) {
      const proofs = treeExports.get(epoch);
      if (!proofs) {
        return {
          tree: treeKey,
          epoch,
          proofs: [],
          message: "No proofs for this epoch",
        };
      }
      return { tree: treeKey, epoch, proofCount: proofs.length, proofs };
    }
    const epochs = Array.from(treeExports.entries()).map(([ep, proofs]) => ({
      epoch: ep,
      proofCount: proofs.length,
    }));
    return {
      tree: treeKey,
      exportedEpochs: epochs,
      totalProofs: epochs.reduce((s, e) => s + e.proofCount, 0),
    };
  }

  createSnapshot(treeKey: string): Snapshot | { error: string } {
    const store = this.manager.get(treeKey);
    if (!store) return { error: `Tree ${treeKey} not found` };

    const nodes = store.getNodes();
    const root = store.getRoot();
    const frozenKeys = store.getFrozenKeys();

    return createSmtSnapshot(
      nodes,
      root,
      {
        treeKey,
        entryCount: store.getEntryCount(),
        nodeCount: nodes.size,
        root,
        createdAt: new Date().toISOString(),
      },
      frozenKeys.size > 0 ? Array.from(frozenKeys) : undefined,
    );
  }

  restoreSnapshot(
    treeKey: string,
    snapshot: Snapshot,
  ): { root: string; nodeCount: number } | { error: string } {
    try {
      const restored = restoreSmtSnapshot(snapshot);
      const store = this.manager.getOrCreate(treeKey);
      store.restoreFromState(
        restored.nodes,
        restored.root,
        restored.frozenKeys,
      );
      return { root: restored.root, nodeCount: restored.nodes.size };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Restore failed: ${msg}` };
    }
  }

  /**
   * Replay existing audit events into the SMT in batches.
   * Used on startup to rebuild the tree when no checkpoint exists.
   * Accepts either an array (legacy) or a batch-fetching callback to
   * avoid loading the entire audit store into memory at once.
   */
  replayEvents(
    eventsOrFetcher:
      | AuditEvent[]
      | ((offset: number, limit: number) => AuditEvent[]),
    totalCount?: number,
  ): number {
    this.suppressCheckpoints = true;
    let replayed = 0;

    if (Array.isArray(eventsOrFetcher)) {
      for (const event of eventsOrFetcher) {
        this.onEventAppended(event);
      }
      replayed = eventsOrFetcher.length;
    } else {
      const BATCH_SIZE = 1000;
      const total = totalCount ?? Infinity;
      let offset = 0;
      while (offset < total) {
        const batch = eventsOrFetcher(offset, BATCH_SIZE);
        if (batch.length === 0) break;
        for (const event of batch) {
          this.onEventAppended(event);
        }
        replayed += batch.length;
        offset += batch.length;
      }
    }

    this.suppressCheckpoints = false;
    this.needsFirstCheckpoint = false;
    if (replayed > 0) {
      this.checkpoint();
    }
    return replayed;
  }

  /** Highest audit event sequence number that was inserted into the SMT and checkpointed. */
  getLastCheckpointedSequence(): number {
    return this.lastInsertedSeq;
  }

  getCurrentSmtRoot(treeKey?: string): string | null {
    const key = treeKey ?? this.getTreeKey();
    const store = this.manager.get(key);
    return store?.getRoot() ?? null;
  }

  private async checkpointMetadata(): Promise<void> {
    try {
      const data = {
        seqNos: Array.from(this.seqNos),
        conversationChains: Array.from(this.conversationChains).map(
          ([tk, chains]) => [tk, Array.from(chains)] as const,
        ),
        epochEntries: Array.from(this.epochEntries).map(
          ([tk, epochs]) => [tk, Array.from(epochs)] as const,
        ),
        exportedProofs: Array.from(this.exportedProofs).map(
          ([tk, epochs]) => [tk, Array.from(epochs)] as const,
        ),
        lastInsertedSeq: this.lastInsertedSeq,
      };
      const filePath = join(this.config.checkpointDir, "_metadata.json");
      const tmpPath = filePath + ".tmp";
      await writeFile(tmpPath, JSON.stringify(data));
      await rename(tmpPath, filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin:smt] Metadata checkpoint failed:", msg);
    }
  }

  private async restoreMetadata(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(
        join(this.config.checkpointDir, "_metadata.json"),
        "utf-8",
      );
    } catch {
      return; // No metadata file yet
    }

    try {
      const data = JSON.parse(raw);

      if (Array.isArray(data.seqNos)) {
        this.seqNos = new Map(data.seqNos);
      }
      if (Array.isArray(data.conversationChains)) {
        this.conversationChains = new Map(
          data.conversationChains.map(
            ([tk, chains]: [string, [string, ChainEntry[]][]]) => [
              tk,
              new Map(chains),
            ],
          ),
        );
      }
      if (Array.isArray(data.epochEntries)) {
        this.epochEntries = new Map(
          data.epochEntries.map(
            ([tk, epochs]: [string, [number, string[]][]]) => [
              tk,
              new Map(epochs),
            ],
          ),
        );
      }
      if (Array.isArray(data.exportedProofs)) {
        this.exportedProofs = new Map(
          data.exportedProofs.map(
            ([tk, epochs]: [string, [number, object[]][]]) => [
              tk,
              new Map(epochs),
            ],
          ),
        );
      }
      const savedSeq = data.lastInsertedSeq ?? data.lastCheckpointedSeq;
      if (typeof savedSeq === "number") {
        this.lastInsertedSeq = savedSeq;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin:smt] Metadata restore failed:", msg);
    }
  }

  private checkpoint(): void {
    // Serialize checkpoints: wait for any in-flight checkpoint to finish before
    // starting the next one. Prevents concurrent checkpointAll calls from
    // interleaving their clear-then-write sequences on the same LevelDB.
    const prev = this.checkpointInFlight ?? Promise.resolve();
    const work = prev
      .catch(() => {})
      .then(() =>
        Promise.all([
          this.manager.checkpointAll(this.config.checkpointDir).catch((err) => {
            const msg = err instanceof Error ? err.message : "Unknown error";
            console.error("[audit-plugin:smt] Tree checkpoint failed:", msg);
          }),
          this.checkpointMetadata().catch((err) => {
            const msg = err instanceof Error ? err.message : "Unknown error";
            console.error(
              "[audit-plugin:smt] Metadata checkpoint failed:",
              msg,
            );
          }),
        ]).then(() => {}),
      );
    this.checkpointInFlight = work;
    work.finally(() => {
      if (this.checkpointInFlight === work) {
        this.checkpointInFlight = undefined;
      }
    });
  }

  private autoPrune(): void {
    const currentEpoch = getCurrentEpoch();
    const cutoff = currentEpoch - this.config.pruneAfterEpochs;

    for (const [treeKey, treeEpochs] of this.epochEntries) {
      const expiredEpochs = Array.from(treeEpochs.keys()).filter(
        (e) => e < cutoff,
      );

      for (const epoch of expiredEpochs) {
        const result = this.pruneEpoch(treeKey, epoch);
        if ("error" in result) {
          console.error(
            `[audit-plugin] Auto-prune failed for tree ${treeKey} epoch ${epoch}: ${result.error}`,
          );
        } else if (result.pruned > 0) {
          console.error(
            `[audit-plugin] Froze epoch ${epoch} in SMT tree ${treeKey}: ${result.pruned} entries`,
          );
        }
      }
    }
  }
}
