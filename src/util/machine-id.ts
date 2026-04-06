import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

/** Try IOPlatformUUID on macOS. */
function macosUuid(): string | undefined {
  if (platform() !== "darwin") return undefined;
  try {
    const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", { encoding: "utf-8", timeout: 3000 });
    const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  } catch {}
  return undefined;
}

export function getMachineId(): string {
  if (cached) return cached;

  const raw =
    linuxMachineId() ??
    macosUuid() ??
    `${hostname()}-${platform()}-${arch()}`;

  cached = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cached;
}