/**
 * SMT Snapshot — Serialize SMT state for backup and restore.
 *
 * Flow:
 *   SMT nodes Map -> canonical JSON -> SHA-256 content hash
 *
 * Restore:
 *   JSON -> verify content hash -> restore SMT nodes Map
 */

import { createRequire } from "module";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
  hashDocument: (content: string | Buffer) => string;
};

export interface Snapshot {
  version: 1;
  contentHash: string;
  data: string;
  meta: {
    treeKey: string;
    entryCount: number;
    nodeCount: number;
    root: string;
    createdAt: string;
  };
}

export function serializeSmtState(
  nodes: Map<string, string[]>,
  root: string,
  frozenKeys?: string[],
): Buffer {
  const obj: Record<string, string[]> = {};
  for (const [key, value] of nodes) {
    obj[key] = value;
  }
  const payload: Record<string, unknown> = { root, nodes: obj };
  if (frozenKeys && frozenKeys.length > 0) {
    payload.frozenKeys = frozenKeys;
  }
  return Buffer.from(sdk.canonicalize(payload));
}

export function deserializeSmtState(
  data: Buffer,
): { root: string; nodes: Map<string, string[]>; frozenKeys?: string[] } {
  const obj = JSON.parse(data.toString());
  const nodes = new Map<string, string[]>();
  for (const [key, value] of Object.entries(
    obj.nodes as Record<string, string[]>,
  )) {
    nodes.set(key, value);
  }
  return {
    root: obj.root,
    nodes,
    frozenKeys: Array.isArray(obj.frozenKeys) ? obj.frozenKeys : undefined,
  };
}

export function createSnapshot(
  nodes: Map<string, string[]>,
  root: string,
  meta: Snapshot["meta"],
  frozenKeys?: string[],
): Snapshot {
  const serialized = serializeSmtState(nodes, root, frozenKeys);
  const contentHash = sdk.hashDocument(serialized);

  return {
    version: 1,
    contentHash,
    data: serialized.toString("base64"),
    meta,
  };
}

export function restoreSnapshot(
  snapshot: Snapshot,
): { root: string; nodes: Map<string, string[]>; frozenKeys?: string[] } {
  const raw = Buffer.from(snapshot.data, "base64");

  const computedHash = sdk.hashDocument(raw);
  if (computedHash !== snapshot.contentHash) {
    throw new Error(
      `Content hash mismatch: expected ${snapshot.contentHash}, got ${computedHash}`,
    );
  }

  return deserializeSmtState(raw);
}

export function getSnapshotBlob(snapshot: Snapshot): {
  blob: Buffer;
  contentHash: string;
  mimeType: string;
} {
  const blob = Buffer.from(sdk.canonicalize(snapshot));
  const contentHash = sdk.hashDocument(blob);

  return {
    blob,
    contentHash,
    mimeType: "application/json",
  };
}
