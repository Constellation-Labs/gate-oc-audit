# Security review (round 3) — fix/audit-listener-review-followups

## Summary

Round 3 verifies all H/M-level mitigations are in place and that the working-tree peer-dep bump (`>=2026.4.15` → `>=2026.4.24`) closes the round-1/round-2 "out-of-scope" carry-forward without introducing a regression. Specifically:

- The truncation-marker payload is now nested under the reserved key `$auditTruncation` (`src/store/audit-store.ts:269, 280`), which directly resolves the round-2 [L] "structurally indistinguishable from a real event" concern.
- A defensive recheck (`audit-store.ts:289-293`) re-asserts the cap on the marker payload itself, closing the silent re-opening of size-evasion if a future contributor adds a sender-controlled field to the marker.
- The persisted and returned `metadata` are now the same object (`audit-store.ts:336`), so SMT raw-hash verification passes for truncated rows. The e2e test at `test/e2e.test.ts:1330-1371` proves it.
- The peer-dep floor bump in the working tree (`package.json:40`, `README.md:11`, `src/hooks.ts:99, 740`) is consistent across the three files. The runtime no longer needs the warn-and-skip fallback path on supported runtimes; `before_install` exists in `>=2026.4.15` (per the comment at `src/hooks.ts:739-747`) which is a strict subset of the new floor.

The remaining residual concerns are L-level: a small set of fields the plugin records into description templates can carry C1 control bytes (`\x80-\x9F`), which `safeDesc()` does not strip; a build/runtime version skew between `peerDependencies.openclaw >=2026.4.24` and the locally-installed `openclaw@2026.4.1` in `node_modules`; and the test-only `_resetConversationAccessWarningStateForTests` is exported from `src/hooks.ts` (not re-exported by `src/index.ts`), which is a minor surface-area expansion.

No High-severity findings. No new injection, deserialization, secret-leakage, or audit-evasion regressions introduced by `5d3065f` or `e8138fb` (`3396d40` in this checkout — the squash is identical).

## Prior-finding verification

### Round 1 (carried into round 2)

- **[M] Sender-controlled fields evade audit via 1 MB metadata cap** — **Resolved.**
  `src/store/audit-store.ts:273-283` now records a marker row instead of `return undefined`. `originalSize` records the canonicalized length so a reviewer can see the magnitude without preserving the hostile payload. The marker is bounded — see new finding [L] sanity check below.

- **[M] `before_install` registration miss recorded as audit row** — **Resolved.**
  `src/hooks.ts:794-806`. The catch is inside `registerHooks` so `safeAppend`, `limiter`, `store`, `redactContent`, `redactToolArgs` are all in lexical scope, and `safeDesc` is module-scope. New event type `system.install_hook_unavailable` is in the union (`src/types/events.ts:52`). Category `"system"` is in `FULL_FIDELITY_CATEGORIES` (`src/rate-limiter.ts:12`), so coalescing cannot drop the row. e2e at `test/e2e.test.ts:1265-1323` proves the row lands.

- **[L] Description log/UI injection** — **Resolved (over-resolved, in fact).**
  `safeDesc()` (`src/hooks.ts:139-143`) is applied at every interpolation site (28 templates verified at lines 192, 243, 272, 287, 300, 320, 339, 365, 396, 426, 456, 481, 514, 578, 597, 616-617, 642, 660, 679, 699, 732, 769, 803). The regex was tightened beyond the round-2 review's recipe — `CONTROL_CHARS` (`hooks.ts:138`) now also strips U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), so a JS-aware attacker cannot emit a literal newline via JSON's ` ` either. C0+DEL are still covered. Length cap remains 256 with `…` suffix.

- **[L] Manifest `onCapabilities: ["hook", "tool"]`** — **Not addressed.**
  `openclaw.plugin.json:8` is unchanged. The plugin still declares `"tool"` despite registering no tools. Carry forward; not a regression on this branch.

- **[L] `CONVERSATION_ACCESS_WARNING` fingerprinting** — **Not addressed (intentional).**
  `src/hooks.ts:86-92` is unchanged. Still references the literal config key. Low impact; flagged for awareness.

- **[L] README CLI examples use unquoted `~`** — **Resolved.**
  `README.md:47` uses `"$HOME/.openclaw/audit.db"`. The JSON example at `README.md:61` retains `"~/.openclaw/audit.db"`, which is correct because `AuditStore` resolves `~` itself at `audit-store.ts:168`. Documentation is consistent with runtime.

