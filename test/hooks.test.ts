import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { AuditStore } from "../src/store/audit-store.js";
import { sanitizeArgs, registerHooks } from "../src/hooks.js";
import type { OpenClawPluginApi, HookOptions } from "../src/types/openclaw-sdk.js";

function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-hooks-test-"));
  return join(dir, "test.db");
}

function getEvents(dbPath: string) {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT * FROM audit_events ORDER BY sequence").all() as Array<{
    event_type: string;
    category: string;
    description: string;
    metadata: string;
    session_id: string | null;
  }>;
  db.close();
  return rows;
}

type HookHandler = (...args: unknown[]) => unknown;

function createMockApi() {
  const hooks = new Map<string, { handler: HookHandler; options?: HookOptions }>();
  const diagnostics = new Map<string, HookHandler>();

  const api = {
    hooks,
    diagnostics,
    on(hook: string, handler: HookHandler, options?: HookOptions) {
      hooks.set(hook, { handler, options });
    },
    onDiagnosticEvent(event: string, handler: HookHandler) {
      diagnostics.set(event, handler);
    },
    registerService() {},
    registerCli() {},
    registerTool() {},
    config: { plugins: { entries: {} } },
  } as unknown as OpenClawPluginApi & {
    hooks: Map<string, { handler: HookHandler; options?: HookOptions }>;
    diagnostics: Map<string, HookHandler>;
  };

  return api;
}

function fireHook(api: ReturnType<typeof createMockApi>, name: string, ctx: unknown) {
  api.hooks.get(name)!.handler(ctx);
}

function fireDiagnostic(api: ReturnType<typeof createMockApi>, name: string, ctx: unknown) {
  api.diagnostics.get(name)!(ctx);
}

// --- sanitizeArgs ---

describe("sanitizeArgs", () => {
  it("redacts top-level sensitive keys", () => {
    const result = sanitizeArgs({ path: "/tmp", apiKey: "secret123", password: "x" });
    assert.equal(result.path, "/tmp");
    assert.equal(result.apiKey, "[REDACTED]");
    assert.equal(result.password, "[REDACTED]");
  });

  it("redacts nested sensitive keys", () => {
    const result = sanitizeArgs({
      headers: { Authorization: "Bearer xyz", Accept: "application/json" },
    });
    const headers = result.headers as Record<string, unknown>;
    assert.equal(headers.Authorization, "[REDACTED]");
    assert.equal(headers.Accept, "application/json");
  });

  it("redacts sensitive keys inside arrays", () => {
    const result = sanitizeArgs({
      items: [{ name: "ok", secretKey: "hidden" }, { name: "also ok" }],
    });
    const items = result.items as Array<Record<string, unknown>>;
    assert.equal(items[0].name, "ok");
    assert.equal(items[0].secretKey, "[REDACTED]");
  });

  it("redacts credential, passphrase, jwt, bearer, cookie patterns", () => {
    const result = sanitizeArgs({
      credential: "a",
      passphrase: "b",
      jwtToken: "c",
      bearerAuth: "d",
      cookieSession: "e",
    });
    for (const v of Object.values(result)) {
      assert.equal(v, "[REDACTED]");
    }
  });

  it("preserves null and undefined values", () => {
    const result = sanitizeArgs({ a: null, b: undefined });
    assert.equal(result.a, null);
    assert.equal(result.b, undefined);
  });

  it("handles deeply nested objects", () => {
    const result = sanitizeArgs({
      level1: { level2: { level3: { password: "deep" } } },
    });
    assert.equal((result.level1 as any).level2.level3.password, "[REDACTED]");
  });

  it("handles circular references without throwing", () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular.self = circular;
    const result = sanitizeArgs(circular);
    assert.equal(result.name, "test");
    assert.equal(result.self, "[Circular]");
  });
});

// --- registerHooks ---

