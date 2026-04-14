import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export function fileHash(filePath: string): string | undefined {
  try {
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
