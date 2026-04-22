# @constellation-network/openclaw-audit-plugin

Tamper-evident audit trail for AI coding agent activity. Records every session, tool invocation, and prompt exchange into a local SQLite database with SHA-256 hash chain integrity, so you can verify that no events were altered or deleted after the fact.

## Installation

```bash
openclaw plugins install @constellation-network/openclaw-audit-plugin
```

Requires `openclaw >= 2026.1.0` as a peer dependency and Node.js ≥ 22.5 (≥ 24 recommended). The plugin uses the built-in `node:sqlite` module; on Node 22.x it must be launched with `--experimental-sqlite`.

That's it. The plugin automatically starts recording audit events when your agent runs.

### Configuration (optional)

Add config under `plugins.entries` in your OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "constellation-audit-plugin": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/audit.db",
          "localRetentionDays": 365,
          "localMaxSizeMb": 500
        }
      }
    }
  }
}
```

#### Storage

| Option | Default | Description |
|---|---|---|
| `dbPath` | `~/.openclaw/audit.db` | Path to the SQLite database file |
| `localRetentionDays` | `365` | Delete events older than this many days |
| `localMaxSizeMb` | `500` | Prune oldest events when the DB exceeds this size |

#### Rate limiting

| Option | Default | Description |
|---|---|---|
| `rateLimitPerSec` | `100` | Max audit events written per second |
| `rateLimitBufferSize` | `10000` | Buffer capacity for events that exceed the rate limit |

#### Notifications

| Option | Default | Description |
|---|---|---|
| `notificationWebhook` | — | Webhook URL for alerts (config changes, integrity violations, DE divergence) |

#### Redaction

| Option | Default | Description |
|---|---|---|
| `redactPromptText` | `false` | Replace content of `prompt.*` and `message.*` events with `"sha256:<hex>"` before DB write. Length metadata (`contentLength` / `promptLength`) is preserved. |
| `redactToolArgs` | `false` | Replace `tool.invoked` `metadata.args` with `{ hash: "sha256:<hex>" }` (hash computed over canonicalized JSON of the already key-sanitized args). |

Hashes allow independent verification — anyone with the original plaintext can re-hash and confirm it matches the audit record, without the plaintext ever touching the DB.

#### Sparse Merkle Tree

Nested under the `smt` key:

```json
{
  "config": {
    "smt": {
      "treeKey": "auto",
      "maxTreeSize": 500000
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `smt.treeKey` | `auto` | Tree identifier (`auto` derives from machine ID) |
| `smt.maxTreeSize` | `500000` | Max leaves per tree |
| `smt.checkpointDir` | `~/.openclaw/smt-checkpoints` | Directory for tree checkpoint files |
| `smt.checkpointIntervalMs` | `300000` | Interval between tree checkpoints (ms) |
| `smt.epochDurationMs` | `3600000` | Epoch duration for subtree freezing (ms) |
| `smt.pruneAfterEpochs` | `0` (disabled) | Freeze subtrees older than this many epochs |
| `smt.storageCapBytes` | `524288000` (500 MB) | Max estimated in-memory tree storage |

#### File watching

| Option | Default | Description |
|---|---|---|
| `fileWatchPatterns` | `[]` | Glob patterns for files to monitor for changes |
| `fileWatchIgnorePatterns` | `[]` | Glob patterns to exclude from file watching |
| `fileWatchIntervalMs` | `1000` | Polling interval for file changes (ms, min 100) |
| `fileWatchUsePolling` | `false` | Use polling instead of native FS events |

#### Config watching

| Option | Default | Description |
|---|---|---|
| `openclawDir` | `~/.openclaw` | Path to the OpenClaw config directory to watch for skill/tool/soul/cron changes |

### Digital Evidence anchoring

Anchor SMT roots to the [Constellation Digital Evidence](https://evidence.constellationnetwork.io) network for independent, tamper-proof verification. Two authentication methods are supported:

**Option 1 — API key**

```bash
openclaw config set plugins.entries.constellation-audit-plugin.config.deApiKey "your-api-key"
openclaw config set plugins.entries.constellation-audit-plugin.config.deOrgId "your-org-uuid"
openclaw config set plugins.entries.constellation-audit-plugin.config.deTenantId "your-tenant-uuid"
```

Or in the config JSON:

```json
{
  "plugins": {
    "entries": {
      "constellation-audit-plugin": {
        "enabled": true,
        "config": {
          "deApiKey": "your-api-key",
          "deOrgId": "your-org-uuid",
          "deTenantId": "your-tenant-uuid"
        }
      }
    }
  }
}
```

Create a free account at https://evidence.constellationnetwork.io and generate an API key from your dashboard.

**Option 2 — Wallet key file (x402 micropayments)**

```bash
openclaw config set plugins.entries.constellation-audit-plugin.config.deWalletKeyFile "/path/to/wallet.key"
```

Or in the config JSON:

```json
{
  "plugins": {
    "entries": {
      "constellation-audit-plugin": {
        "enabled": true,
        "config": {
          "deWalletKeyFile": "/path/to/wallet.key"
        }
      }
    }
  }
}
```

The file should contain a SECP256K1 private key (64-char hex). Organization and tenant IDs are derived automatically from the wallet address — no registration required. Submission uses [x402](https://www.x402.org/) micropayments (USDC on Base) via the `@constellation-network/digital-evidence-sdk-x402` package.

| Option | Default | Description |
|---|---|---|
| `deApiKey` | — | API key for DE anchoring |
| `deOrgId` | — | Organization UUID (required with API key) |
| `deTenantId` | — | Tenant UUID (required with API key) |
| `deWalletKeyFile` | — | Path to wallet private key file (alternative to API key) |
| `deSigningKey` | auto-generated | SECP256K1 private key (64-char hex) for signing fingerprints (see note below) |
| `deEnv` | `mainnet` | DE network environment (`test`, `integration`, or `mainnet`). `test` requires the `DE_TEST_URL` environment variable pointing at a loopback URL (`http(s)://localhost`, `127.0.0.1`, or `[::1]`); used for local development only. |
| `deEventThreshold` | `100` | Events to accumulate before anchoring (event-count trigger) |
| `deTimerMinEvents` | `1` | Minimum events required to anchor on a timer tick (clamped to >= 1) |
| `deIntervalMs` | `300000` | Interval between timer-triggered anchoring attempts (ms) |

> **Ephemeral signing keys:** When `deSigningKey` is not configured, a new key pair is generated on each startup. This means fingerprints from different sessions are signed with different keys and cannot be verified against a single identity. Pin `deSigningKey` in your config if you need cross-session verifiable provenance.

## What gets recorded

The plugin hooks into 25 OpenClaw lifecycle hooks and records them into the audit trail. Full message/prompt content is stored gzipped; metadata contains a 50-char preview.

Sensitive values (`secret`, `password`, `token`, `apiKey`, `auth`, `credential`, `passphrase`, `jwt`, `bearer`, `cookie`, `privateKey`) in tool arguments are automatically redacted before storage.

### Prompt events

| Event type | Hook | Metadata captured |
|---|---|---|
| `prompt.model_resolve` | `before_model_resolve` | prompt length, trigger |
| `prompt.build` | `before_prompt_build` | prompt length, message count |
| `prompt.input` | `llm_input` | provider, model, prompt length, history message count, images count, content (gzipped) |
| `prompt.response` | `llm_output` | provider, model, token usage (input/output/cache read/write), content (gzipped) |

### Agent events

| Event type | Hook | Metadata captured |
|---|---|---|
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
| `tool.denied` | `after_tool_call` | tool name, duration (ms), reason |
| `tool.persisted` | `tool_result_persist` | tool name, is synthetic |

`tool.denied` is emitted instead of `tool.result` when a `before_tool_call` hook returns `block: true` or a user/approval flow denies the call. Denials with free-form reasons (custom `blockReason` set by a plugin, or engine-side loop-detector blocks) do not match the known phrases and will surface as `tool.result` with the error populated.

### Cron events

| Event type | Hook | Metadata captured |
|---|---|---|
| `cron.executed` | `before_model_resolve` | agent ID, run ID, prompt length |
| `cron.failed` | `agent_end` | agent ID, run ID, duration (ms), error |

Emitted only when the agent run's `ctx.trigger === "cron"`. `cron.executed` marks the start of a cron-triggered run; it is not guaranteed to be paired with a `cron.failed` or `agent.end` if the process exits abnormally before the run completes.

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

Verify SMT proofs for recent events and check DE checkpoint consistency:

```bash
openclaw audit verify
```

Exits with code `0` if all proofs and checkpoints are valid, `1` if any verification fails.

### Export

```bash
openclaw audit export          # JSON Lines (default)
openclaw audit export csv      # CSV format
openclaw audit export --type tool.invoked --limit 100
```

### SMT operations

```bash
openclaw audit smt root                     # Show current SMT root and entry count
openclaw audit smt root --tree <key>        # Root for a specific tree
openclaw audit smt trees                    # List all SMT trees
openclaw audit smt proof <hash>             # Generate inclusion/exclusion proof for a hash
openclaw audit smt proof <hash> --tree <key>
openclaw audit smt verify --proof '<json>'  # Verify a proof against known tree/checkpointed roots
openclaw audit smt chain <conversationId> --tree <key>  # Show conversation chain
```

Proof verification checks both internal consistency (siblings hash to the claimed root) and root legitimacy (the proof's root matches a current tree root or a DE-checkpointed root). A self-consistent proof with an unknown root is rejected.

Exit codes for `smt verify`:

| Exit code | Meaning |
|-----------|---------|
| 0 | Proof is valid — internally consistent and root matches a known anchor |
| 1 | INVALID — root not recognized by this node, or proof is internally inconsistent |
| 2 | UNVERIFIABLE — no SMT trees or DE checkpoints exist to verify against |

**Live-root window:** proofs are verified against current tree roots and DE-checkpointed roots. When a new event advances the tree from root R1 to R2, proofs generated at R1 will be rejected unless a checkpoint captured R1. On active systems there is always a brief window between tree advancement and the next checkpoint where recently-generated proofs cannot be verified. To avoid this, verify proofs before appending new events, or ensure the checkpoint interval is short enough for your use case.

## How the Sparse Merkle Tree works

Every audit event is committed as dual-hash (raw + censored) leaves in a Sparse Merkle Tree. The raw hash covers all event fields; the censored hash covers only the event type, category, and timestamp (for privacy-preserving verification).

- Inserting an event changes the SMT root, creating a tamper-evident chain of state transitions
- Deleting or modifying an event is detectable via inclusion/exclusion proofs
- The SMT root can be anchored to the Constellation Digital Evidence network for independent verification

Run `openclaw audit verify` at any time to check SMT integrity and DE checkpoint consistency.

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
npm test         # Run the full test suite (unit + e2e)
npm run test:e2e # Run only the e2e suite (test/e2e.test.ts)
npm run clean    # Remove dist/
```

The e2e suite simulates openclaw firing lifecycle events through the plugin's hook pipeline and verifies the resulting audit trail, SMT proofs, CLI handlers, and Digital Evidence publishing (against a local mock DE server). It runs as a separate CI job (`.github/workflows/e2e.yml`) in addition to the main `ci.yml`.

### Local install

To install the plugin from a local checkout into OpenClaw:

```bash
npm run build
openclaw plugins install --link .
```

The `--link` flag symlinks the local directory instead of copying, so changes are picked up after a rebuild and gateway restart:

```bash
npm run build
openclaw gateway restart
```
