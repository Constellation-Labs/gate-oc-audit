# Security Review — swarm-deck gateway publisher removal (commit `9f5482c`)

## Summary

Removal commit `9f5482c` cleanly excises the outbound `gateway-publisher`
service and all `gateway{Url,ApiKey,...}` config keys. From a security
posture standpoint the removal is **net-positive**: it eliminates an
authenticated egress channel (API-key-bearing POST), removes the
attendant SSRF/MITM surface, and shrinks the persisted config-key set
that could carry secrets.

Outcome of the review:

- **No must-fix findings.** Network policy, hooks gate, rate-limiter
  callers, and webhook/report-pusher egress posture are intact.
- The remaining outbound channels (`webhook.ts`, `report-pusher.ts`)
  continue to gate through `validateHttpTargetUrl`, unchanged in
  substance — only doc comments were rewritten.
- `allowExportOnNonLoopback` (UI export gate) is unmodified and still
  enforced at `src/ui/routes.ts:475,555,626` via
  `resolveGatewayBaseUrl().nonLoopback`.
- Type-check passes (`tsc --noEmit` clean).

Three low/medium hygiene concerns remain — see Findings.

## Findings

### M-1. Stale gateway-publishing section in `docs/FEATURES.md` still instructs operators to set `gatewayUrl`/`gatewayApiKey`.

**Severity:** M (should-fix).

`docs/FEATURES.md:85-102` still documents the removed "Gateway
Publisher" feature, including a description of the `X-Gateway-Api-Key`
header, the `validateHttpTargetUrl`-derived SSRF policy, and a claim
that drop events are recorded as audit rows. An operator following this
doc would persist `gatewayApiKey` (a token-grammar secret) into
`openclaw config set plugins.entries.openclaw-audit-plugin.config.gatewayApiKey`,
where it would sit unused but readable on disk for whoever has filesystem
access to the openclaw config file.

`README.md` was updated in the same commit and no longer references
these keys (`README.md` diff: -41 lines). `docs/FEATURES.md` was missed.

**Suggested action:** delete or replace the FEATURES.md "Gateway
Publisher" section so operators don't paste API keys into a config slot
no code reads.

### M-2. Stale `gateway` row in `service_health` SQLite table is never cleaned up.

**Severity:** M (should-fix).

Operators upgrading from the prior version may have a persisted row in
the `service_health` table written by the removed publisher (see prior
`upsertServiceHealth(GATEWAY_HEALTH_NAME, h)` call at the deleted
`src/index.ts:572-606` block; key was the literal string `"gateway"`).
No migration in `src/store/schema.ts` deletes this row.

I verified the **payload itself does not contain secrets** — the prior
`GatewayHealth` interface (in the deleted `src/services/gateway-publisher.ts`)
was `{isActive, buffered, droppedToday, circuitOpen, lastSuccessAt,
lastErrorAt}`. The URL was injected by the *caller* into the
status-snapshot projection, not stored in service_health. So this is a
hygiene issue (stale state survives), not an active info-disclosure.
But anyone diffing `service_health` after upgrade will see references
to a feature that no longer exists, and any future code that mistakenly
re-uses the `"gateway"` row name (e.g. for a different feature) would
read corrupt state.

**Suggested action:** add a one-shot
`DELETE FROM service_health WHERE name = 'gateway'` to the
post-DDL migration block in `src/store/schema.ts` (it currently runs
pre-DDL `migrateAuditEventsToV4` at `src/store/schema.ts:179`).

### L-1. Stale log message references "Gateway" cap in `src/hooks.ts:86`.

**Severity:** L (nit).

`src/hooks.ts:86` still emits

> `${source} value exceeds ${USER_ID_MAX_LEN} chars; truncating. Gateway would otherwise reject every batch on validation.`

The comments around `applyFieldCaps` and `resolveConfiguredUserId` were
rewritten in this commit (hooks.ts diff, +11/-11), but this `log.warn`
string was missed. Not a security risk — it is misleading operator
output only.

### L-2. `STATUS_SCHEMA_VERSION` not bumped despite breaking change to status snapshot.

**Severity:** L (nit).

`schemas/audit-status.schema.json` removed `gateway` from the required
keys list and dropped the entire `gateway` property block (status
schema diff: -24 lines). The constant
`STATUS_SCHEMA_VERSION = 1` at `src/reports/status-snapshot.ts:15`
stayed at `1`. Old consumers (anything reading the `--json` output and
expecting a `gateway` field) will see a missing property without any
version-bump signal. Not a security issue per se, but the schema
contract is implicit rather than explicit. The schema's
`"schemaVersion": { "const": 1 }` at `schemas/audit-status.schema.json:19`
also still asserts version 1.

