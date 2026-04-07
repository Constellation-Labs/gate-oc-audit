import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform, arch } from "node:os";

let cached: string | undefined;

/** Try /etc/machine-id (Linux/systemd). */
function linuxMachineId(): string | undefined {
  try {
    const id = readFileSync("/etc/machine-id", "utf-8").trim();
    if (id) return id;
  } catch {}
  return undefined;
}

/** Try macOS-specific machine ID files. */
function macosMachineId(): string | undefined {
  if (platform() !== "darwin") return undefined;
  try {
    // Hardware UUID is also available via system profiler plist cache
    const id = readFileSync("/Library/Preferences/SystemConfiguration/com.apple.computer-plist", "utf-8");
    const match = id.match(/<string>([0-9A-F-]{36})<\/string>/);
    if (match?.[1]) return match[1];
  } catch {}
  return undefined;
}

export function getMachineId(): string {
  if (cached) return cached;

  const raw =
    linuxMachineId() ??
    macosMachineId() ??
    `${hostname()}-${platform()}-${arch()}`;

  cached = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cached;
}