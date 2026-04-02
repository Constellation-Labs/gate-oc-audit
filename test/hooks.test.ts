import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { AuditStore } from "../src/store/audit-store.js";
import { sanitizeArgs, registerHooks } from "../src/hooks.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-hooks-test-")), "test.db");
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

type HookEntry = {
  handler: (event: unknown, ctx: unknown) => unknown;
  options?: { priority?: number };
};

function createMockApi() {
  const hooks = new Map<string, HookEntry>();

  return {
    hooks,
    on(hook: string, handler: HookEntry["handler"], opts?: HookEntry["options"]) {
      hooks.set(hook, { handler, options: opts });
    },
    registerHook() {},
    registerService() {},
    registerCli() {},
    registerTool() {},
    registerCommand() {},
    registerHttpRoute() {},
    pluginConfig: {},
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtime: {},
    registrationMode: "full",
    id: "test",
    name: "test",
    source: "test",
    resolvePath: (p: string) => p,
  } as unknown as OpenClawPluginApi & { hooks: Map<string, HookEntry> };
}

function fireHook(api: ReturnType<typeof createMockApi>, name: string, event: unknown, ctx: unknown = {}) {
  api.hooks.get(name)!.handler(event, ctx);
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
      credential: "a", passphrase: "b", jwtToken: "c", bearerAuth: "d", cookieSession: "e",
    });
    for (const v of Object.values(result)) assert.equal(v, "[REDACTED]");
  });

  it("preserves null and undefined values", () => {
    const result = sanitizeArgs({ a: null, b: undefined });
    assert.equal(result.a, null);
    assert.equal(result.b, undefined);
  });

  it("handles deeply nested objects", () => {
    const result = sanitizeArgs({ level1: { level2: { level3: { password: "deep" } } } });
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

  it("registers 8 lifecycle hooks", () => {
    assert.equal(api.hooks.size, 8);
    for (const name of [
      "before_agent_start", "agent_end", "before_tool_call", "after_tool_call",
      "tool_result_persist", "message_received", "message_sent", "llm_output",
    ]) {
      assert.ok(api.hooks.has(name), `Missing hook: ${name}`);
    }
  });

  it("registers all hooks with priority 200", () => {
    for (const [name, { options }] of api.hooks) {
      assert.equal(options?.priority, 200, `${name} should have priority 200`);
    }
  });

  describe("before_agent_start", () => {
    it("records session.start with prompt length", () => {
      fireHook(api, "before_agent_start",
        { prompt: "hello world" },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "session.start");
      assert.equal(events[0].session_id, "s1");
      assert.equal(JSON.parse(events[0].metadata).promptLength, 11);
    });

    it("handles missing optional prompt", () => {
      fireHook(api, "before_agent_start", {}, { sessionId: "s1" });
      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.ok(!("promptLength" in meta));
    });
  });

  describe("agent_end", () => {
    it("records session.end", () => {
      fireHook(api, "agent_end",
        { durationMs: 5000, success: true, messages: [] },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "session.end");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.durationMs, 5000);
      assert.equal(meta.success, true);
    });
  });

  describe("before_tool_call", () => {
    it("records tool.invoked with sanitized args", () => {
      fireHook(api, "before_tool_call",
        { toolName: "read_file", params: { path: "/tmp/test", apiKey: "secret123" } },
        { sessionId: "s1", toolName: "read_file" },
      );

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
      fireHook(api, "after_tool_call",
        { toolName: "bash", durationMs: 120, params: {} },
        { sessionId: "s1", toolName: "bash" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.toolName, "bash");
      assert.equal(meta.durationMs, 120);
    });
  });

  describe("tool_result_persist", () => {
    it("records tool.persisted", () => {
      fireHook(api, "tool_result_persist",
        { toolName: "write_file", message: { role: "tool", content: "done" } },
        { sessionKey: "sk1", toolName: "write_file" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "tool.persisted");
      assert.equal(JSON.parse(events[0].metadata).toolName, "write_file");
    });
  });

  describe("message_received", () => {
    it("records prompt.sent with truncated content", () => {
      fireHook(api, "message_received",
        { from: "user-123", content: "Please help me" },
        { channelId: "telegram" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "prompt.sent");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.contentLength, 14);
      assert.equal(meta.truncatedContent, "Please help me");
    });

    it("truncates content to 500 chars", () => {
      fireHook(api, "message_received",
        { from: "user", content: "a".repeat(1000) },
        { channelId: "telegram" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.truncatedContent.length, 500);
      assert.equal(meta.contentLength, 1000);
    });
  });

  describe("message_sent", () => {
    it("records prompt.response", () => {
      fireHook(api, "message_sent",
        { to: "user-123", content: "Here is the answer", success: true },
        { channelId: "telegram" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.success, true);
      assert.equal(meta.contentLength, 18);
    });
  });

  describe("llm_output", () => {
    it("records LLM usage", () => {
      fireHook(api, "llm_output",
        {
          runId: "r1", sessionId: "s1",
          provider: "anthropic", model: "claude-sonnet-4-6",
          assistantTexts: ["response"],
          usage: { input: 1500, output: 800, cacheRead: 200 },
        },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "prompt.response");
      assert.ok(events[0].description.includes("anthropic/claude-sonnet-4-6"));
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.inputTokens, 1500);
      assert.equal(meta.outputTokens, 800);
      assert.equal(meta.cacheReadTokens, 200);
    });
  });

  describe("fail-open", () => {
    it("does not throw when store is closed", () => {
      store.close();
      fireHook(api, "before_agent_start", {}, { sessionId: "s1" });
      store = new AuditStore(makeTempDb());
    });
  });
});
