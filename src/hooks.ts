import type { AuditStore } from "./store/audit-store.js";
import type { AuditEventInsert } from "./types/events.js";
import type { OpenClawPluginApi } from "./types/openclaw-sdk.js";

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
    (ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        eventType: "session.start",
        category: "system",
        description: "Agent session started",
        metadata: { promptLength: ctx.prompt?.length },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "agent_end",
    (ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "session.end",
        category: "system",
        description: "Agent session ended",
        metadata: { durationMs: ctx.durationMs, success: ctx.success },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "before_tool_call",
    (ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "tool.invoked",
        category: "tool",
        description: `Tool invoked: ${ctx.toolName}`,
        metadata: { toolName: ctx.toolName, args: sanitizeArgs(ctx.params) },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "after_tool_call",
    (ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "tool.result",
        category: "tool",
        description: `Tool completed: ${ctx.toolName}`,
        metadata: {
          toolName: ctx.toolName,
          exitCode: ctx.exitCode,
          durationMs: ctx.durationMs,
          truncatedOutput: ctx.result?.slice(0, 1024),
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  // tool_result_persist is synchronous in OpenClaw — append is also synchronous
  // (better-sqlite3), so no special handling needed.
  api.on(
    "tool_result_persist",
    (ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "tool.persisted",
        category: "tool",
        description: `Tool result persisted: ${ctx.toolName}`,
        metadata: { toolName: ctx.toolName, contentLength: ctx.result?.length },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "message_received",
    (ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "prompt.sent",
        category: "prompt",
        description: `Message received (${ctx.channel})`,
        metadata: {
          contentLength: ctx.content?.length,
          truncatedPrompt: ctx.content?.slice(0, 500),
        },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.on(
    "message_sent",
    (ctx) =>
      safeAppend(store, {
        sessionId: ctx.sessionId,
        eventType: "prompt.response",
        category: "prompt",
        description: `Message sent (${ctx.channel})`,
        metadata: { contentLength: ctx.content?.length, success: ctx.success },
      }),
    { priority: AUDIT_PRIORITY },
  );

  api.onDiagnosticEvent("model.usage", (evt) =>
    safeAppend(store, {
      sessionId: evt.sessionId,
      eventType: "prompt.response",
      category: "prompt",
      description: `LLM call: ${evt.provider}/${evt.model}`,
      metadata: {
        provider: evt.provider,
        model: evt.model,
        inputTokens: evt.inputTokens,
        outputTokens: evt.outputTokens,
        cacheTokens: evt.cacheTokens,
        durationMs: evt.durationMs,
        costUsd: evt.costUsd,
      },
    }),
  );
}
