# Security review — feat/upgrade-openclaw-pluing

## Summary
The 2026.4.x alignment is mostly safe: SQL writes remain parameterized via `node:sqlite` named bindings, and the new metadata fields are scalar identifiers stored inside a JSON-canonicalized blob. The two concrete worries are (a) audit-trail evasion via oversized sender-controlled fields on the new `before_install` path, and (b) the `try/catch` around install-hook registration silently downgrades a registration failure into a console warning rather than a recorded audit event — and recording installs reliably is exactly what this hook is for.

## Findings

### [M] Sender-controlled fields can evade audit recording via the 1 MB metadata cap (`src/store/audit-store.ts:260-265`, applied to new fields in `src/hooks.ts:301-321`, `src/hooks.ts:362-376`, `src/hooks.ts:388-405`, `src/hooks.ts:696-720`)
`AuditStore.append` (`audit-store.ts:260`) drops the entire event if `sdk.canonicalize(metadata).length > MAX_METADATA_SIZE` (1 MB). The new diff persists several fields that originate from event payloads we can't trust:
- `messageId`, `threadId`, `replyToId`, `senderId` on `message_received` / `message_sending` / `message_sent` / `inbound_claim` (all sender-supplied via openclaw transport adapters such as Telegram/Discord webhooks).
- `sessionFile`, `nextSessionId`, `nextSessionKey` on compaction / reset / `session_end`.
- `sourcePath`, `requestedSpecifier`, `targetName` on `before_install`.

Because these go straight into `metadata` without length-clamping, a hostile sender (or a malicious install request crafting a 1 MB+ `requestedSpecifier`) can blow past the cap and cause the event itself to be skipped — i.e. the audit trail loses the very event that would have recorded the abuse. The `before_install` case is the highest-impact one: the whole point of the hook is recording supply-chain events.

The behavior is preexisting, but the new fields multiply the exposure (the previous metadata payloads were almost entirely plugin-controlled). Mitigation: clamp each sender-controlled scalar to a sane upper bound before insertion (e.g. `String(value).slice(0, 4096)` for path/specifier/id-shaped fields), or change the overflow path in `audit-store.ts` to truncate-and-record rather than skip. Recording with a `[truncated]` marker preserves the audit signal.

### [M] `before_install` registration failure is swallowed without an audit-trail signal (`src/hooks.ts:678-727`)
The new install hook is wrapped in `try { (api.on as ...)("before_install", ...) } catch (err) { console.warn(...) }`. The justification (the comment at L675-677) is that older openclaw runtimes log "unknown typed hook" and ignore the call, but the catch is a defensive net for the `throw` path. Three issues:

1. The fallback is `console.warn` only — no `system.install_hook_unavailable` row gets written to the audit DB, so an operator reviewing the SQLite log later cannot tell the difference between "no installs happened" and "we silently couldn't register". For a hook whose purpose is tamper-evident install recording, that's the wrong default.
2. The cast `(api.on as unknown as ...)` deliberately bypasses TypeScript's typed-hook surface. If openclaw renames the hook or changes the event shape between minor releases, registration succeeds but the handler reads `undefined` from every field and emits empty `system.install` rows that look like real installs to a downstream verifier.
3. There's no symmetric "did the handler ever fire?" telemetry analogous to `HookActivity.llmInputObserved` (which exists for the conversation hooks), so an operator on openclaw 2026.3.x has no signal that install auditing is missing.

Mitigation: on catch, append a `safeAppend({ eventType: "system.install_hook_unavailable", category: "system", ... })` row so the registration miss is itself part of the audit log. Optional: extend `HookActivity` with an `installHookRegistered` flag.

### [L] `description` template embeds attacker-controlled `targetName` and `request.mode` without escaping (`src/hooks.ts:699`)
`description: \`Install ${request?.mode ?? "request"}: ${target} ${name}\`` interpolates `evt.targetName` and `request.mode` (both sender-controlled per the openclaw install request) directly into the description column. SQL is safe (parameterized binding), but:
- A hostile install request with `targetName: "x\n[audit-plugin] FAKE: legitimate-pkg installed"` will produce a description that, when piped to a terminal or naive log aggregator, looks like a separate audit-plugin log line. This is classic log/UI-injection.
- The same applies to `description` on `session_end` (`src/hooks.ts:551-553`) using `e.reason`, and indirectly all the `${evt.toolName}` / `${evt.error}` description templates that already existed.

Mitigation: when building `description`, replace `\r`, `\n`, and ASCII control chars with a single space (or `\\n`-encoded escapes) before interpolation, and clamp length. Same recipe applies to existing description sites; the new install row just makes it operator-visible in scenarios where the operator might not have audited tool-name/error fields with the same suspicion.