- **[Out-of-scope, round 1] Peer-dep range `>=2026.4.1` should be `>=2026.4.24`** — **Resolved (uncommitted).**
  Working-tree changes bump `package.json:40` to `>=2026.4.24`, `package.json:52-53` `compat.pluginApi` and `compat.minGatewayVersion` to `>=2026.4.24` and `2026.4.24` respectively, and `README.md:11`. The comment at `src/hooks.ts:99` is also updated. The user on `2026.4.1`-`2026.4.23` will now see a peer-dep mismatch at install time (loud failure) instead of silent loss of `prompt.input`/`prompt.response`/`agent.end` events. **Caveat**: see new finding [L] below — `package.json:55-58` still lists `build.openclawVersion: "2026.4.1"` and `build.pluginSdkVersion: "2026.4.1"`, which is now inconsistent with the peer floor.

### Round 2

- **[L] Truncation marker structurally indistinguishable from a real event** — **Resolved.**
  `src/store/audit-store.ts:269` (non-serializable path) and `audit-store.ts:280` (size-cap path) now nest the marker under `$auditTruncation`. The reserved-key shape is documented in the comment at `audit-store.ts:258-262` and exercised by tests at `test/store/audit-store.test.ts:108, 130` and `test/e2e.test.ts:1353-1357`. A real plugin that picks `metadataDropped` as a field name can no longer be confused with the marker; the chosen `$`-prefixed key avoids JS identifier-name collisions and is unlikely to appear in MongoDB-shaped or JSONLogic-shaped payloads.

- **[L] Module-scope `llmInputObserved`/`conversationAccessWarned` test bleed-over** — **Resolved.**
  `src/hooks.ts:81-84` exports `_resetConversationAccessWarningStateForTests()`, used by `test/hooks.test.ts:153` (`beforeEach`). The reset clears both flags. Three new tests at `test/hooks.test.ts:190-256` confirm fire-once-per-process semantics. The export is from `src/hooks.ts`, not re-exported by `src/index.ts` (verified — `index.ts:3, 150, 169` only import `registerHooks`), so the package-public surface is unchanged. See new finding [L] below for the residual concern.

- **[L] `accountId` and `parentConversationId` are sender-controlled but not redacted** — **Not addressed (acknowledged in round 2).**
  Still recorded verbatim in metadata (`src/hooks.ts:371, 401, 431, 462`). Stored via parameterized binding so no SQL/path injection risk. Carry forward for the future "value-side scrub for high-entropy substrings" PR.

- **[L] No rate limit on `system.install_hook_unavailable`** — **Not addressed (acknowledged in round 2).**
  Still emitted unconditionally on each catch. Same threat-model assumption: operator-only config-write access. Carry forward.

## New findings

### [L] `safeDesc()` does not strip C1 control bytes (`\x80-\x9F`) (`src/hooks.ts:138`)

`CONTROL_CHARS = /[\x00-\x1F\x7F  ]/g` strips C0 (`\x00-\x1F`), DEL (`\x7F`), and the two JS-line-terminator code points. It does not strip C1 controls (`\x80-\x9F`), which include:

- `\x9B` (CSI — Control Sequence Introducer, single-byte form)
- `\x9D` (OSC — Operating System Command, single-byte form)
- `\x84` (IND — Index)
- `\x85` (NEL — Next Line; ECMA-48 line terminator)

Modern xterm and most VT-aware terminals recognize **8-bit C1** sequences in addition to the 7-bit `ESC [` / `ESC ]` forms. After `safeDesc()` strips `\x1B`, an attacker who supplies a description containing a literal `\x9B` byte plus a CSI payload (e.g. `\x9B2J` to clear screen, `\x9B?25l` to hide cursor) emits a working terminal escape sequence when the audit log is `cat`'d. NEL (`\x85`) is also a line-terminator under ECMA-48, so a hostile sender could split a line in C1-aware viewers.

Practical impact:
- Most modern operator setups use UTF-8 terminals and parse only 7-bit CSI, where `\x9B` is treated as a stray byte (often shown as `?` or stripped). On those, no exploit.
- Older terminal emulators (`mlterm`, some VT220-faithful emulators) and some `less`/`more` configurations *do* honor 8-bit C1. The audit log piped through such a viewer is vulnerable.

