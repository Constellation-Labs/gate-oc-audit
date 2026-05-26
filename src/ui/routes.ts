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
import { parseDate, parseWeek, todayInTz, thisWeekInTz, type TimeZoneMode } from "../reports/time-window.js";
import { buildProjection } from "../reports/projection.js";
import { formatProjectionHtml } from "../reports/format-html.js";
import { buildCronRollup, formatCronRollupHtml, DEFAULT_LAST as CRON_DEFAULT_LAST, MAX_LAST as CRON_MAX_LAST } from "../reports/cron-rollup.js";
import { buildStatusSnapshot } from "../reports/status-snapshot.js";
import { ANCHOR_HEALTH_NAME, type AnchorHealth } from "../services/de-anchor.js";
import { RETENTION_HEALTH_NAME, DEFAULT_RETENTION_DAYS, DEFAULT_MAX_SIZE_MB, type RetentionHealth } from "../services/retention.js";
import { collectInventory } from "../services/inventory.js";
import { buildSessionProjection } from "../reports/session-projection.js";

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
  /** In-flight counts, scoped to this registration so a double-register
   *  call doesn't share state across instances. */
  concurrency: ConcurrencyState;
  deBaseUrl?: string;
  /**
   * Predicate evaluated at request time so the gate reflects the live
   * gateway bind setting, not the value at plugin-registration time.
   */
  isNonLoopback: () => boolean;
  /**
   * Operator opt-in to keep /api/export enabled when the gateway binds
   * beyond loopback. Off by default — the export is the highest-blast-
   * radius endpoint in this plugin (raw conversation content) and the
   * existing UI routes are documented as relying on loopback for safety.
   */
  allowExportOnNonLoopback: boolean;
  /**
   * Operator opt-in to keep /api/verify enabled when the gateway binds
   * beyond loopback. Off by default — verification gunzips and rehashes
   * every event in the audit log, which is the same blast radius as the
   * export (CPU-bound full-table scan).
   */
  allowVerifyOnNonLoopback: boolean;
  /**
   * Openclaw root used to populate `cron.configured` in the projection
   * returned by /api/report. Omit to suppress configured cron manifests
   * from the HTTP response.
   */
  openclawDir?: string;
  /**
   * Runtime metadata + config snapshot required by /api/status. Carrying
   * the same triple here that `cliStatusHandler` receives means the HTTP
   * route is a pure mirror of the CLI handler — no duplicated config
   * lookup logic. When undefined the /api/status route returns 503.
   */
  statusContext?: StatusContext;
}

export interface StatusContext {
  pluginName: string;
  pluginVersion: string;
  /** Plugin config as passed by openclaw; read by reference (no copy). */
  config: Record<string, unknown>;
}

/**
 * Strict ISO 8601 — `2026-05-16T12:34:56(.789)?(Z|±HH:MM|±HHMM)`. Reject
 * anything Date.parse would silently accept (`"2020-1-1"`, `"Jan 1 2020"`,
 * `"01/01/2020"`) so a malformed input produces a 400 instead of a
 * silently wrong-range export.
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Bound the number of /api/export requests in flight. A single export
 * holds a SQLite reader (preventing WAL checkpoint truncation) plus
 * gunzip + serialisation on the event loop, so a handful of parallel
 * exports can DoS the plugin even on loopback.
 */
const MAX_CONCURRENT_EXPORTS = 2;
const EXPORT_LIMIT_HARD_CAP = 10_000_000;

/**
 * Bound /api/verify the same way. A verification walks every event with
 * `includeContent: true` (gunzip + rehash), and on root mismatch it makes a
 * second full pass to locate the tampered range — so concurrent verifies
 * pin the event loop on CPU work.
 */
const MAX_CONCURRENT_VERIFIES = 2;

/** Per-registration mutable concurrency counters. Held inside the closure
 *  of registerAuditUiRoutes so a double registration doesn't share state
 *  across instances. */
interface ConcurrencyState {
  exports: number;
  verifies: number;
}

