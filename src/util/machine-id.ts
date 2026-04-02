import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform, arch } from "node:os";

let cached: string | undefined;

export function getMachineId(): string {
  if (cached) return cached;

  let raw: string;
  try {
    raw = readFileSync("/etc/machine-id", "utf-8").trim();
  } catch {
    raw = `${hostname()}-${platform()}-${arch()}`;
  }

  cached = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cached;
}
