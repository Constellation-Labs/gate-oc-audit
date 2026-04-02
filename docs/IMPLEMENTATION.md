# Implementation Notes

## Project Structure

```
src/
  index.ts                    Plugin entry point — register(api), wires hooks + CLI + services
  hooks.ts                    Hook registration + sanitizeArgs + safeAppend helper
  cli.ts                      CLI handlers: audit, audit verify, audit export
  store/
    audit-store.ts            AuditStore class — append, query, verify, prune, count
    schema.ts                 SQLite DDL, indexes, pragmas
  services/
    retention.ts              Background pruning service (age + size based)
  types/
    events.ts                 AuditEvent, AuditEventInsert, EventType, EventCategory
    openclaw-sdk.ts           Type stubs for OpenClawPluginApi and hook contexts
  util/
    hash.ts                   canonicalize() + computeEventHash()
    machine-id.ts             Stable machine identifier from /etc/machine-id

test/
  index.test.ts               Plugin entry point registration
  hooks.test.ts               Hook registration, sanitization, all 8 event handlers
  cli.test.ts                 CLI output for audit, verify, export
  store/
    audit-store.test.ts       Append, hash chain, persistence, degraded mode, permissions, tamper detection
    audit-store-query.test.ts Query, count, verify, prune
    schema.test.ts            Table/index creation, idempotence
  services/
    retention.test.ts         Pruning on start, custom config, idempotent stop
  util/
    hash.test.ts              canonicalize determinism, computeEventHash field sensitivity
    machine-id.test.ts        Format, caching
```

## Dependencies

Only two runtime dependencies:

- **`better-sqlite3`** — Synchronous SQLite driver. Chosen because the `tool_result_persist` hook is synchronous in OpenClaw (async handlers are silently ignored), so the entire write path must be sync. WAL mode is enabled for read concurrency.
- **`uuidv7`** — Time-ordered UUIDs for event IDs. UUIDv7 embeds a millisecond timestamp, making IDs naturally sortable without relying on the sequence counter.

Dev dependencies: `typescript`, `tsx` (for running tests without a compile step), `@types/better-sqlite3`, `@types/node`.

## SDK Type Stubs

The `openclaw/plugin-sdk` package doesn't exist yet. `src/types/openclaw-sdk.ts` defines the full `OpenClawPluginApi` interface and all hook context types based on the product spec. The `on()` method uses a `HookContextMap` generic so each hook name maps to its specific context type. These stubs will be replaced by the real SDK when it ships.

## Hash Chain Design

The spec defines `contentHash` as `SHA-256(metadata)` with `previousHash` pointing to the prior event's `contentHash`. We deviate from this intentionally:

**Our `contentHash` includes:** `id`, `sequence`, `previousHash`, `source`, `sessionId`, `orgId`, `userId`, `eventType`, `category`, `description`, and `metadata`.

**Why:** The spec's metadata-only hash doesn't detect reordering (swapping sequences), ID replacement, or modification of non-metadata fields like `eventType` or `description`. By including `id` and `sequence`, each hash commits to the event's identity and position. By including `previousHash`, each hash commits to the full chain history — modifying any earlier event cascades through all subsequent hashes.

**Canonical serialization:** `canonicalize()` uses a recursive `stableStringify` that sorts object keys, handles circular references (via `WeakSet`), enforces a depth limit of 100, and omits `undefined` keys (matching `JSON.stringify` behavior). This produces deterministic output regardless of key insertion order.

**Single serialization path:** The canonical form is used for both the `metadata` column in SQLite and the hash computation. There is no double serialization — `canonicalize()` runs once per event, and the result is passed to both `computeEventHash()` (as `metadataCanonical`) and the INSERT statement.

## Fail-Open Error Handling

Every hook handler calls `safeAppend()` which wraps `store.append()` in a try/catch that logs `err.message` to stderr and returns silently. Inside `append()`, there's a second try/catch that sets the `degraded` flag and rolls back in-memory state (sequence and previousHash are only updated after a successful INSERT). The `degraded` flag clears on the next successful write.

Metadata validation happens before the INSERT: non-serializable values (BigInt, functions) are caught by a try/catch around `canonicalize()`, and oversized metadata (>1MB) is rejected. Both return `undefined` without setting the `degraded` flag, since these are input validation issues, not store failures.

## Sequence Atomicity

The sequence counter and `previousHash` are stored in memory and only advanced after a successful `insertStmt.run()`. If the INSERT throws (DB locked, disk full, constraint violation), the in-memory state remains unchanged — the next append retries with the same sequence number. There is no `sequence--` rollback that could race with concurrent processes.

## SQLite Configuration

- **WAL mode** — allows concurrent readers while writing
- **`synchronous = NORMAL`** — fsync on checkpoint, not every commit (trades a small durability window for throughput)
- **Prepared statement** — the INSERT is prepared once in the constructor and reused for every append
- **File permissions** — new DB files are created with `0o600` (owner read/write only)

## Retention

`RetentionService` runs `store.prune()` on start and every hour via `setInterval` (with `.unref()` so it doesn't keep the process alive). Pruning is two-pass:

1. **Age-based:** `DELETE FROM audit_events WHERE created_at < cutoff` (single statement)
2. **Size-based:** If the DB exceeds `maxSizeMb`, delete the oldest 1000 events in a loop until under the limit. Size is estimated via `PRAGMA page_size * PRAGMA page_count`.

The spec mentions preferring to prune synced events first — this is not yet implemented since the sync service doesn't exist.

## CLI

`src/cli.ts` exports three handler functions registered via `api.registerCli()`. All share a `parseFlags()` helper that extracts `--key value` pairs from argv.

- **`audit`** queries with `ORDER BY sequence DESC` and reverses the result for chronological display
- **`verify`** reads all events in sequence order and recomputes every hash, checking both content integrity and chain links
- **`export json`** outputs one JSON object per line (JSON Lines format); `export csv` outputs a header row plus data rows with proper quoting

## Known Limitations

- **No `openclaw/plugin-sdk` package** — type stubs are local; will need updating when the real SDK ships
- **Prompt content stored in plaintext** — the DB file is permission-protected but not encrypted at rest
- **Key-name-only sanitization** — secrets in values under non-matching key names (e.g., `{ command: "curl -H 'Authorization: ...'" }`) are not redacted
- **No config watcher** — `config_manifests` table exists but nothing populates it
- **No DE anchoring** — `integrity_checkpoints` table exists but no Merkle root computation or API calls
- **No gateway sync** — `sync_state` table exists but no sync service
- **No rate limiting** — high-throughput tool loops write every event individually
- **No DB recovery** — if SQLite is corrupted, the plugin degrades but doesn't create a fresh DB

## Not Implemented (Future Features)

Per the product spec, these are planned for the free tier but not yet built:

1. **ConfigWatcher** — `chokidar` filesystem watcher on skills, tools, soul files, cron prompts
2. **Tool scanning** — static analysis for suspicious patterns in skill/tool code
3. **Change notifications** — webhooks to Slack/Discord on config changes
4. **DE anchoring** — periodic Merkle root submission to Digital Evidence API with circuit breaker
5. **Rate limiting** — ring buffer with event coalescing under sustained load
6. **DB recovery** — create fresh DB on corruption, preserve old file
