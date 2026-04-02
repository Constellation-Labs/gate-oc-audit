import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AuditStore } from "./store/audit-store.js";
import type { AuditEventInsert } from "./types/events.js";

const SENSITIVE_KEY =
  /secret|password|token|key|auth|credential|passphrase|jwt|bearer|cookie/i;

const AUDIT_PRIORITY = 200;

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
    (evt, ctx) =>
      safeAppend(store, {
        sessionId: ctx.conversationId,
        eventType: "prompt.sent",
        category: "prompt",
        description: `Message received from ${evt.from}`,
        metadata: {
          from: evt.from,
          contentLength: evt.content?.length,
          truncatedContent: evt.content?.slice(0, 500),
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "message_sent",
    (evt, ctx) =>
      safeAppend(store, {
        sessionId: ctx.conversationId,
        eventType: "prompt.response",
        category: "prompt",
        description: `Message sent to ${evt.to}`,
        metadata: {
          to: evt.to,
          contentLength: evt.content?.length,
          success: evt.success,
          error: evt.error,
        },
      }),
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
          inputTokens: evt.usage?.input,
          outputTokens: evt.usage?.output,
          cacheReadTokens: evt.usage?.cacheRead,
          cacheWriteTokens: evt.usage?.cacheWrite,
        },
      }),
    { priority: AUDIT_PRIORITY },
  );
}