function setSecurityHeaders(res: ServerResponse): void {
  // Defense-in-depth headers for the audit UI/API. The plugin is intended
  // to run on loopback, so the main goal is to neutralise browser-side
  // attacks: clickjacking , MIME sniffing,
  // referrer leakage to externally-loaded resources, and third-party
  // script execution inside the SPA.
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  setSecurityHeaders(res);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(buf.length));
  res.setHeader("cache-control", "no-store");
  res.end(buf);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Same-origin gate for the /api/* surface. Requests with no Origin pass
 * through (curl, server-to-server — not browser-driven CSRF); requests
 * with an Origin must match the request's Host header. Stops a hostile
 * page the operator visits from dispatching state-changing requests or
 * scraping raw conversation content even when CORS would block the read,
 * because the request *dispatch* still hits the server.
 */
function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === "" || origin === "null") return true;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  const host = req.headers.host ?? "";
  if (host.length === 0) return false;
  return parsed.host === host;
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
    // already processed this sequence AND chose to track it. Three cases
    // are NOT tampering:
    //  - event.sequence > smtLastSeq: not yet replayed (e.g., gateway.stop
    //    captured via the SIGINT/SIGTERM signal path, which bypasses the
    //    rate-limiter and only enters the SMT on the next plugin start).
    //  - smtService.wasSkipped: the SMT looked at this seq and skipped it
    //    by policy (frozen leaf or insertEntry rejected).
    if (event.sequence > smtLastSeq || ctx.smtService.wasSkipped(event.sequence)) {
      return { status: "untracked" };
    }
    return { status: "tampered" };
  }
  return {
    status: event.sequence <= anchoredSeq ? "verified" : "pending",
    treeKey,
  };
}

/** Maximum length of a single GET query-parameter value before we reject the
 *  request. JSON bodies are already bounded by MAX_JSON_BODY_BYTES; URL
 *  parameters need their own cap so a 1 MiB `?session=AAA...` can't pin the
 *  event loop in URLSearchParams parsing. */
const MAX_QUERY_PARAM_LEN = 1024;

function tooLongParam(values: ReadonlyArray<string | null | undefined>): boolean {
  for (const v of values) {
    if (typeof v === "string" && v.length > MAX_QUERY_PARAM_LEN) return true;
  }
  return false;
}

