import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AuditStore } from "./store/audit-store.js";
import type { AuditEventInsert } from "./types/events.js";

const SENSITIVE_KEY =
  /secret|password|token|key|auth|credential|passphrase|jwt|bearer|cookie/i;

const AUDIT_PRIORITY = 200;
const CONTENT_PREVIEW_LENGTH = 50;

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

function safeAppend(store: AuditStore, insert: AuditEventInsert): void {
  try {
    store.append(insert);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[audit-plugin]", message);
  }
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

export function registerHooks(api: OpenClawPluginApi, store: AuditStore): void {
  api.on(
    "before_agent_start",
    (evt, ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "session.start",
        category: "system",
        description: "Agent session started",
        metadata: { promptLength: evt.prompt?.length, trigger: ctx.trigger },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "agent_end",
    (evt, ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "session.end",
        category: "system",
        description: "Agent session ended",
        metadata: { durationMs: evt.durationMs, success: evt.success },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_tool_call",
    (evt, ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "tool.invoked",
        category: "tool",
        description: `Tool invoked: ${evt.toolName}`,
        metadata: { toolName: evt.toolName, args: sanitizeArgs(evt.params) },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "after_tool_call",
    (evt, ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "tool.result",
        category: "tool",
        description: `Tool completed: ${evt.toolName}`,
        metadata: {
          toolName: evt.toolName,
          durationMs: evt.durationMs,
          error: evt.error,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "tool_result_persist",
    (evt, ctx) =>
      safeAppend(store, {
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

  api.on(
    "message_received",
    (evt, ctx) => {
      const sender = resolveSender(evt);
      safeAppend(store, {
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
          truncatedContent: evt.content?.slice(0, CONTENT_PREVIEW_LENGTH),
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
      safeAppend(store, {
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
          truncatedContent: evt.content?.slice(0, CONTENT_PREVIEW_LENGTH),
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
    "llm_output",
    (evt, ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "prompt.response",
        category: "prompt",
        description: `LLM call: ${evt.provider}/${evt.model}`,
        metadata: {
          provider: evt.provider,
          model: evt.model,
          truncatedContent: evt.assistantTexts?.join("\n")?.slice(0, CONTENT_PREVIEW_LENGTH),
          inputTokens: evt.usage?.input,
          outputTokens: evt.usage?.output,
          cacheReadTokens: evt.usage?.cacheRead,
          cacheWriteTokens: evt.usage?.cacheWrite,
        },
        content: evt.assistantTexts?.join("\n"),
      }),
    { priority: AUDIT_PRIORITY },
  );
}
