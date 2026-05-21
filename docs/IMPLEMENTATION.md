# Implementation Notes

## Project Structure

62 TypeScript files under `src/`. The layout follows roughly one
subsystem per directory.

```
src/
  index.ts                  Plugin entry: register(api), wires hooks +
                            CLI + agent tools + 8 background services
  hooks.ts                  Hook registrations; safeAppend chokepoint
                            with sanitize + applyFieldCaps + safeDesc
  cli.ts                    CLI handlers + warnIfDegraded helper
  scanner.ts                ToolScanner: regex static analysis for
                            installed skill/tool source files
  rate-limiter.ts           RateLimiter: ring buffer + coalescing
  gateway-stop-capture.ts   SIGTERM/SIGINT fallback that records
                            gateway.stop when the host exits before
                            the openclaw hook fires

  store/
    audit-store.ts          AuditStore class: append, query, prune,
                            countAndMaxSince, ~30 prepared statements,
                            content_hash chain via scalar subquery
    schema.ts               DDL + migrations + runInTransaction
    smt-logic.ts            insertEntry, getNextSeqNo, epoch/chain helpers
    smt-store.ts            SmtStore: SMT wrapper, frozen-leaf set,
                            snapshot/restore with consistency check
    smt-tree-manager.ts     One TreeManager owns per-treeKey SmtStores
                            and authoritative cursors in tree DBs

  services/
    smt-service.ts          SmtService: dual-hash inserts, checkpointing,
                            replay, prune-epoch, skippedSeqs persistence
    smt-snapshot.ts         Serialize/deserialize SMT snapshots with a
                            self-hash for tamper detection
    de-anchor.ts            ActiveAnchorService (API-key + x402 wallet)
                            + NoOpAnchorService + circuit breaker
    gateway-publisher.ts    Batched outbound publisher; validators;
                            selectMostRecentAnchorAtOrBefore helper
    notifications.ts        NotificationService: 4 incident notifiers
    report-pusher.ts        ReportPusherService: daily/weekly digest
                            push with restoreState persistence
    verifier.ts             Range replay-and-compare against
                            DE-anchored roots; tamper-range bracket
    retention.ts            RetentionService: hourly age + size prune
    config-watcher.ts       ConfigWatcher: chokidar + ToolScanner +
                            notify on skill/tool/soul/cron changes
    file-watcher.ts         FileWatcher: operator-configured patterns
    cron-manifests.ts       Reads ~/.openclaw/<jobId>.cron.*.json with
                            fd-based size check (no TOCTOU)
    inventory.ts            Plugin/skill/tool/soul/cron inventory

  reports/
    projection.ts             Day/week digest projection
    session-projection.ts     Per-conversation projection
    spend-rollup.ts           LLM spend by provider/model/day/session
    status-snapshot.ts        `audit status` shape builder
    cron-rollup.ts            Per-cron-job rollup
    anomalies-view.ts         Anomalies CLI view assembly
    detectors.ts              5 anomaly detectors (dup, first-seen,
                              drop spike, denial spike, install events)
    time-window.ts            parseInstant, parseSince, parseDate,
                              parseWeek with TZ + sub-ms rejection
    format-{text,html,blocks,session,status,anomalies-*}.ts
                              Render projections to text/HTML
    text-utils.ts, html-utils.ts
                              Shared formatting primitives

  ui/
    routes.ts                 HTTP route dispatch, same-origin gate,
                              CSP headers, concurrency caps in closure
    export.ts                 NDJSON / CSV streaming exporter with
                              OWASP formula-injection guard
    inventory-formatter.ts    Inventory text/JSON formatting

  control-ui/                 Lit SPA served from /plugins/audit/
    main.ts, api.ts, styles.css, index.html
    components/audit-app.ts, event-filters.ts, event-table.ts,
                event-detail.ts, trees-overview.ts, verify-panel.ts

  util/
    network-policy.ts         validateHttpTargetUrl + private/loopback/
                              numeric-IP / userinfo policy used by
                              both the gateway and webhooks
    webhook.ts                postJsonWebhook + isUnsafeWebhookUrl
                              (calls network-policy)
    gateway-url.ts            UI URL resolution
    asset-server.ts           Static file serving with path.sep guard
    error-message.ts          messageOf(err) normaliser
    fs.ts                     MAX_HASHABLE_BYTES + fileHash helper
    openclaw-paths.ts         Resolve ~/.openclaw + plugin metadata
                              readers (size-capped)
    machine-id.ts             Stable machine identifier
    logger.ts                 Subsystem-scoped loggers

  types/
    events.ts                 AuditEvent shapes + EventType union
    smt.ts                    SeqNos, ChainEntry, EpochEntries, etc.
```

