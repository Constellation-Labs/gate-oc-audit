# @constellation-network/openclaw-audit-plugin

Tamper-evident audit trail for AI coding agent activity. Records every session, tool invocation, and prompt exchange into a local SQLite database with SHA-256 hash chain integrity, so you can verify that no events were altered or deleted after the fact.

## Installation

```bash
openclaw plugins install @constellation-network/openclaw-audit-plugin
```

Requires `openclaw >= 2026.1.0` as a peer dependency.

That's it. The plugin automatically starts recording audit events when your agent runs.

### Configuration (optional)

```json
{
  "plugins": ["@constellation-network/openclaw-audit-plugin"],
  "plugin": {
    "@constellation-network/openclaw-audit-plugin": {
      "config": {
        "dbPath": "~/.openclaw/audit.db",
        "localRetentionDays": 365,
        "localMaxSizeMb": 500
      }
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `dbPath` | `~/.openclaw/audit.db` | Path to the SQLite database file |
| `localRetentionDays` | `365` | Delete events older than this many days |
| `localMaxSizeMb` | `500` | Prune oldest events when the DB exceeds this size |

## What gets recorded

The plugin hooks into OpenClaw's lifecycle and captures:

| Category | Events | Description |
|---|---|---|
| **Session** | `session.start`, `session.end` | Agent start/stop with duration and success status |
| **Tool** | `tool.invoked`, `tool.result`, `tool.persisted`, `tool.denied` | Every tool call with arguments, results, and timing |
| **Message** | `message.received`, `message.sent` | Inbound/outbound messages with sender fallback resolution; 50-char preview in metadata, full content stored gzipped |
| **Prompt** | `prompt.sent`, `prompt.response` | LLM calls with model, token usage; 50-char preview in metadata, full content stored gzipped |

Sensitive values (secrets, passwords, tokens, API keys, etc.) in tool arguments are automatically redacted before storage.

## CLI commands

### List events

```bash
openclaw audit list
openclaw audit list --last 20
openclaw audit list --type tool.invoked
openclaw audit list --category prompt --session <session-id>
```

### Verify integrity

Walk the full hash chain and confirm no events have been tampered with:

```bash
openclaw audit verify
```

Exits with code `0` if the chain is intact, `1` if tampering is detected.

### Export

```bash
openclaw audit export          # JSON Lines (default)
openclaw audit export csv      # CSV format
openclaw audit export --type tool.invoked --limit 100
```

## How the hash chain works

Each event's `contentHash` is a SHA-256 digest over its ID, sequence number, previous hash, and all event fields. The first event links to a `GENESIS` sentinel. This means:

- Deleting an event breaks the chain (the next event's `previousHash` won't match)
- Modifying any field changes the hash
- Reordering events is detectable via sequence numbers embedded in the hash

Run `openclaw audit verify` at any time to check chain integrity.

## Security notes

- The database file is created with `0600` permissions (owner read/write only)
- Sensitive keys (`secret`, `password`, `token`, `key`, `auth`, `credential`, `passphrase`, `jwt`, `bearer`, `cookie`) are recursively redacted from tool arguments
- The plugin is fail-open: if the database is unavailable, events are silently dropped and the agent continues normally. A degraded-mode warning appears in `audit list` output

## Development

```bash
npm install
npm run build    # Compile TypeScript to dist/
npm test         # Run the test suite (109 tests)
npm run clean    # Remove dist/
```

### Local install

To install the plugin from a local checkout into OpenClaw:

```bash
npm run build
openclaw plugins install --link .
```

The `--link` flag symlinks the local directory instead of copying, so changes are picked up after a rebuild and gateway restart:

```bash
npm run build
openclaw daemon restart
```
