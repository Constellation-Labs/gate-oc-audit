# Correctness review — `feat/AG-118` (per-conversation rollup)

Base: `main` · Branch: `feat/AG-118-per-conversation-rollup` · Files reviewed: 5

Findings are grouped by severity (blocker / must-fix / nice-to-have / nit).
Severity rubric:
- **blocker** — wrong answer on a documented acceptance scenario, silent
  data loss, or breaks an explicit PRD guarantee.
- **must-fix** — narrow but plausible bug; misleading output; ergonomic
  foot-gun.
- **nice-to-have** — hardening, semantic clarity, or coverage gap.
- **nit** — naming / docs / dead defensive code.

Test suite: `npm test` → 652 pass, 1 skipped, 0 fail (28.5s).
The four R4 tests in `test/reports/session-projection.test.ts` all pass.

---

## Acceptance criteria validation

| PRD R4 criterion | Status | Evidence |
|---|---|---|
| `--raw` matches `audit list --session <id> --limit 50` for a 12-event session | **pass with caveat** (see must-fix #1) | `session-projection.test.ts:108-129` asserts exact sequence-by-sequence equality against `store.query({sessionId, limit: 50}).reverse()`. For ≤50 events the two paths converge; >50 they diverge silently. |
| Default mode collapses the four duplicate-body rows into one Outbound section row | **pass** | `session-projection.test.ts:83-106` (collapses 4→1) and `:175-198` (groups by `contentHash`). The seeded fixture matches the PRD's 20:57Z duplicate-send pattern. |
| Latency < 1s for a typical (12-event) session | **pass** | `session-projection.test.ts:214-221` measures `buildSessionProjection` end-to-end; the assertion holds with headroom (typical run << 1000 ms). The latency budget excludes `ensureReady()`, see nice-to-have #1. |

---

## must-fix #1 · `--raw` parity quietly breaks above 50 events

**File:** `src/reports/session-projection.ts:367-373` + `src/cli.ts:62-85`

`audit list --session <id> --limit 50` runs `store.query({sessionId, limit: 50})` —
default order is `DESC` (`audit-store.ts:616`), then `cliAuditHandler:82` reverses
the top-50 slice. The visible rows are therefore **the 50 highest-sequence
events for the session, in ASC order**.

`buildSessionProjection` queries `{sessionId, order: "asc", limit: SESSION_FETCH_CAP=50_000}`.
For sessions with ≤50 events the two paths happen to enumerate the same set in
the same order. For a session with 51+ events:

- `audit list --limit 50` → sequences `[N-49 .. N]` ASC.
- `buildSessionProjection` (raw) → sequences `[1 .. min(N, 50000)]` ASC.

The PRD wording in the priority list says "`--raw` output matches `audit list
--session <id> --limit 50`". That only holds for the ≤50 case. The user prompt
calls this out and asks to confirm "that `limit 50` vs `SESSION_FETCH_CAP=50_000`
doesn't change the comparison **for the ≤50 case**" — yes, for ≤50 the parity is
exact. For >50 it isn't, and the test only exercises the 12-event case so the
divergence is silent.

**Concrete failing scenario:** a long-running session with 200 events.
`audit list --session sess --limit 50` shows events 151-200. `audit report
session sess --raw` shows all 200, starting at event 1. An operator told
"these should match" will trip on this.

**Suggested fix:** pick a side and document it. Either
- Document that `--raw` shows **all** session rows in ASC (which is more useful
  for forensics anyway — this is what `--raw` is for), and adjust the PRD/help
  text so the "matches `audit list`" claim is conditioned on `--limit ≥ count`; or
- Add a `--limit N` flag to `report session` so the parity claim can be
  exact when N is specified.

Either way, the current help string ("Return the un-deduplicated row stream
(forensic)" in `src/index.ts:181`) doesn't mention parity, so the simplest fix
is the doc/wording one. **Add a test that the >50 case still produces
sensible output**, since right now no test exercises it.

---

## must-fix #2 · `aggregateOutbound` reads `e.content.length` after the content was already truncated to 500 chars

**File:** `src/reports/session-projection.ts:256-258`

```ts
const contentLength = typeof e.metadata.contentLength === "number"
  ? e.metadata.contentLength
  : (e.content ? e.content.length : null);
```

`buildSessionProjection` queries with `contentPreview: previewChars` (default
500), and `audit-store.ts:96-97 / 105-107` confirm that this only decompresses
the first `maxChars` of `content_gz`. So `e.content.length ≤ 500` for every
event, regardless of the real body size.

When `metadata.contentLength` is missing (older `message.sent` rows, or a
gateway that didn't set the field), the report shows `500 chars` for **every**
non-trivially-sized outbound body, which is wrong. The format-session output
prints this as `len=500 chars` next to each send — actively misleading.

**Concrete failing input:** a `message.sent` row whose `metadata.contentLength`
is missing and whose actual body is 5000 chars. Report: `5000 chars` from
metadata path is correct; if metadata is absent, report shows `500 chars`.

**Suggested fix:** either
- Drop the `e.content.length` fallback entirely and emit `null` (which the
  text formatter already renders as `size unknown`, `format-session.ts:72`); or
- Read `contentLength` from a separate full-content query for the outbound
  rows only; or
- Store the original `contentLength` at append time (the gateway-stop hook
  already does this — check it's set everywhere).

Dropping the fallback is the safest minimum fix. There is no test for this
path (every fixture sets `metadata.contentLength`).

---

## must-fix #3 · `aggregateTools` ignores `tool.denied`

**File:** `src/reports/session-projection.ts:177-196`

```ts
for (const e of events) {
  if (e.category !== "tool") continue;
  ...
  if (e.eventType === "tool.invoked") entry.calls += 1;
  if (e.eventType === "tool.result") { ... totalDurationMs / errors ... }
}
```

`tool.denied` is a `category: "tool"` event (per the EventType union in
`types/events.ts:17-20`) emitted when an invocation is rejected by a policy
guard. The current code creates a `toolName` bucket for it (line 181 fires
for any tool-category row), then increments **neither calls, errors, nor
durationMs**. The bucket therefore shows up in `toolsUsed` with `{ calls:0,
errors:0, totalDurationMs:0 }` — a row that conveys nothing and makes the
sort order misleading (a denied tool with 0 calls can outrank a successful
tool by alphabetical accident, since the sort is stable on equal `calls`).

`tool.persisted` has the same shape — also no field is incremented, also
creates an empty bucket.

**Concrete failing input:** session with `tool.invoked(exec)` then
`tool.denied(curl)`. Report:
```
exec    calls=1  errors=0  0.00s
curl    calls=0  errors=0  0.00s
```
A reader trying to triage "did anything bad happen?" needs to scan zero-call
rows to see denials.

**Suggested fix:** decide policy. Either
- Surface denials in the report (probably as a separate `errors` increment
  or a new `denials` field on `SessionToolUsage`), or
- Skip non-`{invoked, result}` rows when bucketing so zero-row entries don't
  appear.

Skipping is the one-line fix:
```ts
if (e.eventType !== "tool.invoked" && e.eventType !== "tool.result") continue;
```

`tool.result` with an error string already increments `errors`; that path is
correct.

No test covers `tool.denied` flow.

---

## must-fix #4 · `computeIntegrity` does not distinguish "past SMT high-water mark" from "tampered"

**File:** `src/reports/session-projection.ts:285-354` (vs `services/verifier.ts:238-269` & `ui/routes.ts:213+`)

Existing tampering classifiers skip events whose `sequence > smtLastSeq` and
treat them as **untracked, not tampered** (verifier `findTamperedRange` line
252-257; `routes.ts:classifyEvent`). `computeIntegrity` here has no such
guard — every event past the SMT's `lastInsertedSeq` lands in
`proofsUnavailable` exactly like a genuinely-missing leaf would.

For a session that is still being written to while the report runs (the
default mode of operation: `audit report session` from a live agent host),
the trailing events will all be past `smtLastSeq` and will inflate
`proofsUnavailable`. The operator reads "5 proofs unavailable" and worries
about tampering when in reality those 5 events just haven't been replayed
into the tree yet.

This mirrors the AG-121 review's M-4 finding on `tamperedEvents`, but on
the opposite axis: AG-121 *correctly* skips untracked events, and AG-118
does not.

**Suggested fix:** add an `untracked` axis to `SessionIntegrity` and gate
the `findContainingTreeKey` lookup on `e.sequence <= smtLastSeq`. Equivalent
to:
```ts
const smtLastSeq = smtService.getLastCheckpointedSequence();
...
for (const e of events) {
  if (e.sequence > smtLastSeq) { untracked += 1; continue; }
  ...
}
```
Then surface `untracked` separately in the text formatter so the operator
sees `verified=7 untracked=5 unavailable=0` instead of `unavailable=5`.

No test covers the still-writing case.

---

## must-fix #5 · `computeIntegrity` reports an `smtRoot` even when nothing was verified against it

**File:** `src/reports/session-projection.ts:338-343, 352`

```ts
} else {
  // No roots to compare against ...
  unavailable += 1;
  roots.add(proof.root);
}
...
smtRoot: roots.size === 1 ? Array.from(roots)[0] : null,
```

When `knownRoots` is empty (e.g., the catch block at `cli.ts:393-395` set
`smtForProjection` but the `try` happened to leave `knownRoots = undefined`
— actually impossible since we set both together — or when
`getKnownRoots()` returns an empty set), the function falls into the
"unavailable" branch but still adds `proof.root` to the local `roots` set.
If every event shares the same root, the projection's `smtRoot` is the tree
root, and the text formatter prints `SMT root abc123…` — alongside
`verified=0 failed=0 unavailable=N`. A reader skimming the report sees a
root and assumes it was verified.

`cli.ts:387-395` always pairs `smtForProjection` with a populated
`knownRoots` (or sets both to undefined), so this branch is reached only
when `knownRoots.size === 0` *after* the ensure-ready path succeeded. That
implies: SMT loaded but contains no trees and no checkpoints. Plausible on
a freshly initialised host that has the audit DB but never wrote to the SMT.

**Suggested fix:** only add to `roots` from the `valid` branch:
```ts
if (res.status === "valid") {
  verified += 1;
  roots.add(proof.root);
}
```
That makes `smtRoot` exactly mean "the root the verified proofs anchor
against". The current behaviour is documented by the comment at line
340 ("count the proof existence as 'unavailable' rather than verified, so
the report doesn't lie") — but the `roots.add(proof.root)` two lines later
contradicts that intent.

---

## nice-to-have #1 · `ensureReady()` latency is excluded from the < 1s PRD budget

**File:** `src/cli.ts:389-395` + `test/reports/session-projection.test.ts:214-221`

The latency test measures `buildSessionProjection()` only. `ensureReady()`
(restore checkpoints from disk, rebuild `__verifier__` tree, etc.) runs in
`cliReportSessionHandler` **before** the projection call and can be the
dominant cost on a host with many trees / large checkpoints (a few hundred
ms in the smt tests' setup logs). The PRD R4 1s budget applies to the
end-to-end CLI invocation, not just the pure-function projection.

**Suggested:** add a CLI-level latency test that exercises
`cliReportSessionHandler` with a non-trivial SMT to confirm the budget
holds, or document that the < 1s budget excludes SMT load.

---

## nice-to-have #2 · `dedupTimeline` could collapse semantically-distinct event types when contentHash collides

**File:** `src/reports/session-projection.ts:154-175`

The dedup rule is "consecutive rows in `DEDUP_EVENT_TYPES` with the same
contentHash". Three event types share the same body in the PRD-described
flow (prompt.response → message.sending → message.sent), and they collapse
under a `prompt.response` anchor. **The resulting collapsed row is labelled
with the eventType / description of the first row** (line 167-169 leaves
`last` untouched apart from `collapsedCount`/`collapsedSequences`).

So a 4-row run collapses to:
```
#42  ...  prompt.response — LLM response received (×4 consecutive identical-body rows: #42, #43, #44, #45)
```

That's correct for the PRD pattern (the prompt.response is what the operator
cares about). But: if for some reason a `message.sending` row arrives
*before* the `prompt.response` (e.g., upstream reorder), the collapsed
anchor is `message.sending`, hiding the fact that an LLM response was part
of the group. Tests do not exercise this ordering.

**Suggested:** consider folding the collapsed group's eventType list into
metadata so the rendered row can show "prompt.response + 2× message.sent",
or leave the anchor logic as-is and document the assumption (in-order
arrival) in the doc-comment at line 7-15.

Low risk for normal traffic; flagging because the assumption is currently
unstated.

---

## nice-to-have #3 · Floating-point summation for `costUsd` is unbounded

**File:** `src/reports/session-projection.ts:230, 237`

```ts
entry.costUsd += numOrZero(e.metadata.costUsd);
totalCostUsd += numOrZero(e.metadata.costUsd);
```

Naive `+=` on IEEE 754. For typical session magnitudes (a few cents to a few
dollars across <100 calls) the round-off is negligible (<1e-10). The test
explicitly checks `Math.abs(p.llmCost.totalCostUsd - 0.011) < 1e-9` and
passes. Not a blocker.

**Concrete bound:** 50_000 events × $0.10 each, summed iteratively → max
relative error ~ 50_000 × eps ≈ 1.1e-11 — still well below the 4-decimal
rendering precision (`format-session.ts:118-120`'s `toFixed(4)`).

**Suggested:** none for now. If costs ever balloon into the "$10k report"
range with thousands of rows, consider Kahan summation. Flagging for
documentation only.

---

## nice-to-have #4 · `jobId` hoisting first-non-null can pick a subagent's id when subagents predate the cron row

**File:** `src/reports/session-projection.ts:383-387`

```ts
let jobId: string | null = null;
for (const e of events) {
  const candidate = stringOrNull(e.metadata.jobId);
  if (candidate) { jobId = candidate; break; }
}
```

Events arrive in ASC sequence order, and `hooks.ts:323-329` shows that
`cron.executed` is the canonical jobId carrier and is emitted at the top of
a cron-triggered run. Downstream prompt rows inherit `jobId` via
`hooks.ts:364, 378`. **Subagent events (`hooks.ts:764+`) do not set
`metadata.jobId`** — confirmed by grep. So in practice the first non-null
is the parent cron's jobId.

That said, the function name `jobId` is ambiguous — if any future event ever
records a `metadata.jobId` of its own (a subagent run with its own job id,
say), the first-wins rule loses information. Cheap defensive fix:

**Suggested:** if `jobId` is meant to mean "the cron jobId for this
session", pull it specifically from the `cron.executed` row rather than the
first event that happens to have `metadata.jobId`. One-line change:
```ts
for (const e of events) {
  if (e.eventType === "cron.executed") {
    jobId = stringOrNull(e.metadata.jobId);
    if (jobId) break;
  }
}
```
This is more robust to future event-type additions.

---

## nice-to-have #5 · `truncated` flag is plumbed through projection but not exposed in the JSON-mode error / empty path

**File:** `src/cli.ts:403-411` + `src/reports/session-projection.ts:373`

`truncated: events.length >= SESSION_FETCH_CAP` correctly propagates into
the JSON output (it's a top-level field on `SessionProjection`) and the
text output ("WARNING: event fetch truncated; some session rows are not
in this report.", `format-session.ts:20-22`). ✓

However: in the **empty-session** text path (`cli.ts:403-406`),
`buildSessionProjection` is still called and returns a projection with
`timeline.length === 0`. If for some pathological reason the empty result
also happened to set `truncated: true` (it can't — `0 >= 50000` is false),
the CLI would print only "No events found for session …" and discard the
warning. The truncation flag works correctly in practice; flagging only
because the empty path bypasses the formatter entirely.

No fix needed.

---

## nit #1 · `contentHash !== ""` guard is dead code

**File:** `src/reports/session-projection.ts:163`

```ts
e.contentHash === last.contentHash &&
e.contentHash !== "" &&
e.contentHash !== EMPTY_CONTENT_SHA256;
```

`audit-store.ts:511` does `const contentHash = sha256(rawContent ?? "");`,
which always produces a 64-char hex digest. `contentHash` is also typed
`string` (required) on `AuditEvent`. The `!== ""` check can never fire.

The `!== EMPTY_CONTENT_SHA256` check **is** load-bearing — it correctly
prevents collapsing two consecutive empty-body events of dedup types, which
otherwise would all share the sha256-of-empty hash. Verified by Node:
```
$ node -e "console.log(require('crypto').createHash('sha256').update('').digest('hex'))"
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```
matches the constant at line 152. ✓

**Suggested:** drop the `e.contentHash !== ""` check, or leave it with a
short comment noting it's defensive against a hypothetical future
non-sha256 contentHash path. Cosmetic.

---

## nit #2 · `SESSION_PROJECTION_SCHEMA_VERSION` published but no consumer-side pin documented

**File:** `src/reports/session-projection.ts:5, 99-100`

`PROJECTION_SCHEMA_VERSION` (daily/weekly) has a published JSON Schema
pinned in `schemas/audit-projection.schema.json` (per the doc-comment at
`projection.ts:5-10`). The session projection has no equivalent file. If
external consumers will parse the JSON, publish the schema or document the
intent not to. Out of scope for this branch — flagging for follow-up.

---

## nit #3 · `aggregateLlmCost` sorts `byModel` by `costUsd` desc — ties resolve by Map insertion order

**File:** `src/reports/session-projection.ts:246`

```ts
byModel: Array.from(byKey.values()).sort((a, b) => b.costUsd - a.costUsd),
```

Two models with identical cost (both $0.00 during dev, or two free models)
sort in `Map.values()` order, which is insertion order — the order of first
appearance in the event stream. Deterministic given the same input, but
unstable across event-arrival permutations. Not a correctness bug; nice to
have a `.toString()` tie-break for cosmetic stability:
```ts
.sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
```

Same nit applies to `aggregateTools` sort at line 195 (ties by `calls` then
insertion order).

---

## Test coverage assessment

`test/reports/session-projection.test.ts` covers:

| Behaviour | Tested? |
|---|---|
| 12-event session → 4 rows collapse to 1 | yes (`:83-106`) |
| `--raw` produces 12 entries with no collapse | yes (`:108-129`) |
| `--raw` matches `audit list` row order (≤50 case) | yes (`:122-127`) |
| `--raw` matches `audit list` order **above 50 events** | **no — see must-fix #1** |
| LLM cost / tools / outbound aggregations | yes (`:145-173`) |
| Duplicate outbound sends grouped by contentHash | yes (`:175-198`) |
| jobId hoisting from cron.executed | yes (`:172`) |
| jobId hoisting when first non-null is a subagent | **no — see nice-to-have #4** |
| Latency < 1s for 12 events | yes (`:214-221`) |
| Empty session returns empty projection | yes (`:237-247`) |
| Unknown session in JSON mode | **no** (current text-mode path returns early; JSON path returns an empty projection — neither asserted) |
| `tool.denied` handling | **no — see must-fix #3** |
| `tool.result` with error string increments errors | **no** (existing aggregateTools branch at `:190-192` is untested) |
| `aggregateOutbound` `contentLength` fallback when metadata is missing | **no — see must-fix #2** |
| Integrity past smtLastSeq | **no — see must-fix #4** |
| Integrity with empty `knownRoots` | **no — see must-fix #5** |
| Dedup with interleaved tool call (non-consecutive identical hashes) | **no** |
| Truncation flag propagation when ≥ SESSION_FETCH_CAP events | **no** |

The five must-fix items are all detectable with unit tests against the
existing `AuditStore` + fake `SmtService` plumbing.

---

## Summary

- **0 blockers** — the three PRD R4 acceptance criteria all pass on the
  seeded 12-event fixture.
- **5 must-fix items**:
  1. `--raw` parity claim quietly breaks above 50 session events.
  2. Outbound `contentLength` falls back to a preview-truncated length.
  3. `tool.denied` (and `tool.persisted`) create zero-valued tool-usage
     rows and don't surface denials.
  4. Integrity conflates "untracked (past smtLastSeq)" with "unavailable".
  5. Integrity surfaces `smtRoot` even when no proof was verified against
     it.
- **5 nice-to-have**: `ensureReady()` latency excluded from the budget
  test; dedup anchor depends on arrival order; `costUsd` summation
  precision; `jobId` hoisting picks first-non-null instead of
  `cron.executed`; truncation flag bypassed in empty-text path.
- **3 nits**: dead `contentHash !== ""` guard, unpublished schema, sort tie
  breaking.

Recommended fix order:
1. must-fix #3 (one-line `if` skip) — closes a misleading-output path.
2. must-fix #2 (drop the preview fallback) — closes a wrong-number path.
3. must-fix #4/#5 (integrity semantics) — closes two operator-trust
   issues.
4. must-fix #1 (doc/scope of `--raw` parity) — non-code, but spec-level.
5. nice-to-haves as time allows; add the missing tests called out above.
