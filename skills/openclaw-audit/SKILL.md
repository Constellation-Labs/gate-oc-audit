---
name: openclaw-audit
description: Inspect and operate the OpenClaw audit trail — runtime health, activity digests, LLM spend, integrity verification, Digital Evidence anchoring, file-watch alerts, and tamper-evident export. Use whenever the user asks "is auditing working?", "what did the agent do today?", "how much am I spending on LLM calls?", "is anchoring active?", "can I prove this event happened?", or wants to set up alerts on watched files.
metadata:
 { "openclaw": { "emoji": "🔒", "requires": { "config": ["plugins.entries.constellation-audit-plugin.enabled"] } } }
---

# OpenClaw audit trail

A tamper-evident SQLite log of every agent session, tool call, prompt, and message. Optional Digital Evidence anchoring publishes Merkle roots so an event's existence can be proven without trusting the local machine. The CLI is the primary interface — the agent does **not** auto-narrate audit state, so users have to ask, and that's what this skill is for.

## Pick the right command

| User's question | Command |
| --- | --- |
| "Is auditing working?" / "Show me the plugin's health" | `openclaw audit status` |
| "What happened today / this week?" | `openclaw audit report daily` / `… weekly` |
| "How much am I spending on LLM calls?" | `openclaw audit spend` |
| "Show me the events" / "List recent activity" | `openclaw audit list` |
| "Has anything been tampered with?" | `openclaw audit verify` |
| "Prove this specific event exists" | `openclaw audit smt proof <hash>` |
| "Export the trail for legal/compliance" | `openclaw audit export` (JSON / CSV) |
| "What's installed on this box?" | `openclaw audit inventory` |
| "Is Digital Evidence anchoring set up?" | `audit_de_setup` tool (or `openclaw audit status` → "Digital Evidence anchor" section) |
| "How do I get alerted on file changes?" | Configure `fileWatchPatterns` — see Setup below |

**Default to `openclaw audit status` first** when the user asks anything vague like "is this thing on?", "what's it doing?", or "did it install correctly?". The status snapshot is one screen and answers most discovery questions at once: DB size, retention, sequence head, SMT root, last anchor, gateway publisher state, file-watch counts, inventory, last security scan.

## `openclaw audit status` — start here

One-screen runtime health. Shows seven sections:

- **Storage** — DB size vs cap, event count, oldest event, next prune
- **Integrity** — sequence head, SMT trees + root, last checkpoint, conversation-hook state (`ENABLED` / `DISABLED` / `ENABLED-but-silent`)
- **Digital Evidence anchor** — active/inactive, anchors today, last anchor + tx hash, circuit-breaker state
- **Gateway publisher** — active/inactive, buffer depth, dropped today, last success
- **File watching** — patterns watched/ignored, recent change count
- **Inventory** — plugins / skills / tools / cron counts
- **Last security scan** — timestamp + finding counts

Add `--json` for machine-readable output (single line, parseable with `jq`).

Common follow-ups based on what `status` shows:

- `Conversation hook: DISABLED` → user hasn't set `plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess=true`; three event types (`prompt.input`, `prompt.response`, `agent.end`) are missing.
- `Digital Evidence anchor: INACTIVE` → call the `audit_de_setup` tool to see which credentials are missing, then point the user at the DE setup steps.
- `Circuit: OPEN` (anchor or gateway) → recent failures tripped a breaker; the next section of `status` shows the consecutive-failure count.
- `Patterns watched: 0` → user hasn't configured `fileWatchPatterns`; alerts on watched files won't fire.

## Activity and spend

```
openclaw audit report daily          # today UTC, human-readable
openclaw audit report daily --tz local
openclaw audit report weekly
openclaw audit report daily --json   # machine-readable
openclaw audit report daily --html > report.html
openclaw audit report cron <jobId>   # one row per cron execution
openclaw audit report session <id>   # per-conversation rollup
```

Each report includes anomaly detectors: duplicate outbound messages (sha256-identical), first-seen tool names not present in the prior 30 days, and integrity violations from the SMT scan. The **Integrity footer** pins the report to a sequence point + last anchored checkpoint so a consumer can cross-check it with `openclaw audit verify`.

```
openclaw audit spend                            # last 24h, grouped by model
openclaw audit spend --by provider --since 7d
openclaw audit spend --by day --since 30d
openclaw audit spend --by session --json
```

`spend` sums `costUsd` from `prompt.response` events. `--by model` formats labels as `provider/model` so `openai/gpt-5` and `anthropic/claude-...` don't collide.

## Integrity and proofs

```
openclaw audit verify                            # full SMT + checkpoint replay
openclaw audit smt root                          # current Merkle root
openclaw audit smt trees                         # all trees
openclaw audit smt proof <eventHash>             # inclusion/exclusion proof
openclaw audit smt verify --proof '<json>'       # verify a proof blob
openclaw audit smt chain <conversationId> --tree <key>
```

