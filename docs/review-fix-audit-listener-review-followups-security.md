# Security review — fix/audit-listener-review-followups

## Summary

The two M-level findings from the prior review are correctly mitigated, and the L-level log/UI-injection finding is mitigated thoroughly across every description template (every single backtick description that interpolates a possibly-attacker-controlled value now goes through `safeDesc()`). The fixes themselves do not introduce a new high-severity issue, but they add three small new attack surfaces worth flagging:

1. The truncation-marker payload is **ambiguous**: a real event whose plugin-provided metadata happens to include `metadataDropped: true` is structurally indistinguishable from a truncated row. The marker is not nested under a namespaced key.
2. The replacement payload **inherits the size from the original**: `originalSize` is the canonicalized length of the offending input. While that number is bounded by the integer encoder, an attacker can still pump content into the audit DB via the marker — the marker itself is trivially small (~80 bytes), but each oversize attempt costs the attacker bandwidth-only and yields a permanent audit row, so the path is still a cheap DB-bloat amplifier (no rate limiting on the truncate path beyond the existing `RateLimiter`).
3. The new `safeDesc()` length limit (`DESCRIPTION_MAX = 256`) silently truncates legitimately long descriptions with `…` (U+2026). For a forensic audit log this is a behavior change worth being explicit about — but the metadata column still preserves the raw values, which is the right design.

The `before_install` catch path is wired correctly — `safeAppend`, `limiter`, and `safeDesc` are all in scope at the point the catch fires, and the e2e test at `test/e2e.test.ts:1265-1323` proves the audit row lands. No new SQL/path/injection issues found.

## Prior-finding verification

- **[M] Audit-trail evasion via 1MB metadata cap**: **Resolved.**
  `src/store/audit-store.ts:265-278` now keeps the row with a `{ metadataDropped: true, reason: "size-cap", originalSize }` payload instead of dropping it. The replacement payload is itself ~80 bytes canonicalized, so it cannot recursively exceed the cap. `originalSize` is the integer length of the offending canonicalization — even at the JS `Number.MAX_SAFE_INTEGER` it serializes to ~16 chars, well below 1MB. There is no quadratic blow-up path. The non-serializable branch (`audit-store.ts:255-263`) is symmetric: it produces a fixed `{ metadataDropped: true, reason: "non-serializable" }` payload that cannot itself fail to serialize. Both replacement payloads are constructed from primitives only — `sdk.canonicalize` on those literal objects cannot throw. Tests at `test/store/audit-store.test.ts:96-122` and `test/e2e.test.ts:1325-1359` confirm the truncate-and-record behavior end-to-end. See **new finding [L] Marker payload is structurally ambiguous** below for the residual concern.

- **[M] `before_install` registration miss now writes audit row**: **Resolved.**
  `src/hooks.ts:776-788`. The catch is inside `registerHooks`, so `safeAppend`, `limiter`, `store`, `redactContent`, `redactToolArgs`, and `safeDesc` are all in lexical scope. `safeDesc` is declared at module scope (`hooks.ts:129-133`), so it is defined regardless of where the catch fires inside `registerHooks`. The new event type `system.install_hook_unavailable` is added to the union (`src/types/events.ts:51`) and the category is `"system"`, which is one of `FULL_FIDELITY_CATEGORIES` in the rate limiter (`src/rate-limiter.ts:11`) — so even if the limiter is configured with a low `rateLimitPerSec`, this event will be persisted at full fidelity. The e2e test at `test/e2e.test.ts:1265-1323` simulates a runtime that throws on `before_install` registration and confirms the audit row is recorded with the underlying error.

  Caveat (already noted in the prior review and called out in the task brief): only `before_install` is wrapped. If a future openclaw runtime starts throwing on other unknown hooks (e.g. `tool_result_persist`, which only landed recently), `registerHooks` will throw out of the catch-less `api.on` calls and abort hook registration entirely — the user will get a stack trace and no plugin. That is the correct fail-loud behavior, but it's worth noting as a cliff: the asymmetry here is deliberate, not accidental.

