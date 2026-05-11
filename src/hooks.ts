import { createRequire } from "module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AuditStore } from "./store/audit-store.js";
import type { AuditEventInsert } from "./types/events.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { GatewayStopCapture } from "./gateway-stop-capture.js";
import {log} from "./util/logger.js";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
  hashDocument: (content: string | Buffer) => string;
};

const SENSITIVE_KEY =
  /secret|password|token|api.?key|auth|credential|passphrase|jwt|bearer|cookie|private.?key/i;

const AUDIT_PRIORITY = 200;

// Mirrors the gateway DTO's MAX_FIELD_LENGTH cap on userId (see
// swarm-deck/apps/gateway-proxy/src/audit-ingest/types.ts). Truncating here
// keeps every batch publishable even when an operator misconfigures the env.
const USER_ID_MAX_LEN = 1000;

function resolveConfiguredUserId(config: Record<string, unknown>): string | undefined {
  const candidates: Array<{ source: string; raw: unknown }> = [
    { source: "config.userId", raw: config.userId },
    { source: "OPENCLAW_USER_ID env", raw: process.env.OPENCLAW_USER_ID },
    { source: "USER env", raw: process.env.USER },
  ];
  for (const { source, raw } of candidates) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > USER_ID_MAX_LEN) {
      console.warn(
        `[audit-plugin] WARN ${source} value exceeds ${USER_ID_MAX_LEN} chars; truncating. Gateway would otherwise reject every batch on validation.`,
      );
      return trimmed.slice(0, USER_ID_MAX_LEN);
    }
    return trimmed;
  }
  return undefined;
}

// OpenClaw's engine surfaces tool denials/blocks as thrown errors that reach
// us via after_tool_call's `error` field. We can't distinguish denials from
// runtime errors structurally, so we match on the engine's authored phrases.
// Free-form reasons (plugin-supplied blockReason, engine-side loop-detector
// blocks) replace these phrases and will surface as tool.result with the
// error populated, not tool.denied.
const ENGINE_DENIAL_PREFIX =
  /^(Denied by user|Approval (timed out|cancelled|unavailable)|Plugin approval|Tool call blocked)/i;

function isToolDenialError(error: string | undefined): boolean {
  return error !== undefined && ENGINE_DENIAL_PREFIX.test(error);
}

function sanitize(value: unknown, seen = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    sanitized[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitize(v, seen);
  }
  return sanitized;
}

export function sanitizeArgs(params: Record<string, unknown>): Record<string, unknown> {
  return sanitize(params) as Record<string, unknown>;
}

/** Fallback chain for sender identity — `from` is empty on webchat/TUI connections. */
function resolveSender(evt: { from?: string; metadata?: Record<string, unknown> }): string {
  return (
    evt.from ||
    (evt.metadata?.senderId as string | undefined) ||
    (evt.metadata?.senderName as string | undefined) ||
    (evt.metadata?.senderUsername as string | undefined) ||
    "unknown"
  );
}

function resolveRecipient(evt: { to?: string }): string {
  return evt.to || "unknown";
}

/**
 * Process-wide one-shot tracker for the conversation-access operator opt-in
 * diagnostic. Module-scoped (not per-`registerHooks` call) so that openclaw's
 * legitimate re-registration on a fresh api instance doesn't reset the flag
 * and spuriously warn after `llm_input` was already observed on a prior
 * instance. The warning fires at most once per process.
 */
let llmInputObserved = false;
let conversationAccessWarned = false;

// Test-only hook: clear module-scope warning state so unit tests can pin
// fire-once behavior without leaking across test files. Not exported as a
// public API; reset() is intentionally narrow.
export function _resetConversationAccessWarningStateForTests(): void {
  llmInputObserved = false;
  conversationAccessWarned = false;
}


const CONVERSATION_ACCESS_WARNING =
  "tool.invoked observed without any preceding llm_input — " +
  "either (a) openclaw 2026.4.24+ dropped the conversation hook registrations " +
  "because the operator opt-in is missing (set " +
  "plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess=true), " +
  "or (b) the tool was invoked outside a normal LLM turn. See README.md. " +
  "Fires once per process.";