function getQueryEvents(ctx: AuditUiContext, url: URL): { events: EnrichedEvent[]; total: number; limit: number; offset: number } | { tooLong: true } {
  // Cap at 100 — per-row verification requires gunzipping the full content of
  // every returned event, so unbounded page sizes would blow up.
  const limit = clamp(parseInt32(url.searchParams.get("limit")) ?? 10, 1, 100);
  // Reject focusSeq < 1: sequences are always ≥ 1, so anything else is a
  // malformed request (and `count({afterSequence:0})` returns the full
  // total, which would snap to the last page — surprising and meaningless).
  const focusSeqRaw = parseInt32(url.searchParams.get("focusSeq"));
  const focusSeq = focusSeqRaw !== undefined && focusSeqRaw >= 1 ? focusSeqRaw : undefined;
  // Need full content (not just a preview) to recompute rawHash. We trim back
  // to a preview for the wire response so the table payload stays small.
  const opts: QueryOptions = { limit, order: "desc", includeContent: true };
  // Filters are dropped when focusSeq is in play: combining them can hide
  // the focused row from its own page, which defeats the marker. The only
  // caller (event-table.syncFromHash) already clears its filters in this
  // case; making the server enforce the same invariant means a hand-crafted
  // URL behaves like the UI.
  if (focusSeq === undefined) {
    const eventType = url.searchParams.get("type");
    const category = url.searchParams.get("category");
    const sessionId = url.searchParams.get("session");
    if (tooLongParam([eventType, category, sessionId])) {
      return { tooLong: true };
    }
    if (eventType) opts.eventType = eventType;
    if (category) opts.category = category;
    if (sessionId) opts.sessionId = sessionId;
  }

  // When focusSeq is set, override the client's offset to land on the page
  // that contains the focused sequence. Position in a desc-ordered listing
  // equals the number of events with a greater sequence.
  let offset: number;
  if (focusSeq !== undefined) {
    const position = ctx.store.count({ afterSequence: focusSeq });
    offset = Math.floor(position / limit) * limit;
  } else {
    offset = Math.max(0, parseInt32(url.searchParams.get("offset")) ?? 0);
  }
  opts.offset = offset;

  const events = ctx.store.query(opts);
  const anchoredSeq = lastAnchoredSequence(ctx);
  const smtLastSeq = ctx.smtService.getLastInsertedSequence();
  const enriched: EnrichedEvent[] = events.map((event) => {
    const verification = classifyEvent(ctx, event, anchoredSeq, smtLastSeq);
    const trimmed = event.content !== undefined && event.content.length > CONTENT_PREVIEW_CHARS
      ? { ...event, content: event.content.slice(0, CONTENT_PREVIEW_CHARS) }
      : event;
    return { ...trimmed, verification };
  });

  return { events: enriched, total: ctx.store.count(opts), limit, offset };
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
    const result = getQueryEvents(ctx, url);
    if ("tooLong" in result) {
      sendError(res, 400, `query parameter exceeds ${MAX_QUERY_PARAM_LEN} bytes`);
      return true;
    }
    sendJson(res, 200, { ...result, degraded: ctx.store.isDegraded() });
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
    if (ctx.isNonLoopback() && !ctx.allowVerifyOnNonLoopback) {
      sendError(
        res,
        403,
        "audit verify is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowVerifyOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    if (ctx.concurrency.verifies >= MAX_CONCURRENT_VERIFIES) {
      res.setHeader("retry-after", "10");
      sendError(res, 503, `at most ${MAX_CONCURRENT_VERIFIES} concurrent verifies allowed`);
      return true;
    }
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
    if (!ISO_8601_RE.test(from) || !ISO_8601_RE.test(to)) {
      sendError(res, 400, "from and to must be ISO 8601 timestamps");
      return true;
    }
    ctx.concurrency.verifies++;
    try {
      const result = ctx.verifier.verifyRange({ from, to });
      sendJson(res, 200, result);
    } finally {
      ctx.concurrency.verifies--;
    }
    return true;
  }

  // GET /api/export?format=json|csv&from=&to=&type=&category=&session=&securityOnly=&includeContent=&limit=
  if (apiPath === "export" && req.method === "GET") {
    if (ctx.isNonLoopback() && !ctx.allowExportOnNonLoopback) {
      sendError(
        res,
        403,
        "audit export is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowExportOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    if (ctx.concurrency.exports >= MAX_CONCURRENT_EXPORTS) {
      res.setHeader("retry-after", "10");
      sendError(res, 503, `at most ${MAX_CONCURRENT_EXPORTS} concurrent exports allowed`);
      return true;
    }
    const formatParam = (url.searchParams.get("format") ?? "json").toLowerCase();
    if (formatParam !== "json" && formatParam !== "csv") {
      sendError(res, 400, "format must be 'json' or 'csv'");
      return true;
    }
    const format: ExportFormat = formatParam;
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    for (const [name, value] of [["from", from], ["to", to]] as const) {
      if (value !== undefined && !ISO_8601_RE.test(value)) {
        sendError(res, 400, `${name} must be an ISO 8601 timestamp`);
        return true;
      }
    }
    const limitParam = url.searchParams.get("limit");
    let limitRows: number | undefined;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isInteger(n) || n <= 0) {
        sendError(res, 400, "limit must be a positive integer");
        return true;
      }
      limitRows = Math.min(n, EXPORT_LIMIT_HARD_CAP);
    }
    const exportType = url.searchParams.get("type") ?? undefined;
    const exportCategory = url.searchParams.get("category") ?? undefined;
    const exportSession = url.searchParams.get("session") ?? undefined;
    if (tooLongParam([exportType, exportCategory, exportSession])) {
      sendError(res, 400, `query parameter exceeds ${MAX_QUERY_PARAM_LEN} bytes`);
      return true;
    }
    const filters: ExportFilters = {
      from,
      to,
      eventType: exportType,
      category: exportCategory,
      sessionId: exportSession,
      securityOnly: url.searchParams.get("securityOnly") === "true",
      includeContent: url.searchParams.get("includeContent") === "true",
    };
    ctx.concurrency.exports++;
    try {
      await pipeExportToResponse(res, { store: ctx.store, filters, format, limitRows });
    } finally {
      ctx.concurrency.exports--;
    }
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

  // GET /api/report?period=daily|weekly&date=YYYY-MM-DD&week=YYYY-Www&tz=local|utc&format=json|html
  if (apiPath === "report" && req.method === "GET") {
    // Match /api/export's caution: the report surfaces aggregated channel,
    // recipient, tool, and content-hash metadata. The other /api/* routes
    // also leak similar metadata without this gate, but those predate the
    // explicit non-loopback policy switch — new routes opt in to the gate
    // so the policy can be tightened by default in a later pass.
    if (ctx.isNonLoopback() && !ctx.allowExportOnNonLoopback) {
      sendError(
        res,
        403,
        "audit report is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowExportOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    const period = url.searchParams.get("period");
    if (period !== "daily" && period !== "weekly") {
      sendError(res, 400, "period must be 'daily' or 'weekly'");
      return true;
    }
    const tzParam = url.searchParams.get("tz");
    if (tzParam !== null && tzParam !== "local" && tzParam !== "utc") {
      sendError(res, 400, "tz must be 'local' or 'utc'");
      return true;
    }
    const tz: TimeZoneMode = tzParam === "local" ? "local" : "utc";
    let window;
    try {
      if (period === "daily") {
        window = parseDate(url.searchParams.get("date") ?? todayInTz(tz), tz);
      } else {
        window = parseWeek(url.searchParams.get("week") ?? thisWeekInTz(tz), tz);
      }
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "invalid window");
      return true;
    }
    const dupWindow = parseOptPositiveInt(url.searchParams.get("dupWindowSec"), 3600);
    const lookback = parseOptPositiveInt(url.searchParams.get("lookbackDays"), 365);
    const topTools = parseOptPositiveInt(url.searchParams.get("topTools"), 1000);
    if (dupWindow === "invalid" || lookback === "invalid" || topTools === "invalid") {
      sendError(
        res,
        400,
        "dupWindowSec (1..3600), lookbackDays (1..365), and topTools (1..1000) must be positive integers within range",
      );
      return true;
    }
    const projection = buildProjection(ctx.store, window, {
      duplicateOutboundWindowSec: dupWindow,
      firstSeenLookbackDays: lookback,
      topToolsLimit: topTools,
      openclawDir: ctx.openclawDir,
    });
    const format = (url.searchParams.get("format") ?? "json").toLowerCase();
    if (format === "html") {
      const body = Buffer.from(formatProjectionHtml(projection));
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-length", String(body.length));
      res.setHeader("cache-control", "no-store");
      res.end(body);
      return true;
    }
    if (format !== "json") {
      sendError(res, 400, "format must be 'json' or 'html'");
      return true;
    }
    sendJson(res, 200, projection);
    return true;
  }

  // GET /api/report/cron/<job-id>?last=N&format=json|html
  if (apiPath.startsWith("report/cron/") && req.method === "GET") {
    // Same loopback gate as /api/report. The rollup surfaces aggregated
    // run-level metadata (jobId, runId, sessionId, error strings) — narrow
    // by intent but the same blast radius as a digest slice.
    if (ctx.isNonLoopback() && !ctx.allowExportOnNonLoopback) {
      sendError(
        res,
        403,
        "audit report is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowExportOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    const jobId = decodeURIComponent(apiPath.slice("report/cron/".length));
    if (!jobId) {
      sendError(res, 400, "missing job-id");
      return true;
    }
    const lastParam = parseOptPositiveInt(url.searchParams.get("last"), CRON_MAX_LAST);
    if (lastParam === "invalid") {
      sendError(res, 400, `last must be a positive integer in 1..${CRON_MAX_LAST}`);
      return true;
    }
    const rollup = buildCronRollup(ctx.store, jobId, {
      last: lastParam ?? CRON_DEFAULT_LAST,
      openclawDir: ctx.openclawDir,
    });
    const format = (url.searchParams.get("format") ?? "json").toLowerCase();
    if (format === "html") {
      const body = Buffer.from(formatCronRollupHtml(rollup));
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-length", String(body.length));
      res.setHeader("cache-control", "no-store");
      res.end(body);
      return true;
    }
    if (format !== "json") {
      sendError(res, 400, "format must be 'json' or 'html'");
      return true;
    }
    sendJson(res, 200, rollup);
    return true;
  }

  // GET /api/report/session/:id?raw=&limit=&includeMetadata=
  if (apiPath.startsWith("report/session/") && req.method === "GET") {
  if (ctx.isNonLoopback() && !ctx.allowExportOnNonLoopback) {
  sendError(
  res,
  403,
  "audit report is disabled when the gateway binds beyond loopback. " +
  "Set audit config 'allowExportOnNonLoopback: true' to opt in.",
  );
  return true;
  }
  const sessionId = decodeURIComponent(apiPath.slice("report/session/".length));
  if (!sessionId) {
  sendError(res, 400, "missing session id");
  return true;
  }
  if (sessionId.length > MAX_QUERY_PARAM_LEN) {
  sendError(res, 400, `session id exceeds ${MAX_QUERY_PARAM_LEN} bytes`);
  return true;
  }
  const limitParam = parseOptPositiveInt(url.searchParams.get("limit"), 50_000);
  if (limitParam === "invalid") {
  sendError(res, 400, "limit must be a positive integer in 1..50000");
  return true;
  }
  const raw = url.searchParams.get("raw") === "true";
  const includeMetadata = url.searchParams.get("includeMetadata") === "true";
  // SmtService is best-effort: when the cursor isn't loaded yet we still
  // return a projection (no proof verification) rather than failing the
  // whole request, matching cliReportSessionHandler.
  let smtForProjection;
  let knownRoots: Set<string> | undefined;
  try {
  await ctx.smtService.ensureReady();
  knownRoots = ctx.smtService.getKnownRoots(ctx.store.getCheckpointedRoots());
  smtForProjection = ctx.smtService;
  } catch {
  smtForProjection = undefined;
  }
  const projection = buildSessionProjection(ctx.store, sessionId, {
  raw,
  limit: limitParam,
  smtService: smtForProjection,
  knownRoots,
  });
  // Match the CLI's --include-metadata gate: tool args live in
  // event.metadata which the human formatter never prints; drop them by
  // default so a fetch from a non-interactive caller doesn't leak more
  // than the text view would.
  const body = includeMetadata
  ? projection
  : { ...projection, timeline: projection.timeline.map(({ metadata: _omit, ...rest }) => rest) };
  sendJson(res, 200, { ...body, degraded: ctx.store.isDegraded() });
  return true;
  }

  // GET /api/status
  if (apiPath === "status" && req.method === "GET") {
    // Same loopback gate as /api/report. The snapshot surfaces aggregate
    // anchor / retention / inventory metadata, including a recent
    // security-scan summary — same blast radius as a digest slice.
    if (ctx.isNonLoopback() && !ctx.allowExportOnNonLoopback) {
      sendError(
        res,
        403,
        "audit status is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowExportOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    if (!ctx.statusContext) {
      sendError(res, 503, "audit status is not configured on this plugin instance");
      return true;
    }
    const snapshot = buildStatusFromContext(ctx);
    sendJson(res, 200, { ...snapshot, degraded: ctx.store.isDegraded() });
    return true;
  }

  return false;
}

/**
 * HTTP-side equivalent of `cliStatusHandler` (src/cli.ts). The CLI handler
 * walks the same inputs and calls `buildStatusSnapshot`; mirroring it here
 * keeps the projection identical to `openclaw audit status --json` so a
 * dashboard pinned against the published schema sees the same payload from
 * either source.
 */
function buildStatusFromContext(ctx: AuditUiContext): ReturnType<typeof buildStatusSnapshot> {
  const { store, smtService, statusContext } = ctx;
  if (!statusContext) {
    // Caller has already guarded; keep the check for type narrowing.
    throw new Error("statusContext required");
  }
  const { pluginName, pluginVersion, config } = statusContext;
  const anchorHealth = readHealth<AnchorHealth>(store, ANCHOR_HEALTH_NAME);
  const persistedRetention = readHealth<RetentionHealth>(store, RETENTION_HEALTH_NAME);
  const retentionHealth: RetentionHealth = persistedRetention ?? {
    nextPruneAt: undefined,
    retentionDays: typeof config.localRetentionDays === "number" ? config.localRetentionDays : DEFAULT_RETENTION_DAYS,
    maxSizeMb: typeof config.localMaxSizeMb === "number" ? config.localMaxSizeMb : DEFAULT_MAX_SIZE_MB,
  };
  const inventoryReport = collectInventory(store, "summary", {
    openclawDir: ctx.openclawDir ?? "",
    projectRoot: process.cwd(),
  });
  const filePatterns = {
    watched: Array.isArray(config.fileWatchPatterns) ? (config.fileWatchPatterns as unknown[]).length : 0,
    ignored: Array.isArray(config.fileWatchIgnorePatterns) ? (config.fileWatchIgnorePatterns as unknown[]).length : 0,
  };
  return buildStatusSnapshot({
    pluginName,
    pluginVersion,
    machineId: smtService.getMachineId(),
    now: new Date(),
    store,
    smtService,
    anchorHealth,
    retentionHealth,
    filePatterns,
    inventorySummary: inventoryReport.summary,
    allowConversationAccess: config.allowConversationAccess === true,
  });
}

function readHealth<T>(store: AuditStore, name: string): T | undefined {
  const row = store.getServiceHealth(name);
  if (!row) return undefined;
  return row.payload as T;
}

function parseOptPositiveInt(v: string | null, max: number): number | undefined | "invalid" {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > max) return "invalid";
  return n;
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

export interface AuditUiOptions {
  deBaseUrl?: string;
  /** Resolves the live non-loopback bind status. Evaluated at request time. */
  isNonLoopback?: () => boolean;
  /** Operator opt-in to keep /api/export available when bound beyond loopback. */
  allowExportOnNonLoopback?: boolean;
  /** Operator opt-in to keep /api/verify available when bound beyond loopback. */
  allowVerifyOnNonLoopback?: boolean;
  /** Openclaw root used to populate `cron.configured` in /api/report. */
  openclawDir?: string;
  /**
   * Runtime metadata + config snapshot used by /api/status. Mirror of the
   * inputs passed to `cliStatusHandler` (src/cli.ts). Omit to disable the
   * status endpoint .
   */
  statusContext?: StatusContext;
}

export function registerAuditUiRoutes(
  api: RegisterArgs,
  store: AuditStore,
  smtService: SmtService,
  verifier: Verifier,
  options: AuditUiOptions | string = {},
): void {
  // Back-compat overload: the previous signature took deBaseUrl as a string.
  const opts: AuditUiOptions = typeof options === "string" ? { deBaseUrl: options } : options;
  const ctx: AuditUiContext = {
    store,
    smtService,
    verifier,
    concurrency: { exports: 0, verifies: 0 },
    deBaseUrl: opts.deBaseUrl,
    isNonLoopback: opts.isNonLoopback ?? (() => false),
    allowExportOnNonLoopback: opts.allowExportOnNonLoopback === true,
    allowVerifyOnNonLoopback: opts.allowVerifyOnNonLoopback === true,
    openclawDir: opts.openclawDir,
    statusContext: opts.statusContext,
  };

  api.registerHttpRoute({
    path: API_BASE,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      if (!isAllowedOrigin(req)) {
        sendError(res, 403, "cross-origin request rejected");
        return true;
      }
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
