import { getMachineId } from "../util/machine-id.js";
import { sanitizeForLog } from "./gateway-publisher.js";

const INGEST_PATH = "/api/v1/audit/ingest";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  /** Override the per-request timeout. Default 10s. */
  timeoutMs?: number;
  /** Override fetch — used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the machineId stamped on the probe payload. Real callers
   * should leave this unset; tests inject a deterministic value. */
  machineId?: string;
}

export type ProbeResult =
  | { kind: "ok"; status: number }
  | { kind: "unauthorized"; status: number; body: string }
  | { kind: "http-error"; status: number; body: string }
  | { kind: "network-error"; message: string };

/**
 * Probe a Gate instance to verify URL + API key are correct before we
 * persist them to the operator's openclaw config.
 *
 * One HTTP request, no retries, hard timeout — this is a fast confidence
 * check during install, not a long-running poller. The probe POSTs
 * `{ machineId, events: [] }` (matching what the runtime gateway
 * publisher will send) to `<baseUrl>/api/v1/audit/ingest`. swarm-deck's
 * audit-ingest controller treats an empty `events` array as a no-op —
 * the API key and URL round-trip without writing anything server-side.
 *
 * `redirect: "manual"` is set so a hostile/compromised Gate cannot 302
 * the probe (with `X-Gateway-Api-Key` attached by undici) toward a
 * private SSRF target or a credential-collecting attacker URL. Any 3xx
 * is surfaced to the operator as an http-error.
 *
 * `baseUrl` is the operator-facing Gate URL (no path). Trailing slashes
 * are tolerated.
 */
export async function probeGate(baseUrl: string, apiKey: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const machineId = opts.machineId ?? getMachineId();
  const url = baseUrl.replace(/\/+$/, "") + INGEST_PATH;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Api-Key": apiKey,
      },
      body: JSON.stringify({ machineId, events: [] }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: "network-error", message: err instanceof Error ? err.message : String(err) };
  }

  if (res.ok) return { kind: "ok", status: res.status };

  const body = await safeText(res);
  if (res.status === 401 || res.status === 403) {
    return { kind: "unauthorized", status: res.status, body };
  }
  return { kind: "http-error", status: res.status, body };
}

/** Read at most 500 bytes of the response body and strip control chars
 * (CR/LF/ANSI) before surfacing it to operator logs. Reuses the same
 * sanitizer the gateway publisher uses for server error messages, so a
 * server that echoes the submitted API key back can't leak it through
 * our error path. */
async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
    return sanitizeForLog(truncated, 500);
  } catch {
    return "";
  }
}