Test layout mirrors `src/`. 44 test files; ~815 `it(...)` blocks; 798
currently passing + 1 pre-existing skip.

## Dependencies

Runtime  (`engines.node >= 22.13.0`):

- **`@constellation-network/digital-evidence-sdk`** — canonicaliser,
  hashDocument, generateFingerprint, DedClient, isValidPrivateKey,
  generateKeyPair. Loaded via `createRequire(import.meta.url)` so the
  SDK doesn't have to be an ESM module.
- **`@constellation-network/digital-evidence-sdk-x402`** — x402 wallet
  client. Loaded lazily only when `WalletAnchorService` is instantiated.
- **`@zk-kit/smt`** — Sparse Merkle Tree primitive. Single dep for SMT
  arithmetic; `SmtStore` wraps it for frozen-leaf bookkeeping.
- **`chokidar`** v4 — file watcher used by `ConfigWatcher` and
  `FileWatcher`.
- **`picomatch`** v4 — glob matcher for the file-watch ignore lists.
- **`uuidv7`** — UUIDv7 for event IDs and checkpoint IDs.

No `better-sqlite3` — the plugin uses Node 22's built-in `node:sqlite`
(`DatabaseSync`). The synchronous API is a hard requirement: openclaw's
`tool_result_persist` hook is synchronous, so the write path is sync
top-to-bottom.

Optional peer:

- **`ethers`** ^6 — only loaded when `WalletAnchorService` initialises
  (x402 wallet auth path). Missing dependency means wallet anchoring
  fails over to `NoOpAnchorService` with a logical-error message.

Dev:

- `openclaw` ^2026.4.24 (peer SDK), `lit` (SPA), `typescript`, `tsx`,
  `vite` (UI build).

## Schema (v7)

Managed by `src/store/schema.ts`. `runInTransaction` wraps every
migration; `schema_version` records every applied version.

**Tables:**

- **`audit_events`** — `sequence` INTEGER PK AUTOINCREMENT, `id`
  UNIQUE, source, machine/session/org/user ids, event_type, category,
  description, metadata (canonical JSON), `content_gz` (gzipped raw
  content), `content_hash` (SHA-256 of canonicalised event),
  `previous_hash`, `created_at` ISO 8601, `received_at`, `synced_at`.
  11 indexes including a partial index on `cron.executed` keyed by
  `metadata.jobId` for the per-cron rollup.
- **`integrity_checkpoints`** — DE-anchored checkpoint: `id`,
  `sequence_start..end`, `smt_root`, `event_count`, `de_tx_hash`,
  `created_at`, `verified_at`. `verified_at` is set once DE confirms
  the tx hash; NULL until then  so that
  verification retries on next start.
- **`checkpoint_archive`** — orphaned-after-prune checkpoints get
  moved here so historical anchors remain queryable.
- **`config_manifests`** — content-hash record per scanned manifest
  artifact .
- **`service_health`** — `name` PRIMARY KEY, JSON `payload`,
  `updated_at`. Shared cross-process state surface .
- **`schema_version`** — applied-migration ledger.

**Migrations applied at startup:**

1. **v2** — `checkpoint_archive` table.
2. **v3** — removed hash chain (legacy).
3. **v4** — re-introduced `content_hash` + `previous_hash` with a
   transactional table rebuild and a `backfillHashChain()` pass over
   existing rows.
4. **v5** — compound indexes on `audit_events(event_type, created_at)`
   and `(category, created_at)` plus `service_health`.
5. **v6** — `integrity_checkpoints.verified_at` cache column.
6. **v7** — partial index on `audit_events` for
   `event_type='cron.executed'` keyed by `metadata.jobId`.

**Recovery:** if `initializeSchema` throws during writer open, the
existing DB is renamed to `<path>.corrupt.<ts>` (along with its WAL/SHM
siblings) and a fresh DB is created. Read-only opens (CLI) skip the
recovery branch and surface the error.