/**
 * Module-scope cast aliases for fields openclaw 2026.4.x added to existing
 * event/context shapes but hasn't yet typed in the SDK we build against.
 * Centralized so that, when the SDK catches up, deletion is a single place.
 * Do NOT add fields here without verifying they exist in the openclaw types
 * the plugin expects to load against (peer floor: `>=2026.4.24`).
 */
type AgentCtxExtra = {
  jobId?: string;
  modelProviderId?: string;
  modelId?: string;
};
type MessageCtxExtra = {
  sessionKey?: string;
  runId?: string;
};
type MessageEvtExtra = {
  threadId?: string | number;
  messageId?: string;
  senderId?: string;
  replyToId?: string | number;
  sessionKey?: string;
  runId?: string;
};
// PluginHookSessionEndEvent is the only session event whose `sessionFile`,
// `reason`, etc. the SDK does not yet type. The compaction/reset events do
// declare `sessionFile`, so we read those directly without a cast.
type SessionEndEvtExtra = {
  sessionFile?: string;
  reason?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
};

/**
 * Sanitize a string before interpolating into an event description. Strips
 * control bytes (which would otherwise let attacker-controlled fields like
 * `targetName` forge log lines, drive 8-bit-CSI-aware terminals, or split
 * rows when piped to a log aggregator) and clamps length so a hostile input
 * can't bloat the description column.
 *
 * Complementary to `sanitize()`, which redacts by key in metadata; this
 * scrubs by value in descriptions.
 */
const DESCRIPTION_MAX = 256;
// Strip C0 (\x00-\x1F), DEL (\x7F), C1 (\x80-\x9F — \x9B is single-byte CSI),
// and the JS line-terminator code points U+2028/U+2029 so attacker-controlled
// fields cannot forge or split log lines or drive a terminal escape.
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;
function safeDesc(value: unknown): string {
  if (value === undefined || value === null) return "";
  const str = String(value).replace(CONTROL_CHARS, " ");
  if (str.length <= DESCRIPTION_MAX) return str;
  // slice() operates on UTF-16 code units. If the cut lands between a
  // surrogate pair, drop the orphan high surrogate so SQLite (UTF-8) doesn't
  // round-trip it as U+FFFD on read-back, which would diverge the in-memory
  // and persisted hashes — the same SMT-vs-DB invariant AuditStore.append
  // protects on the metadata column.
  let end = DESCRIPTION_MAX - 1;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, end) + "…";
}

// Clamp a fully composed description string. `safeDesc` clamps each
// interpolated slot to 256 chars; `safeComposite` clamps the *total* so a
// pathological multi-slot template (e.g. install: mode + target + name) can't
// exceed the column's intended budget.
function safeComposite(value: string): string {
  if (value.length <= DESCRIPTION_MAX) return value;
  let end = DESCRIPTION_MAX - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end) + "…";
}

