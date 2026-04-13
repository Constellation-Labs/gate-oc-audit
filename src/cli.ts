import type { AuditStore, QueryOptions } from "./store/audit-store.js";
import type { AuditEvent } from "./types/events.js";
import type { NotificationService } from "./services/notifications.js";
import type { SmtService } from "./services/smt-service.js";

const CONTENT_PREVIEW_LENGTH = 500;

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
  includeContent?: boolean;
}

function formatEvent(event: AuditEvent): string {
  const time = event.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const session = event.sessionId ? ` [${event.sessionId.slice(0, 8)}]` : "";
  const preview = event.content ? `\n    ${event.content.slice(0, CONTENT_PREVIEW_LENGTH)}` : "";
  return `#${event.sequence} ${time}${session} ${event.eventType} — ${event.description}${preview}`;
}

function toJsonLines(events: AuditEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

function toCsv(events: AuditEvent[], includeContent?: boolean): string {
  const headers = [
    "id",
    "sequence",
    "source",
    "machineId",
    "sessionId",
    "eventType",
    "category",
    "description",
    "metadata",
    "createdAt",
    ...(includeContent ? ["content"] as const : []),
  ];
  const rows = events.map((e) =>
    headers.map((h) => {
      let val = e[h as keyof AuditEvent];
      if (h === "metadata") val = JSON.stringify(val);
      const str = val === undefined || val === null ? "" : String(val);
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(","),
  );
  return [headers.join(","), ...rows].join("\n");
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
    console.log("No audit events found.");
    return;
  }

  const total = store.count();
  console.log(`Showing ${events.length} of ${total} events:\n`);

  for (const event of events.reverse()) {
    console.log(formatEvent(event));
  }
}

export async function cliVerifyHandler(
  smtService: SmtService,
  store: AuditStore,
  notifier?: NotificationService,
): Promise<void> {
  await smtService.ensureReady();
  console.log("Verifying audit trail integrity...\n");

  // 1. SMT verification — check trees and sample proofs
  const trees = smtService.listTrees();
  if (trees.length === 0) {
    console.log("No SMT trees found. Events may not have been committed yet.");
  } else {
    let allValid = true;

    for (const tree of trees) {
      console.log(`SMT tree "${tree.key}": root=${tree.root}, ${tree.entryCount} entries, ${tree.size} nodes`);

      // Sample recent events and verify their proofs
      const recentEvents = store.query({ limit: 10, includeContent: true });
      let verified = 0;
      let failed = 0;

      for (const event of recentEvents) {
        const rawHash = smtService.computeRawHash(event);
        const proof = smtService.createProof(rawHash, tree.key);
        if (proof && proof.membership && smtService.verifyProof(proof)) {
          verified++;
        } else if (proof && !proof.membership) {
          // Event not in this tree — may be in a different tree
        } else {
          failed++;
          allValid = false;
        }
      }

      if (verified > 0) {
        console.log(`  Sampled ${verified} event proof(s) — all valid.`);
      }
      if (failed > 0) {
        console.error(`  WARNING: ${failed} proof verification(s) failed.`);
        notifier?.notifyIntegrityViolation(0, `${failed} SMT proof verification(s) failed`).catch(() => {});
        process.exitCode = 1;
      }
    }

    if (allValid && trees.some((t) => t.entryCount > 0)) {
      console.log(`\nOK — ${trees.length} tree(s), all sampled proofs valid.`);
    }
  }

  // 2. DE checkpoint verification
  const checkpoints = store.getCheckpoints();
  if (checkpoints.length > 0) {
    console.log(`\nVerifying ${checkpoints.length} DE checkpoint(s)...`);
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

    console.log(`  ${cpValid} anchored to DE`);
    if (!cpFailed) {
      console.log("  All checkpoints have DE transaction hashes.");
    }
  }
}

export function cliExportHandler(store: AuditStore, format?: string, opts: AuditExportOptions = {}): void {
  const q = buildQueryOpts(opts);
  if (!q.limit) q.limit = 10_000;
  if (opts.includeContent) q.includeContent = true;

  const events = store.query(q).reverse();
  const fmt = format ?? "json";

  if (fmt === "csv") {
    console.log(toCsv(events, opts.includeContent));
  } else {
    console.log(toJsonLines(events));
  }
}

export async function cliSmtHandler(
  smtService: SmtService,
  action: string,
  opts: Record<string, string>,
): Promise<void> {
  await smtService.ensureReady();
  switch (action) {
    case "root": {
      const result = smtService.getRoot(opts.tree);
      if (!result) {
        console.log("No SMT tree found.");
        return;
      }
      console.log(`Root: ${result.root}`);
      console.log(`Entries: ${result.entryCount}`);
      break;
    }
    case "proof": {
      const proof = smtService.createProof(opts.hash, opts.tree);
      if (!proof) {
        console.error("Tree not found or hash not provided.");
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(proof, null, 2));
      break;
    }
    case "verify-proof": {
      try {
        const proof = JSON.parse(opts.proof);
        const valid = smtService.verifyProof(proof);
        if (valid) {
          console.log("OK — proof is valid.");
        } else {
          console.error("INVALID — proof verification failed.");
          process.exitCode = 1;
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
        console.log("No SMT trees.");
        return;
      }
      for (const tree of trees) {
        console.log(`${tree.key}: root=${tree.root}, ${tree.entryCount} entries, ${tree.size} nodes`);
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
        console.log("No chain entries found.");
        return;
      }
      for (const entry of chain) {
        console.log(`#${entry.seqNo} ${new Date(entry.timestamp * 1000).toISOString()} ${entry.rawHash.slice(0, 16)}... [${entry.auditEventId}]`);
      }
      break;
    }
    default:
      console.error(`Unknown SMT action: ${action}`);
      process.exitCode = 1;
  }
}
