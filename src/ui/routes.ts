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
import {
  GateInstallError,
  installGate,
  normalizeAndValidateUrl,
  readGateStatus,
  readSavedGatewayApiKey,
  validateApiKeyOrThrow,
} from "../services/gate-installer.js";
import { probeGate } from "../services/gate-client.js";
import {
  applyProviderEntryPatch,
  readOpenclawConfig,
  readProviders,
  removeProviderEntry,
  writeOpenclawConfig,
} from "../util/openclaw-config-writer.js";
import { resolveOpenclawDir } from "../util/openclaw-paths.js";
import { startOpenAIOAuthFlow, type OAuthToken } from "../services/openai-oauth.js";
import { resolveOpenAIOAuthEndpoints } from "../services/openai-oauth-constants.js";
import { randomBytes } from "node:crypto";

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
   * Operator opt-in to keep the mutation endpoints `/api/gate/install`
   * and `/api/gate/test` enabled when the gateway binds beyond loopback.
   * Off by default — these endpoints write the operator's Gate API key
   * to ~/.openclaw/config.json (install) and emit outbound HTTP probes
   * with that key (test); both are credential-handling paths that
   * shouldn't accept arbitrary network input.
   */
  allowGateMutationOnNonLoopback: boolean;
  /** Override openclaw config dir for tests. */
  openclawDir?: string;
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
let inFlightExports = 0;

/**
 * Bound /api/verify the same way. A verification walks every event with
 * `includeContent: true` (gunzip + rehash), and on root mismatch it makes a
 * second full pass to locate the tampered range — so concurrent verifies
 * pin the event loop on CPU work.
 */
const MAX_CONCURRENT_VERIFIES = 2;
let inFlightVerifies = 0;

/** Clickjacking + framing defense: refuse to be embedded in a cross-
 * origin iframe. Set on every JSON response and on static HTML so a
 * malicious page can't overlay the Gate setup form with a transparent
 * UI-redress attack. CSP is the modern equivalent; both are sent
 * because older proxies sometimes drop one or the other. */
function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(buf.length));
  res.setHeader("cache-control", "no-store");
  setSecurityHeaders(res);
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

/**
 * In-flight OAuth sessions, keyed by the opaque sessionId returned to
 * the UI. Each session owns one ActiveOAuthFlow + an eventual
 * resolution. The map is module-local because the loopback OAuth port
 * is fixed (codex-cli convention), so at most one flow can be in
 * flight per plugin process.
 */
type OAuthSessionStatus =
  | { kind: "pending"; authUrl: string; startedAt: number }
  | { kind: "complete"; configPath: string; providerKey: string; expiresAt: string }
  | { kind: "error"; message: string };

interface OAuthSession {
  providerKey: string;
  status: OAuthSessionStatus;
  cancel: () => void;
  /** Wall-clock when this session entry can be reaped (ttl + grace). */
  reapAt: number;
}

const openaiOauthSessions = new Map<string, OAuthSession>();
const OAUTH_SESSION_GRACE_MS = 60_000; // keep terminal sessions around so the UI can poll once more

function reapOauthSessions(): void {
  const now = Date.now();
  for (const [sid, s] of openaiOauthSessions.entries()) {
    if (s.reapAt <= now) openaiOauthSessions.delete(sid);
  }
}

/**
 * Origin-bind CSRF defense for mutating / IO-driving routes. The audit
 * UI is served from the same loopback origin as the gateway, so a
 * legitimate POST from the SPA carries:
 *   - `Content-Type: application/json` (Lit fetch in api.ts always sets it)
 *   - `Origin` matching the request's `Host`
 *   - `Sec-Fetch-Site: same-origin` or `none` (set by all modern browsers)
 *
 * A cross-origin tab cannot reproduce all three without a CORS
 * preflight (which we never honor). Returns true to continue, false
 * after writing a 403 — short-circuit the route on false.
 *
 * Not applied to GET endpoints. The browser SOP already prevents a
 * cross-origin tab from reading their responses; the only residual
 * exposure (heavy CPU/DB work triggered by a forged GET) is gated
 * behind the existing `allowExportOnNonLoopback` / `allowVerifyOnNonLoopback`
 * opt-ins.
 */