export function registerHooks(
  api: OpenClawPluginApi,
  store: AuditStore,
  limiter: RateLimiter | undefined,
  config: Record<string, unknown>,
  gatewayStopCapture: GatewayStopCapture,
): void {
  const redactContent = config.redactPromptText === true;
  const redactToolArgs = config.redactToolArgs === true;

  // Resolution order: explicit config > OPENCLAW_USER_ID env > USER env > unset.
  // Stamped on every insert; leaves NULL when nothing resolves. Each candidate
  // is trimmed, skipped when empty, and truncated to USER_ID_MAX_LEN so an
  // oversized value can't quietly trip the gateway DTO's length cap and stall
  // every batch on validation rejection.
  const configuredUserId = resolveConfiguredUserId(config);

  const safeAppend = (insert: AuditEventInsert): void => {
    if (configuredUserId !== undefined && insert.userId === undefined) {
      insert = { ...insert, userId: configuredUserId };
    }
    if (
      redactContent &&
      typeof insert.content === "string" &&
      (insert.category === "prompt" || insert.category === "message")
    ) {
      insert = { ...insert, content: "sha256:" + sdk.hashDocument(insert.content) };
    }
    try {
      if (limiter) {
        limiter.append(insert);
      } else {
        store.append(insert);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(message);
    }
  };

  // --- Model & prompt build ---

  api.on(
    "before_model_resolve",
    (evt, ctx) => {
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "prompt.model_resolve",
        category: "prompt",
        description: "Model resolution requested",
        metadata: { promptLength: evt.prompt?.length, trigger: ctx.trigger },
      });
      if (ctx.trigger === "cron") {
        const c = ctx as typeof ctx & AgentCtxExtra;
        safeAppend({
          sessionId: ctx.sessionId,
          eventType: "cron.executed",
          category: "cron",
          description: c.jobId
            ? `Cron-triggered agent run started: ${safeDesc(c.jobId)}`
            : "Cron-triggered agent run started",
          metadata: {
            agentId: ctx.agentId,
            runId: ctx.runId,
            jobId: c.jobId,
            promptLength: evt.prompt?.length,
          },
        });
      }
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_prompt_build",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "prompt.build",
        category: "prompt",
        description: "Prompt build started",
        metadata: { promptLength: evt.prompt?.length, messageCount: evt.messages?.length },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "agent_end",
    (evt, ctx) => {
      const c = ctx as typeof ctx & AgentCtxExtra;
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.end",
        category: "agent",
        description: "Agent run ended",
        metadata: {
          durationMs: evt.durationMs,
          success: evt.success,
          runId: ctx.runId,
          jobId: c.jobId,
          modelProviderId: c.modelProviderId,
          modelId: c.modelId,
        },
      });
      if (ctx.trigger === "cron" && evt.success === false) {
        safeAppend({
          sessionId: ctx.sessionId,
          eventType: "cron.failed",
          category: "cron",
          description: `Cron run failed: ${safeDesc(evt.error || "unknown")}`,
          metadata: {
            agentId: ctx.agentId,
            runId: ctx.runId,
            jobId: c.jobId,
            durationMs: evt.durationMs,
            error: evt.error,
          },
        });
      }
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_tool_call",
    (evt, ctx) => {
      if (!llmInputObserved && !conversationAccessWarned) {
        conversationAccessWarned = true;
        log.warn(CONVERSATION_ACCESS_WARNING);
      }
      const sanitized = sanitizeArgs(evt.params);
      const args = redactToolArgs
        ? { hash: "sha256:" + sdk.hashDocument(sdk.canonicalize(sanitized)) }
        : sanitized;
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "tool.invoked",
        category: "tool",
        description: `Tool invoked: ${safeDesc(evt.toolName)}`,
        metadata: { toolName: evt.toolName, args },
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "after_tool_call",
    (evt, ctx) => {
      if (isToolDenialError(evt.error)) {
        safeAppend({
          sessionId: ctx.sessionId,
          eventType: "tool.denied",
          category: "tool",
          description: `Tool denied: ${safeDesc(evt.toolName)} (${safeDesc(evt.error)})`,
          metadata: {
            toolName: evt.toolName,
            durationMs: evt.durationMs,
            reason: evt.error,
          },
        });
        return;
      }
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "tool.result",
        category: "tool",
        description: `Tool completed: ${safeDesc(evt.toolName)}`,
        metadata: {
          toolName: evt.toolName,
          durationMs: evt.durationMs,
          error: evt.error,
          outputLength: typeof evt.result === "string" ? evt.result.length : undefined,
        },
        content: typeof evt.result === "string" ? evt.result : undefined,
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "tool_result_persist",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionKey,
        eventType: "tool.persisted",
        category: "tool",
        description: `Tool result persisted: ${safeDesc(evt.toolName ?? "unknown")}`,
        metadata: {
          toolName: evt.toolName,
          isSynthetic: evt.isSynthetic,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  // --- LLM I/O ---

  api.on(
    "llm_input",
    (evt, ctx) => {
      llmInputObserved = true;
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "prompt.input",
        category: "prompt",
        description: `LLM input: ${safeDesc(evt.provider)}/${safeDesc(evt.model)}`,
        metadata: {
          provider: evt.provider,
          model: evt.model,
          promptLength: evt.prompt?.length,
          historyMessageCount: evt.historyMessages?.length,
          imagesCount: evt.imagesCount,
        },
        content: evt.prompt,
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  // --- Messages ---

  api.on(
    "message_received",
    (evt, ctx) => {
      const sender = resolveSender(evt);
      const e = evt as typeof evt & MessageEvtExtra;
      const c = ctx as typeof ctx & MessageCtxExtra;
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.received",
        category: "message",
        description: safeComposite(`Inbound from ${safeDesc(sender)} on ${safeDesc(ctx.channelId)}`),
        metadata: {
          direction: "in",
          sender,
          senderId: e.senderId,
          channel: ctx.channelId,
          accountId: ctx.accountId,
          sessionKey: c.sessionKey,
          threadId: e.threadId,
          messageId: e.messageId,
          runId: c.runId ?? e.runId,
          surface: evt.metadata?.surface as string | undefined,
          contentLength: evt.content?.length,
          timestamp: evt.timestamp ?? Date.now(),
        },
        content: evt.content,
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "message_sent",
    (evt, ctx) => {
      const recipient = resolveRecipient(evt);
      const e = evt as typeof evt & MessageEvtExtra;
      const c = ctx as typeof ctx & MessageCtxExtra;
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.sent",
        category: "message",
        description: safeComposite(`Outbound to ${safeDesc(recipient)} on ${safeDesc(ctx.channelId)}`),
        metadata: {
          direction: "out",
          recipient,
          channel: ctx.channelId,
          accountId: ctx.accountId,
          sessionKey: c.sessionKey,
          runId: c.runId ?? e.runId,
          messageId: e.messageId,
          contentLength: evt.content?.length,
          success: evt.success,
          error: evt.error,
          timestamp: Date.now(),
        },
        content: evt.content,
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "message_sending",
    (evt, ctx) => {
      const recipient = resolveRecipient(evt);
      const e = evt as typeof evt & MessageEvtExtra;
      const c = ctx as typeof ctx & MessageCtxExtra;
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.sending",
        category: "message",
        description: safeComposite(`Sending to ${safeDesc(recipient)} on ${safeDesc(ctx.channelId)}`),
        metadata: {
          direction: "out",
          recipient,
          channel: ctx.channelId,
          accountId: ctx.accountId,
          sessionKey: c.sessionKey,
          runId: c.runId,
          replyToId: e.replyToId,
          threadId: e.threadId,
          contentLength: evt.content?.length,
        },
        content: evt.content,
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "inbound_claim",
    (evt, ctx) => {
      const e = evt as typeof evt & MessageEvtExtra;
      const c = ctx as typeof ctx & MessageCtxExtra;
      // sessionId stays on ctx.conversationId for historical continuity —
      // switching to ctx.sessionKey would fragment audit chains across older
      // events that already grouped on conversationId.
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.claimed",
        category: "message",
        description: `Inbound claim on ${safeDesc(evt.channel)}`,
        metadata: {
          channel: evt.channel,
          senderId: evt.senderId,
          senderName: evt.senderName,
          isGroup: evt.isGroup,
          parentConversationId: ctx.parentConversationId ?? evt.parentConversationId,
          sessionKey: c.sessionKey ?? e.sessionKey,
          runId: c.runId ?? e.runId,
          threadId: e.threadId,
          messageId: e.messageId,
          contentLength: evt.content?.length,
        },
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_dispatch",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.dispatched",
        category: "message",
        description: `Dispatch on ${safeDesc(evt.channel ?? ctx.channelId)}`,
        metadata: {
          channel: evt.channel ?? ctx.channelId,
          senderId: evt.senderId ?? ctx.senderId,
          isGroup: evt.isGroup,
          contentLength: evt.content?.length,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_message_write",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionKey,
        eventType: "message.write",
        category: "message",
        description: "Message write",
        metadata: {
          agentId: ctx.agentId,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "llm_output",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "prompt.response",
        category: "prompt",
        description: `LLM call: ${safeDesc(evt.provider)}/${safeDesc(evt.model)}`,
        metadata: {
          provider: evt.provider,
          model: evt.model,
          inputTokens: evt.usage?.input,
          outputTokens: evt.usage?.output,
          cacheReadTokens: evt.usage?.cacheRead,
          cacheWriteTokens: evt.usage?.cacheWrite,
        },
        content: evt.assistantTexts?.join("\n"),
      }),
    { priority: AUDIT_PRIORITY },
  );

  // --- Compaction & reset ---

  api.on(
    "before_compaction",
    (evt, ctx) => {
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.compaction_start",
        category: "agent",
        description: "Context compaction started",
        metadata: {
          messageCount: evt.messageCount,
          compactingCount: evt.compactingCount,
          tokenCount: evt.tokenCount,
          sessionFile: evt.sessionFile,
        },
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "after_compaction",
    (evt, ctx) => {
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.compaction_end",
        category: "agent",
        description: `Compacted ${evt.compactedCount} messages`,
        metadata: {
          messageCount: evt.messageCount,
          compactedCount: evt.compactedCount,
          tokenCount: evt.tokenCount,
          sessionFile: evt.sessionFile,
        },
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_reset",
    (evt, ctx) => {
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.reset",
        category: "agent",
        description: `Session reset: ${safeDesc(evt.reason ?? "unknown")}`,
        metadata: {
          reason: evt.reason,
          sessionFile: evt.sessionFile,
        },
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  // --- Sessions ---

  api.on(
    "session_start",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "session.start",
        category: "system",
        description: `Session started: ${safeDesc(evt.sessionId)}`,
        metadata: {
          sessionKey: evt.sessionKey,
          resumedFrom: evt.resumedFrom,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "session_end",
    (evt, ctx) => {
      const e = evt as typeof evt & SessionEndEvtExtra;
      const hasReason = e.reason != null && e.reason !== "unknown";
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "session.end",
        category: "system",
        description: hasReason
          ? safeComposite(`Session ended (${safeDesc(e.reason)}): ${safeDesc(evt.sessionId)}`)
          : `Session ended: ${safeDesc(evt.sessionId)}`,
        metadata: {
          sessionKey: evt.sessionKey,
          messageCount: evt.messageCount,
          durationMs: evt.durationMs,
          reason: e.reason,
          sessionFile: e.sessionFile,
          transcriptArchived: e.transcriptArchived,
          nextSessionId: e.nextSessionId,
          nextSessionKey: e.nextSessionKey,
        },
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  // --- Subagents ---

  api.on(
    "subagent_spawning",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.requesterSessionKey,
        eventType: "agent.subagent_spawning",
        category: "agent",
        description: `Subagent spawning: ${safeDesc(evt.agentId)}`,
        metadata: {
          agentId: evt.agentId,
          childSessionKey: evt.childSessionKey,
          label: evt.label,
          mode: evt.mode,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "subagent_spawned",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.requesterSessionKey,
        eventType: "agent.subagent_spawned",
        category: "agent",
        description: `Subagent spawned: ${safeDesc(evt.agentId)}`,
        metadata: {
          agentId: evt.agentId,
          childSessionKey: evt.childSessionKey,
          runId: evt.runId,
          label: evt.label,
          mode: evt.mode,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "subagent_delivery_target",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.requesterSessionKey,
        eventType: "agent.subagent_delivery",
        category: "agent",
        description: `Subagent delivery target: ${safeDesc(evt.childSessionKey)}`,
        metadata: {
          childSessionKey: evt.childSessionKey,
          requesterSessionKey: evt.requesterSessionKey,
          spawnMode: evt.spawnMode,
          expectsCompletionMessage: evt.expectsCompletionMessage,
          deliveryChannel: evt.requesterOrigin?.channel,
          deliveryTo: evt.requesterOrigin?.to,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "subagent_ended",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.requesterSessionKey,
        eventType: "agent.subagent_ended",
        category: "agent",
        description: `Subagent ended: ${safeDesc(evt.outcome ?? "unknown")}`,
        metadata: {
          targetSessionKey: evt.targetSessionKey,
          targetKind: evt.targetKind,
          reason: evt.reason,
          outcome: evt.outcome,
          error: evt.error,
          runId: evt.runId,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  // --- Gateway lifecycle ---

  api.on(
    "gateway_start",
    (evt) =>
      safeAppend({
        eventType: "gateway.start",
        category: "gateway",
        description: `Gateway started on port ${evt.port}`,
        metadata: { port: evt.port },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "gateway_stop",
    (evt) => {
      if (!gatewayStopCapture.tryClaim()) return;
      safeAppend({
        eventType: "gateway.stop",
        category: "gateway",
        description: `Gateway stopped: ${safeDesc(evt.reason ?? "shutdown")}`,
        metadata: { reason: evt.reason },
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  // --- Install pipeline ---
  // before_install lands in openclaw >=2026.4.15; this plugin's peer floor is
  // >=2026.4.24 (gated by allowConversationAccess), so the runtime should
  // always recognize this hook. On older runtimes that we may still encounter
  // via mixed-version operator setups, openclaw warns "unknown typed hook"
  // and silently skips the registration without throwing. The try/catch is a
  // defense-in-depth guard against future runtimes that throw on unknown
  // hooks; on the warn-and-skip path it never fires. Either way, an audit
  // row is emitted so the operator's log shows that install auditing did or
  // did not start.
  try {
    (api.on as unknown as (
      name: string,
      handler: (evt: Record<string, unknown>, ctx: Record<string, unknown>) => void,
      opts?: { priority?: number },
    ) => void)(
      "before_install",
      (evt) => {
        const target = (evt.targetType as string | undefined) ?? "unknown";
        const name = (evt.targetName as string | undefined) ?? "unknown";
        const scan = evt.builtinScan as
          | { scannedFiles?: number; critical?: number; warn?: number; info?: number; status?: string }
          | undefined;
        const plugin = evt.plugin as
          | { pluginId?: string; packageName?: string; version?: string; contentType?: string }
          | undefined;
        const skill = evt.skill as { installId?: string } | undefined;
        const request = evt.request as { kind?: string; mode?: string; requestedSpecifier?: string } | undefined;
        safeAppend({
          eventType: "system.install",
          category: "system",
          description: safeComposite(
            `Install ${safeDesc(request?.mode ?? "request")}: ${safeDesc(target)} ${safeDesc(name)}`,
          ),
          metadata: {
            targetType: target,
            targetName: name,
            sourcePath: evt.sourcePath,
            sourcePathKind: evt.sourcePathKind,
            origin: evt.origin,
            requestKind: request?.kind,
            requestMode: request?.mode,
            requestedSpecifier: request?.requestedSpecifier,
            pluginId: plugin?.pluginId,
            packageName: plugin?.packageName,
            version: plugin?.version,
            contentType: plugin?.contentType,
            installId: skill?.installId,
            scanStatus: scan?.status,
            scannedFiles: scan?.scannedFiles,
            scanCritical: scan?.critical,
            scanWarn: scan?.warn,
            scanInfo: scan?.info,
          },
        });
      },
      { priority: AUDIT_PRIORITY },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn(`before_install hook unavailable: ${message}`);
    // Record the registration miss in the audit trail so operators reviewing
    // the SQLite log later can distinguish "no installs happened" from "we
    // silently couldn't register".
    safeAppend({
      eventType: "system.install_hook_unavailable",
      category: "system",
      description: `before_install hook unavailable: ${safeDesc(message)}`,
      metadata: { error: message },
    });
  }
}
