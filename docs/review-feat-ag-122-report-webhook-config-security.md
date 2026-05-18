# Security review — `feat/AG-122-reportWebhook-config`

Base: `main` · Scope: 11 files, 1254-line diff. Focus: SSRF, PII leakage to operator-supplied webhook, log/error-channel exposure, scheduler DoS/race surfaces.

## Summary

- **Threat model is operator-trust:** `config.reportWebhook` is sourced from the local openclaw config file written by the machine operator (`src/index.ts:480-483`), not from any network input. The plugin runs inside openclaw's sandboxed VM. There is no plugin-facing API that lets a remote attacker mutate this value. That collapses the severity of the URL-validation findings from "exploitable SSRF" to "hardening".
- **Real PII leak via duplicate-outbound findings.** The pushed payload includes `anomalies.duplicateOutbound[]` whose entries carry `channel` + `recipient` verbatim (`src/reports/detectors.ts:28-34`, attached via `src/services/report-pusher.ts:151,162`). If `recipient` is a phone number / email / DM handle for any outbound channel, those identifiers are sent to the operator-configured digest endpoint — over `http://` if so configured.
- **URL validator is a protocol filter only**, no host/IP allowlist, no loopback/link-local block, no DNS resolve-and-recheck. `http://` is allowed (`src/util/webhook.ts:25-26`). Acceptable given threat model but worth documenting.
- **Operator-readable error string includes attacker-controlled `statusText`.** The webhook server's response text is concatenated into `lastPushError` and into log messages (`src/services/report-pusher.ts:182-187,192`; `src/util/webhook.ts:51`). Low severity because the surface is operator-only (logs + private `service_health` row, never exposed via the UI/CLI surfaces I scanned).
- **No re-entrancy / overlap risk.** Tick scheduling is `setInterval`-based and the work is awaited inside one tick, but two ticks *can* overlap if a tick exceeds the 5-minute interval — see Findings.

## Findings

### F1 — PII leakage: outbound `recipient` shipped verbatim to webhook · **M** · `src/reports/detectors.ts:28-34`, `src/services/report-pusher.ts:149-168`

`DuplicateOutboundFinding` carries `recipient: string` (the raw recipient handle harvested from `event.metadata.recipient` in `src/reports/projection.ts:178`). `fireDaily`/`fireWeekly` attach the full `projection` to the POST body, so any duplicate-outbound detection during the window publishes the recipient handle to the configured webhook. For channels like SMS/email/Telegram the recipient is PII (phone number, email, @handle). Even if the operator's webhook is Slack (TLS), this is the first time recipient identifiers leave the audit DB.

The audit DB itself stores message content gzipped at rest; this digest is the network-exfil surface. If the operator misconfigures the URL or rotates the Slack webhook to a hostile party, the leak is silent.

**Mitigation:** Hash or truncate `recipient` before it enters the projection (e.g., `sha256(recipient).slice(0,12)`), keeping it useful for "is this the same recipient as last week" correlation while making it non-reversible. Same for `channel` if any channel name carries customer data. Alternatively, add a config knob `reportWebhookIncludeRecipients` defaulting to `false`. If left unredacted, document the leak path in the README so operators know not to point this at third-party endpoints.

### F2 — Webhook server controls `lastPushError` content / log line text · **L** · `src/util/webhook.ts:51`, `src/services/report-pusher.ts:182-187,192`

