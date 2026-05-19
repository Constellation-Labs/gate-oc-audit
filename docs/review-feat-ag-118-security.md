# Security review — feat/AG-118 (`openclaw audit report session <id>`)

Scope: 2 new files (`src/reports/session-projection.ts`,
`src/reports/format-session.ts`), 1 new test file, and small additions to
`src/cli.ts` / `src/index.ts` registering the `report session <id>`
subcommand. CLI-only surface; no HTTP/socket exposure added. Threat model
is a local user with shell access on the operator's host plus any
attacker-controlled bytes that survived being written into
`metadata`/`content` by an earlier audit listener (tool args, recipients,
file paths, error strings).

## Summary

No critical or high-severity findings. The new projection delegates SQL
to the existing parameterised `AuditStore.query`, the SMT verification
path correctly uses `verifyProofWithRoots` (the root-anchored API) rather
than the private unsafe `verifyProof`, and the read-only store flag is
preserved end-to-end. The notable finding is M1: the JSON output is a
strict superset of the text output and includes raw `metadata` for every
timeline entry — tool args (when `redactToolArgs` is off), recipients,
file paths, and error strings will all flow into the JSON. That matches
existing `audit list` JSON behaviour in spirit, but `audit list` does not
have a `--json` flag yet, so this is the first CLI command in the plugin
to dump full metadata blobs in machine-readable form. Worth a CHANGELOG /
docs note. A handful of low / informational items follow.

---

## Findings

### M1 — `--json` emits raw `metadata` for every timeline entry; no `--redact` / `--include-content` gate

**File**: `src/reports/session-projection.ts:136-148` (`toTimelineEntry`)
and `src/cli.ts:407-411` (JSON emission)

```ts
// session-projection.ts:136
function toTimelineEntry(e: AuditEvent): SessionTimelineEntry {
  return {
    sequence: e.sequence,
    id: e.id,
    createdAt: e.createdAt,
    eventType: e.eventType,
    category: e.category,
    description: e.description,
    contentHash: e.contentHash,
    contentPreview: e.content,
    metadata: e.metadata,   // <-- entire metadata object, verbatim
  };
}
```

```ts
// cli.ts:407
if (opts.json === true) {
  outLine(JSON.stringify(projection));
  return;
}
```

`AuditEvent.metadata` is a `Record<string, unknown>` and its concrete
shape varies by `eventType`. From `src/hooks.ts`:

- `tool.invoked` writes `metadata.args` — the *unredacted* sanitized args
  unless `redactToolArgs` is on (`hooks.ts:395-405`). For an `exec`-style
  tool that's the shell command line, which can carry credentials,
  filesystem paths, recipient identifiers, etc.
- `message.sending` / `message.sent` carry `recipient` (phone numbers in
  the test fixture: `+17733192235`) and `channel`.
- `config.*` / `system.file_changed` carry `filePath`.
- `tool.result` carries `error: string` — the verbatim error message,
  which in practice often includes file paths and stack-trace fragments.
- `prompt.response` carries `provider`, `model`, token counts, and
  `costUsd`.

In **text** mode (`format-session.ts:103-111`) the timeline only renders
`#seq createdAt eventType — description` plus the truncated
`contentPreview`. `metadata` is not rendered. But in **JSON** mode the
full `metadata` object ships, including everything above.

The `export` command sets the precedent of gating full content behind an
explicit opt-in flag (`--include-content` at `cli.ts:128, 206`). Here,
JSON output unconditionally includes:

1. Full `metadata` (M1, this finding) — and there's no equivalent flag.
2. `bodyPreview` truncated to 500 chars for every distinct outbound
   message (intentional; matches `audit list`'s 500-char preview at
   `cli.ts:49`).
3. `contentPreview` truncated to 500 chars on every timeline entry.

**Severity**: M (operational sensitive-data exposure on an opt-in flag,
not a remote vulnerability). The CLI is local-only, so the attacker
already has shell access. The concern is rather:

- A scripted pipeline (`audit report session foo --json | jq ... > out.txt`)
  may inadvertently land redacted data into a less-trusted destination
  (log aggregator, ticket attachment, copy/paste into chat).
- Operators may reasonably expect `--json` to be a structured echo of
  what `text` prints, and the text format does not include `metadata`.

**Fix options** (pick one, none are merge-blockers):

1. Add a `--include-metadata` flag (default off) that controls whether
   `SessionTimelineEntry.metadata` is populated. Matches the
   `--include-content` precedent.
2. Add a small allowlist of metadata keys to surface in JSON (e.g.
   `toolName`, `model`, `provider`, `success`, `durationMs`,
   `inputTokens`, `outputTokens`, `costUsd`) and drop the rest by
   default. Most consumers want stats, not args.
3. At minimum: document on the command help and in the PR description
   that `--json` ships raw metadata; mention in the docs that
   `redactToolArgs` should be considered if this output will leave the
   host.

---

### L1 — `--json` also includes `id` and the full `contentPreview` (≤500 chars) per timeline entry; not a regression but worth a note

**File**: `src/reports/session-projection.ts:136-148, 264-269`

`SessionTimelineEntry.contentPreview` is the truncated body (500 chars
in default mode via `DEFAULT_CONTENT_PREVIEW_CHARS`). For a `prompt.response`
that body is the LLM reply; for a `message.sending`/`message.sent` it's
the outbound text. The text formatter renders the same up to 500 chars
(`format-session.ts:107-109`), so this matches existing parity with
`audit list`. Calling out only because it stacks with M1 — both knobs
default to "emit", neither is gated by a `--redact` flag.

**Severity**: L (informational, on-par with `audit list` body preview).

**Fix**: Same as M1 — a single `--redact` / `--include-content` flag could
gate both `contentPreview` and `outboundMessages[*].bodyPreview` if
desired. Otherwise no action.

---

### L2 — Session-id error message is echoed back to stdout unencoded

**File**: `src/cli.ts:411`
```ts
if (projection.timeline.length === 0 && opts.json !== true) {
  outLine(`No events found for session ${sessionId}.`);
  return;
}
```

`sessionId` is an unvalidated CLI arg; only `trim() === ""` is checked
(`cli.ts:373-377`). If a user passes
`'\x1b[2K\rsession-already-deleted\x07'` (terminal control sequences) or
a multi-megabyte string, `outLine` will write it verbatim to the user's
terminal. Same applies to the JSON path — `JSON.stringify` will encode
the control bytes, so JSON is safe; the text path is the one that copies
the input straight through.

This is the same shape as a classic "terminal injection" concern in CLI
tools that echo user-supplied strings. Realistic exploit is essentially
"user runs the CLI themselves with weird arguments and gets a confused
terminal" — i.e., self-DoS. Not a vulnerability in the security sense,
but a hardening opportunity.

**Severity**: L (UX / robustness, not an attack on a different
principal).

**Fix**: Validate the session-id against `^[A-Za-z0-9._:-]{1,128}$` (or
whatever the writers actually emit; `sessionId` in tests is
`session-96be15cb`, plain ASCII). Reject with a clean error message that
omits the offending value. If full character set support is required,
strip ASCII control characters before printing.

---

### L3 — `truncated` and partial-window aggregations may understate cost / outbound counts when `SESSION_FETCH_CAP` is hit

**File**: `src/reports/session-projection.ts:24, 367-373`

```ts
const SESSION_FETCH_CAP = 50_000;
...
const events = store.query({ sessionId, order: "asc", limit: SESSION_FETCH_CAP, ... });
const truncated = events.length >= SESSION_FETCH_CAP;
```