## Hash Chain Design

The spec's literal `contentHash = SHA-256(metadata)` shape doesn't
detect reordering, ID replacement, or modification of non-metadata
fields. We extend the inputs.

**`contentHash` covers:** `id`, `sequence`, `previousHash`, `source`,
`sessionId`, `orgId`, `userId`, `eventType`, `category`, `description`,
`metadata`. Reordering swaps a `sequence`, ID replacement swaps an
`id`, and modifying any earlier event cascades through every
subsequent `content_hash` via `previousHash`.

**Atomic predecessor lookup:** the INSERT prepared statement uses a
scalar subquery for `previous_hash`:

```
INSERT INTO audit_events (..., content_hash, previous_hash, ...)
VALUES (..., @contentHash,
        (SELECT content_hash FROM audit_events ORDER BY sequence DESC LIMIT 1),
        ...)
RETURNING sequence, previous_hash
```

The read-then-write happens inside one statement under SQLite's write
lock, so concurrent `AuditStore` instances can never read the same
predecessor and fork the chain. `RETURNING` reads back the assigned
sequence + linked predecessor so the caller observes exactly what was
persisted.

**Canonical serialization:** `digital-evidence-sdk.canonicalize()`
produces deterministic JSON regardless of key insertion order.
`sanitize()` walks the metadata tree with a `WeakSet` cycle guard and
replaces sensitive-key values with `[REDACTED]`.

## SMT Subsystem

Three layers:

- **`SmtStore`** — wraps `@zk-kit/smt` with a frozen-leaf `Set<string>`
  and snapshot APIs. `restoreFromState` validates the supplied root
  against the nodes map to refuse a stranger-supplied inconsistent
  snapshot.
- **`TreeManager`** — owns per-`treeKey` SmtStores. Each tree gets its
  own SQLite DB under the checkpoint dir; the `kv` table carries an
  authoritative `meta:lastInsertedSeq` cursor that beats the JSON
  sidecar if they disagree.
- **`SmtService`** — public surface. `onEventAppended(event)` computes
  raw + censored leaves, calls `insertEntry`, and `markSkipped(seq)` on
  frozen-leaf collision or tree-cap rejection. Skipped sequences are
  persisted via `service_health` so the classifier doesn't later flag
  them as tampered.

**Dual hashes:**

- `computeRawHash(event)` — `id + sequence + full content` for exact
  replay verification.
- `computeCensoredHash(event)` — `id + sequence + eventType +
  category + timestamp` for privacy-preserving inclusion proofs.

Both leaves are added to the tree, both feed `epochEntries`, and both
go into `conversationChains` so `pruneEpoch` can sweep `leafValues`
cleanly.

**Restore + replay:** `ensureReady()` runs `manager.restoreAll`, then
`restoreSkippedSeqs` from `service_health`, then `restoreMetadata`.
`restoreMetadata` clears the in-memory maps as its first action so any
pre-start hook fires that incremented `seqNos` against an empty state
get wiped before the persisted values land. The host's service `start()`
then runs an explicit `replayEvents` to re-feed any sequences > the
restored cursor against the audit store.

**Verifier:** `Verifier.replayUpTo(maxSeq, anchored, from, to)`
recomputes the SMT from a clean state by re-reading `audit_events` in
batches, honoring `smtService.wasSkipped(seq)` and the real
`maxTreeSize` so the replay tree matches what the live insert path
accepted. On mismatch the verifier brackets the tampered range by
scanning leaves the live tree tracks but whose current content no
longer hashes to a stored leaf.

## DE Anchor

`createDeAnchorService(store, config, notifier)` dispatches to one of:

- **`ApiKeyAnchorService`** — `DedClient({baseUrl, apiKey})` from
  `digital-evidence-sdk/network`. Requires `deOrgId + deTenantId`.
- **`WalletAnchorService`** — reads a SECP256K1 private key file,
  validates via `dedCore.isValidPrivateKey`, wraps it in
  `ethers.Wallet` and `createEthersSigner` from the x402 SDK. Logical
  errors  surface; filesystem-error
  details  are scrubbed.
- **`NoOpAnchorService`** — falls back when DE isn't configured. Logs
  the reason once at construction.

The base `ActiveAnchorService` carries the threshold-counter, circuit
breaker, and the anchor lifecycle:

