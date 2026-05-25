# Correctness review — `9f5482c` (remove swarm-deck gateway publisher)

Branch: `fix/beta1`. Diff: 27 files, +36/-2717. Reviewed lens: correctness only.

## Summary

The removal is mechanically clean: every internal reference to the gateway
publisher / `gateway.dropped` / drop-spike detector / `gateway` status section
has been excised from `src/` and `test/`. `npx tsc --noEmit` is silent and
`npm test` reports 749/750 passing (1 pre-existing skip), so there are no
dangling imports, missing type fields, or broken handler chains.

The interesting correctness questions are at the **boundary** — what happens
to users whose persisted state was produced by the previous version of the
plugin? Two issues land here that meaningfully affect upgrade behavior; the
rest are nits.

## Findings

### Must-fix (H)

#### H1. `additionalProperties: false` config schema will reject existing user configs that still carry `gatewayUrl`/`gatewayApiKey`/etc.
- `openclaw.plugin.json:115` declares `"additionalProperties": false` on the
  plugin's `configSchema`. The 10 `gateway*` keys (`gatewayUrl`,
  `gatewayApiKey`, `gatewayBatchSize`, `gatewayIntervalMs`, `gatewayTimeoutMs`,
  `gatewayBufferCapacity`, `gatewayShutdownDeadlineMs`, `gatewayMaxPayloadBytes`,
  `gatewayAllowPrivateHost`, `gatewayEnabled`) are gone from the schema's
  `properties` (`openclaw.plugin.json:107`).
- Effect on upgrade: any user who set `gatewayUrl` / `gatewayApiKey` in the
  past must remove those keys from their openclaw config or the host's
  schema validator will reject the plugin block. The commit message and
  README both omit a migration note for this — the comparable
  `gatewayIncludeContent` removal previously carried an explicit migration
  note in the README (the old section is now deleted alongside the rest).
- Severity rated H because this is the same failure mode the previous
  `gatewayIncludeContent` removal carried — the previous removal explicitly
  documented "remove the key (it will be rejected by `additionalProperties:
  false`)" but this commit deletes that paragraph without writing a
  replacement migration note for the new key set.
- Fix options: (a) add a migration note to README.md / CHANGELOG so operators
  know to strip the keys before upgrading; (b) relax to `additionalProperties:
  true` for one release so silent ignore is the behavior; or (c) leave the
  keys in the schema as deprecated no-ops for one release.

#### H2. Historical `gateway.dropped` rows persisted in user SQLite stores will load fine but are no longer surfaced by any report
- `src/types/events.ts:12` removed `"gateway.dropped"` from the `EventType`
  union.
- `src/store/audit-store.ts:123` casts `row.event_type as EventType` with
  **no runtime validation**, so old rows still load — they just won't match
  any current report's filters (e.g.
  `src/reports/anomalies-view.ts:121`'s `denialSpikes`/`installEvents`
  filters skip them).
- Effect: existing users upgrading retain `gateway.dropped` rows that count
  toward `eventCount`, retention/prune, and SMT tamper checks, but become
  invisible to every reporting surface. Not a crash; not silent data loss
  (rows are still there); but operators who relied on the drop-spike
  detector to flag historic gaps will silently lose that signal on the
  rows that already existed.
- Severity H because the user may not realise that pre-existing
  `gateway.dropped` rows are now uncategorised noise in the local DB until
  retention prunes them. Worth a one-liner in the README's upgrade notes
  recommending an optional cleanup query, or a migration that re-categorises
  them.

### Should-fix (M)

#### M1. `audit-status.schema.json` shed `gateway` from `required` but kept `schemaVersion: const 1`
- `schemas/audit-status.schema.json:5,19` still advertises `schemaVersion: 1`
  even though the shape changed in a breaking way (a previously-required
  top-level key was removed; `additionalProperties: false` will now reject
  JSON produced by the previous plugin version).
- Downstream consumers that pinned `schemaVersion: 1` validation (e.g. the
  swarm-deck dashboards mentioned in the original description) will see
  two different shapes both claiming v1 if they ingest historical artefacts.
- The in-tree validator test (`test/reports/status-snapshot.test.ts:383`)
  pins `schema.properties.schemaVersion.const === STATUS_SCHEMA_VERSION (1)`,
  so the constant is enforced but not bumped. Bumping to `2` would be the
  conservative move; alternatively, retain `gateway` as an optional property
  with a deprecation note so v1 stays backwards compatible.

#### M2. `audit-projection.schema.json` description trimmed; check no consumer keyed on the old language
- `schemas/audit-projection.schema.json:2-2` only loses the gateway-dashboard
  callout from the `description` string. No structural change. Safe in
  isolation, but the dashboard description in `audit-status.schema.json`
  was also pared back identically — confirm the swarm-deck dashboard repo
  doesn't grep for those exact strings as a feature-flag indicator.

### Nit (L)

#### L1. Plugin version not bumped despite a breaking removal
- `openclaw.plugin.json:5` still reads `"version": "0.2.4"`. Stripping a
  documented config surface is a SemVer-minor-or-major bump even in 0.x
  (per the surrounding `chore: bump version` commit history). Not a
  correctness issue per se but operators relying on version-pinned
  manifests won't be alerted.

#### L2. Stale comment in `src/store/schema.ts:12` mentions multi-gateway-instance concurrency
- Line 12 still reads `"multi-process writers (gateway + CLI, multiple
  gateway instances)..."`. With the publisher gone, the comment is
  misleading — only CLI processes write now. The other gateway mention
  on `schema.ts:214` (in-memory state of long-lived services) is also
  partially stale (it lists "gateway" alongside "anchor, retention").
  Neither affects behavior; documentation drift.

