import type { AuditStore, QueryOptions } from "./store/audit-store.js";
import type { AuditEvent } from "./types/events.js";
import type { NotificationService } from "./services/notifications.js";
import type { SmtService } from "./services/smt-service.js";
import { resolveAuditUiUrl } from "./util/gateway-url.js";
import { streamExport, type ExportFormat } from "./ui/export.js";
import { collectInventory, type CollectOptions, type InventoryKind } from "./services/inventory.js";
import { formatInventoryHuman, formatInventoryJson } from "./ui/inventory-formatter.js";
import { parseDate, parseWeek, parseSince, todayInTz, thisWeekInTz, type TimeZoneMode } from "./reports/time-window.js";
import { buildProjection } from "./reports/projection.js";
import { formatProjectionText } from "./reports/format-text.js";
import { formatProjectionHtml } from "./reports/format-html.js";
import { buildAnomalyView } from "./reports/anomalies-view.js";
import { formatAnomalyViewText } from "./reports/format-anomalies-text.js";
import { formatAnomalyViewHtml } from "./reports/format-anomalies-html.js";
import { buildSessionProjection } from "./reports/session-projection.js";
import { formatSessionProjectionText, serializeSessionProjectionJson } from "./reports/format-session.js";

const CONTENT_PREVIEW_LENGTH = 500;

// Write CLI command output directly to stdout, bypassing console.log. The
// openclaw SDK's routeLogsToStderr() (enabled in CLI dispatch mode to keep
// subsystem-logger noise off stdout) also patches console.log to stderr,
// which would otherwise route this command's actual output to stderr too.
function outLine(s: string): void {
  process.stdout.write(`${s}\n`);
}

export interface AuditListOptions {
  last?: string;
  type?: string;
  category?: string;
  session?: string;
  limit?: string;
  offset?: string;
}

export interface AuditExportOptions {
  type?: string;
  category?: string;
  session?: string;
  limit?: string;
  from?: string;
  to?: string;
  securityOnly?: boolean;
  includeContent?: boolean;
}

function formatEvent(event: AuditEvent): string {
  const time = event.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const session = event.sessionId ? ` [${event.sessionId.slice(0, 8)}]` : "";
  const preview = event.content ? `\n    ${event.content.slice(0, CONTENT_PREVIEW_LENGTH)}` : "";
  return `#${event.sequence} ${time}${session} ${event.eventType} — ${event.description}${preview}`;
}

function buildQueryOpts(opts: { type?: string; category?: string; session?: string; limit?: string }): QueryOptions {
  const q: QueryOptions = {};
  if (opts.type) q.eventType = opts.type;
  if (opts.category) q.category = opts.category;
  if (opts.session) q.sessionId = opts.session;
  if (opts.limit) q.limit = parseInt(opts.limit, 10) || undefined;
  return q;
}

export function cliAuditHandler(store: AuditStore, opts: AuditListOptions): void {
  if (store.isDegraded()) {
    console.error("WARNING: Audit store is in degraded mode. Some events may be missing.\n");
  }

  const q = buildQueryOpts(opts);
  if (opts.last) q.limit = parseInt(opts.last, 10) || 50;
  if (opts.offset) q.offset = parseInt(opts.offset, 10) || 0;
  q.contentPreview = CONTENT_PREVIEW_LENGTH;

  const events = store.query(q);

  if (events.length === 0) {
    outLine("No audit events found.");
    return;
  }

  const total = store.count();
  outLine(`Showing ${events.length} of ${total} events:\n`);

  for (const event of events.reverse()) {
    outLine(formatEvent(event));
  }
}

