/**
 * URL host policy shared by the webhook senders. Centralised so a single source of truth gates
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
 * Apply the shared host policy to a configured URL string. Used by the
 * webhook senders so they can't drift on host classification.
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

/**
 * Classify a single IP address that a hostname resolved to, applying the same
 * loopback / private / link-local intent as {@link validateHttpTargetUrl} —
 * but against the *resolved address*, not the hostname string. This closes the
 * DNS-based SSRF gap where a public-looking hostname resolves to an internal
 * address (e.g. `evil.example.com` -> `127.0.0.1` / `10.x` / `169.254.169.254`).
 *
 * The allow/deny intent mirrors `validateHttpTargetUrl` exactly:
 * - When the configured (validated) host is itself a loopback host, a
 *   loopback-resolved IP is EXPECTED and allowed — this preserves the
 *   intentional `http://localhost` dev-webhook allowance. A loopback host that
 *   somehow resolves to a non-loopback private/link-local IP is still rejected.
 * - When the configured host is NOT loopback (the normal https public target),
 *   any resolved IP that is loopback, private, or link-local is REJECTED,
 *   unless the operator opted in via `allowPrivateHost` (which only ever
 *   permits the private/link-local range, never loopback).
 *
 * `ip` is a literal address string from `dns.lookup` (dotted-quad IPv4 or an
 * IPv6 form); it is classified with the same `isLoopbackHost` /
 * `isPrivateOrLinkLocalIp` predicates used for hostnames.
 */
export function classifyResolvedAddress(
  ip: string,
  opts: { hostIsLoopback: boolean; allowPrivateHost?: boolean },
): ValidationResult {
  const resolvedLoopback = isLoopbackHost(ip);
  if (opts.hostIsLoopback) {
    // Loopback dev target: loopback IPs are the expected, allowed case.
    if (resolvedLoopback) return { ok: true };
    // A loopback-named host that resolves off-loopback into a private/
    // link-local range is suspicious — reject it (e.g. a tampered hosts file
    // pointing "localhost" at 169.254.169.254).
    if (isPrivateOrLinkLocalIp(ip)) {
      return { ok: false, reason: `loopback host resolved to private/link-local IP ${ip}` };
    }
    return { ok: true };
  }
  // Public (https) target: loopback or private/link-local resolved IPs are the
  // SSRF case we block. `allowPrivateHost` only relaxes the private range, not
  // loopback (matching validateHttpTargetUrl, which never permits a non-loopback
  // host that classifies as loopback).
  if (resolvedLoopback) {
    return { ok: false, reason: `host resolved to loopback IP ${ip}` };
  }
  if (!opts.allowPrivateHost && isPrivateOrLinkLocalIp(ip)) {
    return { ok: false, reason: `host resolved to private/link-local IP ${ip}` };
  }
  return { ok: true };
}

/**
 * Resolve a URL's hostname and assert every resolved address is permitted by
 * the policy (see {@link classifyResolvedAddress}). This is the send-time
 * complement to {@link validateHttpTargetUrl}, which only classifies the URL
 * string. Call it immediately before connecting.
 *
 * Fail-safe: a malformed URL or a DNS-resolution failure resolves to
 * `{ ok: false }` (do NOT send) rather than throwing, so a sender never
 * crashes on a transient lookup error — it simply skips that POST.
 *
 * KNOWN LIMITATION (residual TOCTOU): there is a small window between this
 * lookup and the actual TCP connect inside `fetch`, during which a hostile DNS
 * server could re-point the name (DNS rebinding). Fully closing it requires
 * pinning the validated IP at connect time via a custom undici dispatcher /
 * `lookup` hook. This pre-check blocks the steady-state misconfiguration and
 * rebinding-at-rest cases; the connect-time pinning is deliberately left out to
 * avoid coupling to undici internals.
 */
export async function assertResolvedAddressAllowed(
  raw: string,
  lookup: (host: string) => Promise<Array<{ address: string }>>,
  opts: { allowPrivateHost?: boolean } = {},
): Promise<ValidationResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  const host = url.hostname;
  const hostIsLoopback = isLoopbackHost(host);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "lookup failed";
    return { ok: false, reason: `DNS resolution failed for ${host}: ${msg}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `DNS resolution returned no addresses for ${host}` };
  }
  for (const { address } of addresses) {
    const result = classifyResolvedAddress(address, {
      hostIsLoopback,
      allowPrivateHost: opts.allowPrivateHost,
    });
    if (!result.ok) return result;
  }
  return { ok: true };
}
