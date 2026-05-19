# Code-quality review — feat/AG-57-gates-ui

## Summary
The new `/api/gate/*` routes, the Lit `gate-setup` component, and the typed
client all follow the existing audit-UI patterns closely — error shapes, the
non-loopback opt-in gate, and the SPA route table are consistent. The main
quality issues are (a) a copy-paste of `readApiKeyFromConfig` between
`cli-gate.ts` and `routes.ts`, (b) a small behavioural drift between the CLI
`gate test` and the HTTP `gate/test` around `allowPrivateHost`, and (c) some
duplicated boilerplate inside `handleApi` that could be tightened with no
abstraction cost.

## Findings

### [M] `readSavedApiKey` is a verbatim duplicate of `readApiKeyFromConfig`
**File:** src/ui/routes.ts:142 (and src/cli-gate.ts:309)
**Issue:** The two functions are byte-for-byte identical except for the
parameter name; both walk the same nested-object structure to pull
`gatewayApiKey` out of `~/.openclaw/config.json`. Any future change to where
the saved key lives (e.g. a rename, a secondary location, redaction policy)
has to be made in two places, and the comments above each are even copies
of each other.
**Suggestion:** Export one helper (e.g. `readSavedGatewayApiKey`) from
`services/gate-installer.ts` next to `readGateStatus` and consume it from
both call-sites.

### [M] `/api/gate/test` ignores `allowPrivateHost`; CLI honours it
**File:** src/ui/routes.ts:687
**Issue:** The HTTP test handler hard-codes
`normalizeAndValidateUrl(url, false)`, so an operator who configured a
private-host Gate via `audit gate install --allow-private-host` cannot
re-test that Gate from the UI — `normalizeAndValidateUrl` will throw 400
even though the saved URL passed validation at install time. The CLI's
`gate test` accepts `--allow-private-host` and threads it through (see
cli-gate.ts:211).
**Suggestion:** Either accept `allowPrivateHost` from the request body
(matching the install route), or re-validate the saved URL with a
permissive flag when the URL came from `readGateStatus` rather than the
request body.

### [M] Saved-config fallback in `/api/gate/test` partially duplicates CLI logic
**File:** src/ui/routes.ts:666-681 vs src/cli-gate.ts:180-202
**Issue:** Both call-sites implement the same shape: "if url/key missing,
read status; if still missing key, read the saved key; if still nothing,
400". The logic has already drifted slightly (the CLI uses
`readApiKeyFromConfig` and surfaces `handleError` on read failure; the
route uses `readSavedApiKey` and returns a generic 500). Sharing a single
resolver (see previous finding) would also dedupe this branching.
**Suggestion:** Extract `resolveTestTarget({ url, apiKey, openclawDir })`
into `gate-installer.ts` that returns a discriminated result the two
call-sites map to their own response shape.

### [L] Duplicated JSON-body parsing prologue across POST routes
**File:** src/ui/routes.ts:414-419, 648-651, 713-716
**Issue:** Every POST handler opens with the same six-line try/catch
wrapping `readJsonBody`. Not wrong, but it now appears three times in
this file; the gates routes added two more copies.
**Suggestion:** A tiny helper `readJsonOr400(req, res): Promise<Record<string, unknown> | null>`
(returns null after writing 400) collapses the boilerplate. Pure quality nit.

### [L] `/api/gate/test` "could not resolve URL or API key" is unreachable
**File:** src/ui/routes.ts:682
**Issue:** By the point this check fires, every prior branch has already
established `url` and `apiKey` are set (or returned 400 with a more
specific message). Reading the function, it is hard to construct an input
that lands here.
**Suggestion:** Remove the dead check or convert to an assertion comment;
the surrounding control flow already guarantees the invariant.

### [L] `installGate` import is shadowed locally and in the same import group
**File:** src/ui/routes.ts:25 and src/control-ui/api.ts:220
**Issue:** Both the server-side service `installGate` (from
`gate-installer.js`) and the client-side helper `installGate` (in
`api.ts`) use the same name. They live in different files so there is no
collision, but skimming the diff with both files open is confusing.
**Suggestion:** Optional — rename the client helper to e.g.
`requestGateInstall` or import the service as `installGateService` in
`routes.ts`. Lowest-impact path is to leave it; flagging only because the
reviewer asked for naming clarity.

### [L] `gate-setup.ts` uses `.ts` import extensions; rest of control-ui mixes both
**File:** src/control-ui/components/gate-setup.ts:10
**Issue:** `import { … } from "../api.ts";` — verify-panel.ts at line 3
also uses `.ts`, so this matches the new-style convention, but
`audit-app.ts:3` uses `./event-table.ts` while other files in the repo
end imports without an extension. The new file is consistent with
verify-panel, so this is only worth flagging as a repo-wide cleanup
candidate, not a fix here.