- **[L] `description` log/UI injection**: **Resolved.**
  `safeDesc()` (`src/hooks.ts:129-133`) strips `[\x00-\x1F\x7F]` (covers NUL, TAB, LF, CR, VT, FF, ESC, all C0 controls, and DEL) and clamps to 256 chars. I grep'd every backtick template literal in `description:` fields across `src/hooks.ts`. **All 18 templates that interpolate a non-static value now route through `safeDesc()`**. The applied sites are:

  | Line | Template |
  |---|---|
  | 183 | cron jobId |
  | 233 | cron error |
  | 262 | tool name |
  | 277 | tool denied (toolName + error, both wrapped) |
  | 290 | tool name |
  | 310 | tool persisted name |
  | 329 | provider/model |
  | 355 | sender + channel |
  | 386 | recipient + channel |
  | 416 | recipient + channel |
  | 446 | claim channel |
  | 471 | dispatch channel |
  | 504 | provider/model |
  | 563 | reset reason |
  | 581 | session start id |
  | 600-601 | session end (reason + id, both wrapped) |
  | 626, 644, 663, 683 | subagent ids/outcomes |
  | 716 | gateway stop reason |
  | 751 | install mode + target + name (all three wrapped) |
  | 785 | install_hook_unavailable error |

  The control-char regex `/[\x00-\x1F\x7F]/g` is correct: `\x09` (TAB), `\x0A` (LF), `\x0D` (CR), and `\x7F` (DEL) are all in range. Printable Unicode (including emoji and CJK) survives. The only minor cosmetic note: the truncation suffix `…` (U+2026) is one Unicode code point but three UTF-8 bytes, so a downstream parser that *counts bytes against `DESCRIPTION_MAX`* might briefly disagree with the JS string length. Not a security issue.

  **One small gap**: `safeDesc(undefined)` and `safeDesc(null)` return `""`, so an event whose required input field is missing now interpolates an empty string into descriptions — e.g. `LLM input: /` if both `provider` and `model` are missing. The metadata still records the absent fields as `undefined`, so this is cosmetic, not a forensic loss.

- **[L] README `~/` quoting**: **Resolved (CLI example).**
  `README.md:47` now uses `"$HOME/.openclaw/audit.db"` — bash *does* expand `$HOME` inside double quotes, so this lands at the right path on a multi-user host. The JSON example at `README.md:185` (in the config-file form) still has `"~/.openclaw/audit.db"`, which is correct because `AuditStore` resolves `~` itself at `src/store/audit-store.ts:168` (`dbPath.replace(/^~/, process.env.HOME ?? ".")`). I verified that path is unchanged on this branch. Documentation is consistent with runtime behavior.

- **[L] Manifest `onCapabilities`**: **Not addressed.**
  Out of scope for this follow-up (the brief lists only the four items above). `openclaw.plugin.json` is unchanged. Carry forward.

- **[L] `CONVERSATION_ACCESS_WARNING` fingerprinting**: **Not addressed.**
  The warning is unchanged at `src/hooks.ts:78-82`, and now fires under module-scope `conversationAccessWarned` instead of per-call closure state. The fingerprinting concern is the same — low impact. See new finding **[L] Module-scope warning state can leak warning across re-registrations** below for the related-but-distinct concern this introduces.

## New findings

### [L] Truncation-marker payload is structurally indistinguishable from a real event (`src/store/audit-store.ts:259-263`, `268-277`)

