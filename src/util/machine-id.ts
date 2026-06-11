import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform, arch } from "node:os";

let cached: string | undefined;

/**
 * Try /etc/machine-id (Linux/systemd) or /var/lib/dbus/machine-id. This is the
 * only stable-id source on any OS; off-Linux it returns undefined by design and
 * getMachineId() intentionally falls back to a hostname/platform/arch hash.
 */
function linuxMachineId(): string | undefined {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(path, "utf-8").trim();
      if (id) return id;
    } catch {}
  }
  return undefined;
}

export function getMachineId(): string {
  if (cached) return cached;

  const raw = linuxMachineId() ?? `${hostname()}-${platform()}-${arch()}`;

  cached = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cached;
}