function requireSameOriginJsonPost(req: IncomingMessage, res: ServerResponse): boolean {
  const ct = req.headers["content-type"];
  if (typeof ct !== "string" || !ct.toLowerCase().split(";", 1)[0].trim().startsWith("application/json")) {
    sendError(res, 415, "Content-Type must be application/json");
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0 && origin !== "null") {
    let parsed: URL;
    try { parsed = new URL(origin); } catch {
      sendError(res, 403, "Origin header is malformed");
      return false;
    }
    const host = req.headers.host;
    if (typeof host !== "string" || parsed.host !== host) {
      sendError(res, 403, "cross-origin request rejected (Origin does not match Host)");
      return false;
    }
  }
  // Sec-Fetch-Site is set by Chromium/Firefox/Safari for all fetch+XHR
  // requests since 2020. `same-origin` (Lit UI) and `none` (curl,
  // server-side) are acceptable; `cross-site` / `same-site` are not.
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs !== "same-origin" && sfs !== "none") {
    sendError(res, 403, "cross-site request rejected (Sec-Fetch-Site)");
    return false;
  }
  return true;
}

/** Parse a JSON body or write 400 and return null. Collapses the
 * repeated try/catch+typeof prologue used by every POST handler. */
async function readJsonOr400(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "invalid json");
    return null;
  }
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

/** Read a string field from a parsed body, trimming whitespace and
 * treating empty / missing / non-string as undefined. */