`smt verify` exit codes: `0` valid, `1` invalid (root unknown or proof inconsistent), `2` unverifiable (no trees / checkpoints to compare against).

Proofs are verified against current tree roots **and** DE-checkpointed roots. There is a brief window after a new event between tree advancement and the next checkpoint where a freshly-generated proof can't be verified — generate proofs before appending more events, or shorten `smt.checkpointIntervalMs`.

## Export

```
openclaw audit export                             # NDJSON (default, streamed)
openclaw audit export csv                         # CSV
openclaw audit export --from 2025-01-01T00:00:00Z --to 2025-02-01T00:00:00Z
openclaw audit export --security-only             # security / config / system only
openclaw audit export --include-content           # include decompressed prompt/message bodies
```

Each row carries the DE anchor reference (`anchor.deTxHash`, `anchor.smtRoot`, sequence range, createdAt) for the checkpoint covering its sequence, or `null` if no anchored checkpoint covers it yet.

`--include-content` honors `redactPromptText` (prompt/message bodies are hashed) but **does not** redact `tool.result` bodies. Operators that need a fully redacted export should either skip `--include-content` or filter `--category` away from `tool`.

## Setup tasks the agent can help with

These are the configuration moments users most often ask about. All paths are nested under `plugins.entries.constellation-audit-plugin.config.*`.

| Job | Keys | Notes |
| --- | --- | --- |
| Enable full conversation capture | `plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess: true` | Required for `prompt.input`, `prompt.response`, `agent.end`. Not under `config.*` — it's a peer of `config`. |
| Slack / Discord / webhook alerts | `notificationWebhook` (incidents) and `reportWebhook` (daily/weekly digests) | Two separate URLs by design. |
| Stamp a stable user ID | `userId` | Falls back to `OPENCLAW_USER_ID` env, then `USER`, then NULL. |
| Watch files for changes | `fileWatchPatterns: ["src/**/*.ts", ...]` + `fileWatchIgnorePatterns` | Polling interval `fileWatchIntervalMs`; flip `fileWatchUsePolling: true` for network mounts. |
| Anchor to Digital Evidence (API key) | `deApiKey`, `deOrgId`, `deTenantId` | Sign up at https://digitalevidence.constellationnetwork.io. |
| Anchor to Digital Evidence (wallet, x402) | `deWalletKeyFile` | SECP256K1 hex key file; org/tenant derived from the wallet. |
| Pin signing identity across sessions | `deSigningKey` | Without it, an ephemeral key is generated per startup. |
| Forward events to a gateway | `gatewayUrl` + `gatewayApiKey` | Plain `http://` rejected unless loopback; private IPs require `gatewayAllowPrivateHost: true`. |
| Hash prompt/message bodies on disk | `redactPromptText: true`, `redactToolArgs: true` | Lengths preserved; bodies replaced with `sha256:<hex>`. |

When documenting config changes, pair the CLI form with the JSON form:

```bash
openclaw config set plugins.entries.constellation-audit-plugin.config.notificationWebhook "https://hooks.slack.com/services/AAA/BBB/CCC"
```

```json
{ "plugins": { "entries": { "constellation-audit-plugin": { "config": { "notificationWebhook": "https://hooks.slack.com/services/AAA/BBB/CCC" } } } } }
```

## Tools exposed to the agent

| Tool | Purpose |
| --- | --- |
| `audit_de_setup` | Reports DE anchoring config status (`configured` / `misconfigured` / `not_configured`) and tells the user which credentials are missing. Always safe to call. |
| `audit_smt` | Programmatic access to SMT root / proof / verify operations without shelling out. |

## Common pitfalls

- **Plugin id vs npm name.** Config lives under `constellation-audit-plugin` (the manifest id), **not** `@constellation-network/openclaw-audit-plugin`. OpenClaw logs a warning about the mismatch on load — expected, safe to ignore.
- **`plugins.allow` empty** silently auto-loads everything with a startup warning. Tell the user to pin: `openclaw config set plugins.allow '["constellation-audit-plugin"]'`. If they already have other allowed plugins, *append* — don't replace.
- **Ephemeral signing keys.** When `deSigningKey` is unset, a new key pair is generated each startup and fingerprints from different sessions can't be tied to a single identity. Pin it for cross-session provenance.
- **HTTP `/api/export` and `/api/report`** are unauthenticated and only safe on loopback. If the gateway binds beyond loopback they return `403` unless `allowExportOnNonLoopback: true` is set. The CLI reads the DB directly and is unaffected.
- **Fail-open by design.** If the DB is unavailable the plugin silently drops events and the agent continues; a degraded-mode warning appears in `audit list` output. Run `audit status` to confirm health rather than assuming silence = success.