The truncate-and-record path replaces metadata with a top-level object:
```js
{ metadataDropped: true, reason: "size-cap", originalSize: <n> }
```
A downstream verifier (or human auditor) reading the SQLite log cannot, from the metadata alone, distinguish a truncated row from a legitimate event whose plugin happened to record a field literally named `metadataDropped`. Today nothing in this plugin emits a field by that name, so the collision is hypothetical — but the contract is exposed publicly: any third-party plugin that uses `safeAppend` (this plugin's pattern) and happens to set a metadata field called `metadataDropped` would emit ambiguous rows.

The censored hash (`src/services/smt-service.ts:275-285`) does not include metadata, so the truncated row's censored hash is computable and verifies. The raw hash (`smt-service.ts:256-269`) *does* include metadata, so a truncated row's raw hash is computed from the marker payload, not the would-have-been original. A verifier replaying from a forensic copy of the unmodified original input (e.g. from a separate transport-layer recording) would see a hash mismatch. That is the expected behavior, but it is worth being explicit: **the raw hash only proves the row as recorded, not the row as the plugin saw it before truncation**. Same is true for the existing `MAX_CONTENT_SIZE` path (preexisting), so this is a consistency concern, not a regression.

Mitigation (recommended): nest the marker under a reserved namespace key, e.g.
```js
{ "$auditTruncation": { reason: "size-cap", originalSize: n } }
```
The `$` prefix is unlikely to collide with any real metadata key. Optional: also write the `eventType` and `description` un-touched so the marker doesn't hide what the row was about.

### [L] Module-scope warning state can leak across `registerHooks` calls in the same process (`src/hooks.ts:75-76`)

`llmInputObserved` and `conversationAccessWarned` are now module-scope. The intent (per the comment at `hooks.ts:69-74`) is correct: re-registration on a fresh `api` instance should preserve the "we already saw llm_input" signal so the warning doesn't spuriously refire.

The trade-off is that in a process that calls `registerHooks` multiple times (e.g. a test harness, or a hypothetical multi-tenant openclaw host that re-instantiates plugins per workspace), the second `registerHooks` call inherits the first call's `llmInputObserved=true` and **suppresses the warning even if the second tenant's runtime never fired `llm_input`**. The warning is one-shot per process, not per registration.

Two practical implications:
1. **Test isolation**: this affects ordering between tests. The hooks tests at `test/hooks.test.ts` re-register hooks per-test (`beforeEach`), and any test that fires `llm_input` (e.g. `hooks.test.ts:557`) will set the module flag for every subsequent test in the file. If a future test asserts the warning fires, it will be order-dependent.
2. **Multi-tenant fingerprinting** (the prior review's L-level fingerprinting concern): if openclaw ever runs multiple plugin instances in the same process (it currently does not — openclaw plugins are per-process per the user's MEMORY.md note that plugins run in a sandboxed VM), the fingerprinting signal "this tenant's audit plugin has conversation access disabled" could leak from tenant A's stderr to tenant B's logs by virtue of being module-scope. Out of scope today, but the assumption is now load-bearing.

Mitigation (optional): keep the flag per-`registerHooks` call but guard against the legitimate re-registration case by storing it on the `api` object (`api[Symbol("llmInputObserved")] = true`). If openclaw's plugin lifecycle is strictly per-process (the documented case), the current module-scope is fine — leave a comment noting the assumption.

### [L] `accountId` and `parentConversationId` are sender-controlled in some transport paths but not redacted (`src/hooks.ts:361, 391, 421, 452`)

The new metadata fields `accountId` (on `message_received`/`message_sent`/`message_sending`) and `parentConversationId` (on `inbound_claim`) come from `ctx`, which openclaw populates from the transport adapter (Telegram bot account ID, Discord workspace ID, etc.). In normal openclaw operation `ctx.accountId` is set by the gateway from a verified source, but for transports that surface webhook-claimed identity (e.g. Telegram channels where the bot account is fixed but the conversation-thread parent can be claimed by message metadata), the value can be partially attacker-influenced.

These fields land in `metadata` only — never in `description` — and the metadata column is stored verbatim (no SQL injection risk; parameterized binding at `audit-store.ts:180-187`). The risk is purely on the downstream consumer: an operator querying audit metadata with naive string concatenation would inherit whatever the sender stuffed into `accountId`. Same story as the prior review's `senderId`/`messageId`/`threadId` finding — these new fields just extend the same surface.

The metadata-cap mitigation now bounds the impact of an oversized hostile value (the row gets truncated and recorded with the marker rather than dropped), so this is L, not M.

Mitigation: not blocking for this PR. If a future PR adds value-side scrubbing for high-entropy inline secrets in metadata (per the prior review's "out-of-scope but noted"), include `accountId` / `parentConversationId` in the scrub set.

### [L] No rate limit on `system.install_hook_unavailable` itself

The catch block at `src/hooks.ts:776-788` fires once per `registerHooks` call (because `api.on("before_install", ...)` is called exactly once and either succeeds or throws once). In the current openclaw lifecycle that means once per plugin load, which is once per process — so a single stuck audit row, not a flood.

But: an operator who has gateway-level config control could trigger `registerHooks` repeatedly (config reload → plugin reinit) on a runtime that throws on `before_install`. Each reload would record one new `system.install_hook_unavailable` row. Since the event is in `FULL_FIDELITY_CATEGORIES` (`src/rate-limiter.ts:11`), it bypasses coalescing. There's no per-event-type dedup.

Practical impact: very low. An attacker who can already reload plugin config can also trigger every other `register*` call and flood the audit DB any number of other ways. The threat model assumes config-write access is operator-only.

Mitigation: not blocking. If openclaw ever exposes plugin reload as a sender-influenced operation, add a process-scope `installHookUnavailableRecorded` flag analogous to `conversationAccessWarned` to make this strictly one-shot per process.

## What's done well

- **`safeDesc` is comprehensive.** Every description template that touches a non-static value now goes through it, including ones from the prior review that weren't called out as injection risks (e.g. subagent outcomes, gateway shutdown reasons). This is the right "blanket fix" for log injection across the codebase.

- **Truncate-and-record fixes the audit-evasion finding correctly.** The replacement payload is constructed from primitives only, so it cannot recursively fail to serialize or exceed the cap. `originalSize` is bounded by the integer encoder. Both error paths (non-serializable + size-cap) are symmetric and tested.

- **Catch path correctness.** `safeAppend` is a closure capturing `limiter`/`store`/`redactContent`/`redactToolArgs`, and the catch is inside `registerHooks`, so all are in scope. `safeDesc` is module-scope, so it is also defined. The category `"system"` ensures the row bypasses rate-limiter coalescing. The e2e test at `test/e2e.test.ts:1265-1323` proves the row actually lands.

- **Module-scope warning state is documented.** The comment at `hooks.ts:69-74` explains the trade-off. Future maintainers can see the choice was deliberate.

- **Test coverage is strong.** New tests at `test/hooks.test.ts:895-917` (description sanitization with embedded `\n`/`\r`), `test/store/audit-store.test.ts:96-122` (truncate-and-record for both branches), and `test/e2e.test.ts:1265-1359` (registration-failure audit row + oversized-metadata via the install path) all verify the security-relevant behavior end-to-end, not just unit-level.

- **README CLI example is correct.** `$HOME` expands inside double quotes; the JSON form keeps `~/` because `AuditStore` resolves it at runtime.

## Out-of-scope but noted

- The `MAX_CONTENT_SIZE` path at `src/store/audit-store.ts:283-288` still **silently strips content without writing a marker** (it logs to stderr but records the row with `content_gz = null`). For consistency with the new metadata behavior, content stripping should also leave a `contentDropped: true` marker in metadata. Not a regression on this branch — preexisting.

- The marker payload's collision risk (new finding [L] above) applies symmetrically to the existing prior-review out-of-scope item about `truncated: true` markers on content. If a future PR introduces content-side markers, namespace both under the same reserved key (e.g. `$auditTruncation`) so a single matcher can detect either kind.

- `safeDesc` clamps to 256 chars with a `…` suffix. For a forensic log this is short; a future PR could lift the limit (the existing schema column is unbounded `TEXT`) since the metadata-side preservation is the real audit signal. Not a security issue, but the 256 cap is essentially arbitrary.

- The peer-dep range note from the prior review (`>=2026.4.1` should be `>=2026.4.24`) is not addressed on this branch. Carry forward.
