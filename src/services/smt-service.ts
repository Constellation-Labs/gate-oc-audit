/**
 * SMT Service — Orchestrates SMT operations for the audit plugin.
 *
 * Every event appended to the audit store is also committed as dual-hash
 * (raw + censored) SMT leaves. Provides proof generation, epoch pruning,
 * encrypted snapshots, and background checkpointing.
 */

import { createRequire } from "module";
import { TreeManager, type TreeInfo } from "../store/smt-tree-manager.js";
import type { SmtProof } from "../store/smt-store.js";
import {
  insertEntry,
  getCurrentEpoch,
  EPOCH_DURATION_MS,
} from "../store/smt-logic.js";
import {
  encryptSnapshot,
  decryptSnapshot,
  type EncryptedSnapshot,
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
    treeKey:
      typeof smt.treeKey === "string" ? smt.treeKey : "auto",
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
    snapshotPassphrase:
      typeof smt.snapshotPassphrase === "string"
        ? smt.snapshotPassphrase
        : "",
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

  private checkpointTimer: ReturnType<typeof setInterval> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: Record<string, unknown>) {
    this.config = resolveConfig(config);
    this.machineId = getMachineId();
  }

  async start(): Promise<void> {
    try {
      await this.manager.restoreAll(this.config.checkpointDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] SMT checkpoint restore failed:", msg);
    }

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
    // Final checkpoint on shutdown — await to ensure LevelDB write completes
    try {
      await this.manager.checkpointAll(this.config.checkpointDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] SMT final checkpoint failed:", msg);
    }
  }

  private getTreeKey(): string {
    return this.config.treeKey === "auto" ? this.machineId : this.config.treeKey;
  }

  private estimateStorageBytes(): number {
    let total = 0;
    for (const { size } of this.manager.listTrees()) {
      total += size * BYTES_PER_NODE;
    }
    return total;
  }

  /**
   * Called after each successful audit store append.
   * Computes dual hashes and inserts into the SMT. Fail-open.
   */
  onEventAppended(event: AuditEvent): void {
    try {
      if (this.estimateStorageBytes() >= this.config.storageCapBytes) {
        console.error("[audit-plugin] SMT storage cap reached, skipping insert");
        return;
      }

      const treeKey = this.getTreeKey();
      const store = this.manager.getOrCreate(treeKey);
      const timestamp = Math.floor(new Date(event.createdAt).getTime() / 1000);
      const conversationId = event.sessionId ?? this.machineId;

      const rawHash = sdk.hashDocument(
        "raw:" +
          sdk.canonicalize({
            id: event.id,
            sequence: event.sequence,
            eventType: event.eventType,
            category: event.category,
            description: event.description,
            metadata: event.metadata,
          }),
      );

      const censoredHash = sdk.hashDocument(
        "censored:" +
          sdk.canonicalize({
            id: event.id,
            eventType: event.eventType,
            category: event.category,
            createdAt: event.createdAt,
          }),
      );

      insertEntry(store, {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] SMT insert failed:", msg);
    }
  }

  /**
   * Compute the raw hash for an event (for proof lookups).
   * Includes full event fields — use for exact replay verification.
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
    return store.createProof(hash);
  }

  verifyProof(proof: SmtProof): boolean {
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

  getChain(treeKey: string, conversationId: string): ChainEntry[] {
    const treeChains = this.conversationChains.get(treeKey);
    return treeChains?.get(conversationId) || [];
  }

  pruneEpoch(
    treeKey: string,
    epoch: number,
  ): { pruned: number; proofsExported: number; root: string } | { error: string } {
    const store = this.manager.get(treeKey);
    if (!store) return { error: `Tree ${treeKey} not found` };

    const treeEpochs = this.epochEntries.get(treeKey);
    const hashes: string[] = treeEpochs?.get(epoch) || [];

    // Export proofs before deletion
    const proofs = hashes.map((h) => store.createProof(h));

    let treeExports = this.exportedProofs.get(treeKey);
    if (!treeExports) {
      treeExports = new Map();
      this.exportedProofs.set(treeKey, treeExports);
    }
    treeExports.set(epoch, proofs);

    // Delete entries from SMT
    for (const h of hashes) {
      store.delete(h);
    }
    treeEpochs?.delete(epoch);

    return {
      pruned: hashes.length,
      proofsExported: proofs.length,
      root: store.getRoot(),
    };
  }

  getExportedProofs(
    treeKey: string,
    epoch?: number,
  ): object {
    const treeExports = this.exportedProofs.get(treeKey);
    if (!treeExports || treeExports.size === 0) {
      return { tree: treeKey, exportedEpochs: [], message: "No exported proofs" };
    }
    if (epoch !== undefined) {
      const proofs = treeExports.get(epoch);
      if (!proofs) {
        return { tree: treeKey, epoch, proofs: [], message: "No proofs for this epoch" };
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

  createSnapshot(
    treeKey: string,
    passphrase?: string,
  ): EncryptedSnapshot | { error: string } {
    const store = this.manager.get(treeKey);
    if (!store) return { error: `Tree ${treeKey} not found` };

    const pp = passphrase || this.config.snapshotPassphrase || "default-audit-key";
    const nodes = store.getNodes();
    const root = store.getRoot();

    return encryptSnapshot(nodes, root, pp, {
      treeKey,
      entryCount: store.getEntryCount(),
      nodeCount: nodes.size,
      root,
      createdAt: new Date().toISOString(),
    });
  }

  restoreSnapshot(
    treeKey: string,
    snapshot: EncryptedSnapshot,
    passphrase?: string,
  ): { root: string; nodeCount: number } | { error: string } {
    try {
      const pp =
        passphrase || this.config.snapshotPassphrase || "default-audit-key";
      const restored = decryptSnapshot(snapshot, pp);
      const store = this.manager.getOrCreate(treeKey);
      store.restoreFromState(restored.nodes, restored.root);
      return { root: restored.root, nodeCount: restored.nodes.size };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Restore failed: ${msg}` };
    }
  }

  getCurrentSmtRoot(treeKey?: string): string | null {
    const key = treeKey ?? this.getTreeKey();
    const store = this.manager.get(key);
    return store?.getRoot() ?? null;
  }

  private checkpoint(): void {
    this.manager.checkpointAll(this.config.checkpointDir).catch((err) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] SMT checkpoint failed:", msg);
    });
  }

  private autoPrune(): void {
    const currentEpoch = getCurrentEpoch();
    const cutoff = currentEpoch - this.config.pruneAfterEpochs;

    for (const [treeKey, treeEpochs] of this.epochEntries) {
      const store = this.manager.get(treeKey);
      if (!store) continue;

      for (const [epoch] of treeEpochs) {
        if (epoch >= cutoff) continue;

        const hashes = treeEpochs.get(epoch) || [];
        const proofs = hashes.map((h) => store.createProof(h));

        let treeExports = this.exportedProofs.get(treeKey);
        if (!treeExports) {
          treeExports = new Map();
          this.exportedProofs.set(treeKey, treeExports);
        }
        treeExports.set(epoch, proofs);

        for (const h of hashes) {
          store.delete(h);
        }
        treeEpochs.delete(epoch);

        console.error(
          `[audit-plugin] Pruned epoch ${epoch} from SMT tree ${treeKey}: ${hashes.length} entries`,
        );
      }
    }
  }
}
