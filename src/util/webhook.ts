/**
 * Shared HTTP-webhook sender. Used by both NotificationService (incident
 * alerts) and ReportPusherService (daily/weekly digests). Validation +
 * timeout live here so the two paths can't drift; retry policy is the
 * caller's choice (incidents are fire-and-forget, digests want one retry).
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export interface PostResult {
  ok: boolean;
  status?: number;
  /** Populated on network errors, timeouts, or non-2xx responses. */
  error?: string;
}

import { lookup as dnsLookup } from "node:dns/promises";
import { assertResolvedAddressAllowed, validateHttpTargetUrl } from "./network-policy.js";

/**
 * Returns a reason if the URL isn't safe to POST to, or undefined if it
 * passes the shared host policy (see util/network-policy.ts). Callers log
 * the reason once and disable the webhook rather than throwing at request
 * time.
 *
 * Trust model: URLs originate from the plugin's config file. We gate them
 * through a shared SSRF policy — `http://` only to loopback, no userinfo,
 * no numeric IP encoding tricks, and private/link-local hosts only when
 * the caller explicitly opts in via
 * `allowPrivateHost: true`. Operators who legitimately need to POST to
 * an intranet recipient flip the corresponding `*AllowPrivateHost` config
 * flag; everyone else gets defense in depth against a copy-pasted bad URL.
 */
export function isUnsafeWebhookUrl(
  raw: string,
  opts: { allowPrivateHost?: boolean } = {},
): string | undefined {
  const result = validateHttpTargetUrl(raw, opts);
  if (result.ok) return undefined;
  return result.reason;
}

/** Strip CR/LF/tab and cap length so a hostile webhook server's status text
 *  or error message can't inject log/header garbage when callers persist
 *  or log the result. */
function sanitize(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.replace(/[\r\n\t]/g, " ").slice(0, 200);
}

/**
 * POST a JSON body to a webhook URL. Never throws — all failure modes are
 * surfaced through the returned `PostResult` so callers can decide retry
 * vs. give-up uniformly. The URL is never logged here; the caller logs
 * status/error if it wants to surface them.
 *
 * Send-time SSRF re-check: before each `fetch`, the hostname is resolved
 * (`dns.lookup`, all addresses) and every resolved IP is re-classified against
 * the shared policy (see network-policy.ts `assertResolvedAddressAllowed`).
 * This closes the gap where the host string passed config-time validation
 * (`validateHttpTargetUrl`) but the name resolves to a private/loopback/
 * link-local address, and re-runs on every send rather than once at startup —
 * so a DNS record flipped after config load is caught too. A resolution
 * failure is treated as "do not send" (fail-safe). `allowPrivateHost` mirrors
 * the config-time flag so loopback dev webhooks and operator-opted-in intranet
 * targets keep working.
 *
 * NOTE: a small TOCTOU window remains between this lookup and the actual
 * connect inside `fetch` (true IP-pinning would need a custom undici
 * dispatcher); documented as a known limitation in network-policy.ts.
 */
export async function postJsonWebhook(
  url: string,
  body: unknown,
  opts: { timeoutMs?: number; allowPrivateHost?: boolean } = {},
): Promise<PostResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolved = await assertResolvedAddressAllowed(
    url,
    (host) => dnsLookup(host, { all: true }),
    { allowPrivateHost: opts.allowPrivateHost === true },
  );
  if (!resolved.ok) {
    return { ok: false, error: sanitize(`blocked by SSRF policy: ${resolved.reason}`) };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Reject redirects rather than following them. A hostile or
      // misconfigured webhook that returns 302 could otherwise steer the
      // POST to an unintended host. Treat any 3xx as a transport failure.
      redirect: "manual",
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: sanitize(response.statusText) };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: sanitize(message) };
  }
}