function bodyStr(b: Record<string, unknown>, key: string): string | undefined {
  const v = b[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Strict-boolean read: only literal `true` / `false` pass through;
 * everything else is `undefined`. Caller picks the default explicitly. */
function bodyBool(b: Record<string, unknown>, key: string): boolean | undefined {
  const v = b[key];
  return v === true || v === false ? v : undefined;
}

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
  const smtLastSeq = ctx.smtService.getLastCheckpointedSequence();
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
    if (ctx.isNonLoopback() && !ctx.allowVerifyOnNonLoopback) {
      sendError(
        res,
        403,
        "audit verify is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowVerifyOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    if (!requireSameOriginJsonPost(req, res)) return true;
    if (inFlightVerifies >= MAX_CONCURRENT_VERIFIES) {
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
    inFlightVerifies++;
    try {
      const result = ctx.verifier.verifyRange({ from, to });
      sendJson(res, 200, result);
    } finally {
      inFlightVerifies--;
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
    if (inFlightExports >= MAX_CONCURRENT_EXPORTS) {
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
    const filters: ExportFilters = {
      from,
      to,
      eventType: url.searchParams.get("type") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      sessionId: url.searchParams.get("session") ?? undefined,
      securityOnly: url.searchParams.get("securityOnly") === "true",
      includeContent: url.searchParams.get("includeContent") === "true",
    };
    inFlightExports++;
    try {
      await pipeExportToResponse(res, { store: ctx.store, filters, format, limitRows });
    } finally {
      inFlightExports--;
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
    const rollup = buildCronRollup(ctx.store, jobId, { last: lastParam ?? CRON_DEFAULT_LAST });
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

  // GET /api/gate/status — redacted summary of the operator's Gate config.
  // Never returns the API key value; only `hasApiKey: boolean`.
  if (apiPath === "gate/status" && req.method === "GET") {
    const status = readGateStatus(ctx.openclawDir);
    sendJson(res, 200, status);
    return true;
  }

  // POST /api/gate/test — body { url?, apiKey?, allowPrivateHost? }.
  // If url+apiKey are not both supplied, fall back to the saved config.
  // PR-1 exfil guard: when only `url` is supplied, refuse to load the
  // saved key (or it'd get POSTed to the request-supplied URL).
  if (apiPath === "gate/test" && req.method === "POST") {
    if (ctx.isNonLoopback() && !ctx.allowGateMutationOnNonLoopback) {
      sendError(
        res,
        403,
        "audit gate test is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowGateMutationOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    if (!requireSameOriginJsonPost(req, res)) return true;
    const b = await readJsonOr400(req, res);
    if (!b) return true;

    const urlOverride = bodyStr(b, "url");
    let apiKey = bodyStr(b, "apiKey");
    let url = urlOverride;
    const allowPrivateHost = bodyBool(b, "allowPrivateHost") === true;

    if (urlOverride && !apiKey) {
      sendError(
        res,
        400,
        "url override requires apiKey; the saved API key is never sent to a non-configured URL",
      );
      return true;
    }
    if (!url || !apiKey) {
      const status = readGateStatus(ctx.openclawDir);
      if (!status.configured) {
        sendError(res, 400, "Gate is not configured. POST /api/gate/install first.");
        return true;
      }
      url = url ?? status.url;
      if (!apiKey) {
        try {
          apiKey = readSavedGatewayApiKey(ctx.openclawDir);
        } catch (err) {
          sendError(res, 500, err instanceof Error ? err.message : "config read error");
          return true;
        }
      }
    }
    if (!url || !apiKey) {
      // Should be unreachable given the branches above, but keeps the
      // type narrowing honest and avoids a silent 200 with a probe of
      // undefined values if a future refactor breaks an invariant.
      sendError(res, 500, "could not resolve URL or API key");
      return true;
    }
    try {
      url = normalizeAndValidateUrl(url, allowPrivateHost);
      apiKey = validateApiKeyOrThrow(apiKey);
    } catch (err) {
      if (err instanceof GateInstallError) {
        sendError(res, 400, err.message);
        return true;
      }
      throw err;
    }
    const result = await probeGate(url, apiKey);
    sendJson(res, 200, { url, result });
    return true;
  }

  // POST /api/gate/install — body { url, apiKey, registerBroker?,
  // allowPrivateHost?, skipProbe? }. Writes Gate config to disk.
  if (apiPath === "gate/install" && req.method === "POST") {
    if (ctx.isNonLoopback() && !ctx.allowGateMutationOnNonLoopback) {
      sendError(
        res,
        403,
        "audit gate install is disabled when the gateway binds beyond loopback. " +
          "Set audit config 'allowGateMutationOnNonLoopback: true' to opt in.",
      );
      return true;
    }
    if (!requireSameOriginJsonPost(req, res)) return true;
    const b = await readJsonOr400(req, res);
    if (!b) return true;

    const url = bodyStr(b, "url");
    const apiKey = bodyStr(b, "apiKey");
    if (!url || !apiKey) {
      sendError(res, 400, "url and apiKey are required (non-empty strings)");
      return true;
    }
    try {
      const report = await installGate({
        url,
        apiKey,
        // Strict boolean: only explicit `false` opts out. Truthy
        // non-bool values (null, "false", 0) are ignored.
        registerBroker: bodyBool(b, "registerBroker") !== false,
        allowPrivateHost: bodyBool(b, "allowPrivateHost") === true,
        skipProbe: bodyBool(b, "skipProbe") === true,
        openclawDir: ctx.openclawDir,
      });
      sendJson(res, 200, {
        configPath: report.configPath,
        changes: report.changes,
        // installGate throws on every non-ok probe outcome, so the
        // only values we can actually send here are "ok" and "skipped".
        // The client union is narrowed to match.
        probe: report.probe?.kind === "ok" ? "ok" : "skipped",
      });
    } catch (err) {
      if (err instanceof GateInstallError) {
        sendError(res, 400, err.message);
        return true;
      }
      throw err;
    }
    return true;
  }

  // GET /api/gate/providers — redacted list. Never includes api-key
  // values or refresh tokens, only the metadata needed to render a
  // provider list in the UI.
  if (apiPath === "gate/providers" && req.method === "GET") {
    let file;
    try { file = readOpenclawConfig(resolveOpenclawDir({ openclawDir: ctx.openclawDir })); }
    catch (err) { sendError(res, 500, err instanceof Error ? err.message : "config read error"); return true; }
    const providers = readProviders(file.content);
    const list = Object.entries(providers).map(([key, entry]) => {
      const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
      const auth = typeof entry.auth === "string" ? entry.auth : undefined;
      const hasApiKey = typeof entry.apiKey === "string" && entry.apiKey.length > 0;
      let oauthExpiresAt: string | undefined;
      const meta = entry.openclawAudit;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const oa = (meta as Record<string, unknown>).oauth;
        if (oa && typeof oa === "object" && !Array.isArray(oa)) {
          const v = (oa as Record<string, unknown>).expiresAt;
          if (typeof v === "string") oauthExpiresAt = v;
        }
      }
      return { key, baseUrl, auth, hasApiKey, oauthExpiresAt };
    });
    sendJson(res, 200, { providers: list });
    return true;
  }

  // POST /api/gate/providers — body { providerKey?, kind: "openai", apiKey }.
  // OAuth flow uses the /gate/oauth/openai/* endpoints below; this one
  // is for direct api-key entry.
  if (apiPath === "gate/providers" && req.method === "POST") {
    if (ctx.isNonLoopback() && !ctx.allowGateMutationOnNonLoopback) {
      sendError(res, 403, "audit gate provider mutation disabled when bound beyond loopback. Set 'allowGateMutationOnNonLoopback: true' to opt in.");
      return true;
    }
    if (!requireSameOriginJsonPost(req, res)) return true;
    const b = await readJsonOr400(req, res);
    if (!b) return true;
    const kind = bodyStr(b, "kind");
    if (kind !== "openai") {
      sendError(res, 400, "only kind: 'openai' is supported in this release");
      return true;
    }
    const providerKey = bodyStr(b, "providerKey") ?? "openai";
    const apiKey = bodyStr(b, "apiKey");
    if (!apiKey) {
      sendError(res, 400, "apiKey is required (non-empty string)");
      return true;
    }
    if (/\s/.test(apiKey)) {
      sendError(res, 400, "apiKey contains whitespace");
      return true;
    }
    const dir = resolveOpenclawDir({ openclawDir: ctx.openclawDir });
    let file;
    try { file = readOpenclawConfig(dir); }
    catch (err) { sendError(res, 500, err instanceof Error ? err.message : "config read error"); return true; }
    const changes = applyProviderEntryPatch(file.content, {
      providerKey,
      baseUrl: "https://api.openai.com/v1",
      apiKey,
      tokenKind: "api-key",
    });
    if (changes.length > 0) writeOpenclawConfig(file.path, file.content);
    sendJson(res, 200, { configPath: file.path, providerKey, changes });
    return true;
  }

  // DELETE /api/gate/providers/<key> — remove. Refuses the conventional
  // 'gate' key (owned by `audit gate install`).
  if (apiPath.startsWith("gate/providers/") && req.method === "DELETE") {
    if (ctx.isNonLoopback() && !ctx.allowGateMutationOnNonLoopback) {
      sendError(res, 403, "audit gate provider mutation disabled when bound beyond loopback. Set 'allowGateMutationOnNonLoopback: true' to opt in.");
      return true;
    }
    if (!requireSameOriginJsonPost(req, res)) return true;
    const key = decodeURIComponent(apiPath.slice("gate/providers/".length));
    if (!key) { sendError(res, 400, "missing provider key"); return true; }
    const dir = resolveOpenclawDir({ openclawDir: ctx.openclawDir });
    let file;
    try { file = readOpenclawConfig(dir); }
    catch (err) { sendError(res, 500, err instanceof Error ? err.message : "config read error"); return true; }
    let changes: string[];
    try { changes = removeProviderEntry(file.content, key); }
    catch (err) { sendError(res, 400, err instanceof Error ? err.message : "remove failed"); return true; }
    if (changes.length > 0) writeOpenclawConfig(file.path, file.content);
    sendJson(res, 200, { configPath: file.path, providerKey: key, changes });
    return true;
  }

  // POST /api/gate/oauth/openai/start — body { providerKey? }. Starts
  // the loopback OAuth flow and returns the authorize URL the browser
  // should open. Only one flow may be in flight per process (the
  // redirect_uri port is fixed); a second start while one is pending
  // returns 409.
  if (apiPath === "gate/oauth/openai/start" && req.method === "POST") {
    if (ctx.isNonLoopback() && !ctx.allowGateMutationOnNonLoopback) {
      sendError(res, 403, "audit gate oauth disabled when bound beyond loopback. Set 'allowGateMutationOnNonLoopback: true' to opt in.");
      return true;
    }
    if (!requireSameOriginJsonPost(req, res)) return true;
    reapOauthSessions();
    for (const s of openaiOauthSessions.values()) {
      if (s.status.kind === "pending") {
        sendError(res, 409, "an OAuth flow is already in progress; wait or cancel it before starting a new one");
        return true;
      }
    }
    const b = await readJsonOr400(req, res);
    if (!b) return true;
    const providerKey = bodyStr(b, "providerKey") ?? "openai";

    const endpoints = resolveOpenAIOAuthEndpoints();
    let flow;
    try { flow = startOpenAIOAuthFlow({ endpoints }); }
    catch (err) {
      sendError(res, 500, `failed to start OAuth listener on port ${endpoints.redirectPort}: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    const sessionId = randomBytes(16).toString("hex");
    const session: OAuthSession = {
      providerKey,
      status: { kind: "pending", authUrl: flow.authUrl, startedAt: Date.now() },
      cancel: flow.cancel,
      reapAt: Date.now() + 6 * 60_000, // 5min timeout + 1min grace
    };
    openaiOauthSessions.set(sessionId, session);

    flow.waitForToken.then(
      (token) => onOauthComplete(sessionId, session, token, ctx),
      (err) => onOauthError(sessionId, session, err),
    );

    sendJson(res, 200, { sessionId, authUrl: flow.authUrl, port: flow.port });
    return true;
  }

  // GET /api/gate/oauth/openai/<sid>/status — long-poll-friendly
  // status check. Returns pending/complete/error.
  if (apiPath.startsWith("gate/oauth/openai/") && apiPath.endsWith("/status") && req.method === "GET") {
    reapOauthSessions();
    const sid = apiPath.slice("gate/oauth/openai/".length, -"/status".length);
    const session = openaiOauthSessions.get(sid);
    if (!session) { sendError(res, 404, "unknown sessionId"); return true; }
    sendJson(res, 200, { providerKey: session.providerKey, ...session.status });
    return true;
  }

  // POST /api/gate/oauth/openai/<sid>/cancel — tear down a pending flow.
  if (apiPath.startsWith("gate/oauth/openai/") && apiPath.endsWith("/cancel") && req.method === "POST") {
    if (!requireSameOriginJsonPost(req, res)) return true;
    const sid = apiPath.slice("gate/oauth/openai/".length, -"/cancel".length);
    const session = openaiOauthSessions.get(sid);
    if (!session) { sendError(res, 404, "unknown sessionId"); return true; }
    session.cancel();
    if (session.status.kind === "pending") {
      session.status = { kind: "error", message: "cancelled by operator" };
      session.reapAt = Date.now() + OAUTH_SESSION_GRACE_MS;
    }
    sendJson(res, 200, { cancelled: true });
    return true;
  }

  return false;
}

function onOauthComplete(
  sessionId: string,
  session: OAuthSession,
  token: OAuthToken,
  ctx: AuditUiContext,
): void {
  try {
    const dir = resolveOpenclawDir({ openclawDir: ctx.openclawDir });
    const file = readOpenclawConfig(dir);
    applyProviderEntryPatch(file.content, {
      providerKey: session.providerKey,
      baseUrl: "https://api.openai.com/v1",
      apiKey: token.accessToken,
      tokenKind: "oauth-access",
      oauth: {
        issuer: new URL(resolveOpenAIOAuthEndpoints().authorizeUrl).origin,
        clientId: resolveOpenAIOAuthEndpoints().clientId,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scope: token.scope,
      },
    });
    writeOpenclawConfig(file.path, file.content);
    session.status = {
      kind: "complete",
      configPath: file.path,
      providerKey: session.providerKey,
      expiresAt: token.expiresAt,
    };
  } catch (err) {
    session.status = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  session.reapAt = Date.now() + OAUTH_SESSION_GRACE_MS;
  // sessionId reference is kept by callers; this fn just updates the
  // session entry that was inserted by the route handler.
  void sessionId;
}

function onOauthError(sessionId: string, session: OAuthSession, err: unknown): void {
  session.status = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  session.reapAt = Date.now() + OAUTH_SESSION_GRACE_MS;
  void sessionId;
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
  setSecurityHeaders(res);
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
  /** Operator opt-in to keep /api/gate/{install,test} available when bound beyond loopback. */
  allowGateMutationOnNonLoopback?: boolean;
  /** Override openclaw config dir (for tests / non-default installs). */
  openclawDir?: string;
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
    deBaseUrl: opts.deBaseUrl,
    isNonLoopback: opts.isNonLoopback ?? (() => false),
    allowExportOnNonLoopback: opts.allowExportOnNonLoopback === true,
    allowVerifyOnNonLoopback: opts.allowVerifyOnNonLoopback === true,
    allowGateMutationOnNonLoopback: opts.allowGateMutationOnNonLoopback === true,
    openclawDir: opts.openclawDir,
  };

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