### [L] `pill()` return type is `unknown`
**File:** src/control-ui/components/gate-setup.ts:320
**Issue:** The function returns a Lit `TemplateResult` (used inside
`html\`…\``). Declaring the return as `unknown` works because Lit accepts
unknown in interpolations, but it loses the meaningful type on a helper
that the rest of the component relies on.
**Suggestion:** Return `TemplateResult` (or let TS infer it by removing
the annotation).

### [L] `formatProbe` lacks an exhaustiveness guard
**File:** src/control-ui/components/gate-setup.ts:326
**Issue:** The `switch (r.kind)` has no `default` and no
`never`-assertion. If a new probe-kind is added to `GateProbeResult`,
TypeScript will catch it at the type level, but the function still
implicitly returns `undefined` at runtime if the assumption is ever
violated.
**Suggestion:** Add `default: { const _: never = r; return ""; }` to
match the failure-loud pattern used elsewhere (e.g. verify-panel's
`renderResult` is exhaustive by structure).

### [L] Comment on `readSavedApiKey` says "errors propagate so the route returns 500" but the route catches them
**File:** src/ui/routes.ts:138-141 and 676-679
**Issue:** The doc comment says errors propagate; the route catches them
and returns 500 with the error message in the body. Both behaviours are
fine, but the comment misdescribes where the 500 originates.
**Suggestion:** Update the comment to say "callers catch and surface as
500" or drop the assertion.

### [L] Test coverage gaps in `test/ui/gate-routes.test.ts`
**File:** test/ui/gate-routes.test.ts
**Issues** (uncovered cases worth at least one test each):
- `POST /api/gate/install` with a bad JSON body (assert 400 + error
  message — the readJsonBody catch path is uncovered).
- `POST /api/gate/install` with an oversized body (>64 KiB) — covers the
  `MAX_JSON_BODY_BYTES` branch in `readJsonBody` via this route.
- `POST /api/gate/test` with `{ apiKey: "x" }` and no `url` — should fall
  back to the saved URL; not currently tested (only "url override
  without apiKey" is).
- `POST /api/gate/test` with both `url` and `apiKey` overridden — should
  bypass the saved config entirely; not covered.
- A method-not-allowed assertion (e.g. `GET /api/gate/install`) — the
  routes only match on `req.method === "POST"`, so the implicit 404 is
  worth a test to lock the contract.
- `GET /api/gate/status` after a partial install (url set, no api key on
  disk) — verifies the `hasApiKey: false` branch with a real config file
  rather than the empty-config path.
**Suggestion:** None of these blocks merge; add as a follow-up commit if
not already scheduled.

### [L] Missing `try/finally` cleanup on the `readSavedApiKey` config-read path
**File:** src/ui/routes.ts:673-680
**Issue:** Other concurrency-bounded routes (`/api/verify`,
`/api/export`) use `try/finally` to decrement counters. `gate/test`
doesn't have a counter so this is moot — flagged only to note that the
two gate routes share none of the back-pressure machinery the other
mutation-ish routes have. Probably fine because the probe has its own
timeout, but worth confirming with the correctness sibling.

## What's good
- New routes share the `sendError(res, status, message)` shape and the
  `parseUrl/readJsonBody` helpers — no parallel error-response style was
  introduced.
- Non-loopback gating for the gates routes is consistent with the
  existing `allowExportOnNonLoopback` / `allowVerifyOnNonLoopback` design,
  including the opt-in flag, the rationale comment, and the
  `openclaw.plugin.json` schema entry.
- `gate-setup.ts` uses `@state()` reactively (no manual `requestUpdate`
  calls) and wires events with `@input` / `@change` / `@submit`
  consistently — matches verify-panel.
- The `usingOverride` guard in `runTest()` mirrors the server-side
  `urlOverride && !apiKey` check, so the UI fails fast without a wasted
  network round-trip.
- The API key is cleared from state after a successful install
  (gate-setup.ts:207) — small but important detail.
- `GateStatus.hasApiKey: boolean` (no key value on the wire) is preserved
  in the client type, so the typed client cannot accidentally start
  rendering the key.
- The test rig boots a real `http.Server` and a real mock-Gate server —
  closer to the production code path than mocking `fetch`, and matches
  the style in `test/ui/routes.test.ts`.

## Open questions
- Should `/api/gate/test` accept an `allowPrivateHost` body field (and
  the UI expose a checkbox), or should it always re-use the
  install-time validation result of the saved URL? Either is
  defensible; the current "hard-coded false" is the only stance that
  isn't.
- Is the absence of a concurrency limiter on `/api/gate/test` and
  `/api/gate/install` intentional? `probeGate` has a network timeout, so
  load is bounded, but the other write-ish endpoints in this file are
  capped. Worth a deliberate yes/no rather than implicit.