describe("registerHooks", () => {
  let dbPath: string;
  let store: AuditStore;
  let api: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    api = createMockApi();
    registerHooks(api, store);
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("registers all 7 lifecycle hooks and 1 diagnostic", () => {
    assert.equal(api.hooks.size, 7);
    assert.equal(api.diagnostics.size, 1);
    assert.ok(api.diagnostics.has("model.usage"));
  });

  it("registers all hooks with priority 200", () => {
    for (const [name, { options }] of api.hooks) {
      assert.equal(options?.priority, 200, `${name} should have priority 200`);
    }
  });

  describe("before_agent_start", () => {
    it("records session.start with prompt length", () => {
      fireHook(api, "before_agent_start", {
        sessionId: "s1",
        userId: "u1",
        orgId: "org1",
        prompt: "hello world",
        config: {},
      });

      const events = getEvents(dbPath);
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "session.start");
      assert.equal(events[0].session_id, "s1");
      assert.equal(JSON.parse(events[0].metadata).promptLength, 11);
    });

    it("handles missing optional prompt", () => {
      fireHook(api, "before_agent_start", { sessionId: "s1", config: {} });
      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.ok(!("promptLength" in meta));
    });
  });

  describe("agent_end", () => {
    it("records session.end", () => {
      fireHook(api, "agent_end", {
        sessionId: "s1",
        durationMs: 5000,
        success: true,
        stats: { tokensUsed: 100, toolCalls: 3 },
      });

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "session.end");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.durationMs, 5000);
      assert.equal(meta.success, true);
    });
  });

  describe("before_tool_call", () => {
    it("records tool.invoked with sanitized args", () => {
      fireHook(api, "before_tool_call", {
        sessionId: "s1",
        toolName: "read_file",
        params: { path: "/tmp/test", apiKey: "secret123" },
        requestId: "r1",
      });

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "tool.invoked");
      assert.ok(events[0].description.includes("read_file"));
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.args.path, "/tmp/test");
      assert.equal(meta.args.apiKey, "[REDACTED]");
    });
  });

  describe("after_tool_call", () => {
    it("records tool.result", () => {
      fireHook(api, "after_tool_call", {
        sessionId: "s1",
        toolName: "bash",
        result: "output",
        exitCode: 0,
        durationMs: 120,
        requestId: "r1",
      });

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.toolName, "bash");
      assert.equal(meta.exitCode, 0);
      assert.equal(meta.durationMs, 120);
    });

    it("truncates output to 1024 chars", () => {
      fireHook(api, "after_tool_call", {
        sessionId: "s1",
        toolName: "bash",
        result: "x".repeat(2000),
        durationMs: 100,
        requestId: "r1",
      });

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.truncatedOutput.length, 1024);
    });

    it("handles missing optional fields", () => {
      fireHook(api, "after_tool_call", {
        sessionId: "s1",
        toolName: "bash",
        durationMs: 50,
        requestId: "r1",
      });

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.ok(!("exitCode" in meta));
      assert.ok(!("truncatedOutput" in meta));
    });
  });

  describe("tool_result_persist", () => {
    it("records tool.persisted", () => {
      fireHook(api, "tool_result_persist", {
        sessionId: "s1",
        toolName: "write_file",
        result: "file contents here",
        requestId: "r1",
      });

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "tool.persisted");
      assert.equal(JSON.parse(events[0].metadata).contentLength, 18);
    });
  });

  describe("message_received", () => {
    it("records prompt.sent with truncated content", () => {
      fireHook(api, "message_received", {
        sessionId: "s1",
        channel: "user",
        content: "Please help me",
        role: "user",
      });

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "prompt.sent");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.contentLength, 14);
      assert.equal(meta.truncatedPrompt, "Please help me");
    });

    it("truncates prompt to 500 chars", () => {
      fireHook(api, "message_received", {
        sessionId: "s1",
        channel: "user",
        content: "a".repeat(1000),
        role: "user",
      });

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.truncatedPrompt.length, 500);
      assert.equal(meta.contentLength, 1000);
    });
  });

  describe("message_sent", () => {
    it("records prompt.response", () => {
      fireHook(api, "message_sent", {
        sessionId: "s1",
        channel: "assistant",
        content: "Here is the answer",
        role: "assistant",
        success: true,
      });

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.success, true);
      assert.equal(meta.contentLength, 18);
    });
  });

  describe("model.usage diagnostic", () => {
    it("records LLM usage", () => {
      fireDiagnostic(api, "model.usage", {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 1500,
        outputTokens: 800,
        cacheTokens: 200,
        durationMs: 3200,
        costUsd: 0.012,
        sessionId: "s1",
      });

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "prompt.response");
      assert.ok(events[0].description.includes("anthropic/claude-sonnet-4-6"));
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.inputTokens, 1500);
      assert.equal(meta.costUsd, 0.012);
    });
  });

  describe("fail-open", () => {
    it("does not throw when store is closed", () => {
      store.close();
      fireHook(api, "before_agent_start", { sessionId: "s1", config: {} });
      // No assertion needed — if it throws, the test fails
      store = new AuditStore(makeTempDb());
    });
  });
});
