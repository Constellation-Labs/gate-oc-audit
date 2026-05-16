// TODO(audit-ui-auth): all routes here are currently registered with
// auth: "plugin" and perform no verification. The plugin relies on the
// gateway being bound to loopback (the openclaw default) for safety. Before
// shipping to networks that don't, switch to auth: "gateway" or implement
// a shared-secret / device-pairing check here.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuditStore, QueryOptions } from "../store/audit-store.js";
import type { SmtService } from "../services/smt-service.js";
import type { Verifier } from "../services/verifier.js";
import type { SmtProof } from "../store/smt-store.js";
import type { AuditEvent } from "../types/events.js";
import { serveStaticFile } from "../util/asset-server.js";
import { pipeExportToResponse, type ExportFilters, type ExportFormat } from "./export.js";
import { log } from "../util/logger.js";

const ROUTE_BASE = "/plugins/audit";
const UI_BASE = `${ROUTE_BASE}/`;
const API_BASE = `${ROUTE_BASE}/api/`;

// Inside dist/, the compiled file sits at dist/ui/routes.js. The built SPA
// lives at dist/control-ui/. Resolve relative so the path is correct in both
// the published tarball and a local `npm run build` checkout.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = join(moduleDir, "..", "control-ui");

interface AuditUiContext {
  store: AuditStore;
  smtService: SmtService;
  verifier: Verifier;
  deBaseUrl?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(buf.length));
  res.setHeader("cache-control", "no-store");
  res.end(buf);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function parseInt32(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function parseUrl(req: IncomingMessage): URL | undefined {
  if (!req.url) return undefined;
  try { return new URL(req.url, "http://localhost"); } catch { return undefined; }
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks, total).toString("utf-8");
  return JSON.parse(text);
}

const CONTENT_PREVIEW_CHARS = 200;

type VerificationStatus = "verified" | "pending" | "tampered" | "untracked";

interface EventVerification {
  status: VerificationStatus;
  treeKey?: string;
}

type EnrichedEvent = AuditEvent & { verification: EventVerification };

function lastAnchoredSequence(ctx: AuditUiContext): number {
  let max = 0;
  for (const cp of ctx.store.getCheckpoints()) {
    if (cp.deTxHash !== null && cp.sequenceEnd > max) max = cp.sequenceEnd;
  }
  return max;
}

function classifyEvent(
  ctx: AuditUiContext,
  event: AuditEvent,
  anchoredSeq: number,
  smtLastSeq: number,
): EventVerification {
  const rawHash = ctx.smtService.computeRawHash(event);
  const treeKey = ctx.smtService.findContainingTreeKey(rawHash);
  if (!treeKey) {
    // Absence of the leaf is only evidence of tampering when the SMT has
    // already processed this sequence. If the SMT's high-water mark is
    // below this event's sequence, the row simply hasn't been replayed in
    // yet (e.g., gateway.stop captured via the SIGINT/SIGTERM signal path,
    // which bypasses the rate-limiter and only enters the SMT on the next
    // plugin start).
    return { status: event.sequence > smtLastSeq ? "untracked" : "tampered" };
  }
  return {
    status: event.sequence <= anchoredSeq ? "verified" : "pending",
    treeKey,
  };
}

function getQueryEvents(ctx: AuditUiContext, url: URL): { events: EnrichedEvent[]; total: number; limit: number; offset: number } {
  // Cap at 100 — per-row verification requires gunzipping the full content of
  // every returned event, so unbounded page sizes would blow up.
  const limit = clamp(parseInt32(url.searchParams.get("limit")) ?? 10, 1, 100);
  const offset = Math.max(0, parseInt32(url.searchParams.get("offset")) ?? 0);
  // Need full content (not just a preview) to recompute rawHash. We trim back
  // to a preview for the wire response so the table payload stays small.
  const opts: QueryOptions = { limit, offset, order: "desc", includeContent: true };
  const eventType = url.searchParams.get("type");
  const category = url.searchParams.get("category");
  const sessionId = url.searchParams.get("session");
  if (eventType) opts.eventType = eventType;
  if (category) opts.category = category;
  if (sessionId) opts.sessionId = sessionId;

  const events = ctx.store.query(opts);
  const anchoredSeq = lastAnchoredSequence(ctx);
  const smtLastSeq = ctx.smtService.getLastCheckpointedSequence();
  const enriched: EnrichedEvent[] = events.map((event) => {
    const verification = classifyEvent(ctx, event, anchoredSeq, smtLastSeq);
    const trimmed = event.content !== undefined && event.content.length > CONTENT_PREVIEW_CHARS
      ? { ...event, content: event.content.slice(0, CONTENT_PREVIEW_CHARS) }
      : event;
    return { ...trimmed, verification };
  });

  return { events: enriched, total: ctx.store.count(), limit, offset };
}