export async function cliVerifyHandler(
  smtService: SmtService,
  store: AuditStore,
  notifier?: NotificationService,
): Promise<void> {
  await smtService.ensureReady();
  outLine("Verifying audit trail integrity...\n");

  // 1. SMT verification — check trees and sample proofs
  const trees = smtService.listTrees();
  if (trees.length === 0) {
    outLine("No SMT trees found. Events may not have been committed yet.");
  } else {
    let allValid = true;

    const knownRoots = smtService.getKnownRoots(store.getCheckpointedRoots());

    for (const tree of trees) {
      outLine(`SMT tree "${tree.key}": root=${tree.root}, ${tree.entryCount} entries, ${tree.size} nodes`);

      // Sample recent events and verify their proofs
      const recentEvents = store.query({ limit: 10, includeContent: true });
      let verified = 0;
      let failed = 0;
      let errored = 0;

      for (const event of recentEvents) {
        const rawHash = smtService.computeRawHash(event);
        const proof = smtService.createProof(rawHash, tree.key);
        if (proof === null) {
          errored++;
          allValid = false;
          continue;
        }
        if (proof.membership && smtService.verifyProofWithRoots(proof, knownRoots).status === "valid") {
          verified++;
        } else if (!proof.membership) {
          // Event not in this tree — may be in a different tree
        } else {
          failed++;
          allValid = false;
        }
      }

      if (verified > 0) {
        outLine(`  Sampled ${verified} event proof(s) — all valid.`);
      }
      if (errored > 0) {
        const dbPath = `${smtService.getCheckpointDir()}/${tree.key}`;
        console.error(
          `  WARNING: ${errored} proof(s) could not be generated — tree "${tree.key}" state is inconsistent. ` +
            `Checkpoint at ${dbPath} is likely corrupt or was written by an incompatible plugin version.`,
        );
        notifier?.notifyIntegrityViolation(0, `SMT tree ${tree.key} inconsistent — ${errored} proof(s) failed to generate`).catch(() => {});
        process.exitCode = 1;
      }
      if (failed > 0) {
        console.error(`  WARNING: ${failed} proof verification(s) failed.`);
        notifier?.notifyIntegrityViolation(0, `${failed} SMT proof verification(s) failed`).catch(() => {});
        process.exitCode = 1;
      }
    }

    if (allValid && trees.some((t) => t.entryCount > 0)) {
      outLine(`\nOK — ${trees.length} tree(s), all sampled proofs valid.`);
    }
  }

  // 2. DE checkpoint verification
  const checkpoints = store.getCheckpoints();
  if (checkpoints.length > 0) {
    outLine(`\nVerifying ${checkpoints.length} DE checkpoint(s)...`);
    let cpValid = 0;
    let cpFailed = false;

    for (const cp of checkpoints) {
      // The smt_root column stores the SMT root at checkpoint time.
      // We verify it was anchored to DE (not recomputable since SMT root evolves).
      if (cp.deTxHash) {
        cpValid++;
      } else {
        console.error(`  CHECKPOINT ${cp.id}: No DE transaction hash (submission may have failed)`);
        cpFailed = true;
      }
    }

    outLine(`  ${cpValid} anchored to DE`);
    if (!cpFailed) {
      outLine("  All checkpoints have DE transaction hashes.");
    }
  }
}

