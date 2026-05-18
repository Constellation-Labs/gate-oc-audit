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

/**
 * Returns a reason if the URL isn't safe to POST to. Surfaces protocol +
 * parse failures; callers log this once and disable the webhook rather than
 * throwing at request time.
 */
export function isUnsafeWebhookUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return "malformed URL"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `disallowed protocol ${url.protocol}`;
  }
  return undefined;
}

/**
 * POST a JSON body to a webhook URL. Never throws — all failure modes are
 * surfaced through the returned `PostResult` so callers can decide retry
 * vs. give-up uniformly. The URL is never logged here; the caller logs
 * status/error if it wants to surface them.
 */
export async function postJsonWebhook(
  url: string,
  body: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<PostResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: response.statusText };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: message };
  }
}
