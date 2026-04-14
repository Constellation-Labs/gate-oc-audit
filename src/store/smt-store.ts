/**
 * SMT Store Adapter
 *
 * Wraps @zk-kit/smt with a clean API, hiding @ts-ignore internals.
 * Uses SHA-256 hash function via DED SDK, pinned to @zk-kit/smt@1.0.2.
 */

import { createRequire } from "module";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  hashDocument: (content: string | Buffer) => string;
};
const SMTModule = require2(
  require2.resolve("@zk-kit/smt").replace("index.js", "index.cjs"),
);
const SMT = SMTModule.SMT || SMTModule.default || SMTModule;

export interface SmtProof {
  entry: string[];
  matchingEntry: string[] | undefined;
  siblings: string[];
  root: string;
  membership: boolean;
  frozen?: boolean;
}

export interface SmtSnapshot {
  root: string;
  nodes: Map<string, string[]>;
  frozenKeys?: string[];
}

function sha256Hash(childNodes: (string | bigint)[]): string {
  const input = childNodes.map((n) => String(n)).join("");
  return sdk.hashDocument(input);
}

export class SmtStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private smt: any;
  private frozenKeys: Set<string> = new Set();

  constructor() {
    this.smt = new SMT(sha256Hash, false);
  }

  add(key: string, value: string): void {
    this.smt.add(key, value);
  }

  get(key: string): string | undefined {
    try {
      const result = this.smt.get(key);
      return result === undefined || result === null ? undefined : String(result);
    } catch {
      return undefined;
    }
  }

  delete(key: string): void {
    this.smt.delete(key);
  }

  /** Mark a leaf key as frozen. The leaf stays in the SMT; root is unchanged. */
  freezeLeaf(key: string): void {
    this.frozenKeys.add(key);
  }

  isFrozen(key: string): boolean {
    return this.frozenKeys.has(key);
  }

  getFrozenKeys(): Set<string> {
    return new Set(this.frozenKeys);
  }

  getFrozenCount(): number {
    return this.frozenKeys.size;
  }

  createProof(key: string): SmtProof {
    const proof = this.smt.createProof(key);
    return {
      entry: proof.entry,
      matchingEntry: proof.matchingEntry,
      siblings: proof.siblings,
      root: proof.root,
      membership: proof.membership,
    };
  }

  verifyProof(proof: SmtProof): boolean {
    const { frozen: _, ...smtProof } = proof;
    return this.smt.verifyProof(smtProof);
  }

  getRoot(): string {
    return String(this.smt.root);
  }

  getSize(): number {
    // @ts-ignore — accessing internal nodes map
    const nodes: Map<string, string[]> = this.smt.nodes;
    return nodes.size;
  }

  getEntryCount(): number {
    // @ts-ignore — accessing internal nodes map
    const nodes: Map<string, string[]> = this.smt.nodes;
    let count = 0;
    for (const children of nodes.values()) {
      if (children.length === 3 && children[2] === "1") {
        count++;
      }
    }
    return count;
  }

  getNodeCount(): number {
    return this.getSize();
  }

  checkpoint(): SmtSnapshot {
    // @ts-ignore — accessing internal nodes map
    const nodes: Map<string, string[]> = this.smt.nodes;
    return {
      root: String(this.smt.root),
      nodes: new Map(nodes),
      frozenKeys: this.frozenKeys.size > 0 ? Array.from(this.frozenKeys) : undefined,
    };
  }

  restore(snapshot: SmtSnapshot): void {
    this.smt.root = snapshot.root;
    // @ts-ignore — accessing internal nodes map
    const nodes: Map<string, string[]> = this.smt.nodes;
    nodes.clear();
    for (const [key, value] of snapshot.nodes) {
      nodes.set(key, value);
    }
    this.frozenKeys = new Set(snapshot.frozenKeys ?? []);
  }

  getNodes(): Map<string, string[]> {
    // @ts-ignore — accessing internal nodes map
    return new Map(this.smt.nodes);
  }

  restoreFromState(nodes: Map<string, string[]>, root: string, frozenKeys?: Iterable<string>): void {
    this.smt.root = root;
    // @ts-ignore — accessing internal nodes map
    const internalNodes: Map<string, string[]> = this.smt.nodes;
    internalNodes.clear();
    for (const [key, value] of nodes) {
      internalNodes.set(key, value);
    }
    if (frozenKeys) {
      this.frozenKeys = new Set(frozenKeys);
    }
  }
}
