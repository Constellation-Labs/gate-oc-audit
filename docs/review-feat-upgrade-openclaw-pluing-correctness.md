# Correctness review — feat/upgrade-openclaw-pluing

## Summary
The branch correctly captures the new openclaw 2026.4.x correlation fields and the `before_install` hook, with broad test coverage. Two real bugs stand out: spurious `conversationAccessWarned` firing across re-registered API instances, and a `peerDependencies` floor (`>=2026.4.1`) that does not match the actual minimum required by the new conversation-access opt-in (2026.4.24), which means valid peer-dep installs will still drop `llm_input/llm_output/agent_end`. A handful of smaller correctness nits (return value of `registerHooks` is never captured at the call site, `session_end` description mishandles `reason === ""`, missing `accountId` on `message_sending`, missing `parentConversationId` on `inbound_claim`).

## Findings

### [M] `registerHooks` return value is never captured — `HookActivity` API is dead (`src/index.ts:148`, `src/index.ts:167`)

Both call sites discard the return value:
```ts
registerHooks(api, store, limiter, config);   // index.ts:167
registerHooks(api, _store, _limiter, config); // index.ts:148
```
The only consumer of `HookActivity` is the closure inside `hooks.ts` itself (the `before_tool_call` handler reads `activity.llmInputObserved`). That works, but the public return type is then misleading — externally, no caller gets to inspect activity, so the warning state is fully encapsulated inside the closure. Either:
- drop the return type back to `void` and document it as "internal closure state only", or
- have `index.ts` capture the activity object so retention or a service can inspect it later (e.g. emit a single audit event when the warning fires).

The current shape is harmless functionally but signals an unfinished refactor: a tracker designed to be observable from outside the function is in fact unreachable from outside.

### [H] Re-registration creates a fresh `activity` closure on `api2`; ordering across api instances can spuriously warn (`src/hooks.ts:95-96`, `src/index.ts:148`)

`registerHooks` is invoked on every new api instance (intentional — see the comment at `index.ts:144-145`). Each call creates:
```ts
const activity: HookActivity = { llmInputObserved: false, toolCallObserved: false };
let conversationAccessWarned = false;
```
Each api instance has its own closure. The user's question 1 worry plays out concretely: if openclaw fires `llm_input` on `api1` and `before_tool_call` on `api2` (or in any order where the first hook to fire on `api2` is `before_tool_call`), `api2`'s `activity.llmInputObserved` is still `false` and the warning fires even though conversation access IS working — it's just that this api instance happened to receive the tool hook first.