### [L] Manifest declares `activation.onCapabilities: ["hook", "tool"]` without verified semantics (`openclaw.plugin.json:5-9`)
The diff adds an `activation` block targeting openclaw 2026.4.24+. I could not find any consumer of `onCapabilities` in the openclaw distribution under `node_modules/openclaw/dist` in this checkout (the package.json bumped to `^2026.4.1`, not `2026.4.24`, so the loader code that reads this field isn't shipped here yet). Two implications:

1. We cannot verify from this branch whether `"tool"` is purely a planner/lazy-load hint or whether it grants any permission the plugin doesn't otherwise have. The plugin doesn't actually register any tools (it's a hook-only listener) — declaring `"tool"` as a capability is at best dead code, and at worst grants something we don't need.
2. If 2026.4.24's manifest schema rejects unknown `activation` keys strictly, this could break loading on intermediate versions. (Not a security finding per se, but worth catching during merge.)

Mitigation: confirm against openclaw 2026.4.24 docs that `onCapabilities` is a planner-only hint, and drop `"tool"` from the array since the plugin registers none. If the loader treats `onCapabilities` as a capability grant rather than a hint, this is upgraded to M.

### [L] `CONVERSATION_ACCESS_WARNING` is safe but reveals the exact opt-in path (`src/hooks.ts:79-85`)
The warning string includes the literal config key `plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess`. No secret is leaked — the key is documented in README.md anyway — but the warning fires to `console.warn` on every `before_tool_call` that lacks a preceding `llm_input`. If this plugin runs on a multi-tenant openclaw host whose stderr is shipped to a less-trusted log sink, that sink learns "this tenant has an audit plugin with conversation access disabled," which is a fingerprinting signal. Low impact; flag for awareness only.

### [L] README CLI examples use unquoted-tilde paths inside double quotes (`README.md:47`, `README.md:184`)
`openclaw config set ... config.dbPath "~/.openclaw/audit.db"` — the shell does not tilde-expand `~` inside double quotes, so the literal value `~/.openclaw/audit.db` reaches openclaw's config writer. If openclaw stores it raw and the plugin (or `resolveDbPath`) doesn't expand `~` itself, the DB ends up at a path like `./~/.openclaw/audit.db` relative to cwd — which on a multi-user host could land in an unexpected location with the wrong perms. Not a regression on this branch (the same pattern exists for `deApiKey` / `deWalletKeyFile`), but the new examples extend it. Functional/security fix is to use unquoted `~` or write `$HOME/.openclaw/audit.db`.

## What's done well
- All new metadata is funneled through `safeAppend` → `AuditStore.append`, which uses parameterized named-binding inserts (`audit-store.ts:180-189`). No string-built SQL anywhere on the new path. **No SQL injection risk** from any of the new sender-controlled fields.
- `sdk.canonicalize` is wrapped in a try/catch (`audit-store.ts:253-258`), so an attacker stuffing a non-serializable object (e.g. circular refs constructed via Proxy) into a metadata field cannot crash the listener.
- `HookActivity` + the conversation-access warning is a thoughtful "tell the operator when their config is wrong" pattern. Only fires once (`conversationAccessWarned` guard at L96, L202-204) so it can't be used as a console-flooding amplifier.
- `before_install` event recording is non-decisive (the comment at README:298 confirms "the plugin observes only and never blocks") — the plugin can't be turned into an install gate by malicious config.
- The new e2e tests use placeholder secrets (`deApiKey: "test-key"`, fake DIDs) and write only to mkdtemp'd temp dirs (`createRig` pattern). No real credentials hit disk.

## Out-of-scope but noted
- The 1 MB metadata-cap "skip on overflow" behavior in `audit-store.ts:260` is the wrong default for an audit logger in general — silent skipping erases audit signal under load or under attack. A future PR should change this to truncate-and-record with a `truncated: true` marker. Same applies to `MAX_CONTENT_SIZE`, which currently strips content but keeps the row (better) — make metadata behave the same way.
- The plugin's existing `sanitize()` (`src/hooks.ts:31-47`) only redacts on **key name match** (regex against the property key). It will not redact a sender-controlled VALUE that happens to contain a JWT or API key. If openclaw transports ever start surfacing inbound message content as part of structured `evt.params` to tool calls, an operator with `redactToolArgs: false` (the default) would see secrets-bearing values stored verbatim. Not a regression on this branch, but the assumption "args don't contain inline secrets" is fragile; consider an optional value-side scrub for high-entropy substrings.
- `package.json` bumps the peer-dep range to `openclaw >= 2026.4.1` but the new conversation-access opt-in only exists in `>= 2026.4.24`. A user on `2026.4.1` through `2026.4.23` will silently lose `prompt.input` / `prompt.response` / `agent.end` events and the warning at L80 will fire, but install will succeed. Tighten the peer range to `>= 2026.4.24` to make the failure mode loud.
- The before_install handler stores `evt.builtinScan` summary fields (`scanCritical`, `scanWarn`, `scanInfo`) but discards the `findings` array. For supply-chain forensics, the findings detail (file paths, rule IDs) is what an operator actually wants. Out of scope here, but a follow-up PR could capture `scan.findings` (size-clamped) so a future incident has more than just counters to work from.
