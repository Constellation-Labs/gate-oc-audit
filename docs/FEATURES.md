# OpenClaw Audit Plugin — Implemented Features

A tamper-evident audit trail for AI coding agent activity. Every meaningful
lifecycle event is captured locally, hashed into a per-event chain and a
Sparse Merkle Tree, periodically anchored to Constellation's Digital
Evidence , and optionally streamed to a remote gateway and digest
webhooks.

## Audit Trail Capture

Events land in a local SQLite database at `~/.openclaw/audit.db` . The plugin registers all of its hooks at priority 200 so it sees
events before other plugins can modify or short-circuit them.

The plugin captures every openclaw lifecycle hook it has access to:

- **Session boundaries** — `session_start`, `session_end`
- **Agent loop** — `before_model_resolve`, `before_prompt_build`, `agent_end`
- **Tool invocations** — `before_tool_call`, `after_tool_call`,
  `tool_result_persist`
- **Messages** — `message_received`, `message_sending`, `message_sent`,
  `before_message_write`, `before_dispatch`, `inbound_claim`
- **LLM I/O** — `llm_input`, `llm_output` (gated by
  `allowConversationAccess`; non-bundled plugins must opt in to receive
  these on openclaw 2026.4.24+)
- **Subagent lifecycle** — `subagent_spawning`, `subagent_spawned`,
  `subagent_delivery_target`, `subagent_ended`
- **Conversation reset / compaction** — `before_compaction`,
  `after_compaction`, `before_reset`
- **Gateway** — `gateway_start`, `gateway_stop` (with a signal-handler
  fallback so SIGTERM/SIGINT still record a stop event when the host
  exits before the hook fires)
- **Diagnostic** — `model.usage` via the SDK's `onDiagnosticEvent`
  subscription (LLM provider/model/tokens/cost in USD)

## Tamper-Evident Hash Chain

Each event row carries a SHA-256 `content_hash` and a `previous_hash`
pointing at the previous row's `content_hash`. Predecessor lookup happens
inside the same INSERT via a scalar subquery, so concurrent writers can't
fork the chain. The first event links to the literal string `GENESIS`.
The chain survives restarts and full process restarts.

## Sparse Merkle Tree (SMT)

On every successful append, the audit store appends two leaves to a
local SMT — one keyed by a **raw hash** (event id + sequence + full
content), and one by a **censored hash** (id + sequence + type/category
+ timestamp only). The censored leaf lets verifiers prove an event
existed at a given time without disclosing its content.

The SMT is checkpointed on a configurable interval (default 5 min) into
`~/.openclaw/smt-checkpoints/`. Checkpoint state is stored as one SQLite
DB per tree key plus a `_metadata.json` carrying the seqNos /
conversationChains / epochEntries / lastInsertedSequence cursor. The
authoritative cursor lives in the tree DBs' `kv` table; the JSON is a
sidecar. On restart, `ensureReady()` restores the cursor and the
explicit replay path in service startup re-feeds any events that were
appended before the SMT was ready.

Sequences that the SMT chooses not to track (frozen-leaf collision or
tree-cap rejection) are persisted to the audit DB's `service_health`
table (not the checkpoint dir) so a local-fs attacker who can write to
the checkpoint dir can't suppress tamper narration.

## Digital Evidence Anchoring

Periodically  the plugin
submits the current SMT root to Constellation's Digital Evidence (DE)
network. Two auth modes:

- **API key** — `deApiKey` + `deOrgId` + `deTenantId`
- **x402 wallet** — `deWalletKeyFile` pointing at a SECP256K1 private
  key file; payments go through the x402 client

A `CIRCUIT_BREAKER_THRESHOLD = 5` opens the breaker after consecutive
failures with exponential backoff (capped at 5 min). The breaker keeps
the publisher running but stops hammering DE while it's down.

Each successful submission writes an `integrity_checkpoints` row tying
the SMT root to a DE tx hash and a sequence range. On startup the
service re-verifies any un-verified checkpoint by tx hash; 404s leave
`verified_at` NULL and fire a one-shot "anchor not found" notification
.