The warning text claims openclaw "silently dropped the llm_input/llm_output/agent_end hook registrations". On the second registration that's almost certainly wrong (the first registration already proved the hook works). Two clean fixes:
- Hoist `activity` and `conversationAccessWarned` to module-scope (they don't actually need per-api isolation since the warning is a global one-shot operator-config diagnostic).
- Or, since `index.ts:146` already gates re-registration on `_registered`, only attach the warning logic on the FIRST call.

The current code is also subtly worse than the comment implies: even on a single api instance, hook firing order between `llm_input` and `before_tool_call` is not guaranteed by openclaw (priorities are 200 for both — same bucket). If a tool call happens during the very first turn before `llm_input` fires (e.g. some prefetch or autonomous agent path), the warning fires on a correctly configured system.

### [H] `peerDependencies.openclaw: ">=2026.4.1"` is below the version that actually exposes `before_install` and `allowConversationAccess` (`package.json:40`, `README.md` "Required openclaw config")

The README explicitly states the conversation-access opt-in landed in `2026.4.24` and `before_install` is "openclaw >= 2026.4 only" (per `src/hooks.ts:674`). The installed `node_modules/openclaw` is 2026.4.1, and `node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1583` confirms `before_install` is NOT in `PluginHookName` for that version. Yet the peer floor is `>=2026.4.1`.

Practical consequence: an operator on the floor version (2026.4.1) installs the plugin, sees no peer-dep complaint, and gets:
1. `before_install` registration silently dropped by openclaw with an "unknown typed hook" warning.
2. `llm_input`/`llm_output`/`agent_end` silently dropped because `allowConversationAccess` doesn't exist as a config key in 2026.4.1. The plugin's spurious-warning logic at `hooks.ts:202-205` will fire on every tool call but blame an opt-in the user can't grant.

Bump the peer floor to `>=2026.4.24` to match what the README and the new code actually require. Alternatively, gate the `allowConversationAccess` warning behind a runtime check that the operator's openclaw version supports the opt-in.

Note: `package.json:52` also has a separate `openclaw.compat.pluginApi: ">=2026.1.0"` and `openclaw.compat.minGatewayVersion: "2026.1.0"` which are even lower — same fix applies.

### [M] `session_end` description mishandles falsy non-undefined `reason` (`src/hooks.ts:551`)

```ts
description: e.reason
  ? `Session ended (${e.reason}): ${evt.sessionId}`
  : `Session ended: ${evt.sessionId}`,
```
If openclaw ever emits `reason: ""` the ternary falls through to "Session ended: ...". For `null` or `undefined` that's correct; for `""` it's a silent loss of info, but since `""` would render badly anyway (`Session ended (): ...`), the ternary is arguably defensible. The user's question called out `"unknown"` — that's truthy, so the parenthesized branch fires correctly there.

The real risk is the opposite: if openclaw later types `reason` as a `PluginHookSessionEndReason` union that includes `null` or omits it from the type altogether, the ternary still works. Suggestion is **L** unless the openclaw spec actually permits `""`. I rate this **M** only because the metadata field stores the raw value either way, so the description string is the only victim. Leave as-is or switch to `e.reason != null && e.reason !== ""`.

### [L] Order of operations on tool denial: `activity.toolCallObserved` is set before `safeAppend`, which is fine (`src/hooks.ts:201-216`)

`safeAppend` swallows its own errors (`hooks.ts:112-115`), so the question of "is `toolCallObserved` left dirty if append throws?" is moot — append cannot throw out of the handler. Even if it did, `toolCallObserved=true` reflects reality (the tool call DID happen, the audit write is what failed). The warning logic only uses `llmInputObserved`, not `toolCallObserved`, so dirty state has no observable effect. No action needed.

### [M] `before_install` outer try/catch is redundant for handler errors but legitimate for registration errors (`src/hooks.ts:678-727`)

The catch wraps the SYNCHRONOUS `api.on("before_install", ...)` registration call. If `api.on` throws synchronously when given an unknown hook name (which is what older openclaw runtimes do per the comment), the catch correctly swallows the registration failure. If the hook IS registered and a future invocation throws inside the handler, this catch is NOT in the call stack — only `safeAppend`'s internal try/catch (`hooks.ts:112-115`) protects against handler errors.

So the catch is doing exactly one thing: tolerating the version-skew case where `api.on` rejects unknown hook names. Verifying by grepping the openclaw 2026.4.1 types confirms `before_install` is absent from `PluginHookName` (`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1583`). However, in practice openclaw 2026.4.1 does NOT throw on unknown hooks — it logs a warning and ignores the registration (per the comment at `hooks.ts:675-677`). So the catch is largely defensive against hypothetical future runtimes that do throw. It's not redundant in a strictly-correct sense, just rarely exercised. Acceptable, but a comment clarifying "intended for runtimes that throw on unknown hooks; older runtimes that warn-and-ignore reach this code path successfully" would be clearer.

Minor: the outer `(api.on as unknown as ...)` cast loses type-checking on the handler signature. If openclaw later renames `before_install` to `pre_install`, TypeScript will not catch it. Same fragility risk as item below.

### [M] `message_sending` omits `accountId` (`src/hooks.ts:358-383` vs `297-326` and `328-356`)

`message_received` captures `accountId: ctx.accountId`, `message_sent` captures `accountId: ctx.accountId`, but `message_sending` does not. Per `node_modules/openclaw/.../types.d.ts:1697-1701`, `PluginHookMessageContext` includes `accountId` on all three message hooks — so the field is available on `message_sending`'s ctx too. The omission is almost certainly an oversight. Add `accountId: ctx.accountId` for consistency with the sibling handlers.

### [M] `inbound_claim` does not capture `parentConversationId` (`src/hooks.ts:385-409`)

The openclaw type (`types.d.ts:1702-1706`) defines `PluginHookInboundClaimContext = PluginHookMessageContext & { parentConversationId?: string; senderId?: string; messageId?: string }`. The handler captures `senderId` (from `evt`) and adds `messageId` from the cast extension, but `parentConversationId` is in the official type and is not captured. For thread-bound conversations this is the only signal that links a claim to its parent thread.

Add `parentConversationId: ctx.parentConversationId` to the metadata. While at it, `messageId` is on the OFFICIAL ctx type for `inbound_claim` — the cast at `hooks.ts:388` could be tightened by reading from `ctx` (which is `PluginHookInboundClaimContext`) instead of the loose `evt` cast.

Sub-finding (L): `sessionId: ctx.conversationId` is intentional per the prior convention. That's defensible — the audit author noted that switching to `sessionKey` would fragment historical chains. But it's worth documenting in the code, not just in the conversation history; otherwise a future contributor will "fix" it.

### [M] Cast safety: `(ctx as { jobId?: string }).jobId` etc. silently breaks under field renames (`src/hooks.ts:139, 164, 188, 301-302, 332-333, 362-363, 388-389, 479, 497, 513, 540`)

`(ctx as { jobId?: string })` is a structural cast that always succeeds at compile time. If openclaw renames `jobId` → `cronJobId`, TypeScript will not flag it; the field will quietly read `undefined` at runtime and the audit metadata will silently lose the value with no test failure (the unit tests pass synthetic ctx objects with whatever fields the test expects, so they don't catch a real mismatch).

The repo's existing pattern is `as any` (`src/index.ts:183-185, 327, 370`) and `satisfies X as any` (`src/index.ts:284, 378`) — both equally lossy. The new `as typeof ctx & { ... }` pattern is somewhat better than `as any` because it's additive (the existing context fields stay typed), but it still allows the cast extension to lie about field names that don't exist. There is no project-wide pattern of declaring a single narrow `ExtraCtx2026_4` type and importing it.

Suggested mitigation: define a single module-local interface `Openclaw2026_4Extensions` that lists every "new" field with its expected type. Then cast `(ctx as PluginHookAgentContext & Openclaw2026_4Extensions)` once per handler. When openclaw 2026.4 fields land in the official types, you can delete the extensions one-by-one and TypeScript will tell you which casts are now redundant. Without this, each new audit field is a typo away from being silently `undefined`.

This is **M** because the field exposure tests in `test/hooks.test.ts:251-262, 459-470, 507-516, 610-620, 640-650` only assert that the ctx values you put in come back out — they don't catch a typo where the handler reads `c.modelProviderID` instead of `c.modelProviderId`. Verified manually that all four agent_end fields use the correct camelCase: `runId`, `jobId`, `modelProviderId`, `modelId`. Test coverage would catch a swap (e.g. `c.modelId` written into `modelProviderId` slot) only if the test asserts both fields with DIFFERENT values — which `test/hooks.test.ts:254` does (`modelProviderId: "anthropic"`, `modelId: "claude-opus-4-7"`), so a swap there would be caught. Same is true in `test/e2e.test.ts:1073-1075`. Good.

### [L] e2e ALL_HOOKS guard substring match is fragile but acceptable (`test/e2e.test.ts:1283-1290`)

```ts
src.includes(`fire(rig.api, "${hook}"`)
```
Misses if a future test uses `fire(rig.api,"<hook>"` (no space) or `fire(api, ...)` against a different rig variable, or wraps `fire` in a helper. The current file uses the canonical form 64 times consistently, so today the guard works. Risk is forward-looking only. A regex on `fire\([^,]+,\s*"<hook>"` would harden it slightly. Leave as-is for now; it's a guard-test, not production code.

### [L] Manifest activation: `onCapabilities: ["hook", "tool"]` covers tool registrations (`openclaw.plugin.json:6-9`)

`onCommands: ["audit"]` matches the top-level CLI command. The two agent-callable tools `audit_de_setup` and `audit_smt` are registered via `api.registerTool` and are discovered through `onCapabilities: ["tool"]`, not via command activation. So no separate activation hint is needed.

The README does not document a `system_install` capability, but the plugin's hook subscription IS the activation trigger via `onCapabilities: ["hook"]`. Looks correct.

### [L] `conversationAccessWarned` resets on re-registration — closure scope is the wrong place (`src/hooks.ts:96`)

This is the same root cause as the [H] above. If you fix [H] by moving `activity` to module scope, also move `conversationAccessWarned` so the one-shot warning truly fires once per process, not once per api instance.

### [L] `system.install` test on SMT proof — check is correct (`test/e2e.test.ts:1252-1262`)

The test verifies that censored hashes for `system.install` events produce valid proofs against known roots — confirming the new event type doesn't break SMT semantics. No bug, just noting test quality is good here.

## What's done well

- Test coverage of the new fields is genuinely thorough — `test/hooks.test.ts:251-262` and `test/e2e.test.ts:1062-1127` would catch a swap or omission of `modelProviderId`/`modelId` (different string values mean a swap fails the assertion).
- `safeAppend`'s internal try/catch is correctly preserved; the new before_install registration error handling is layered on top and does not regress.
- The redaction tests (`test/e2e.test.ts:564-627`) prove that adding `system.install` does not break SMT proof verification end-to-end.
- The "all hooks exercised" guard test at `test/e2e.test.ts:1265-1291` is a smart fail-loud signal for future hook additions, even if the substring check is slightly fragile.
- The `before_install` cast at `hooks.ts:679-683` cleanly captures every nested optional field (request, plugin, skill, scan) without using `as any`.
- The before_install handler intentionally omits `sessionId` (lines 696-720), which is correct — install events are session-less and naturally fall under the global/system audit category.