### L-3. Stale `swarm-deck` / `gateway`-publisher wording in adjacent doc comments.

**Severity:** L (nit).

Several comments mention the removed publisher in passing:

- `src/store/schema.ts:12` — `"process writers (gateway + CLI, multiple gateway instances)"` (ambiguous; could be misread to mean the removed publisher rather than the openclaw local gateway daemon).
- `src/store/schema.ts:214` — `"long-lived services (anchor, gateway, retention)"` — `gateway` here meant the publisher.

Not a security risk, just stale documentation.

## Notes

### What I verified, and how

- **Authn/secret regressions** — `rg -n 'gatewayApiKey|gatewayUrl|gatewayBatchSize|gatewayIntervalMs|gatewayTimeoutMs|gatewayBufferCapacity|gatewayShutdownDeadlineMs|gatewayMaxPayloadBytes|gatewayAllowPrivateHost|gatewayEnabled' src test schemas README.md openclaw.plugin.json` returns **0 hits**. No runtime reader still pulls these keys from disk. Only `docs/FEATURES.md` retains the prose reference (finding M-1).

- **Network policy / SSRF** — `src/util/network-policy.ts` diff is comment-only (`+3/-5`, all in JSDoc). `validateHttpTargetUrl` (`src/util/network-policy.ts:88-116`) is bit-for-bit identical in logic: loopback-only http, no userinfo, no numeric-IP encodings, `allowPrivateHost` opt-in for private/link-local. The three callers — `webhook.ts:35`, `notifications.ts:40`, `report-pusher.ts:114` — all still pass through it. `allowExportOnNonLoopback` (UI export gate) is read at `src/index.ts:675` and enforced at `src/ui/routes.ts:475,555,626` — unchanged.

- **Rate-limiter** — `src/rate-limiter.ts` removed `setGatewayPublisher()` and three `gatewayPublisher?.notifyAppend(...)` call sites. `rg -n 'setGatewayPublisher|gatewayPublisher\.|createGatewayPublisher|drainForShutdown|GATEWAY_HEALTH_NAME' src test` returns **0 hits** outside the commit's deletions. No orphan caller. The remaining `notifyAppend()` invocations on lines 68, 116, 233 are `deAnchor.notifyAppend()` — a separate, intact service. DoS via unthrottled callers: no regression — the rate limiter's coalesce/drop logic (`src/rate-limiter.ts:74-92, 136-186`) is unchanged.

- **Removed safeguards (`MaxPayloadBytes`, `BufferCapacity`, `ShutdownDeadlineMs`)** — these were caps specific to the deleted batch publisher's outbound queue. The remaining exporters do not buffer/batch: `webhook.ts` is request-scoped (per-call HTTP), and `report-pusher.ts` pushes synthesized daily/weekly digests on a tick, not buffered event streams. The defense-in-depth field caps in `src/hooks.ts:18-21` (`MAX_FIELD_LENGTH=1000`, `MAX_DESCRIPTION_LENGTH=4000`, `MAX_CONTENT_LENGTH=64000`) are unchanged and still applied at `applyFieldCaps()` in the hooks chokepoint. No regression.

- **Information disclosure** — `gateway` section removed from `StatusSnapshot` (`src/reports/status-snapshot.ts` diff: -25 lines, removed `GatewaySection` interface + `gatewayHealth`/`gatewayUrl` inputs). `format-status.ts` text formatter also drops the corresponding lines. No other endpoint or projection exposes the removed fields — `rg -n 'GatewayHealth|GatewaySection|gatewayHealth|gatewayUrl' src test` returns 0 hits outside the removed code. The previously-stored `service_health` payload contained no secrets (finding M-2).

- **Hooks gate** — `src/hooks.ts` 22-line diff is **comment-only**. I read the diff in full: 4 hunks, every change is text inside a `//` comment or a `log.warn` message; no `api.on(...)` registration, no truncation cap value, and no conversation-access gate condition was modified. The hook subscription list (`rg -n 'api\.on' src/hooks.ts`) still covers `agent_end`, `llm_input`, `llm_output`, `tool.*`, etc. — unchanged.

### Out of scope for this lens

- Whether the removal makes sense as a product decision (correctness lens).
- Whether the e2e/unit test deletions (e.g. `test/services/gateway-publisher.test.ts`, -1022 lines) leave gaps in coverage for the *remaining* exporters (correctness lens).
- Whether the schema-version stability across the breaking status-snapshot change matters to specific downstream consumers (correctness / compat lens).