1. `notifyAppend()` increments `appendsSinceLastCheckpoint`; threshold
   crossing fires-and-forgets `anchorIfNeeded()`.
2. `anchorIfNeeded(minEvents?)` short-circuits if an anchor is already
   running or the breaker is open.
3. `doAnchor(minEvents)` reads `countAndMaxSince(startSeq)` atomically
   , checks SMT
   root availability, calls `submitFingerprint(smtRoot)`, persists the
   checkpoint, and on success resets the counter. Failures call
   `recordFailure()`  and reset the counter too .
4. `verifyCheckpoints()` runs at start: for every checkpoint with no
   `verified_at`, GET the tx hash. Any 404 fires a deduped
   `notifyDeAnchorNotFound` (persisted via `service_health` so it
   doesn't re-fire on every restart).

## Gateway Publisher

`createGatewayPublisher(deps)` returns either `NoOpPublisher` or
`ActivePublisher`. Validation:

- `validateGatewayUrl(raw, {allowPrivateHost})` — delegates to the
  shared `util/network-policy.ts` and appends the gateway-specific
  config hint when a private host is rejected.
- `validateGatewayApiKey(key)` — length + character whitelist (no CR,
  no LF, no quotes).

The publisher buffers events and flushes on size, age, or
`notifyAppend`. Each batch's `smtCheckpoint` envelope field is
populated by `selectMostRecentAnchorAtOrBefore(checkpoints, maxSeq)`
. The
batch's max sequence is computed via `reduce` (the spread form
overflows V8's argument limit at ~7500 entries).

Failure modes:

- **413** — split the batch in half via `sendWithSplit`.
- **429 / `Retry-After`** — set `rateLimitedUntil` and pause.
- **Network / 5xx** — record on a consecutive-failure circuit breaker.

Outbound `fetch` calls use `redirect: "manual"` so a 302 from a
compromised gateway can't steer the POST  to a private network host.

Drops: when the buffer overflows we record a `gateway.dropped` audit
row . A drop-throttle ensures we don't
emit one health upsert per dropped event.

## Hook Chokepoint

Every hook funnels through `safeAppend()` in `src/hooks.ts`:

1. `applyFieldCaps()` clamps the per-field strings against gateway DTO
   caps.
2. `safeDesc` / `safeComposite` clamp the operator-visible description.
3. `truncateMetadataStrings` walks the metadata and clamps strings.
4. `sanitize()` redacts sensitive-key values.
5. `numOrUndef()` coerces SDK-supplied counts/durations/costs so the
   stored metadata stays clean of `NaN`/`Infinity`.
6. The result lands on `store.append()` (writer path) or
   `limiter.append()` (rate-limited path).

`*Extra` cast aliases concentrate the SDK-type-lag `as any` annotations
into one block instead of scattering them across each handler.

## Rate Limiter

`RateLimiter` interposes between hooks and the store. When the
per-second window is exceeded, events go into a ring buffer keyed by
`eventType + category`. `coalesceBuffer()` collapses entries in the
same group; if the buffer is still full after coalescing, the drop is
logged via the subsystem logger (it used to silently drop). The drain
timer pumps buffered events back through the store on a low-throughput
schedule.

## Network Policy

`src/util/network-policy.ts:validateHttpTargetUrl` is the single source
of truth for outbound URL safety:

- malformed URL → reject
- protocol not in `{http:, https:}` → reject
- userinfo `user:pass@host` → reject (would otherwise leak in logs)
- numeric-IP encodings  →
  reject
- `http://` to anything but loopback → reject (cleartext credential
  risk)
- `https://` to private/link-local IPs → reject unless
  `allowPrivateHost` is set

Used by `validateGatewayUrl` (gateway publisher) and
`isUnsafeWebhookUrl` (notification + report webhooks).

## UI Authorization Posture

The `/plugins/audit/api/*` surface is registered with `auth: "plugin"`
and relies on:

1. **Loopback bind** — the openclaw default.
2. **Same-origin gate** — every API request with an `Origin` header
   must match the request's `Host`; mismatches return 403.
3. **Concurrency caps in a closure** — `MAX_CONCURRENT_EXPORTS = 2`
   and `MAX_CONCURRENT_VERIFIES = 2` live on a per-registration
   `ConcurrencyState` object so double registration can't share
   counters.
4. **Defense-in-depth headers** — `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, tight
   `Content-Security-Policy` with `frame-ancestors 'none'`.
5. **Opt-in for non-loopback** — `/api/export`, `/api/verify`, and
   `/api/report*` refuse to serve when the gateway binds beyond
   loopback unless `allowExportOnNonLoopback` / `allowVerifyOnNonLoopback`
   are set.

Future work: a shared-secret token or device-pairing claim. The TODO
is referenced in `src/ui/routes.ts:1-5`.

## Failure / Degraded Behavior

- **Sticky `degraded`** — once set, only `clearDegraded()` clears it.
  A subsequent successful append does NOT clear because the dropped
  events aren't recovered just because a later write succeeded.
- **Recovery on corruption** — `openOrRecover` renames the bad DB to
  `audit.db.corrupt.<ts>` (with WAL/SHM siblings) and creates a fresh
  DB. CLI / read-only opens surface the error without rewriting.
- **`gateway.stop` capture** — `GatewayStopCapture` installs
  SIGTERM/SIGINT fallback listeners so a stop event is still recorded
  when the host exits before openclaw's `gateway_stop` hook fires. The
  listener invariant  is documented in
  the captureSignal preamble.

## CLI

`src/cli.ts` exports per-subcommand handler functions registered via
`api.registerCli({program})`. CLI handlers open the DB read-only by
default; the writer-side `AuditStore` is created later when the host
calls `register({api})` in full mode.

`outLine()` bypasses `console.log` because the SDK's
`routeLogsToStderr()` rewires console.log to stderr in CLI dispatch
mode — `outLine` writes directly to `process.stdout` so command output
lands where the operator expects.

`warnIfDegraded(store)` centralises the degraded-mode banner across
all eight handlers.

`parsePositiveInt(label, max)` and `parseSince` (in `reports/time-window`)
own the input-validation shape for numeric and time-range arguments.

## Time Windows

`parseInstant(input, now?)` accepts either a duration (`5m`, `1h`,
`3d`) or an ISO 8601 instant with an explicit offset (`Z` or
`±HH:MM`). It rejects sub-millisecond precision so a `to` bound with
`.123456Z` doesn't silently truncate and mis-bucket boundary events.

`parseDate(YYYY-MM-DD, tz)` and `parseWeek(YYYY-Www, tz)` resolve to
`[from, to)` half-open ranges in the requested zone.

The audit store's `createdBefore` SQL bound is **exclusive** to match
the half-open convention; `src/ui/export.ts` bumps the operator-passed
`--to` by 1 ms before binding so the CLI's documented inclusive
`--to` keeps emitting the boundary event.

## SQLite Configuration

- **WAL mode** for reader/writer concurrency.
- **`synchronous = NORMAL`** — fsync at WAL checkpoint, not every
  commit.
- **`busy_timeout`** + the prepared-statement insert means concurrent
  writers serialise rather than retry-loop.
- **AUTOINCREMENT sequence** + `RETURNING sequence` removes the need
  for an in-memory counter; multiple AuditStore instances on the same
  file safely interleave inserts.
- **0o600 file mode** — writers chmod the file on first creation;
  read-only opens leave it alone.

## Notable Single-Caller Conventions

A few small but load-bearing rules:

- **`@deprecated` aliases** — `selectAnchorCovering` is kept as a thin
  alias for `selectMostRecentAnchorAtOrBefore`; `countSince` and
  `maxSequenceSince` are kept around `countAndMaxSince`. Any external
  importer keeps working.
- **Configured-cron output** — anything sourced from the filesystem
  (cron-manifest fields, inventory) is run through `sanitizeOutput`
  before reaching reports or webhooks so a hostile filename or edited
  manifest can't splice ANSI / CR / LF into operator output.
- **`messageOf(err)`** — `src/util/error-message.ts` normalises
  `err instanceof Error ? err.message : "Unknown error"` so a future
  audit-log injection rule has one place to enforce wording.

## Build + Test

- `npm run build` — `tsc && vite build`. `tsc` emits to `dist/`; the
  UI bundle lands in `dist/control-ui/`.
- `npm test` — `node --import tsx --test test/**/*.test.ts`. No
  separate runner.
- `npm run test:e2e` — only the e2e suite.

Tests use `tsx` so there's no separate compile step, and the test
runner is Node's built-in `node:test`.
