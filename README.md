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

The plugin hooks into all 26 OpenClaw lifecycle events and records them into the audit trail. Full message/prompt content is stored gzipped; metadata contains a 50-char preview.

Sensitive values (`secret`, `password`, `token`, `apiKey`, `auth`, `credential`, `passphrase`, `jwt`, `bearer`, `cookie`, `privateKey`) in tool arguments are automatically redacted before storage.

### Prompt events

| Event type | Hook | Metadata captured |
|---|---|---|
| `prompt.model_resolve` | `before_model_resolve` | prompt length |
| `prompt.build` | `before_prompt_build` | prompt length, message count |
| `prompt.input` | `llm_input` | provider, model, prompt length, history message count, images count, content (gzipped) |
| `prompt.response` | `llm_output` | provider, model, token usage (input/output/cache read/write), content (gzipped) |

### Agent events

| Event type | Hook | Metadata captured |
|---|---|---|
| `agent.start` | `before_agent_start` | prompt length, trigger |
| `agent.end` | `agent_end` | duration (ms), success |
| `agent.compaction_start` | `before_compaction` | message count, compacting count, token count |
| `agent.compaction_end` | `after_compaction` | message count, compacted count, token count |
| `agent.reset` | `before_reset` | reason |
| `agent.subagent_spawning` | `subagent_spawning` | agent ID, child session key, label, mode |
| `agent.subagent_spawned` | `subagent_spawned` | agent ID, child session key, run ID, label, mode |
| `agent.subagent_delivery` | `subagent_delivery_target` | child/requester session keys, spawn mode, delivery channel/target |
| `agent.subagent_ended` | `subagent_ended` | target session key, target kind, reason, outcome, error, run ID |

### Tool events

| Event type | Hook | Metadata captured |
|---|---|---|
| `tool.invoked` | `before_tool_call` | tool name, sanitized arguments |
| `tool.result` | `after_tool_call` | tool name, duration (ms), error |
| `tool.persisted` | `tool_result_persist` | tool name, is synthetic |

### Message events

| Event type | Hook | Metadata captured |
|---|---|---|
| `message.received` | `message_received` | direction, sender (with fallback chain), channel, account, surface, content length, timestamp, content (gzipped) |
| `message.sending` | `message_sending` | direction, recipient, channel, content length, content (gzipped) |
| `message.sent` | `message_sent` | direction, recipient, channel, account, content length, success, error, timestamp, content (gzipped) |
| `message.claimed` | `inbound_claim` | channel, sender ID/name, is group, content length |
| `message.dispatched` | `before_dispatch` | channel, sender ID, is group, content length |
| `message.write` | `before_message_write` | agent ID |

### Session events

| Event type | Hook | Metadata captured |
|---|---|---|
| `session.start` | `session_start` | session key, resumed from |
| `session.end` | `session_end` | session key, message count, duration (ms) |

### Gateway events

| Event type | Hook | Metadata captured |
|---|---|---|
| `gateway.start` | `gateway_start` | port |
| `gateway.stop` | `gateway_stop` | reason |

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

## Known security audit warnings

Running `openclaw security audit --deep` may report a `potential-exfiltration` warning for `src/scanner.ts` and `dist/scanner.js`. This is a false positive: the built-in tool scanner uses `readFileSync` to read local skill/tool files for code-safety analysis, not to exfiltrate data. The warning is triggered because the deep audit heuristic detects filesystem reads in the same package as other code. It is safe to ignore.

## Security notes

- The database file is created with `0600` permissions (owner read/write only)
- Sensitive keys (`secret`, `password`, `token`, `apiKey`, `api_key`, `auth`, `credential`, `passphrase`, `jwt`, `bearer`, `cookie`, `privateKey`) are recursively redacted from tool arguments
- The plugin is fail-open: if the database is unavailable, events are silently dropped and the agent continues normally. A degraded-mode warning appears in `audit list` output

## Development

```bash
npm install
npm run build    # Compile TypeScript to dist/
npm test         # Run the test suite (119 tests)
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