interface VerifyPayload {
  rawHash: string;
  censoredHash: string;
  treesContaining: Array<{ key: string; hasRaw: boolean; hasCensored: boolean }>;
  proof: SmtProof | null;
  verification: { status: "valid" | "invalid" | "unverifiable"; reason?: string };
  anchoredAt: {
    checkpointId: string;
    smtRoot: string;
    deTxHash: string;
    sequenceStart: number;
    sequenceEnd: number;
    createdAt: string;
  } | null;
  deBaseUrl: string | null;
}

function buildVerifyPayload(ctx: AuditUiContext, event: AuditEvent): VerifyPayload {
  const smt = ctx.smtService;
  const rawHash = smt.computeRawHash(event);
  const censoredHash = smt.computeCensoredHash(event);

  const treesContaining = smt.listTrees().map((t) => {
    const proofRaw = smt.createProof(rawHash, t.key);
    const proofCensored = smt.createProof(censoredHash, t.key);
    return {
      key: t.key,
      hasRaw: proofRaw !== null && proofRaw.membership,
      hasCensored: proofCensored !== null && proofCensored.membership,
    };
  });

  const containingKey = smt.findContainingTreeKey(rawHash);
  const proof = containingKey ? smt.createProof(rawHash, containingKey) : null;

  let verification: VerifyPayload["verification"];
  if (!proof) {
    verification = { status: "invalid", reason: "Event content does not hash to a known SMT leaf" };
  } else {
    const knownRoots = smt.getKnownRoots(ctx.store.getCheckpointedRoots());
    const result = smt.verifyProofWithRoots(proof, knownRoots);
    verification = result.status === "valid"
      ? { status: "valid" }
      : { status: result.status, reason: result.reason };
  }

  // First DE-anchored checkpoint whose sequence range covers this event.
  let anchoredAt: VerifyPayload["anchoredAt"] = null;
  for (const cp of ctx.store.getCheckpoints()) {
    if (cp.deTxHash === null) continue;
    if (cp.sequenceStart <= event.sequence && cp.sequenceEnd >= event.sequence) {
      anchoredAt = {
        checkpointId: cp.id,
        smtRoot: cp.smtRoot,
        deTxHash: cp.deTxHash,
        sequenceStart: cp.sequenceStart,
        sequenceEnd: cp.sequenceEnd,
        createdAt: cp.createdAt,
      };
      break;
    }
  }

  return { rawHash, censoredHash, treesContaining, proof, verification, anchoredAt, deBaseUrl: ctx.deBaseUrl ?? null };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuditUiContext,
  apiPath: string,
): Promise<boolean> {
  const url = parseUrl(req);
  if (!url) {
    sendError(res, 400, "invalid url");
    return true;
  }

  // GET /api/events
  if (apiPath === "events" && req.method === "GET") {
    const { events, total, limit, offset } = getQueryEvents(ctx, url);
    sendJson(res, 200, { events, total, limit, offset, degraded: ctx.store.isDegraded() });
    return true;
  }

  // GET /api/events/:id/verify
  if (apiPath.startsWith("events/") && apiPath.endsWith("/verify") && req.method === "GET") {
    const id = decodeURIComponent(apiPath.slice("events/".length, -"/verify".length));
    if (!id) {
      sendError(res, 400, "missing event id");
      return true;
    }
    const event = ctx.store.getById(id, { includeContent: true });
    if (!event) {
      sendError(res, 404, "event not found");
      return true;
    }
    sendJson(res, 200, buildVerifyPayload(ctx, event));
    return true;
  }

  // GET /api/events/:id
  if (apiPath.startsWith("events/") && req.method === "GET") {
    const id = decodeURIComponent(apiPath.slice("events/".length));
    if (!id) {
      sendError(res, 400, "missing event id");
      return true;
    }
    const event = ctx.store.getById(id, { includeContent: true });
    if (!event) {
      sendError(res, 404, "event not found");
      return true;
    }
    sendJson(res, 200, { event });
    return true;
  }

  // GET /api/trees
  if (apiPath === "trees" && req.method === "GET") {
    sendJson(res, 200, { trees: ctx.smtService.listTrees() });
    return true;
  }

  // GET /api/checkpoints
  if (apiPath === "checkpoints" && req.method === "GET") {
    sendJson(res, 200, {
      checkpoints: ctx.store.getCheckpoints(),
      deBaseUrl: ctx.deBaseUrl ?? null,
    });
    return true;
  }

  // POST /api/verify
  if (apiPath === "verify" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "invalid json");
      return true;
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const from = typeof b.from === "string" ? b.from : undefined;
    const to = typeof b.to === "string" ? b.to : undefined;
    if (!from || !to) {
      sendError(res, 400, "from and to (ISO 8601) are required");
      return true;
    }
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      sendError(res, 400, "from and to must be ISO 8601 timestamps");
      return true;
    }
    const result = ctx.verifier.verifyRange({ from, to });
    sendJson(res, 200, result);
    return true;
  }

  // GET /api/export?format=json|csv&from=&to=&type=&category=&session=&securityOnly=&includeContent=
  if (apiPath === "export" && req.method === "GET") {
    const url = parseUrl(req);
    if (!url) {
      sendError(res, 400, "invalid url");
      return true;
    }
    const formatParam = (url.searchParams.get("format") ?? "json").toLowerCase();
    if (formatParam !== "json" && formatParam !== "csv") {
      sendError(res, 400, "format must be 'json' or 'csv'");
      return true;
    }
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    for (const [name, value] of [["from", from], ["to", to]] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        sendError(res, 400, `${name} must be an ISO 8601 timestamp`);
        return true;
      }
    }
    const filters: ExportFilters = {
      from,
      to,
      eventType: url.searchParams.get("type") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      sessionId: url.searchParams.get("session") ?? undefined,
      securityOnly: url.searchParams.get("securityOnly") === "true",
      includeContent: url.searchParams.get("includeContent") === "true",
    };
    await pipeExportToResponse(res, {
      store: ctx.store,
      filters,
      format: formatParam as ExportFormat,
    });
    return true;
  }

  // GET /api/health
  if (apiPath === "health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      degraded: ctx.store.isDegraded(),
      eventCount: ctx.store.count(),
    });
    return true;
  }

  return false;
}

