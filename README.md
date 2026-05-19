# @constellation-network/openclaw-audit-plugin

Tamper-evident audit trail for AI coding agent activity. Records every session, tool invocation, and prompt exchange into a local SQLite database with SHA-256 hash chain integrity, so you can verify that no events were altered or deleted after the fact.

## Installation

```bash
openclaw plugins install @constellation-network/openclaw-audit-plugin
```

Requires `openclaw >= 2026.4.24` as a peer dependency and Node.js ≥ 22.13 (uses the built-in `node:sqlite` module).

That's it. The plugin automatically starts recording audit events when your agent runs.

### Required openclaw config (openclaw ≥ 2026.4.24)

Two operator-policy opt-ins are required for full functionality. Both are decisions openclaw forces on the operator — the plugin cannot self-grant either.

#### Trust the plugin

Add `constellation-audit-plugin` to `plugins.allow`. When `plugins.allow` is empty, openclaw still auto-loads discovered plugins but logs a warning on every startup:

```
[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load …
```

Setting an explicit allowlist silences the warning and locks loading down to the listed ids:

```bash
openclaw config set plugins.allow '["constellation-audit-plugin"]'
```

Or directly in the config JSON:

```json
{
  "plugins": {
    "allow": ["constellation-audit-plugin"]
  }
}
```

If you already have other trusted plugins in `plugins.allow`, append `"constellation-audit-plugin"` to the existing array rather than replacing it.

#### Grant conversation access

Non-bundled plugins must explicitly opt in to receive raw conversation content from the `llm_input`, `llm_output`, `before_agent_finalize`, and `agent_end` hooks. Without this opt-in, openclaw blocks those hook registrations and logs:

```
[plugins] typed hook "llm_input" blocked because non-bundled plugins must set plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess=true …
```

Three of the audit plugin's most important event types (`prompt.input`, `prompt.response`, `agent.end`) will be missing from the audit trail until this is set.

```bash
openclaw config set plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess true
```

Or directly in the config JSON:

