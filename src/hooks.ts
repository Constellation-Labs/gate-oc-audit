import { createRequire } from "module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AuditStore } from "./store/audit-store.js";
import type { AuditEventInsert } from "./types/events.js";
import type { RateLimiter } from "./rate-limiter.js";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
  hashDocument: (content: string | Buffer) => string;
};

const SENSITIVE_KEY =
  /secret|password|token|api.?key|auth|credential|passphrase|jwt|bearer|cookie|private.?key/i;

const AUDIT_PRIORITY = 200;

// OpenClaw's engine surfaces tool denials/blocks as thrown errors that reach
// us via after_tool_call's `error` field. We can't distinguish denials from
// runtime errors structurally, so we match on the engine's authored phrases.
// Plugins that set a custom blockReason replace these phrases entirely and
// will surface as tool.result with the error populated, not tool.denied.
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

export function registerHooks(
  api: OpenClawPluginApi,
  store: AuditStore,
  limiter?: RateLimiter,
  config: Record<string, unknown> = {},
): void {
  const redactContent = config.redactPromptText === true;
  const redactToolArgs = config.redactToolArgs === true;

  const safeAppend = (insert: AuditEventInsert): void => {
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
      console.error("[audit-plugin]", message);
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
        safeAppend({
          sessionId: ctx.sessionId,
          eventType: "cron.executed",
          category: "cron",
          description: "Cron-triggered agent run started",
          metadata: { agentId: ctx.agentId, runId: ctx.runId, promptLength: evt.prompt?.length },
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
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.end",
        category: "agent",
        description: "Agent run ended",
        metadata: { durationMs: evt.durationMs, success: evt.success },
      });
      if (ctx.trigger === "cron" && evt.success === false) {
        safeAppend({
          sessionId: ctx.sessionId,
          eventType: "cron.failed",
          category: "cron",
          description: `Cron run failed: ${evt.error || "unknown"}`,
          metadata: {
            agentId: ctx.agentId,
            runId: ctx.runId,
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
      const sanitized = sanitizeArgs(evt.params);
      const args = redactToolArgs
        ? { hash: "sha256:" + sdk.hashDocument(sdk.canonicalize(sanitized)) }
        : sanitized;
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "tool.invoked",
        category: "tool",
        description: `Tool invoked: ${evt.toolName}`,
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
          description: `Tool denied: ${evt.toolName}`,
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
        description: `Tool completed: ${evt.toolName}`,
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
        description: `Tool result persisted: ${evt.toolName ?? "unknown"}`,
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
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "prompt.input",
        category: "prompt",
        description: `LLM input: ${evt.provider}/${evt.model}`,
        metadata: {
          provider: evt.provider,
          model: evt.model,
          promptLength: evt.prompt?.length,
          historyMessageCount: evt.historyMessages?.length,
          imagesCount: evt.imagesCount,
        },
        content: evt.prompt,
      }),
    { priority: AUDIT_PRIORITY },
  );

  // --- Messages ---

  api.on(
    "message_received",
    (evt, ctx) => {
      const sender = resolveSender(evt);
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.received",
        category: "message",
        description: `Inbound from ${sender} on ${ctx.channelId}`,
        metadata: {
          direction: "in",
          sender,
          channel: ctx.channelId,
          accountId: ctx.accountId,
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
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.sent",
        category: "message",
        description: `Outbound to ${recipient} on ${ctx.channelId}`,
        metadata: {
          direction: "out",
          recipient,
          channel: ctx.channelId,
          accountId: ctx.accountId,
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
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.sending",
        category: "message",
        description: `Sending to ${recipient} on ${ctx.channelId}`,
        metadata: {
          direction: "out",
          recipient,
          channel: ctx.channelId,
          contentLength: evt.content?.length,
        },
        content: evt.content,
      });
    },
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "inbound_claim",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.claimed",
        category: "message",
        description: `Inbound claim on ${evt.channel}`,
        metadata: {
          channel: evt.channel,
          senderId: evt.senderId,
          senderName: evt.senderName,
          isGroup: evt.isGroup,
          contentLength: evt.content?.length,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_dispatch",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.conversationId,
        eventType: "message.dispatched",
        category: "message",
        description: `Dispatch on ${evt.channel ?? ctx.channelId}`,
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
        description: `LLM call: ${evt.provider}/${evt.model}`,
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
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.compaction_start",
        category: "agent",
        description: "Context compaction started",
        metadata: {
          messageCount: evt.messageCount,
          compactingCount: evt.compactingCount,
          tokenCount: evt.tokenCount,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "after_compaction",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.compaction_end",
        category: "agent",
        description: `Compacted ${evt.compactedCount} messages`,
        metadata: {
          messageCount: evt.messageCount,
          compactedCount: evt.compactedCount,
          tokenCount: evt.tokenCount,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_reset",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "agent.reset",
        category: "agent",
        description: `Session reset: ${evt.reason ?? "unknown"}`,
        metadata: {
          reason: evt.reason,
        },
      }),
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
        description: `Session started: ${evt.sessionId}`,
        metadata: {
          sessionKey: evt.sessionKey,
          resumedFrom: evt.resumedFrom,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "session_end",
    (evt, ctx) =>
      safeAppend({
        sessionId: ctx.sessionId,
        eventType: "session.end",
        category: "system",
        description: `Session ended: ${evt.sessionId}`,
        metadata: {
          sessionKey: evt.sessionKey,
          messageCount: evt.messageCount,
          durationMs: evt.durationMs,
        },
      }),
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
        description: `Subagent spawning: ${evt.agentId}`,
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
        description: `Subagent spawned: ${evt.agentId}`,
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
        description: `Subagent delivery target: ${evt.childSessionKey}`,
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
        description: `Subagent ended: ${evt.outcome ?? "unknown"}`,
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
    (evt) =>
      safeAppend({
        eventType: "gateway.stop",
        category: "gateway",
        description: `Gateway stopped: ${evt.reason ?? "shutdown"}`,
        metadata: { reason: evt.reason },
      }),
    { priority: AUDIT_PRIORITY },
  );
}
