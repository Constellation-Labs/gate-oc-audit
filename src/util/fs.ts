import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

// Cap on synchronous full-file reads. Planted or symlinked large blobs would
// otherwise OOM-kill the audit CLI and DoS the inventory.
export const MAX_HASHABLE_BYTES = 100 * 1024 * 1024;

export function fileHash(filePath: string): string | undefined {
  try {
    if (statSync(filePath).size > MAX_HASHABLE_BYTES) return undefined;
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

export function fileSizeBytes(filePath: string): number | undefined {
  try {
    return statSync(filePath).size;
  } catch {
    return undefined;
  }
}