export async function cliExportHandler(store: AuditStore, format?: string, opts: AuditExportOptions = {}): Promise<void> {
  const fmt: ExportFormat = format === "csv" ? "csv" : "json";
  // `parseInt(...) || undefined` would collapse a legitimate `--limit 0`
  // (and `--limit abc`) into "no cap". Be strict instead.
  let limitRows: number | undefined;
  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer (got "${opts.limit}")`);
    }
    limitRows = n;
  }

  // process.stdout in a TTY is line-buffered and synchronous; piped to a file
  // it can return false. The drain await handles both cases uniformly.
  await streamExport({
    store,
    format: fmt,
    limitRows,
    filters: {
      from: opts.from,
      to: opts.to,
      eventType: opts.type,
      category: opts.category,
      sessionId: opts.session,
      securityOnly: opts.securityOnly === true,
      includeContent: opts.includeContent === true,
    },
    write: (chunk) => process.stdout.write(chunk),
    waitForDrain: () => new Promise<void>((resolve) => process.stdout.once("drain", resolve)),
  });
}

export function cliAuditUiHandler(): void {
  outLine(resolveAuditUiUrl());
}

export interface AuditInventoryOptions {
  json?: boolean;
}

export function cliInventoryHandler(
  store: AuditStore,
  kind: InventoryKind | "summary",
  opts: AuditInventoryOptions,
  collectOpts: CollectOptions,
): void {
  if (store.isDegraded()) {
    console.error("WARNING: Audit store is in degraded mode. Some events may be missing.\n");
  }
  const report = collectInventory(store, kind, collectOpts);
  outLine(opts.json ? formatInventoryJson(report) : formatInventoryHuman(report, kind));
}

export async function cliSmtHandler(
  smtService: SmtService,
  action: string,
  opts: Record<string, string>,
  store?: AuditStore,
): Promise<void> {
  await smtService.ensureReady();
  switch (action) {
    case "root": {
      const result = smtService.getRoot(opts.tree);
      if (!result) {
        outLine("No SMT tree found.");
        return;
      }
      outLine(`Root: ${result.root}`);
      outLine(`Entries: ${result.entryCount}`);
      break;
    }
    case "proof": {
      const proof = smtService.createProof(opts.hash, opts.tree);
      if (!proof) {
        console.error("Tree not found or hash not provided.");
        process.exitCode = 1;
        return;
      }
      outLine(JSON.stringify(proof, null, 2));
      break;
    }
    case "verify-proof": {
      try {
        const proof = JSON.parse(opts.proof);
        const knownRoots = smtService.getKnownRoots(store?.getCheckpointedRoots());
        const result = smtService.verifyProofWithRoots(proof, knownRoots);
        switch (result.status) {
          case "valid":
            outLine("OK — proof is valid.");
            break;
          case "unverifiable":
            console.error(`UNVERIFIABLE — ${result.reason}.`);
            process.exitCode = 2;
            break;
          case "invalid":
            console.error(`INVALID — ${result.reason}.`);
            process.exitCode = 1;
            break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`Failed to parse proof: ${msg}`);
        process.exitCode = 1;
      }
      break;
    }
    case "trees": {
      const trees = smtService.listTrees();
      if (trees.length === 0) {
        outLine("No SMT trees.");
        return;
      }
      for (const tree of trees) {
        outLine(`${tree.key}: root=${tree.root}, ${tree.entryCount} entries, ${tree.size} nodes`);
      }
      break;
    }
    case "chain": {
      const treeKey = opts.tree;
      if (!treeKey) {
        console.error("--tree is required for chain command.");
        process.exitCode = 1;
        return;
      }
      const chain = smtService.getChain(treeKey, opts.conversationId);
      if (chain.length === 0) {
        outLine("No chain entries found.");
        return;
      }
      for (const entry of chain) {
        outLine(`#${entry.seqNo} ${new Date(entry.timestamp * 1000).toISOString()} ${entry.rawHash.slice(0, 16)}... [${entry.auditEventId}]`);
      }
      break;
    }
    default:
      console.error(`Unknown SMT action: ${action}`);
      process.exitCode = 1;
  }
}

export interface AuditReportOptions {
  date?: string;
  week?: string;
  tz?: string;
  json?: boolean;
  html?: boolean;
  dupWindowSec?: string;
  lookbackDays?: string;
  topTools?: string;
}

export function cliReportHandler(
  store: AuditStore,
  period: "daily" | "weekly",
  opts: AuditReportOptions = {},
): void {
  if (store.isDegraded()) {
    console.error("WARNING: Audit store is in degraded mode. Some events may be missing.\n");
  }
  const tz: TimeZoneMode = opts.tz === "local" ? "local" : "utc";
  const window = period === "daily"
    ? parseDate(opts.date ?? todayInTz(tz), tz)
    : parseWeek(opts.week ?? thisWeekInTz(tz), tz);

  const projection = buildProjection(store, window, {
    duplicateOutboundWindowSec: parsePositiveInt(opts.dupWindowSec, "--dup-window-sec", 3600),
    firstSeenLookbackDays: parsePositiveInt(opts.lookbackDays, "--lookback-days", 365),
    topToolsLimit: parsePositiveInt(opts.topTools, "--top-tools", 1000),
  });

  if (opts.json === true) {
    outLine(JSON.stringify(projection));
    return;
  }
  if (opts.html === true) {
    process.stdout.write(formatProjectionHtml(projection));
    return;
  }
  process.stdout.write(formatProjectionText(projection));
}