## Gateway Publisher

When `gatewayUrl` is configured the plugin batches audit events to the
gateway via `fetch` with an `X-Gateway-Api-Key` header. Batches honor
`gatewayBatchSize`, `gatewayMaxPayloadBytes`, and a configurable flush
interval. On 413 the batch is split in half and retried; on rate-limit
the publisher pauses until the configured window. Each batch carries the
most-recent DE-anchored checkpoint covering its sequence range as
`smtCheckpoint` so the gateway can mark each event verified or
anchor-pending. Drop events on overflow are themselves audit rows so
the operator sees the loss.

Outbound requests set `redirect: "manual"` so a compromised gateway
can't 302 the POST  to an unintended host. The
gateway URL is validated against the shared `validateHttpTargetUrl`
network policy: `http://` only to loopback, no private/link-local hosts
unless `gatewayAllowPrivateHost: true`, no numeric-IP encodings, no
userinfo.

## CLI Commands

All commands run read-only against the audit DB (the writer is the
in-process gateway lifecycle).

- **`audit list`** — view recent events; filters `--last/--type/--category/--session/--limit/--offset`.
- **`audit verify`** — verify SMT roots against DE-anchored checkpoints; reports the exact tampered range on failure.
- **`audit status [--json]`** — runtime snapshot: storage health, SMT pending, anchor health, gateway health, configured cron manifests, inventory counts.
- **`audit ui`** — print the local audit UI URL.
- **`audit export [json|csv]`** — stream events with optional filters; rows include the covering DE anchor reference. Capped at 2 concurrent.
- **`audit inventory [kind]`** — list installed plugins / skills / tools / soul files / configured crons under `~/.openclaw`.
- **`audit report daily [--date]`** — calendar-day digest: top tools, costs, anomalies, integrity, cron rollups. `--json`, `--html`, and time-zone control.
- **`audit report weekly [--week]`** — ISO 8601 week variant of the daily digest.
- **`audit report cron <jobId> [--last]`** — per-cron rollup: success/failure, p95 duration, last error.
- **`audit report session <sessionId>`** — per-conversation timeline + tools + cost + outbound + integrity, with `--raw` and `--include-metadata`.
- **`audit anomalies --since X [--until Y]`** — anomaly detectors over a `[since, until)` window.
- **`audit spend --by provider|model|day|session [--since X]`** — LLM-spend rollup; default top 25, capped at 1000.
- **`audit smt root|proof|verify|trees|chain`** — SMT introspection.

Every handler that talks to the store prints a "WARNING: audit store is
in degraded mode" preamble when applicable.

## Local UI + HTTP API

A loopback-bound HTTP surface under `/plugins/audit/`:

- `GET /api/events`, `GET /api/events/:id`, `GET /api/events/:id/verify`
- `GET /api/trees`, `GET /api/checkpoints`
- `POST /api/verify` — replay-and-compare against DE-anchored roots
- `GET /api/export` — stream JSON/CSV
- `GET /api/report?period=daily|weekly`
- `GET /api/report/cron/:job-id`
- `GET /api/health` — store ok/degraded/eventCount

Every JSON response carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a tight
`Content-Security-Policy`. Every `/api/*` request that arrives with an
`Origin` header must match the request's `Host` or the server returns
403 — defending against cross-origin browser-driven attacks even on
loopback. Requests without an Origin (curl, server-to-server) pass.

Long-running endpoints have per-route concurrency caps (2 for
`/api/verify` and `/api/export`). Routes that read raw conversation
content or run a CPU-bound replay refuse to serve when the gateway is
bound beyond loopback unless the operator explicitly opts in via
`allowExportOnNonLoopback` / `allowVerifyOnNonLoopback`.

A Lit-based SPA lives under `src/control-ui/`: event table with
verification badges, filters, detail panel, trees overview, verify
panel.

## Agent-Callable Tools

- **`audit_de_setup`** — diagnostic tool that returns the configured DE
  auth mode (API key vs x402 wallet) and instructions when nothing is
  configured. Read-only.