async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  uiPath: string,
): Promise<boolean> {
  // Strip leading slash; empty path => index.html
  const requestPath = uiPath.replace(/^\/+/, "") || "index.html";
  const served = await serveStaticFile(req, res, STATIC_ROOT, requestPath);
  if (served) return true;

  // SPA fallback: serve index.html for unknown sub-paths (no extension), so
  // hash-based or future history-based routes still load the shell.
  if (!/\.[a-z0-9]+$/i.test(requestPath)) {
    return await serveStaticFile(req, res, STATIC_ROOT, "index.html");
  }
  return false;
}

interface RegisterArgs {
  registerHttpRoute: (params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }) => void;
}

export function registerAuditUiRoutes(
  api: RegisterArgs,
  store: AuditStore,
  smtService: SmtService,
  verifier: Verifier,
  deBaseUrl?: string,
): void {
  const ctx: AuditUiContext = { store, smtService, verifier, deBaseUrl };

  api.registerHttpRoute({
    path: API_BASE,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      const url = parseUrl(req);
      if (!url) {
        sendError(res, 400, "invalid url");
        return true;
      }
      // Strip the API_BASE prefix (path may include a basePath we don't know
      // about here; match by suffix to be safe).
      const idx = url.pathname.indexOf(API_BASE);
      if (idx < 0) {
        sendError(res, 404, "not found");
        return true;
      }
      const apiPath = url.pathname.slice(idx + API_BASE.length);
      try {
        const handled = await handleApi(req, res, ctx, apiPath);
        if (!handled) sendError(res, 404, "not found");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`audit-ui api error (${apiPath}): ${msg}`);
        if (!res.headersSent) sendError(res, 500, "internal error");
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: UI_BASE,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      const url = parseUrl(req);
      if (!url) {
        res.statusCode = 400;
        res.end("Bad Request");
        return true;
      }
      const idx = url.pathname.indexOf(UI_BASE);
      if (idx < 0) {
        res.statusCode = 404;
        res.end("Not Found");
        return true;
      }
      const uiPath = url.pathname.slice(idx + UI_BASE.length - 1); // keep leading slash
      try {
        const handled = await handleStatic(req, res, uiPath);
        if (!handled) {
          res.statusCode = 404;
          res.end("Not Found");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`audit-ui static error (${uiPath}): ${msg}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      }
      return true;
    },
  });
}

export const AUDIT_UI_PATH = UI_BASE;