```json
{
  "plugins": {
    "entries": {
      "constellation-audit-plugin": {
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

The plugin also logs a warning at startup if a tool call is observed without any preceding `llm_input` event, which usually indicates this opt-in is missing.

### Configuration (optional)

Set values via the CLI:

```bash
openclaw config set plugins.entries.constellation-audit-plugin.enabled true
openclaw config set plugins.entries.constellation-audit-plugin.config.dbPath "$HOME/.openclaw/audit.db"
openclaw config set plugins.entries.constellation-audit-plugin.config.localRetentionDays 365
openclaw config set plugins.entries.constellation-audit-plugin.config.localMaxSizeMb 500
```

Or directly in the config JSON:

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

Two channels, deliberately separate so incident pokes and periodic digests can be routed to different rooms:

```bash
openclaw config set plugins.entries.constellation-audit-plugin.config.notificationWebhook "https://hooks.slack.com/services/AAA/BBB/CCC"
openclaw config set plugins.entries.constellation-audit-plugin.config.reportWebhook "https://hooks.slack.com/services/AAA/BBB/DDD"
```

```json
{
  "config": {
    "notificationWebhook": "https://hooks.slack.com/services/AAA/BBB/CCC",
    "reportWebhook": "https://hooks.slack.com/services/AAA/BBB/DDD"
  }
}
```

| Option | Default | Description |
|---|---|---|
| `notificationWebhook` | — | Webhook URL for incident alerts (config changes, integrity violations, DE divergence) |
| `reportWebhook` | — | Webhook URL for daily and weekly audit digests. Payload is Slack-compatible `{text, blocks, projection}`; receivers that ignore extras still get a pretty message, and ETL receivers parse the full `projection` (same schema as `audit report`). |

**Cadence:** daily digests fire shortly after local midnight, weekly digests after local Monday 00:00. The scheduler polls every ~5 minutes, so a digest "scheduled" for 00:00 may arrive anywhere in `[00:00, 00:05)`. After a long downtime only the most recently completed window is pushed (no backfill spam).

**Privacy:** `recipient` values in `anomalies.duplicateOutbound[]` are replaced with a truncated SHA-256 digest (`sha256:<16-hex>`) before the payload leaves the machine. This is a **correlation hash** — enough entropy to recognise the same recipient across reports, not a security primitive — so phone numbers / emails / @handles never reach the webhook receiver. **Not hashed** and sent verbatim: channel names (`slack`, `discord`, …), `events[].id` and `events[].sequence`, `events[].sessionId`, tool names (`topTools[].toolName`), and the integrity footer's last-event hashes. If your session IDs or tool names embed customer identifiers, treat the webhook URL like the audit DB itself and route only to endpoints you control.

#### Identity

Stamp a stable user identifier on every event. Resolved once at plugin startup and applied to every insert (locally as `user_id`, on the gateway as `plugin_user_id`).

```bash
openclaw config set plugins.entries.constellation-audit-plugin.config.userId "alice@example.com"
```

```json
{ "config": { "userId": "alice@example.com" } }
```

| Option | Default | Description |
|---|---|---|
| `userId` | — | Identifier to stamp on every event. If unset, falls back to the `OPENCLAW_USER_ID` env var, then the `USER` env var, then NULL. The first non-empty value wins |

#### Redaction

| Option | Default | Description |
|---|---|---|
| `redactPromptText` | `false` | Replace content of `prompt.*` and `message.*` events with `"sha256:<hex>"` before DB write. Length metadata (`contentLength` / `promptLength`) is preserved. |
| `redactToolArgs` | `false` | Replace `tool.invoked` `metadata.args` with `{ hash: "sha256:<hex>" }` (hash computed over canonicalized JSON of the already key-sanitized args). |

Hashes allow independent verification — anyone with the original plaintext can re-hash and confirm it matches the audit record, without the plaintext ever touching the DB.

#### Sparse Merkle Tree

Nested under the `smt` key. Set values via the CLI:

```bash
openclaw config set plugins.entries.constellation-audit-plugin.config.smt.treeKey "auto"
openclaw config set plugins.entries.constellation-audit-plugin.config.smt.maxTreeSize 500000
```

Or directly in the config JSON:

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

#### Gateway publishing

Forward audit events to a swarm-deck gateway for centralized retention. Events are POSTed in batches to `<gatewayUrl>/admin/audit/ingest` with the `X-Gateway-Api-Key` header.

```bash
openclaw config set plugins.entries.constellation-audit-plugin.config.gatewayUrl "https://gateway.example.com"
openclaw config set plugins.entries.constellation-audit-plugin.config.gatewayApiKey "sk-gw-…"
```

```json
{
  "plugins": {
    "entries": {
      "constellation-audit-plugin": {
        "config": {
          "gatewayUrl": "https://gateway.example.com",
          "gatewayApiKey": "sk-gw-…"
        }
      }
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `gatewayUrl` | — | Gateway base URL. Plain `http://` is rejected unless the host is loopback; `https://` to private/link-local IPs requires `gatewayAllowPrivateHost: true` |
| `gatewayApiKey` | — | API key sent in `X-Gateway-Api-Key`. Required when `gatewayUrl` is set |
| `gatewayEnabled` | `true` when url+key set | Explicit on/off switch. Setting `false` disables publishing even when url+key are both present |
| `gatewayAllowPrivateHost` | `false` | Allow `https://` URLs pointing at RFC1918 / link-local / CGNAT hosts |
| `gatewayBatchSize` | `50` | Max events per POST batch |
| `gatewayIntervalMs` | `30000` | Max time between POST attempts (ms, min 1000) |
| `gatewayTimeoutMs` | `15000` | HTTP timeout per POST (ms, min 1000) |
| `gatewayBufferCapacity` | `10000` | Max events buffered awaiting POST; overflow records a synthetic `gateway.dropped` event on an exponential cadence |
| `gatewayShutdownDeadlineMs` | `30000` | Wall-clock deadline for the shutdown drain (ms) |
| `gatewayMaxPayloadBytes` | `5000000` | Drop batches whose JSON exceeds this size rather than retrying forever |

##### Content forwarding

Event `content` (prompt and message bodies, tool result strings) is always forwarded to the gateway. The gateway hashes it server-side and stores only the SHA-256 digest in `plugin_audit_events.content_hash`; the raw text itself is **not** persisted on the gateway.

This is independent of `redactPromptText` / `redactToolArgs`, which govern only what gets written to the plugin's local SQLite database — they do not affect the gateway payload.

> **Migration note.** Earlier versions exposed a `gatewayIncludeContent` flag (default `false`) that stripped `content` from the gateway payload. The flag has been removed — content is now always forwarded. Deployments that explicitly set `gatewayIncludeContent: false` to keep prompt/message bodies off the gateway should remove the key (it will be rejected by `additionalProperties: false`) and rely on `redactPromptText` if they need the content hashed before it leaves the plugin process.

### Digital Evidence anchoring

Anchor SMT roots to the [Constellation Digital Evidence](https://evidence.constellationnetwork.io) network for independent, tamper-proof verification. Follow the [Digital Evidence setup guide](https://digitalevidence.constellationnetwork.io/get-started) to provision an account, generate API credentials, and fund a wallet for x402 micropayments. Two authentication methods are supported:

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

The plugin subscribes to every public OpenClaw lifecycle hook and records each event into the audit trail. Full message/prompt content is stored gzipped; metadata contains a 50-char preview.

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
| `agent.end` | `agent_end` | duration (ms), success, run ID, job ID, model provider/id |
| `agent.compaction_start` | `before_compaction` | message count, compacting count, token count, session file |
| `agent.compaction_end` | `after_compaction` | message count, compacted count, token count, session file |
| `agent.reset` | `before_reset` | reason, session file |
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
| `cron.executed` | `before_model_resolve` | agent ID, run ID, job ID, prompt length |
| `cron.failed` | `agent_end` | agent ID, run ID, job ID, duration (ms), error |

Emitted only when the agent run's `ctx.trigger === "cron"`. `cron.executed` marks the start of a cron-triggered run; it is not guaranteed to be paired with a `cron.failed` or `agent.end` if the process exits abnormally before the run completes.

### Message events

| Event type | Hook | Metadata captured |
|---|---|---|
| `message.received` | `message_received` | direction, sender (with fallback chain), sender ID, channel, account, session key, run ID, thread ID, message ID, surface, content length, timestamp, content (gzipped) |
| `message.sending` | `message_sending` | direction, recipient, channel, session key, run ID, reply-to ID, thread ID, content length, content (gzipped) |
| `message.sent` | `message_sent` | direction, recipient, channel, account, session key, run ID, message ID, content length, success, error, timestamp, content (gzipped) |
| `message.claimed` | `inbound_claim` | channel, sender ID/name, is group, session key, run ID, thread ID, message ID, content length |
| `message.dispatched` | `before_dispatch` | channel, sender ID, is group, content length |
| `message.write` | `before_message_write` | agent ID |

### Session events

| Event type | Hook | Metadata captured |
|---|---|---|
| `session.start` | `session_start` | session key, resumed from |
| `session.end` | `session_end` | session key, message count, duration (ms), reason, session file, transcript archived, next session id/key |

### Gateway events

| Event type | Hook | Metadata captured |
|---|---|---|
| `gateway.start` | `gateway_start` | port |
| `gateway.stop` | `gateway_stop` | reason |

### System events

| Event type | Hook | Metadata captured |
|---|---|---|
| `system.install` | `before_install` | target type (skill/plugin), target name, source path, request kind, plugin/skill identifiers, scan summary (files, critical/warn/info counts) |
| `system.install_hook_unavailable` | (registration failure) | error message |

`system.install` records every plugin or skill install/update intercepted by openclaw's install pipeline, including the built-in security scan summary. Captures who installed what so unexpected supply-chain events leave an audit-trail signal. Hook is non-decisive — the plugin observes only and never blocks.

`system.install_hook_unavailable` is appended each time `registerHooks` runs and `before_install` registration throws (typically once per process, but openclaw may re-register on config reload). This makes "we silently couldn't audit installs" a recorded event rather than a console warning that scrolls away.

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
openclaw audit export                                    # JSON Lines (default, streamed)
openclaw audit export csv                                # CSV (streamed, stable column order)
openclaw audit export --type tool.invoked --limit 100    # cap rows
openclaw audit export --from 2025-01-01T00:00:00Z --to 2025-02-01T00:00:00Z
openclaw audit export --security-only                    # security / config / system categories
openclaw audit export --include-content                  # include decompressed content column / field
```

Each emitted row carries the DE anchor reference (`anchor.deTxHash`, `anchor.smtRoot`, `anchor.sequenceStart`, `anchor.sequenceEnd`, `anchor.createdAt`) for the checkpoint covering its sequence, or `null` when no DE-anchored checkpoint covers it yet. Output is streamed in fixed-size batches via a sequence cursor, so retention pruning during the export can't shift the window and silently drop rows. The same shape is available over HTTP at `GET /plugins/audit/api/export?format=json|csv&from=&to=&type=&category=&session=&securityOnly=&includeContent=&limit=`.

> **`--include-content` and redaction.** `redactPromptText` rewrites prompt / message content to `sha256:<hex>` before insert, and `redactToolArgs` does the same for tool-call arguments. Neither switch covers `tool.result` content (tool stdout / stderr / output bodies). If you set both flags and run `audit export --include-content`, the prompt and message bodies are hashed but tool outputs are still emitted verbatim. Operators that need a fully redacted export should either (a) skip `--include-content`, or (b) filter `--category` away from `tool` events.

> **HTTP endpoint and loopback.** `GET /plugins/audit/api/export` is unauthenticated; the plugin relies on the gateway being bound to loopback (`gateway.bind: "loopback"`, the default) for safety. When the gateway binds beyond loopback the export route returns `403` unless you explicitly opt in:
>
> ```bash
> openclaw config set plugins.entries.constellation-audit-plugin.config.allowExportOnNonLoopback true
> ```
>
> ```json
> { "config": { "allowExportOnNonLoopback": true } }
> ```
>
> The CLI (`openclaw audit export …`) is unaffected — it reads the local DB directly and doesn't traverse the HTTP gate.

### Report

Generate a daily or weekly activity digest with inline anomaly detectors. The projection covers Activity / Cron schedule / Top tools / LLM spend / Outbound messaging / Anomalies / Integrity, rendered as human text (default), single-line JSON (`--json`), or a self-contained HTML document (`--html`).

```bash
openclaw audit report daily                                # today (UTC), human text
openclaw audit report daily --date 2026-05-17              # specific UTC day
openclaw audit report daily --tz local                     # use local-time day boundary
openclaw audit report weekly                               # this ISO week (UTC)
openclaw audit report weekly --week 2026-W19               # specific ISO week
openclaw audit report daily --json                         # single-line JSON
openclaw audit report daily --html > report.html           # standalone HTML
openclaw audit report cron <job-id>                        # per-cron rollup, one row per execution
openclaw audit report cron <job-id> --last 5 --json        # last 5 executions, JSON
openclaw audit report cron <job-id> --html > cron.html     # standalone HTML
```

Detector knobs (capped on both CLI and HTTP):

| Flag | Default | Max | Description |
|---|---|---|---|
| `--dup-window-sec` | `60` | `3600` | R5a duplicate-outbound: sha256-equal `message.sent` within this window to the same channel + recipient is flagged |
| `--lookback-days` | `30` | `365` | R5b first-seen-tool: tools invoked in the window but absent from this trailing day count are flagged |
| `--top-tools` | `10` | `1000` | Cap for the Top tools section |

Anomaly detectors emitted in the `anomalies` block:

- **R5a duplicate outbound** — same content hash sent to the same channel + recipient inside `--dup-window-sec`. `duplicateOutboundTruncated: true` indicates the underlying `message.sent` scan hit its 100k-row cap and a duplicate beyond that point could have been missed.
- **R5b first-seen tools** — tool names invoked in the window that did not appear in the prior `--lookback-days` window. Calendar-day arithmetic in the report's timezone keeps the lookback DST-tolerant.

The Integrity footer pins the report to a sequence point: last event id / sequence / `content_hash`, plus the last DE-anchored checkpoint (id, `smtRoot`, `deTxHash`, sequence range, `createdAt`) when one exists. A consumer can cross-check the footer against `openclaw audit verify` to confirm the report covers a tamper-evident slice of the trail.

**Per-cron rollup (R9).** `openclaw audit report cron <job-id>` projects the trail as one row per cron execution for a given `jobId`, newest first. Each row pairs the `cron.executed` event with its matching `agent.end` (by `sessionId` + `metadata.runId`) and attributes tool / LLM / outbound-message activity that fired on the same session between the two timestamps. `--last N` (default 20, max 1000) bounds the rollup; when the store has more executions than fit, `truncated: true` is surfaced in all output formats. Output is human text (default), single-line JSON (`--json`), or a self-contained HTML document (`--html`). The JSON shape is published at `schemas/audit-cron-rollup.schema.json` so dashboards can pin against `schemaVersion: 1`.

The same projection is available over HTTP at `GET /plugins/audit/api/report?period=daily|weekly&date=&week=&tz=&format=json|html&dupWindowSec=&lookbackDays=&topTools=`. The JSON shape is published at `schemas/audit-projection.schema.json` so dashboards can pin against `schemaVersion: 1`.

> **HTTP endpoint and loopback.** Like `/api/export`, the report route is unauthenticated and returns `403` when the gateway binds beyond loopback unless `allowExportOnNonLoopback: true` is set. The CLI reads the local DB directly and is unaffected.

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
- CLI commands (`audit list`, `audit verify`, `audit export`, `audit smt …`) open the audit DB read-only, so they coexist with the running gateway via SQLite WAL — no lock contention with the writer

## Upgrade notes

### v0.2.0 — SMT checkpoint format

SMT checkpoint persistence moved from LevelDB to `node:sqlite`. On-disk layout changed from `<checkpointDir>/<treeKey>/` (a LevelDB directory) to `<checkpointDir>/<treeKey>.db` (a single sqlite file).

On first startup after upgrading from 0.1.x, the plugin logs a warning for any legacy LevelDB directory it finds and skips it; trees rebuild from events on the next checkpoint. To silence the warning, delete the legacy directories:

```bash
rm -rf ~/.openclaw/smt-checkpoints/*/
```

The migration also drops the `level` runtime dependency, eliminating the `python3` / `build-essential` requirement at install time.

## Maintenance

### Cleaning up orphaned SMT tree files

Each SMT tree is stored as `<smt.checkpointDir>/<treeKey>.db`. With the default `smt.treeKey: "auto"` (derived from `machineId`), exactly one file is reused forever and the directory does not grow. Old `.db` files become orphaned only if:

- you change `smt.treeKey` to a different value (the previous tree's file stays),
- the machine's `machineId` changes — e.g., container rebuild, OS reinstall — leaving the old `<oldMachineId>.db` behind.

The plugin does not GC these automatically. List the directory and delete any tree files you don't recognize:

```bash
ls -lh ~/.openclaw/smt-checkpoints/
rm ~/.openclaw/smt-checkpoints/<old-treeKey>.db
```

A small `__verifier__.db` is also written on each checkpoint — it's a transient verification tree and is safe to leave in place.

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

To install the plugin from a local checkout into OpenClaw, build a tarball with `npm pack` and install it:

```bash
npm install
npm run build
TGZ=$(npm pack --silent)
openclaw plugins uninstall constellation-audit-plugin || true
openclaw plugins install "./$TGZ"
openclaw gateway restart
rm -f "./$TGZ"
```

The `uninstall` step ensures a clean reinstall when iterating; the `|| true` guards against errors when no prior install exists. To also wipe the local extension directory and audit database for a fully clean state (development only):

```bash
rm -rf ~/.openclaw/extensions/constellation-audit-plugin/
rm -f ~/.openclaw/audit.db*
```