- **`audit_smt`** — read-only SMT operations: `root`, `proof`, `verify`,
  `trees`, `stats`, `chain`, `prune_epoch`, `exported_proofs`,
  `snapshot`. `restore_snapshot` is intentionally NOT exposed via the
  agent surface (it would let a malicious agent rewrite the SMT working
  state); `SmtService.restoreSnapshot` is reserved for CLI / admin
  paths.

## Notifications + Report Digests

Two webhook surfaces, both gated through the shared network policy:

- **`notificationWebhook`** — incident notifications:
  `notifyConfigChange`, `notifyIntegrityViolation`,
  `notifyDeAnchorDivergence`, `notifyDeAnchorNotFound`. Slack-style
  blocks payload.
- **`reportWebhook`** — `ReportPusherService` pushes the daily and
  weekly digest on calendar boundaries. State (last-daily / last-weekly
  marker, last error) is persisted in `service_health` so a hot reload
  or re-register doesn't re-push the previous calendar day on the first
  tick. Recipient identifiers in digest payloads are hashed before
  leaving the machine.

Both default to refusing `http://` outside loopback and
private/link-local hosts; operators opt in with
`webhookAllowPrivateHost: true`. Userinfo in URLs is rejected. All
outbound `fetch` calls use `redirect: "manual"`.

## Anomaly Detectors

Run by `audit anomalies` and the daily/weekly digests:

- **`detectDuplicateOutbound`** — message.sent pairs with identical
  content sent to the same `channel + recipient` within `dupWindowSec`,
  honoring both adjacency gap AND total span so the reported window
  matches the operator's contract.
- **`detectFirstSeenTools`** — tool names invoked today that weren't
  present in the prior `lookbackDays` window.
- **`detectGatewayDropSpike`** — clusters of `gateway.dropped` events
  exceeding `dropThreshold` within `dropWindowSec`.
- **`detectDenialSpike`** — clusters of `tool.denied` events exceeding
  `denialThreshold` within `denialWindowSec`.
- **`detectInstallEvents`** — surfaces artifact install events
  (tool/skill/soul/cron installs and updates) that landed in the window.

## Spend Rollup

`audit spend` aggregates `prompt.response` rows in one of four buckets
(`provider`, `model`, `day`, `session`). All four go through a single
`buildSpendStatement` template against parameter-bound SQL; the
columns COALESCE `cacheReadTokens` / `cacheWriteTokens` on the modern
key shape while reading legacy `cacheTokens` rows correctly.

## Service Health Snapshots

Every long-lived service writes a row into the `service_health` table
under a well-known name . The audit
status CLI reads these rows so operators can see cross-process state
. The
rows survive restarts so verification, anchor dedup, report-pusher
markers, and the SMT skip set all carry over.

## Sensitive Data Handling

- **Key-name redaction** — any metadata key matching `secret`,
  `password`, `token`, `key`, `auth`, `credential`, `passphrase`,
  `jwt`, `bearer`, `cookie` (case-insensitive, any depth) is replaced
  with `[REDACTED]` before storage.
- **Field-length caps** — `applyFieldCaps()` at the safeAppend
  chokepoint mirrors the gateway DTO caps (`MAX_FIELD_LENGTH=1000`,
  `MAX_DESCRIPTION_LENGTH=4000`, `MAX_CONTENT_LENGTH=64000`); logs once
  per truncation.
- **Multi-leaf description clamp** — `safeComposite` keeps multi-slot
  descriptions inside the 256-char column budget even after per-slot
  scrubbing.
- **Control-char scrubbing** — every operator-visible string sink
  (descriptions, inventory output, cron-manifest output) is stripped
  of C0/C1/DEL/U+2028/U+2029 so a hostile field can't splice report
  lines or escape log fields.
- **CSV formula-injection guard** — values starting with `=`, `+`, `-`,
  `@` are prefixed with `'` on CSV export.
- **NDJSON safety** — every export row is `JSON.stringify`d, which
  intrinsically escapes embedded `\n`/`\r`.

## File / Config Manifest Watching