export interface AuditReportSessionOptions {
  raw?: boolean;
  json?: boolean;
  limit?: string;
  includeMetadata?: boolean;
}

export async function cliReportSessionHandler(
  store: AuditStore,
  smtService: SmtService,
  sessionId: string,
  opts: AuditReportSessionOptions = {},
): Promise<void> {
  if (store.isDegraded()) {
    console.error("WARNING: Audit store is in degraded mode. Some events may be missing.\n");
  }
  if (!sessionId || sessionId.trim() === "") {
    console.error("Session ID is required.");
    process.exitCode = 1;
    return;
  }

  // SmtService is best-effort: only attached when the on-disk SMT tree is
  // present. The read-only CLI may run on a host that has the audit DB but
  // no SMT working state (e.g. during a forensic copy), so any failure to
  // load SMT state should downgrade to "proofs unavailable" rather than
  // fail the whole command.
  let smtForProjection: SmtService | undefined;
  let knownRoots: Set<string> | undefined;
  try {
    await smtService.ensureReady();
    knownRoots = smtService.getKnownRoots(store.getCheckpointedRoots());
    smtForProjection = smtService;
  } catch {
    smtForProjection = undefined;
  }

  const projection = buildSessionProjection(store, sessionId, {
    raw: opts.raw === true,
    limit: parsePositiveInt(opts.limit, "--limit", 50_000),
    smtService: smtForProjection,
    knownRoots,
  });

  if (projection.timeline.length === 0 && opts.json !== true) {
    outLine(`No events found for session ${sessionId}.`);
    return;
  }

  if (opts.json === true) {
    outLine(serializeSessionProjectionJson(projection, opts.includeMetadata === true));
    return;
  }
  process.stdout.write(formatSessionProjectionText(projection));
}

function parsePositiveInt(value: string | undefined, flag: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${value}")`);
  }
  if (n > max) {
    throw new Error(`${flag} must not exceed ${max} (got "${value}")`);
  }
  return n;
}

export interface AuditAnomaliesOptions {
  since?: string;
  until?: string;
  tz?: string;
  json?: boolean;
  html?: boolean;
  dupWindowSec?: string;
  lookbackDays?: string;
  denialWindowSec?: string;
  denialThreshold?: string;
  dropWindowSec?: string;
  dropThreshold?: string;
}

export function cliAnomaliesHandler(
  store: AuditStore,
  smtService: SmtService,
  opts: AuditAnomaliesOptions = {},
): void {
  if (store.isDegraded()) {
    console.error("WARNING: Audit store is in degraded mode. Some events may be missing.\n");
  }
  const tz: TimeZoneMode = opts.tz === "local" ? "local" : "utc";
  const window = parseSince(opts.since ?? "24h", opts.until, tz);

  const view = buildAnomalyView(store, smtService, window, {
    dupWindowSec: parsePositiveInt(opts.dupWindowSec, "--dup-window-sec", 86_400),
    lookbackDays: parsePositiveInt(opts.lookbackDays, "--lookback-days", 365),
    denialWindowSec: parsePositiveInt(opts.denialWindowSec, "--denial-window-sec", 86_400),
    denialThreshold: parsePositiveInt(opts.denialThreshold, "--denial-threshold", 1_000_000),
    dropWindowSec: parsePositiveInt(opts.dropWindowSec, "--drop-window-sec", 86_400),
    dropThreshold: parsePositiveInt(opts.dropThreshold, "--drop-threshold", 1_000_000),
  });

  if (opts.json === true) {
    outLine(JSON.stringify(view));
    return;
  }
  if (opts.html === true) {
    process.stdout.write(formatAnomalyViewHtml(view));
    return;
  }
  process.stdout.write(formatAnomalyViewText(view));
}
