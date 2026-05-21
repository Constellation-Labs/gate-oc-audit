/**
 * Parse the `<jobId>.cron.<...>.json` manifest files that the openclaw runtime
 * keeps in the openclaw root and expose them as a small {name, schedule} shape
 * that reports can render. We only read what the user-facing reports need —
 * deeper fields (payload, delivery, sessionTarget, …) stay opaque so a future
 * openclaw schema change can't break the audit reports.
 */

import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeOutput } from "./inventory.js";

export type ParsedCronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "unknown"; raw: string };

export interface ConfiguredCron {
  /** Stem before `.cron.` in the filename. Matches the `jobId` used by
   *  `audit report cron <job-id>` and the `cron.executed` audit events. */
  name: string;
  schedule: ParsedCronSchedule;
}

/** Substring marker that identifies a cron manifest filename. Mirrors the
 *  pattern used by `src/services/inventory.ts:listRootFilesMatching`. */
const MARKER = ".cron.";

/** Upper bound on the bytes we'll read from a single manifest. Real openclaw
 *  manifests are well under 1 KiB; the cap exists so a planted `/dev/zero`
 *  symlink (or accidentally-truncated logfile sharing the `.cron.` substring)
 *  can't burn unbounded memory in the audit-report path. */
const MAX_MANIFEST_BYTES = 64 * 1024;

// Strings read out of `.cron.*.json` end up rendered to operator terminals
// (text/HTML reports) and POSTed to digest webhooks. The manifests are
// operator-curated, but a hostile filename or edited manifest could still
// embed CR/LF/ANSI that splices report lines or escapes log fields. Sanitise
// at the loader boundary so every consumer (text, HTML, JSON, webhook)
// receives the cleaned value — mirrors the same defense the inventory module
// applies to its own filesystem-sourced strings.
function parseSchedule(raw: unknown): ParsedCronSchedule {
  if (raw === null || typeof raw !== "object") {
    return {
      kind: "unknown",
      raw: sanitizeOutput(typeof raw === "string" ? raw : JSON.stringify(raw)),
    };
  }
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (kind === "at" && typeof r.at === "string") {
    return { kind: "at", at: sanitizeOutput(r.at) };
  }
  if (kind === "every" && typeof r.everyMs === "number") {
    return {
      kind: "every",
      everyMs: r.everyMs,
      ...(typeof r.anchorMs === "number" ? { anchorMs: r.anchorMs } : {}),
    };
  }
  if (kind === "cron" && typeof r.expr === "string") {
    return {
      kind: "cron",
      expr: sanitizeOutput(r.expr),
      ...(typeof r.tz === "string" ? { tz: sanitizeOutput(r.tz) } : {}),
      ...(typeof r.staggerMs === "number" ? { staggerMs: r.staggerMs } : {}),
    };
  }
  return { kind: "unknown", raw: sanitizeOutput(JSON.stringify(raw)) };
}

function readOne(path: string, name: string): ConfiguredCron {
  // Open-then-fstat-then-read against the SAME fd so the size check
  // applies to the same inode the subsequent read consumes. A plain
  // `statSync(path) + readFileSync(path)` pair has a TOCTOU window
  // where the path can be swapped between syscalls; opening once
  // collapses that window — the read pulls the inode we already
  // measured even if the directory entry now points elsewhere.
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    if (st.size > MAX_MANIFEST_BYTES) {
      return { name, schedule: { kind: "unknown", raw: "<oversize>" } };
    }
    const text = readFileSync(fd, "utf8");
    const doc = JSON.parse(text) as unknown;
    if (doc === null || typeof doc !== "object") {
      return { name, schedule: { kind: "unknown", raw: "<not-an-object>" } };
    }
    return {
      name,
      schedule: parseSchedule((doc as Record<string, unknown>).schedule),
    };
  } catch {
    return { name, schedule: { kind: "unknown", raw: "<unreadable>" } };
  } finally {
    // readFileSync(fd) does NOT close the fd on its own (unlike
    // readFileSync(path)); close explicitly so a parse exception above
    // doesn't leak the descriptor.
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* fd may already be closed; ignore */ }
    }
  }
}

function isSafeManifestFile(openclawDir: string, fileName: string): boolean {
  if (!fileName.endsWith(".json")) return false;
  if (!fileName.includes(MARKER)) return false;
  // Reject symlinks so a hostile entry in `openclawDir` can't redirect the
  // read at /etc/shadow, /dev/zero, or anywhere else outside the trust root.
  // Matches the convention in `src/services/inventory.ts:isSymlink`.
  try {
    return !lstatSync(join(openclawDir, fileName)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Lists `<openclawDir>/<stem>.cron.*.json` manifests in stable (locale)
 *  order. Symlinks and oversized files are filtered out. Returns `[]` when
 *  the directory does not exist or cannot be read. */
export function listConfiguredCrons(openclawDir: string): ConfiguredCron[] {
  if (!existsSync(openclawDir)) return [];
  let entries;
  try {
    entries = readdirSync(openclawDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ConfiguredCron[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!isSafeManifestFile(openclawDir, e.name)) continue;
    const stem = e.name.split(MARKER)[0];
    if (!stem) continue;
    // Sanitize the stem too — filenames may legally embed CR/LF on POSIX.
    out.push(readOne(join(openclawDir, e.name), sanitizeOutput(stem)));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Returns the single manifest whose stem matches `jobId`, or null. */
export function findConfiguredCron(openclawDir: string, jobId: string): ConfiguredCron | null {
  return listConfiguredCrons(openclawDir).find((c) => c.name === jobId) ?? null;
}

/** Compact one-line rendering of a schedule for text/HTML reports. */
export function formatCronSchedule(s: ParsedCronSchedule): string {
  switch (s.kind) {
    case "at":
      return `at ${s.at}`;
    case "every":
      return `every ${s.everyMs}ms`;
    case "cron":
      return s.tz ? `cron ${s.expr} (${s.tz})` : `cron ${s.expr}`;
    case "unknown":
      return `unknown (${s.raw.slice(0, 80)})`;
  }
}
