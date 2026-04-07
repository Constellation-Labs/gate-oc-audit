/**
 * Encrypted Snapshot — Serialize + encrypt SMT state for DED backup
 *
 * Flow:
 *   SMT nodes Map -> JSON -> AES-256-GCM encrypt -> ciphertext blob
 *   SHA-256(ciphertext) -> documentRef for DED fingerprint
 *   Upload ciphertext as document alongside fingerprint
 *
 * Restore:
 *   Download ciphertext from DED -> decrypt -> JSON -> restore SMT nodes Map
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
  hashDocument: (content: string | Buffer) => string;
};

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

export interface EncryptedSnapshot {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  contentHash: string;
  meta: {
    treeKey: string;
    entryCount: number;
    nodeCount: number;
    root: string;
    createdAt: string;
  };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    N: 2 ** 14,
    r: 8,
    p: 1,
  });
}

export function serializeSmtState(
  nodes: Map<string, string[]>,
  root: string,
): Buffer {
  const obj: Record<string, string[]> = {};
  for (const [key, value] of nodes) {
    obj[key] = value;
  }
  return Buffer.from(sdk.canonicalize({ root, nodes: obj }));
}

export function deserializeSmtState(
  data: Buffer,
): { root: string; nodes: Map<string, string[]> } {
  const obj = JSON.parse(data.toString());
  const nodes = new Map<string, string[]>();
  for (const [key, value] of Object.entries(
    obj.nodes as Record<string, string[]>,
  )) {
    nodes.set(key, value);
  }
  return { root: obj.root, nodes };
}

export function encryptSnapshot(
  nodes: Map<string, string[]>,
  root: string,
  passphrase: string,
  meta: EncryptedSnapshot["meta"],
): EncryptedSnapshot {
  const plaintext = serializeSmtState(nodes, root);

  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const contentHash = sdk.hashDocument(encrypted);

  return {
    version: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: encrypted.toString("base64"),
    contentHash,
    meta,
  };
}

export function decryptSnapshot(
  snapshot: EncryptedSnapshot,
  passphrase: string,
): { root: string; nodes: Map<string, string[]> } {
  const salt = Buffer.from(snapshot.salt, "hex");
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(snapshot.iv, "hex");
  const tag = Buffer.from(snapshot.tag, "hex");
  const ciphertext = Buffer.from(snapshot.ciphertext, "base64");

  const computedHash = sdk.hashDocument(ciphertext);
  if (computedHash !== snapshot.contentHash) {
    throw new Error(
      `Content hash mismatch: expected ${snapshot.contentHash}, got ${computedHash}`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return deserializeSmtState(decrypted);
}

export function getSnapshotBlob(snapshot: EncryptedSnapshot): {
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
