/**
 * URL host policy shared by the gateway publisher and the webhook senders
 * . Centralised so a single source of truth gates
 * any outbound HTTP target an operator configures.
 *
 * Trust model: callers pass URLs sourced from the plugin config file. The
 * policy refuses cleartext (http) to anything but loopback, numeric-IP
 * encodings that confuse parsers, and (by default) private/link-local
 * IPs. `allowPrivateHost` is an explicit operator opt-in for the rare
 * intranet recipient.
 */

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** DNS root-form trailing dot ("127.0.0.1." == "127.0.0.1"). Strip before matching. */
export function normalizeHost(host: string): string {
  const trimmed = host.endsWith(".") ? host.slice(0, -1) : host;
  return trimmed.toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv4-mapped IPv6 loopback: ::ffff:127.x.x.x
  if (/^\[?::ffff:127(\.\d{1,3}){3}\]?$/.test(h)) return true;
  return false;
}

export function isPrivateOrLinkLocalIp(host: string): boolean {
  const h = normalizeHost(host);
  // 0.0.0.0/8 — "unspecified" / wildcard; on most OSes binds to all
  // interfaces including loopback, so treat as private to avoid leaking
  // outbound POSTs to whichever interface the OS picks.
  if (/^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const v6 = h.replace(/^\[|\]$/g, "");
  if (v6.startsWith("fe80:") || v6.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}(:|::)/.test(v6)) return true;
  // IPv4-mapped IPv6 to private/link-local addresses (::ffff:10.x, etc.)
  const mapped = v6.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (mapped) {
    const a = Number(mapped[1]);
    const b = Number(mapped[2]);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/**
 * Reject ambiguous numeric-encoded IPv4 (decimal "2130706433", hex
 * "0x7f000001", octal "0177.0.0.1"). Some resolvers decode these to
 * loopback/private addresses; rather than play whack-a-mole, refuse
 * non-dotted-quad numeric hosts up-front.
 */
export function isNumericIpEncoding(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return false;
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(h)) return true;
  if (/\.0x[0-9a-f]+/i.test(h)) return true;
  return false;
}

/**
 * Apply the shared host policy to a configured URL string. Used by both the
 * gateway publisher and the webhook senders so they can't drift on host
 * classification.
 *
 * - Rejects malformed URLs and non-http(s) protocols.
 * - Rejects URLs that carry userinfo  so credentials
 *   can't end up in log lines that echo the URL.
 * - Rejects plain http:// to anything but loopback (cleartext risk).
 * - Rejects https:// to numeric-IP encodings.
 * - Rejects https:// to private/link-local IPs unless `allowPrivateHost`.
 */
export function validateHttpTargetUrl(
  raw: string,
  opts: { allowPrivateHost?: boolean } = {},
): ValidationResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `disallowed protocol ${url.protocol}` };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: "userinfo (user:pass@host) not allowed in URL" };
  }
  const host = url.hostname;
  if (isNumericIpEncoding(host)) {
    return { ok: false, reason: `numeric IP encoding ${host} (use dotted-quad form)` };
  }
  const loopback = isLoopbackHost(host);
  if (url.protocol === "http:" && !loopback) {
    return { ok: false, reason: "http:// requires loopback host (localhost, 127.0.0.1, [::1])" };
  }
  if (!loopback && !opts.allowPrivateHost && isPrivateOrLinkLocalIp(host)) {
    return { ok: false, reason: `private/link-local host ${host}` };
  }
  return { ok: true };
}
