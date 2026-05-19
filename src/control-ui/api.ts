export type EventStatus = "verified" | "pending" | "tampered" | "untracked";

export interface EventVerificationSummary {
  status: EventStatus;
  treeKey?: string;
}

export interface ApiEvent {
  id: string;
  sequence: number;
  source: string;
  machineId: string;
  sessionId?: string;
  orgId?: string;
  userId?: string;
  eventType: string;
  category: string;
  description: string;
  metadata: Record<string, unknown>;
  content?: string;
  createdAt: string;
  receivedAt?: string;
  syncedAt?: string;
  verification?: EventVerificationSummary;
}

export interface SmtProof {
  root: string;
  key: string;
  siblings: string[];
  membership: boolean;
}

export interface EventVerifyPayload {
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

export interface EventsResponse {
  events: ApiEvent[];
  total: number;
  limit: number;
  offset: number;
  degraded: boolean;
}

export interface TreeInfo {
  key: string;
  root: string;
  entryCount: number;
  size: number;
}

export interface CheckpointRecord {
  id: string;
  sequenceStart: number;
  sequenceEnd: number;
  smtRoot: string;
  eventCount: number;
  deTxHash: string | null;
  createdAt: string;
}

const API_BASE = new URL("./api/", document.baseURI).toString();

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init);
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }
    const msg = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : `request failed: ${res.status}`;
    throw new Error(msg);
  }
  return await res.json() as T;
}

export interface EventsQuery {
  limit?: number;
  offset?: number;
  type?: string;
  category?: string;
  session?: string;
  /** Land on the page containing this sequence; server overrides `offset`. */
  focusSeq?: number;
}

export function listEvents(q: EventsQuery = {}): Promise<EventsResponse> {
  const params = new URLSearchParams();
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.offset !== undefined) params.set("offset", String(q.offset));
  if (q.type) params.set("type", q.type);
  if (q.category) params.set("category", q.category);
  if (q.session) params.set("session", q.session);
  if (q.focusSeq !== undefined) params.set("focusSeq", String(q.focusSeq));
  const qs = params.toString();
  return fetchJson<EventsResponse>(`events${qs ? "?" + qs : ""}`);
}

export function getEvent(id: string): Promise<{ event: ApiEvent }> {
  return fetchJson<{ event: ApiEvent }>(`events/${encodeURIComponent(id)}`);
}

export function verifyEvent(id: string): Promise<EventVerifyPayload> {
  return fetchJson<EventVerifyPayload>(`events/${encodeURIComponent(id)}/verify`);
}

export function listTrees(): Promise<{ trees: TreeInfo[] }> {
  return fetchJson<{ trees: TreeInfo[] }>("trees");
}

export function listCheckpoints(): Promise<{ checkpoints: CheckpointRecord[]; deBaseUrl: string | null }> {
  return fetchJson<{ checkpoints: CheckpointRecord[]; deBaseUrl: string | null }>("checkpoints");
}

export interface VerifyMismatch {
  checkpointId: string;
  sequenceStart: number;
  sequenceEnd: number;
  tamperedStart?: number;
  tamperedEnd?: number;
  expectedRoot: string;
  computedRoot: string;
  createdAt: string;
  inWindow: boolean;
  reason: "root-mismatch" | "events-missing";
}

export type VerifyResult =
  | {
      status: "verified";
      checkpointsChecked: number;
      lastAnchoredSequence: number;
      lastAnchoredCreatedAt: string;
      durationMs: number;
    }
  | {
      status: "mismatch-at-interval";
      mismatchAt: VerifyMismatch;
      checkpointsChecked: number;
      durationMs: number;
    }
  | {
      status: "anchor-pending";
      lastAnchoredSequence: number | null;
      lastAnchoredCreatedAt: string | null;
      checkpointsChecked: number;
      durationMs: number;
    };

export function verifyRange(from: string, to: string): Promise<VerifyResult> {
  return fetchJson<VerifyResult>("verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
}

export interface GateStatus {
  configPath: string;
  configured: boolean;
  url?: string;
  hasApiKey: boolean;
  allowlisted: boolean;
  conversationAccess: boolean;
  enabled?: boolean;
  brokerProviderKey?: string;
}

export function getGateStatus(): Promise<GateStatus> {
  return fetchJson<GateStatus>("gate/status");
}

export type GateProbeResult =
  | { kind: "ok"; status: number }
  | { kind: "unauthorized"; status: number; body: string }
  | { kind: "http-error"; status: number; body: string }
  | { kind: "network-error"; message: string };

export interface GateTestRequest {
  url?: string;
  apiKey?: string;
}

export function testGate(req: GateTestRequest = {}): Promise<{ url: string; result: GateProbeResult }> {
  return fetchJson("gate/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}

export interface GateInstallRequest {
  url: string;
  apiKey: string;
  registerBroker?: boolean;
  allowPrivateHost?: boolean;
  skipProbe?: boolean;
}

export interface GateInstallResponse {
  configPath: string;
  changes: string[];
  probe: "ok" | "unauthorized" | "http-error" | "network-error" | "skipped";
}

export function installGate(req: GateInstallRequest): Promise<GateInstallResponse> {
  return fetchJson<GateInstallResponse>("gate/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}