Mitigation: extend the regex to `[\x00-\x1F\x7F-\x9F  ]`. This costs nothing in legitimate Unicode coverage (printable starts at U+00A0, NBSP) and closes the C1 hole. Affects `src/hooks.ts:138`; one-line change. Tests at `test/hooks.test.ts:970-994` should be extended with a `\x9B`/`\x85` case to lock in the behavior.

### [L] `package.json` `build.openclawVersion`/`pluginSdkVersion` inconsistent with bumped peer floor (`package.json:55-58`)

The working-tree edit bumps `peerDependencies.openclaw` and `compat.{pluginApi,minGatewayVersion}` to `>=2026.4.24`, but `build.openclawVersion: "2026.4.1"` and `build.pluginSdkVersion: "2026.4.1"` are unchanged. These fields document the openclaw version the plugin was *built against*. Consequences:

1. **Forensic provenance**: an operator inspecting the plugin's manifest sees a peer floor of `2026.4.24` but a build target of `2026.4.1`. If openclaw 2026.4.24 introduced a binary-compatibility-breaking SDK change between `2026.4.1` and `2026.4.24` (e.g. `before_install` event shape), the plugin would install (peer satisfied) but read `undefined` from new fields.

2. **Currently no exploit**: the code in `src/hooks.ts:756-789` casts `evt` as `Record<string, unknown>` and reads each field defensively (`?? "unknown"`), and `audit-store.ts:266-271` catches non-serializable metadata. A field-shape mismatch produces a row with `undefined` for the affected fields, not a crash. So this is a documentation-correctness L, not a runtime-security M — but for an audit plugin whose forensic signal *is* the row contents, recording an event with `targetName: undefined` because we read against the wrong SDK shape would be misleading.

3. **Locally-installed package mismatch**: `node_modules/openclaw/package.json` reports `version: 2026.4.1` (verified). Tests in this checkout run against the older SDK. CI on a build that resolves `openclaw@>=2026.4.24` may surface different behavior — but no hook in this branch actually depends on a `2026.4.24`-only field, so this is observational only.

Mitigation: bump `build.openclawVersion` and `build.pluginSdkVersion` to `2026.4.24` (or whatever runtime the plugin is actually compiled against), and `npm install` to refresh `node_modules` before merging. If the plugin truly is build-compatible with `2026.4.1`'s SDK, drop the peer floor. The two should agree.

### [L] `_resetConversationAccessWarningStateForTests` is exported from a non-test file (`src/hooks.ts:81-84`)

The function is exported from `src/hooks.ts` (not from a test-helpers file) and not re-exported by `src/index.ts`, so the package-public main entry is unaffected. However, anyone importing `@constellation-network/openclaw-audit-plugin/dist/hooks.js` directly (a brittle path, but possible — `package.json:48-50` lists `./dist/index.js` as the openclaw extension entry, but `dist/hooks.js` is shipped alongside) can call `_reset...` and clear the fire-once warning.

Practical impact:
- The warning is the only mechanism by which the plugin tells the operator "your conversation-access opt-in is missing." A misbehaving sibling plugin that calls `_reset...` on every tool invocation would re-arm the warning, then immediately suppress it when the next `before_tool_call` arrives — but the operator would just see the warning once at process start regardless, so the only observable harm is an extra console line.
- The leading underscore + `ForTests` suffix is a convention, not enforcement. ESM has no runtime "test-only" gate. If the test rig and the plugin shipped from the same `dist/`, a malicious sibling with `import { _reset... } from "...dist/hooks.js"` could cycle the flag.

Mitigation (optional): move the reset into a dedicated `src/hooks-test-only.ts` module that's omitted from the build (`tsconfig.json` `exclude`), or guard with `if (process.env.NODE_ENV !== "test") return;`. Lowest-cost: add a comment-only "do not import outside tests" warning at `hooks.ts:78-80` (already partially present). The current code already has a comment but no enforcement.

### [L] Truncation marker `originalSize` may itself disclose information (`src/store/audit-store.ts:280`)

The marker payload includes `originalSize: <canonicalized length of offending input>`. This is intentional and useful for forensics. But:

- For a sender-controlled field (e.g. `requestedSpecifier`), `originalSize` reveals the precise byte length of the hostile payload to anyone with read access to the audit DB. If the legitimate `requestedSpecifier` field for a real package is bounded (npm package names + version are well below 1 MB), and the hostile payload is, say, exactly 2,097,152 bytes, the size discloses the attacker's amplification factor — a cheap signal of intent.