`SessionLlmCost.totalCostUsd`, `SessionToolUsage.calls`, and
`SessionOutboundMessage.sends` are summed over the first 50k events
only. When the cap fires, the report says `truncated: true` and the text
formatter prints a one-line WARNING (`format-session.ts:21`), but a
downstream consumer of the JSON who keys off `llmCost.totalCostUsd`
without checking `truncated` will read a value that silently undershoots
reality. This is the same shape as the existing `FETCH_CAP` finding in
the AG-121 review, and operator-against-self is the only realistic
scenario, but a consumer reading the JSON programmatically should be
nudged to check `truncated`.

**Severity**: L (correctness/UX, not exploitable; matches existing
`FETCH_CAP` semantics).

**Fix**: Document `truncated` in the inline JSDoc on
`SessionProjection.truncated` ("aggregated fields are partial when
true"). No code change required.

---

### I1 — `SmtService.ensureReady()` failures silently downgrade to "proofs unavailable" — confirmed intentional, but no operator signal

**File**: `src/cli.ts:381-393`
```ts
try {
  await smtService.ensureReady();
  knownRoots = smtService.getKnownRoots(store.getCheckpointedRoots());
  smtForProjection = smtService;
} catch {
  smtForProjection = undefined;
}
```

The empty `catch {}` swallows the underlying error. `ensureReady`
already logs its own failures via `smtLog.error` inside the function
(`smt-service.ts:120-123`), so the operator does see a message via the
logger, but a user who reads only stdout sees `proofsUnavailable: N` in
the integrity section with no hint that the *reason* is "SMT checkpoint
dir failed to restore" vs "no SMT trees yet for this session".

**Severity**: I (informational — observability gap, not a security
vulnerability). Surface area is small because `smtLog.error` is wired
to stderr by `routeLogsToStderr`.

**Fix**: Optional. Either rethrow and let the top-level CLI handler
print the error, or add a one-line `console.error(...)` inside the
`catch` so the user knows why proofs are unavailable. Not required.

---

### I2 — Empty-session JSON output is `(no events found …)` text *or* an empty projection; behaviour-by-flag inconsistency

**File**: `src/cli.ts:403-410`
```ts
if (projection.timeline.length === 0 && opts.json !== true) {
  outLine(`No events found for session ${sessionId}.`);
  return;
}

if (opts.json === true) {
  outLine(JSON.stringify(projection));
  return;
}
```

For an unknown session, `text` prints `No events found for session X.`
and `json` prints the full empty projection (`timeline: []`,
`integrity.eventCount: 0`, etc.). That's correct — scripts should be
able to parse the empty projection — but a scripted consumer relying on
exit code will see `process.exitCode = 0` in both cases. There's no way
to distinguish "session doesn't exist" from "session has 0 events". Same
shape as existing CLI commands (`audit list`), so likely fine, but worth
flagging.

**Severity**: I (informational — UX / scriptability).

**Fix**: Optional. Either set `process.exitCode = 1` on
`timeline.length === 0` so scripts can branch on it, or document that
the caller should check `projection.timeline.length` /
`projection.integrity.eventCount` in the JSON.

---

### I3 — No per-session ACL; anyone with CLI access reads any session

**File**: `src/cli.ts:367-414` (new handler)

Confirmed matches existing `audit list --session <id>` (`cli.ts:62-85`)
and `audit export --session <id>` (`cli.ts:180-211`) behaviour — neither
authenticates the caller or scopes by `orgId`/`userId`. The audit DB on
disk is the access boundary; OS-level file permissions are the only ACL.

Given a multi-tenant deployment (multiple orgs sharing one audit DB),
the CLI would happily dump session contents across tenants. Not in
scope for this PR (the DB itself is what's shared) but flagging
explicitly per the review brief.

**Severity**: I (existing design choice; not introduced by this PR).

**Fix**: Out of scope for AG-118. A future ticket could add an
`--org-id` / `--user-id` filter at the query layer.

---

## Items verified clean

| Concern | Finding |
|---|---|
| **SQL injection (sessionId)** | `store.query({ sessionId })` flows through `AuditStore.buildWhere` at `audit-store.ts:576-579`, which binds via the named parameter `@sessionId` on a `db.prepare(...).all({...})` prepared statement (`audit-store.ts:620-628`). No string interpolation. |
| **SQL injection (other args)** | The new handler only passes `sessionId` plus internal constants (`order: "asc"`, `limit: SESSION_FETCH_CAP`, `contentPreview: previewChars`). All are bound or pre-validated literals. |
| **Read-only store preservation** | `getStore()` at `index.ts:64-72` opens the DB with `readOnly: true`. `cliReportSessionHandler` never calls `store.append`, `store.upsertSmtCheckpoint`, or any mutating method. Confirmed via grep against `session-projection.ts` — only `store.query` is invoked. |
| **SMT read-only paths** | `ensureReady` → `manager.restoreAll` + `restoreMetadata` are filesystem reads of `config.checkpointDir`. `computeCensoredHash`, `findContainingTreeKey`, `createProof`, `verifyProofWithRoots`, `getKnownRoots`, `listTrees` all read in-memory tree state; none mutate it. The session command path never calls `checkpoint`, `start`, `onEventAppended`, or `insertEntry`. |
| **Correct verification API** | `session-projection.ts:329` uses `verifyProofWithRoots(proof, knownRoots)`, the public root-anchored method. The private `verifyProof` (`smt-service.ts:314-317`) is never called from this PR's code — it skips the root legitimacy check and is correctly marked `private`. A tampered row whose proof points at an attacker-controlled root would fail the `knownRoots.has(proof.root)` check at `smt-service.ts:332` and be counted as `invalid` (i.e., `proofsFailed`), not as `verified`. |
| **Integrity counter accuracy** | Verified flow: `computeCensoredHash(e)` → `findContainingTreeKey(leafHash)` → if `null`, count `unavailable` (not `verified`). When a tree key is found, `createProof` builds the proof, `verifyProofWithRoots` enforces both root legitimacy and hash-chain consistency. A row whose censored hash isn't in any tree (i.e., tampered or never anchored) cannot reach the `verified` counter. |
| **Resource exhaustion (memory)** | `SESSION_FETCH_CAP = 50_000` × `contentPreview: 500` ≈ 25 MB of preview bytes worst case, plus metadata JSON. Acceptable for forensic CLI usage. Outbound dedup map is keyed by `contentHash`; even 50k distinct hashes is a few MB. |
| **Resource exhaustion (CPU)** | The SMT proof loop is bounded by `events.length` (≤ 50k). Each iteration is one censored-hash + one tree-key lookup + one proof construction + one verification. Same order of magnitude as the AG-121 detector, which the prior review judged acceptable. No nested loops over events. |
| **ReDoS** | No new regexes introduced. |
| **HTML / JSON injection** | No HTML output. JSON output is `JSON.stringify(...)` of the projection — Node's stringify safely escapes embedded quotes, control bytes, and unicode. Stays parseable by `jq -c`. |
| **Path traversal** | No filesystem paths consumed from CLI args by the new handler. |
| **Command injection** | No `child_process` / `exec` calls introduced. |
| **CLI input validation (trim/null)** | `sessionId` trim/empty check at `cli.ts:373-377` rejects empty strings cleanly with `process.exitCode = 1`. Length is unbounded; SQLite tolerates arbitrarily long parameter strings (the query simply returns zero rows). The terminal-echo concern is L2 above. |
| **Empty-content dedup hash** | `EMPTY_CONTENT_SHA256` constant at `session-projection.ts:152` matches `sha256("")`. Confirmed: `printf '' \| sha256sum` → `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Two empty-body rows correctly fall through to non-collapse. |
| **Schema versioning** | `SESSION_PROJECTION_SCHEMA_VERSION = 1` baked into the JSON output (`session-projection.ts:5, 396`). Future shape changes can be detected by consumers. |