- **`ConfigWatcher`** — chokidar-backed watcher for skills, tools, soul
  files, and cron prompts under `~/.openclaw`. Hashes each manifest's
  contents and writes one `config_manifests` row per artifact. On
  add/modify it invokes the **`ToolScanner`** (regex-based static
  analysis for network calls, exfiltration patterns, jailbreak markers)
  and surfaces findings via `notifyConfigChange`. Scanner reads are
  capped at `MAX_HASHABLE_BYTES = 100 MiB` to keep a planted blob from
  OOMing the plugin.
- **`FileWatcher`** — operator-configured glob patterns for arbitrary
  files (`fileWatchPatterns` / `fileWatchIgnorePatterns`); emits
  `file.added` / `file.modified` / `file.removed` events.
- **`cron-manifests`** — reads `~/.openclaw/cron/jobs.json` (openclaw's
  canonical cron store, one entry per `id` in the `jobs[]` array) and
  falls back to legacy `~/.openclaw/<jobId>.cron.*.json` per-file
  manifests for ids not already covered. Read via `openSync +
  fstatSync + readFileSync(fd)` so the size check and the read see
  the same inode .

## Retention and Pruning

`RetentionService` runs `store.prune()` hourly via
`api.registerService`. Two policies, in order:

- **Age-based** — `DELETE FROM audit_events WHERE created_at < cutoff`
  in two passes (synced first, then unsynced) for telemetry clarity.
- **Size-based** — if `getDbSizeMb() > localMaxSizeMb`, delete the
  oldest 1000 synced events per loop iteration, then the oldest events
  overall, until under the cap.

After pruning, orphaned `integrity_checkpoints` whose sequence range
falls below the new minimum are moved into `checkpoint_archive` so
historical anchors remain queryable.

## Rate Limiting

`RateLimiter` interposes between hooks and the store. When the
configured `rateLimitPerSec` is exceeded, events go into a ring buffer
and are drained on a timer. The buffer coalesces same-`eventType +
category` rows so a noisy tool loop doesn't blow the buffer; if the
buffer is still full after coalescing, the drop is logged.

## Sticky Degraded Mode

If the audit store ever fails to write (disk full, schema corruption,
permission flip), the `degraded` flag is set to `true` and the failure
is logged. The flag is **sticky on purpose** — a subsequent successful
write does NOT clear it, because the events lost during the degraded
window aren't recovered just because a later write succeeded. The CLI
and `/api/events` surface the flag to the operator. Recovery paths call
`clearDegraded()` once the loss is reconciled.

## Fail-Open Design

All hook handlers wrap their core work in try/catch and route through
`safeAppend()` so a single failure can't break the agent loop. The
diagnostic listener also swallows its own errors. Hooks are removed
from the registry on shutdown in a specific order: signal handlers off
first, then writer-quiescent close, then store close. The
SIGTERM/SIGINT handler in `GatewayStopCapture` documents the invariant.

## SQLite Configuration

- **WAL mode** + `synchronous = NORMAL` — readers and the writer
  coexist; CLI/UI open the DB read-only.
- **`busy_timeout`** — single-writer semantics on contention.
- **Schema version 7** — managed via `schema_version` table with
  forward-only migrations (each migration logs the version on apply).
- **File permissions** — fresh DB files are created `0o600`.
- **Recovery** — on corruption the writer renames the bad DB to
  `audit.db.corrupt.<ts>` (along with WAL/SHM siblings) and creates a
  fresh DB rather than crash-looping.

## Test Coverage

44 test files, ~815 `it(...)` blocks, 798 currently-passing tests
covering: append mechanics, hash-chain integrity, persistence across
restarts, degraded-mode behavior, tamper detection, query / filter /
pagination, SMT raw + censored hashes, frozen-leaf collisions, replay
determinism, snapshot/restore, prune-epoch + exported proofs,
checkpoint archive, DE anchor circuit breaker, x402 wallet path,
gateway publisher batching + split + drop tracking, report pusher
daily/weekly fire windows, retention, sanitization (nested, arrays,
circular refs), file permissions, network policy , webhook
SSRF rejection, and the full CLI surface.