#### L3. `audit-projection.schema.json` description still mentions PRD anchors that include AG-101/AG-102 in the dashboard context
- Pure prose — no validation impact.

## Notes

- **Anomaly serializers (`format-anomalies-html.ts`, `format-anomalies-text.ts`,
  `format-status.ts`).** Re-read end to end after the diff: no leftover
  `gatewayDropSpikes`, `s.gateway`, `cfg.dropWindowSec`, or
  `cfg.dropThreshold` references. `npx tsc --noEmit` confirms.
- **Hook surface (`src/hooks.ts`).** Comment-only changes around the
  truncation rationale and one log-string tweak (line 44 dropped the
  "gateway cap" suffix). The `MAX_FIELD_LENGTH`/`MAX_DESCRIPTION_LENGTH`/
  `MAX_CONTENT_LENGTH` values are unchanged, so no behavioural shift for
  stored row sizes. `registerHooks` signature is unchanged and the test
  suite continues to exercise it with the same fixtures
  (`test/hooks.test.ts:165`, etc.).
- **Local-gateway daemon hooks (`gateway.start` / `gateway.stop`) are
  intentionally retained.** Verified by walking through `src/hooks.ts`
  registrations and `test/hooks.test.ts:1163-1188`. The
  `GatewayStopCapture` signal fallback is unchanged.
- **Rate-limiter (`src/rate-limiter.ts`).** All three call sites that
  previously called `gatewayPublisher?.notifyAppend(...)` have been removed
  (lines 66-71 direct-write path; line 113-117 drain path; line 229-234
  flush path). The `smtService?.onEventAppended` / `deAnchor?.notifyAppend`
  notifications continue on every successful store-append. No coalescing
  semantics or buffer-capacity behaviour changed. The `bufferedCount`
  getter is unchanged and still drives `test/index.test.ts:70`'s service
  count.
- **CLI (`src/cli.ts`).** Two `--drop-*` options dropped from
  `cliAnomaliesHandler` (`AuditAnomaliesOptions` at line 480-489 lost
  `dropWindowSec`/`dropThreshold`). The corresponding
  `program.option('--drop-window-sec ...')` and `'--drop-threshold ...'`
  registrations in `src/index.ts:218-219` were removed too. Commander does
  not surface a "help refers to a flag the handler doesn't accept" lint
  in this commit. Help text is consistent.
- **Status snapshot (`src/reports/status-snapshot.ts`).** New shape is in
  sync with `schemas/audit-status.schema.json` and `format-status.ts`. The
  ajv roundtrip test at `test/reports/status-snapshot.test.ts:323-374`
  validates a populated snapshot against the published schema and passes.
  `STATUS_SCHEMA_VERSION = 1` is unchanged (see M1).
- **`src/index.ts` service count.** Dropped from 8 to 7 registered
  services. `test/index.test.ts:70-71` was updated in lockstep. The
  `getStore`/`getSmtService` accessor wiring is unchanged.
- **`src/util/network-policy.ts` and `src/util/webhook.ts`.** Only
  doc-comment edits; the `validateHttpTargetUrl` policy that gates
  notification/report webhooks is unchanged. No remaining caller (webhook
  senders, report-pusher) lost a guard.
- **Test coverage.** `test/e2e.test.ts` lost 380 lines (entire publisher
  rig + 5-6 publisher-specific cases), but the remaining e2e tests still
  exercise hook → rate-limiter → store → SMT → anchor flows. The drop
  doesn't dim any non-publisher path that was only kept lit by publisher
  tests — verified by scanning the remaining suite for the hooks/services
  it still invokes.
- **`gateway-stop-capture.ts`.** One-line comment change only (`(gateway
  publisher, de-anchor)` → `(de-anchor)`). Behaviour unchanged.
- **`src/util/logger.ts`.** Lost the `gatewayPublisherLog` subsystem export.
  No remaining `src` or `test` file imports it (rg confirmed clean).
- **Schema and event-type type-narrowing.** `EventType` is a TS union with no
  runtime enforcement at the store boundary, so historical `gateway.dropped`
  rows do not crash the reader. See H2 for the user-visible consequence.