- If multiple truncation events accumulate from the same attacker, a defender can trivially distinguish runs by `originalSize` (telemetry + correlation). That's a defender win, not a leak.

So this is mostly an awareness note. The real ask, if the size disclosure ever matters, is to bucket it: `originalSize: "exceeds-cap"` or `originalSize: 2 ** Math.ceil(Math.log2(actual))`. Not blocking.

## What's done well

- **Reserved-key marker shape.** `$auditTruncation` (`src/store/audit-store.ts:269, 280`) is a defensible namespace choice: the `$` prefix is unlikely to collide with any legitimate JS identifier-shaped key, doesn't conflict with MongoDB/JSONLogic operators (whose `$`-prefixed keys are top-level, not nested under `$auditTruncation`), and is documented inline at `audit-store.ts:258-262`. Tests pin the contract (`test/store/audit-store.test.ts:108, 130`; `test/e2e.test.ts:1354`).

- **Defensive recheck.** `audit-store.ts:289-293` re-asserts `metadataCanonical.length <= MAX_METADATA_SIZE` *after* the marker is built. The thrown error is caught by the outer `try` at line 248, which marks the store degraded and logs. This closes the latent re-opening of the round-1 vector by a future contributor adding a sender-controlled field to the marker payload.

- **Persisted/returned metadata identity.** `audit-store.ts:336` returns `effectiveMetadata` (the same object that was canonicalized into the row) rather than `insert.metadata`. Verified by the regression-guard test at `test/store/audit-store.test.ts:103-110` and the SMT proof check at `test/e2e.test.ts:1365-1370`. This was a real round-2 correctness bug; round 3 can confirm the fix is stable.

- **C1 was almost-but-not-quite the right scope for `safeDesc`.** Adding ` `/` ` (round-2 → round-3 delta) shows attention to JS-specific log-injection vectors. The C1 omission is the only remaining gap — fixable in a one-line regex change.

- **Peer-dep floor bump is consistent across surfaces.** `package.json:40`, `package.json:52-53`, `README.md:11`, and the comment at `src/hooks.ts:99` all agree on `>=2026.4.24`. Round 1's "out-of-scope" peer-floor concern is now closed.

- **Test coverage is dense for the security-relevant paths.** `test/store/audit-store.test.ts:96-136` covers both marker branches and the persisted-vs-returned identity. `test/e2e.test.ts:1265-1323` proves the registration-miss audit row. `test/e2e.test.ts:1325-1371` proves SMT proof validity for truncated rows. `test/hooks.test.ts:970-994` proves description sanitization end-to-end (for newline/CR; missing C1, see new finding).

- **Catch-and-record is symmetric.** Both error paths (`audit-store.ts:255-263` non-serializable and `audit-store.ts:268-283` size-cap) emit a marker row, and the marker payload is bounded to ≤ ~80 bytes — verified by the literal construction from primitives only.

## Out-of-scope but noted

- The `MAX_CONTENT_SIZE` path (`src/store/audit-store.ts:298-303`) still records the row but with `content_gz = null` and only logs to stderr. It does not write a `$auditTruncation` marker. For symmetry with the metadata path, content stripping should also leave a marker (e.g. `metadata.$auditContentTruncation = { reason: "size-cap", originalSize: n }`). Not a regression on this branch — preexisting from round 1.

- Round 2's "out-of-scope" carry-forwards remain open: (a) `accountId`/`parentConversationId` value-side scrub for high-entropy secrets, (b) per-event-type dedup on `system.install_hook_unavailable` if openclaw ever exposes plugin reload as sender-influenced, (c) `safeDesc`'s 256-char clamp is arbitrary for a forensic log, (d) `before_install`'s `findings` array is discarded — only counters are kept.

- The plugin's existing `sanitize()` redactor (`src/hooks.ts:31-47`) is still key-name-only. A sender-controlled value containing an inline JWT/API key remains stored verbatim in metadata. Round 1 noted this; nothing in this round changes the calculus.

- `openclaw.plugin.json:8` still declares `"tool"` in `onCapabilities`. The plugin registers no tools (`src/index.ts:150, 169` only call `registerHooks`). Round 1 flagged this; carry forward.

- `node_modules/openclaw/package.json` reports `version: 2026.4.1`, mismatched from the new peer floor `>=2026.4.24`. Run `npm install` against an updated lockfile or registry that has 2026.4.24 published before merging, so CI exercises the actual peer floor and not the floor-minus-23-patches dev environment.
