# Review — swarm-deck gateway publisher removal (commit `9f5482c`)

## Summary

Single-commit code-quality review of `9f5482c` — "feat: remove swarm-deck gateway publisher" (+36/-2717, 27 files). The deletion itself is mostly mechanical and consistent: the service file, its tests, its config keys, the `gateway.dropped` event type, the drop-spike detector, the status snapshot section, the CLI flags, and the rate-limiter wiring are all removed together. Build is clean (`tsc --noEmit` passes), and the `gateway_start`/`gateway_stop` capture paths the commit message says to keep are in fact kept.

The leftover work is concentrated in two areas:

1. **Tracked documentation orphans** — `README.md`, `docs/FEATURES.md`, `docs/IMPLEMENTATION.md`, and `skills/openclaw-audit/SKILL.md` still describe the gateway publisher, the deleted config keys, the `gateway.dropped` event, the deleted `detectGatewayDropSpike` detector, and the now-removed status section. SKILL.md is the agent-facing operator playbook, so its drift is the most user-visible.
2. **Stale comments / test names** in `src/` and `test/` that still attribute caps and side-effects to the gateway DTO or gateway publisher.

No leftover code paths, no dangling enum/switch arms, no missing test coverage for surviving features (network policy and webhook are exercised by `webhook.test.ts`, `notifications.test.ts`, `report-pusher.test.ts`). One trivial unused import in `test/e2e.test.ts`.

## Findings

### High (must-fix)

**H-1. `skills/openclaw-audit/SKILL.md` advertises removed config keys and a removed status section to the operator agent.**
- `skills/openclaw-audit/SKILL.md:115` — setup table row "Forward events to a gateway | `gatewayUrl` + `gatewayApiKey`" — these keys are now rejected by `additionalProperties: false` in `openclaw.plugin.json`.
- `skills/openclaw-audit/SKILL.md:27` — "...last anchor, gateway publisher state, ..." in the `audit status` discovery summary.
- `skills/openclaw-audit/SKILL.md:31` — "One-screen runtime health. Shows seven sections:" — there are now six.
- `skills/openclaw-audit/SKILL.md:36` — "Gateway publisher — active/inactive, buffer depth, dropped today, last success" bullet in the section list.

Because this file is loaded into the agent's context at runtime, leaving it stale means the agent will confidently instruct users to set keys that the schema now rejects, and will look for a status section that no longer prints.

**H-2. `README.md` still documents the removed status section.**
- `README.md:102` — "Gateway publisher — buffer depth, dropped today, last success / error" bullet under `audit status`. The status command no longer renders this section .

### Medium (should-fix)

**M-1. `docs/FEATURES.md` retains a full "Gateway Publisher" section and a detector entry that no longer exist.**
- `docs/FEATURES.md:85-102` — entire `## Gateway Publisher` section describing `gatewayUrl`, `gatewayBatchSize`, `gatewayMaxPayloadBytes`, `gatewayAllowPrivateHost`, and the 413/rate-limit behavior — all of which the deleted code implemented.
- `docs/FEATURES.md:197-198` — `detectGatewayDropSpike` bullet under detectors. The detector and the `gateway.dropped` event it scanned are both gone.

**M-2. `docs/IMPLEMENTATION.md` retains a full "Gateway Publisher" implementation section.**
- `docs/IMPLEMENTATION.md:295-324` — `## Gateway Publisher` section walks through `createGatewayPublisher`, `validateGatewayUrl`, `validateGatewayApiKey`, the 413/`Retry-After`/circuit-breaker behavior, and the `gateway.dropped` overflow path. None of these symbols or paths exist after this commit.

**M-3. Stale comment in `src/gateway-stop-capture.ts` claims the rate limiter still has gateway-publish side-effects.**
- `src/gateway-stop-capture.ts:21` — "Bypasses the rate limiter (so its async side-effects — gateway publish, DE anchor — don't try to run inside a synchronous signal callback)..." — the rate limiter's `notifyAppend` to the publisher was removed in this same commit . The remaining limiter side-effect is the DE-anchor notification, so the parenthetical should drop the "gateway publish" half.

### Low (nits)

**L-1. Stale "Coalescing contract" comment in `src/rate-limiter.ts`.**
- `src/rate-limiter.ts:194` — "Coalescing contract :" — the contract was articulated specifically because the publisher consumed coalesced rows. With the publisher gone, the "downstream consumer" phrasing at `:199` has no concrete referent in this repo .

**L-2. Test name in `test/hooks.test.ts` still attributes the cap to the gateway DTO.**
- `test/hooks.test.ts:1483` — `it("truncates oversize values (matches gateway DTO cap) with a one-shot warn", ...)` — the cap is now justified as defense-in-depth on local rows .

**L-3. Unused type-only import after mock-gateway helper deletion.**
- `test/e2e.test.ts:21` — `import { createServer, type IncomingMessage, type Server } from "node:http";` — `IncomingMessage` was only referenced by the deleted `RespondFn` typedef and `ReceivedGatewayRequest.headers` shape. `createServer` and `Server` are still used elsewhere in the file; only `IncomingMessage` is orphaned. `tsc` doesn't flag type-only imports under the project's current config.

**L-4. Ambiguous "gateway-side" phrasing in `src/ui/export.ts:14`.**
- `src/ui/export.ts:14` — "operator-side complement to the gateway-side workspace export described in PRD A12". With the swarm-deck publisher removed, the only "gateway" in this plugin is the openclaw HTTP daemon, so "gateway-side workspace export" now reads ambiguously . Not a defect — flagging because someone re-reading this comment may try to find a swarm-deck artifact that no longer exists.

## Notes

- **Cleanups that landed correctly.** `EventType` no longer contains `gateway.dropped` (`src/types/events.ts:41-42` keeps only `gateway.start` / `gateway.stop`); the projection schema description was tightened (`schemas/audit-projection.schema.json`); status JSON schema dropped the `gateway` required key AND its property block atomically (`schemas/audit-status.schema.json`); the seventh service registration was removed from the count assertion in `test/index.test.ts:73`; `src/util/logger.ts` no longer exports `gatewayPublisherLog`; `src/util/network-policy.ts` header was updated to drop the "shared by the gateway publisher" framing; `src/util/webhook.ts` and `src/services/{notifications,report-pusher}.ts` had their SSRF-policy referent comments updated to "shared outbound-URL policy". The rate-limiter's `setGatewayPublisher` setter and `notifyAppend` call were both removed.
- **Surviving features still tested.** Network policy (`validateHttpTargetUrl`, `isNumericIpEncoding`) was covered by `gateway-publisher.test.ts` (deleted) AND by `test/util/webhook.test.ts`, `test/services/notifications.test.ts`, `test/services/report-pusher.test.ts` (kept). No coverage hole introduced.
- **`docs/PR24-FINDINGS.md`, `docs/review-prot-1544-*.md`, etc.** still reference the publisher heavily but are historical review artifacts that record decisions about code that existed at the time of review — leaving them stale is conventional and intentional.
- **`docs/IMPLEMENTATION.md` / `docs/FEATURES.md` versus historical review files.** Unlike the dated review reports, `FEATURES.md` and `IMPLEMENTATION.md` are framed as current documentation of how the plugin works — that's why M-1 and M-2 are flagged at medium, not noted-and-skipped.
