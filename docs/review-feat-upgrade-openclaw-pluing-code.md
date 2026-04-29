# Code-quality review — feat/upgrade-openclaw-pluing

## Summary
Solid, narrowly-scoped change; the listener correctly tracks the SDK's drift and the new fields/manifest hints are tested. Two real issues stand out: a public return value (`HookActivity`) that no caller reads, and the proliferation of inline `(evt as typeof evt & {...})` casts that would benefit from a couple of named type aliases. Everything else is nit-level.

## Findings

### [M] `HookActivity` is exported and returned but no caller consumes it (`src/hooks.ts:74-77,92,729`)
`registerHooks` was changed from `void` to `HookActivity` and the interface was added to the public API surface, but nothing reads the return value:

- `src/index.ts:148,167` ignores the return.
- `test/harness.ts:85` and every `test/hooks.test.ts` / `test/e2e.test.ts` call ignores it.

The warning logic that needs the activity flags lives entirely inside `registerHooks` (the closure over `activity` and `conversationAccessWarned` at lines 95-96, 201-205, 276). Since the warning fires from `before_tool_call` itself, returning the flags adds no value.

Suggested fix: keep the closure-local `activity` object as a private bookkeeping struct, drop the `HookActivity` export, and revert the signature to `void`. If a future caller does need to introspect activity (e.g. a self-check service), promote it then with a real consumer.

### [L] Repeated inline `(evt as typeof evt & {...})` casts could be hoisted (`src/hooks.ts:164,301,302,332,333,362,363,388,389,479,497,513,540`)
The cast pattern is pragmatic given the SDK at the new peer-dep floor (`>=2026.4.1`) hasn't yet declared `jobId`, `modelProviderId`, `threadId`, `messageId`, `senderId`, `replyToId`, `sessionKey`, `runId`, `sessionFile`, `transcriptArchived`, etc. on its event/context types (verified against `node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1589-1779`). So the casts themselves are correct.

What hurts readability is duplication of nearly the same shape across five message-related hooks. Three small module-scope aliases would clean this up and make a future SDK bump (where the casts disappear) a single-file delete:

```ts
// at module scope, near HookActivity
type AgentCtxExtra = { jobId?: string; modelProviderId?: string; modelId?: string; sessionKey?: string; runId?: string };
type MessageEvtExtra = { threadId?: string | number; messageId?: string; senderId?: string; replyToId?: string | number; sessionKey?: string; runId?: string };
type SessionFileEvt = { sessionFile?: string };
```

then `const e = evt as typeof evt & MessageEvtExtra;` etc. Strictly cosmetic — file works as written.

### [L] Hook count comment in README is now load-bearing across files (`README.md:222`, `test/hooks.test.ts:159,162`, `test/index.test.ts:67`)
The phrase "hooks into 26 OpenClaw lifecycle hooks" in the README is now mirrored as a hard-coded `assert.equal(api.hooks.size, 26)` and `api.registeredHooks.length === 26` in two test files. Every future hook addition forces three coordinated edits. The asserts are useful as a guard, but the README count drifts silently. Either drop the count from the README, or have one of the tests assert the README contains the same number (overkill — prefer the former).

### [L] `try/catch` around `before_install` registration is sound, but the comment overshoots (`src/hooks.ts:674-677,724-727`)
The runtime cast `(api.on as unknown as ...)` plus `try/catch` is the right way to register a hook the typed SDK doesn't know about yet — and for a runtime that throws on unknown hook names this is genuinely defensive, not paranoid. (Verified the SDK at the peer-dep floor lacks `before_install` in `PluginHookName` at `node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1583`.)

The comment block claims older runtimes "log an unknown typed hook warning and ignore the registration" — i.e. *don't* throw. If that's true, the `try/catch` only catches the unforeseen case, which is fine, but the comment should say so plainly: "older runtimes silently warn and skip; the catch is a belt-and-braces guard against future runtimes that throw." Otherwise a reader wonders why the catch is needed at all.

### [L] `console.warn` for the conversation-access banner is multi-line and noisy (`src/hooks.ts:79-85,204`)
Five console lines fire once per process on the first `before_tool_call`. The content is correct and useful; the format choice (joined newlines through `console.warn`) renders fine in a TTY but is awkward in JSON-log aggregators (one synthetic timestamp wraps a paragraph). Consider either a single-line warning with a "see README" pointer, or `console.warn` on each line so structured loggers index them sanely. Not a blocker — the README cross-reference is the substance.

### [L] `description` for `cron.executed` is hard-coded; new `jobId` could enrich it (`src/hooks.ts:135`)
Minor: `description: "Cron-triggered agent run started"` is static even though `cron.failed` (line 184) interpolates `evt.error`. Now that `jobId` is captured, including it (`Cron-triggered run started: ${jobId}`) would help log skimmers. Optional polish.

## What's done well

- The new e2e test ("openclaw 2026.4.x correlation fields survive the full pipeline", `test/e2e.test.ts:230-370`) genuinely tests through the listener's `api.on` path rather than re-asserting unit-test invariants — exactly the right unit/e2e split.
- The "every PluginHookName is registered and exercised" guard test (`test/e2e.test.ts:1276`) was updated for `before_install`, so dropping a hook in a future refactor will fail loudly. Same for the `26` count in `test/hooks.test.ts:159` and `test/index.test.ts:67`.
- The README's "Required openclaw config" section (lines 11-37) explains the operator opt-in clearly, gives both CLI and JSON forms, and explicitly notes the plugin can't self-grant. That's exactly the level of honesty operators need to act on a runtime warning.
- The SMT proof-roundtrip assertion at the end of the `before_install` e2e (`test/e2e.test.ts:425-433`) is a good catch — confirms the new event type doesn't break censored-hash inclusion.
- The `(evt as typeof evt & ...)` pattern, while verbose, is type-safe — it preserves the SDK's known fields rather than fully opaque-casting through `as any`. That's the right trade-off for a moving SDK boundary.
- Test coverage for the new fields is thorough: each new metadata field has both a unit test (`test/hooks.test.ts`) and an end-to-end assertion (`test/e2e.test.ts`).
