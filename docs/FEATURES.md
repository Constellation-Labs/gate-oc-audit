# OpenClaw Audit Plugin — Implemented Features

## Audit Trail Capture

Every meaningful agent lifecycle event is recorded to a local SQLite database at `~/.openclaw/audit.db`. The plugin registers against all OpenClaw lifecycle hooks with priority 200 to capture events before other plugins can modify or short-circuit them.

**Captured events:**

- **Session boundaries** — start (with prompt length) and end (with duration, success/failure)
- **Tool invocations** — tool name, sanitized arguments, exit code, duration, truncated output (1KB)
- **Tool result persistence** — captures the final content written to transcript (synchronous hook)
- **Messages** — inbound prompts (truncated to 500 chars) and outbound responses
- **LLM usage** — provider, model, input/output/cache tokens, duration, cost in USD

## Tamper-Evident Hash Chain

Every event is linked into a SHA-256 hash chain. The `contentHash` covers the event's ID, sequence number, previous hash, source, session, org, user, event type, category, description, and metadata — so reordering events, replacing IDs, or modifying any field breaks the chain. The first event links to `GENESIS`. On restart, the chain resumes from the last stored event.

## Sensitive Data Handling

Tool arguments are recursively sanitized before storage. Keys matching `secret`, `password`, `token`, `key`, `auth`, `credential`, `passphrase`, `jwt`, `bearer`, or `cookie` (case-insensitive) are replaced with `[REDACTED]` at any nesting depth, including inside arrays. Metadata is capped at 1MB; non-serializable values (BigInt, circular references) are handled gracefully without crashing.

## CLI Commands

- **`openclaw audit`** — View recent events with optional filters: `--last N`, `--type`, `--category`, `--session`, `--limit`, `--offset`. Shows a degraded-mode warning when applicable.
- **`openclaw audit verify`** — Walks the entire hash chain, recomputes every content hash, and verifies every chain link. Reports the exact sequence number and error on failure.
- **`openclaw audit export [json|csv]`** — Exports events as JSON lines or CSV. Supports the same filters as `audit`.

## Retention and Pruning

A background service runs every hour (via `api.registerService`) and enforces two pruning policies, whichever triggers first:

- **Age-based** — deletes events older than `localRetentionDays` (default 365)
- **Size-based** — deletes oldest events in batches of 1000 until the DB is under `localMaxSizeMb` (default 500MB)

## Security Hardening

- Database file created with `0o600` permissions (owner read/write only)
- Error logs emit only `err.message`, never the full error object (prevents leaking metadata to stderr)
- Canonical JSON serialization with circular reference detection (WeakSet) and depth limit (100 levels)

## Fail-Open Design

The plugin never blocks the agent. All hook handlers are wrapped in try/catch. If the store encounters an error (disk full, corruption, permissions), the event is silently dropped, a `degraded` flag is set (and cleared on next successful write), and the agent continues unaffected. Non-serializable or oversized metadata returns `undefined` without degrading.

## Schema

SQLite with WAL mode, 4 tables (`audit_events`, `config_manifests`, `integrity_checkpoints`, `sync_state`), and 8 indexes covering event type, category, session, created time, machine, user, org, and unsynced events. The `config_manifests`, `integrity_checkpoints`, and `sync_state` tables are created but unused — reserved for config watching, DE anchoring, and gateway sync (future features).

## Test Coverage

109 tests across 8 test files covering: append mechanics, hash chain integrity, persistence across restarts, degraded mode, tamper detection, query/filter/pagination, chain verification, pruning, CLI output formatting, retention service lifecycle, sanitization (nested, arrays, circular refs), file permissions, and plugin registration.