`postJsonWebhook` returns `error: response.statusText` on non-2xx. HTTP status text is attacker-controllable (a hostile webhook server can emit `HTTP/1.1 503 \r\nINJECT: header` style text — though Node's fetch generally sanitises CR/LF in `statusText`, the string still flows into both `log.warn`/`log.error` and into `service_health.payload.lastPushError`). The downstream log subsystem (`createSubsystemLogger` from `openclaw/plugin-sdk/runtime`) is opaque from this repo; if logs are ever forwarded to a structured ingestion pipeline, the attacker text rides along.

**Mitigation:** Cap and sanitize `statusText`/`message` before persisting/logging — e.g., `String(text).replace(/[\r\n\t]/g, " ").slice(0, 200)`. Cheap and removes the entire class.

### F3 — `http://` allowed; no loopback/link-local/private-IP block (SSRF hardening) · **L** · `src/util/webhook.ts:22-29`

`isUnsafeWebhookUrl` only screens protocol. `http://169.254.169.254/latest/meta-data/`, `http://localhost:6379/`, `http://10.0.0.1/` all pass. Given the operator threat model this is *not* an SSRF vulnerability — the actor who can write `reportWebhook` already has local-config write, which is more powerful than SSRF. **However**, the same `isUnsafeWebhookUrl` is also used by `NotificationService` for `notificationWebhook` (`src/services/notifications.ts:25`), and if a future PR ever lets a less-trusted surface (e.g., a CLI subcommand that takes a URL from stdin, or a control-UI form) feed strings into either constructor, the validator is the wrong place to discover that.

**Mitigation:** Either (a) add an opt-in `requireHttps: true` default with an operator override for dev/loopback, or (b) keep current behavior but add a code comment at `src/util/webhook.ts:22` stating the operator-trust assumption so future callers don't reuse this for untrusted input. The cheapest defence-in-depth is rejecting `http://` for any non-loopback host and refusing IMDS literals (`169.254.169.254`, `fd00::/8`, `::1`, RFC1918 ranges) when protocol is `http`.

### F4 — Single-use `AbortController` makes `stop()` permanent · **L** · `src/services/report-pusher.ts:63,122,132,175`

`abortController` is constructed once at field-init (line 63). `stop()` aborts it. `tick()` short-circuits on `signal.aborted` (line 132) and `postWithRetry` short-circuits on it (line 175). Consequence: if the openclaw host ever calls `service.start()` after `service.stop()` (restart-in-place vs. construct-new), the service silently no-ops forever — no log, no error, no health row update.

**Security framing:** classifies as low because failure mode is "no digest fires" (availability of the audit-report stream), not exploit. But the audit feature is *intentionally* a monitoring channel, and a silent disabling of monitoring is exactly the surface an attacker would want. If you know the openclaw host always destroys+reconstructs services on lifecycle changes, this is moot.

**Mitigation:** Reinstantiate the `AbortController` at the top of `start()` (e.g., `this.abortController = new AbortController();`).

### F5 — No mutual-exclusion between overlapping ticks · **L** · `src/services/report-pusher.ts:111-114,130-147`

`setInterval` fires every 5 min; a tick that takes >5 min (1 retry × 30 s delay + 2 × 10 s timeout for daily + same for weekly + `buildProjection` over 100k rows under load) **can** overlap with the next tick. Both ticks read/write `this.state` (lines 157, 168, 178, 185) without locking. Worst case: tick A succeeds and sets `lastDailyReportedDate = "2026-05-17"`, tick B (started before A's marker update) still sees the old marker and re-fires the same digest → duplicate push to the operator's webhook. Not a security issue per se, but it amplifies F1 (PII repeated) and constitutes minor DoS to the receiver if combined with a slow-loris webhook.

**Mitigation:** Trivial `tickInFlight: Promise<void> | undefined` guard at the top of `tick()`: `if (this.tickInFlight) return this.tickInFlight;`.

### F6 — Webhook error path can echo URL fragments via Node fetch DNS error · **L** · `src/util/webhook.ts:54-56`

When `fetch` fails (DNS, ECONNREFUSED, etc.), Node's error message typically includes the host (e.g., `getaddrinfo ENOTFOUND foo.bar.example`). That message flows into `lastPushError` (persisted to `service_health.payload`) and into `log.error`. If the operator pasted a webhook URL containing a secret in the path/query (common for Slack: `/services/T.../B.../<secret>`), the **host** is logged but **path/secret** is not (Node's fetch error stringifies only the host). Verified by inspecting the standard Node error shape; not a leak today. Listed as a hardening note.

**Mitigation:** None required. If you want belt-and-suspenders, redact the URL host from error messages before persisting.

## Out of scope but worth flagging

- `parseDate(today.fromIso, ...)` in `src/services/report-pusher.ts:224` already-was-midnight, then `subtractCalendarDays(..., 1, tz)` again — correctness-only, not security.
- `weekStringFor` in `src/services/report-pusher.ts:270-282` duplicates ISO-week math that already exists in `src/reports/time-window.ts` (`isoWeek`/`isoWeekYear`). Not security; just drift risk.
- `buildProjection` reads up to 100k message-content rows with `includeContent: true` (`src/reports/projection.ts:160-170`). On a hot DB this is a measurable CPU + I/O pulse every calendar boundary. Not a security issue; capacity-planning note.

## Severity bar applied

- No **H** findings — no remote attacker can write `reportWebhook` and there is no code path I found that lets untrusted input reach `postJsonWebhook` directly.
- F1 is the only **M**: a real PII surface that fires on the first duplicate-outbound the operator's deployment produces, regardless of operator skill.
- F2–F6 are **L** hardening / defence-in-depth items.
