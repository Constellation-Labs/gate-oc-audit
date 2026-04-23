import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../src/store/audit-store.js";
import { sanitizeArgs, registerHooks } from "../src/hooks.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
};

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-hooks-test-")), "test.db");
}

function getEvents(dbPath: string) {
  const db = new DatabaseSync(dbPath);
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

  it("does not redact non-sensitive keys containing 'key'", () => {
    const result = sanitizeArgs({ primaryKey: "pk-1", keyboardLayout: "us", hookeyPokey: "dance" });
    assert.equal(result.primaryKey, "pk-1");
    assert.equal(result.keyboardLayout, "us");
    assert.equal(result.hookeyPokey, "dance");
  });

  it("redacts api_key and privateKey variants", () => {
    const result = sanitizeArgs({ api_key: "k1", apiKey: "k2", privateKey: "k3" });
    assert.equal(result.api_key, "[REDACTED]");
    assert.equal(result.apiKey, "[REDACTED]");
    assert.equal(result.privateKey, "[REDACTED]");
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

  it("registers 25 lifecycle hooks", () => {
    assert.equal(api.hooks.size, 25);
    for (const name of [
      "before_model_resolve", "before_prompt_build",
      "agent_end",
      "before_tool_call", "after_tool_call", "tool_result_persist",
      "llm_input", "llm_output",
      "message_received", "message_sending", "message_sent",
      "inbound_claim", "before_dispatch", "before_message_write",
      "before_compaction", "after_compaction", "before_reset",
      "session_start", "session_end",
      "subagent_spawning", "subagent_spawned", "subagent_delivery_target", "subagent_ended",
      "gateway_start", "gateway_stop",
    ]) {
      assert.ok(api.hooks.has(name), `Missing hook: ${name}`);
    }
  });

  it("registers all hooks with priority 200", () => {
    for (const [name, { options }] of api.hooks) {
      assert.equal(options?.priority, 200, `${name} should have priority 200`);
    }
  });

  describe("before_model_resolve", () => {
    it("records prompt.model_resolve with prompt length and trigger", () => {
      fireHook(api, "before_model_resolve",
        { prompt: "hello world" },
        { sessionId: "s1", trigger: "user" },
      );

      const events = getEvents(dbPath);
      const resolveEvent = events.find((e: any) => e.event_type === "prompt.model_resolve");
      assert.ok(resolveEvent, "expected prompt.model_resolve event");
      assert.equal(resolveEvent.category, "prompt");
      assert.equal(resolveEvent.session_id, "s1");
      const meta = JSON.parse(resolveEvent.metadata);
      assert.equal(meta.promptLength, 11);
      assert.equal(meta.trigger, "user");
    });

    it("handles missing optional prompt", () => {
      fireHook(api, "before_model_resolve", {}, { sessionId: "s1" });
      const events = getEvents(dbPath);
      const resolveEvent = events.find((e: any) => e.event_type === "prompt.model_resolve");
      const meta = JSON.parse(resolveEvent.metadata);
      assert.ok(!("promptLength" in meta));
    });

    it("does not emit cron.executed for non-cron triggers", () => {
      fireHook(api, "before_model_resolve",
        { prompt: "hi" },
        { sessionId: "s1", trigger: "user" },
      );
      const events = getEvents(dbPath);
      assert.equal(events.some((e) => e.event_type === "cron.executed"), false);
    });

    it("emits cron.executed alongside prompt.model_resolve when trigger is cron", () => {
      fireHook(api, "before_model_resolve",
        { prompt: "scheduled work" },
        { sessionId: "s1", agentId: "a1", runId: "r1", trigger: "cron" },
      );
      const events = getEvents(dbPath);
      const cronEvent = events.find((e) => e.event_type === "cron.executed");
      assert.ok(cronEvent, "expected cron.executed event");
      assert.equal(cronEvent.category, "cron");
      assert.equal(cronEvent.session_id, "s1");
      const meta = JSON.parse(cronEvent.metadata);
      assert.equal(meta.agentId, "a1");
      assert.equal(meta.runId, "r1");
      assert.equal(meta.promptLength, 14);
    });
  });

  describe("agent_end", () => {
    it("records agent.end", () => {
      fireHook(api, "agent_end",
        { durationMs: 5000, success: true, messages: [] },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.end");
      assert.equal(events[0].category, "agent");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.durationMs, 5000);
      assert.equal(meta.success, true);
    });

    it("does not emit cron.failed when trigger is cron but success is true", () => {
      fireHook(api, "agent_end",
        { durationMs: 100, success: true, messages: [] },
        { sessionId: "s1", trigger: "cron" },
      );
      const events = getEvents(dbPath);
      assert.equal(events.some((e) => e.event_type === "cron.failed"), false);
    });

    it("does not emit cron.failed when success is false but trigger is not cron", () => {
      fireHook(api, "agent_end",
        { durationMs: 100, success: false, error: "boom", messages: [] },
        { sessionId: "s1", trigger: "user" },
      );
      const events = getEvents(dbPath);
      assert.equal(events.some((e) => e.event_type === "cron.failed"), false);
    });

    it("emits cron.failed alongside agent.end when cron run fails", () => {
      fireHook(api, "agent_end",
        { durationMs: 250, success: false, error: "timeout", messages: [] },
        { sessionId: "s1", agentId: "a1", runId: "r1", trigger: "cron" },
      );
      const events = getEvents(dbPath);
      const cronEvent = events.find((e) => e.event_type === "cron.failed");
      assert.ok(cronEvent, "expected cron.failed event");
      assert.equal(cronEvent.category, "cron");
      assert.ok(cronEvent.description.includes("timeout"));
      const meta = JSON.parse(cronEvent.metadata);
      assert.equal(meta.agentId, "a1");
      assert.equal(meta.runId, "r1");
      assert.equal(meta.durationMs, 250);
      assert.equal(meta.error, "timeout");
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

    it("records tool.result when tool errors with a non-denial message", () => {
      fireHook(api, "after_tool_call",
        { toolName: "bash", durationMs: 5, error: "ENOENT: no such file", params: {} },
        { sessionId: "s1", toolName: "bash" },
      );
      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "tool.result");
      assert.equal(JSON.parse(events[0].metadata).error, "ENOENT: no such file");
    });

    for (const reason of [
      "Denied by user",
      "Approval timed out",
      "Approval cancelled (run aborted)",
      "Plugin approval required (gateway unavailable)",
      "Tool call blocked by plugin hook",
    ]) {
      it(`records tool.denied for engine denial message: "${reason}"`, () => {
        fireHook(api, "after_tool_call",
          { toolName: "bash", durationMs: 3, error: reason, params: {} },
          { sessionId: "s1", toolName: "bash" },
        );
        const events = getEvents(dbPath);
        assert.equal(events.length, 1, "should emit exactly one event");
        assert.equal(events[0].event_type, "tool.denied");
        assert.equal(events[0].category, "tool");
        assert.ok(events[0].description.includes("bash"));
        const meta = JSON.parse(events[0].metadata);
        assert.equal(meta.toolName, "bash");
        assert.equal(meta.reason, reason);
      });
    }
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
    it("records message.received with sender and channel", () => {
      fireHook(api, "message_received",
        { from: "user-123", content: "Please help me" },
        { channelId: "telegram", accountId: "acct-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "message.received");
      assert.equal(events[0].category, "message");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.direction, "in");
      assert.equal(meta.sender, "user-123");
      assert.equal(meta.channel, "telegram");
      assert.equal(meta.contentLength, 14);
    });

    it("stores contentLength for long messages", () => {
      fireHook(api, "message_received",
        { from: "user", content: "a".repeat(1000) },
        { channelId: "telegram" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.contentLength, 1000);
    });

    it("falls back to metadata.senderId when from is empty", () => {
      fireHook(api, "message_received",
        { from: "", content: "hi", metadata: { senderId: "sid-1" } },
        { channelId: "webchat" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.sender, "sid-1");
    });

    it("falls back to metadata.senderName when from and senderId are empty", () => {
      fireHook(api, "message_received",
        { from: "", content: "hi", metadata: { senderName: "Alice" } },
        { channelId: "webchat" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.sender, "Alice");
    });

    it("falls back to metadata.senderUsername", () => {
      fireHook(api, "message_received",
        { from: "", content: "hi", metadata: { senderUsername: "alice42" } },
        { channelId: "webchat" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.sender, "alice42");
    });

    it("falls back to 'unknown' when no sender info available", () => {
      fireHook(api, "message_received",
        { from: "", content: "hi" },
        { channelId: "tui" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.sender, "unknown");
    });

    it("stores full content gzipped", () => {
      const content = "full message content here";
      fireHook(api, "message_received",
        { from: "user", content },
        { channelId: "telegram" },
      );

      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT content_gz FROM audit_events ORDER BY sequence LIMIT 1").get() as { content_gz: Uint8Array | null };
      db.close();

      assert.ok(row.content_gz);

      assert.equal(gunzipSync(row.content_gz).toString(), content);
    });
  });

  describe("message_sent", () => {
    it("records message.sent with recipient and channel", () => {
      fireHook(api, "message_sent",
        { to: "user-123", content: "Here is the answer", success: true },
        { channelId: "telegram", accountId: "acct-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "message.sent");
      assert.equal(events[0].category, "message");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.direction, "out");
      assert.equal(meta.recipient, "user-123");
      assert.equal(meta.channel, "telegram");
      assert.equal(meta.success, true);
      assert.equal(meta.contentLength, 18);
    });

    it("stores full content gzipped", () => {
      const content = "response content";
      fireHook(api, "message_sent",
        { to: "user", content, success: true },
        { channelId: "telegram" },
      );

      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT content_gz FROM audit_events ORDER BY sequence LIMIT 1").get() as { content_gz: Uint8Array | null };
      db.close();

      assert.ok(row.content_gz);

      assert.equal(gunzipSync(row.content_gz).toString(), content);
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

  describe("before_prompt_build", () => {
    it("records prompt.build with message count", () => {
      fireHook(api, "before_prompt_build",
        { prompt: "test", messages: [{}, {}, {}] },
        { sessionId: "s1" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.promptLength, 4);
      assert.equal(meta.messageCount, 3);
    });
  });

  describe("llm_input", () => {
    it("records prompt.input with provider and model", () => {
      fireHook(api, "llm_input",
        {
          runId: "r1", sessionId: "s1",
          provider: "anthropic", model: "claude-sonnet-4-6",
          prompt: "What is 2+2?",
          historyMessages: [{}, {}],
          imagesCount: 1,
        },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "prompt.input");
      assert.ok(events[0].description.includes("anthropic/claude-sonnet-4-6"));
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.provider, "anthropic");
      assert.equal(meta.promptLength, 12);
      assert.equal(meta.historyMessageCount, 2);
      assert.equal(meta.imagesCount, 1);
    });

    it("stores full prompt gzipped", () => {
      const prompt = "a long prompt here";
      fireHook(api, "llm_input",
        { runId: "r1", sessionId: "s1", provider: "p", model: "m", prompt, historyMessages: [], imagesCount: 0 },
        { sessionId: "s1" },
      );

      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT content_gz FROM audit_events ORDER BY sequence LIMIT 1").get() as { content_gz: Uint8Array | null };
      db.close();

      assert.ok(row.content_gz);
      assert.equal(gunzipSync(row.content_gz).toString(), prompt);
    });
  });

  describe("message_sending", () => {
    it("records message.sending with recipient", () => {
      fireHook(api, "message_sending",
        { to: "user-1", content: "draft reply" },
        { channelId: "discord", conversationId: "c1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "message.sending");
      assert.equal(events[0].category, "message");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.direction, "out");
      assert.equal(meta.recipient, "user-1");
      assert.equal(meta.channel, "discord");
      assert.equal(meta.contentLength, 11);
    });
  });

  describe("inbound_claim", () => {
    it("records message.claimed", () => {
      fireHook(api, "inbound_claim",
        { content: "hi", channel: "telegram", senderId: "u1", senderName: "Alice", isGroup: false },
        { channelId: "telegram", conversationId: "c1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "message.claimed");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.channel, "telegram");
      assert.equal(meta.senderId, "u1");
      assert.equal(meta.senderName, "Alice");
      assert.equal(meta.isGroup, false);
      assert.equal(meta.contentLength, 2);
    });
  });

  describe("before_dispatch", () => {
    it("records message.dispatched", () => {
      fireHook(api, "before_dispatch",
        { content: "msg", channel: "slack", senderId: "u2", isGroup: true },
        { conversationId: "c1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "message.dispatched");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.channel, "slack");
      assert.equal(meta.senderId, "u2");
      assert.equal(meta.isGroup, true);
    });
  });

  describe("before_message_write", () => {
    it("records message.write", () => {
      fireHook(api, "before_message_write",
        { message: { role: "assistant", content: "hi" } },
        { sessionKey: "sk1", agentId: "agent-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "message.write");
      assert.equal(events[0].category, "message");
      assert.equal(JSON.parse(events[0].metadata).agentId, "agent-1");
    });
  });

  describe("before_compaction", () => {
    it("records agent.compaction_start", () => {
      fireHook(api, "before_compaction",
        { messageCount: 100, compactingCount: 80, tokenCount: 50000 },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.compaction_start");
      assert.equal(events[0].category, "agent");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.messageCount, 100);
      assert.equal(meta.compactingCount, 80);
      assert.equal(meta.tokenCount, 50000);
    });
  });

  describe("after_compaction", () => {
    it("records agent.compaction_end", () => {
      fireHook(api, "after_compaction",
        { messageCount: 20, compactedCount: 80, tokenCount: 10000 },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.compaction_end");
      assert.ok(events[0].description.includes("80"));
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.compactedCount, 80);
    });
  });

  describe("before_reset", () => {
    it("records agent.reset with reason", () => {
      fireHook(api, "before_reset",
        { reason: "user-requested" },
        { sessionId: "s1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.reset");
      assert.ok(events[0].description.includes("user-requested"));
      assert.equal(JSON.parse(events[0].metadata).reason, "user-requested");
    });

    it("handles missing reason", () => {
      fireHook(api, "before_reset", {}, { sessionId: "s1" });
      assert.ok(getEvents(dbPath)[0].description.includes("unknown"));
    });
  });

  describe("session_start", () => {
    it("records session.start", () => {
      fireHook(api, "session_start",
        { sessionId: "sess-1", sessionKey: "sk-1", resumedFrom: "sess-0" },
        { sessionId: "sess-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "session.start");
      assert.equal(events[0].category, "system");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.sessionKey, "sk-1");
      assert.equal(meta.resumedFrom, "sess-0");
    });
  });

  describe("session_end", () => {
    it("records session.end with duration and message count", () => {
      fireHook(api, "session_end",
        { sessionId: "sess-1", sessionKey: "sk-1", messageCount: 42, durationMs: 30000 },
        { sessionId: "sess-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "session.end");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.messageCount, 42);
      assert.equal(meta.durationMs, 30000);
    });
  });

  describe("subagent_spawning", () => {
    it("records agent.subagent_spawning", () => {
      fireHook(api, "subagent_spawning",
        { agentId: "sub-1", childSessionKey: "csk-1", label: "researcher", mode: "run", threadRequested: false },
        { requesterSessionKey: "rsk-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.subagent_spawning");
      assert.equal(events[0].category, "agent");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.agentId, "sub-1");
      assert.equal(meta.childSessionKey, "csk-1");
      assert.equal(meta.label, "researcher");
      assert.equal(meta.mode, "run");
    });
  });

  describe("subagent_spawned", () => {
    it("records agent.subagent_spawned with runId", () => {
      fireHook(api, "subagent_spawned",
        { agentId: "sub-1", childSessionKey: "csk-1", runId: "r-1", label: "coder", mode: "session", threadRequested: false },
        { requesterSessionKey: "rsk-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.subagent_spawned");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.runId, "r-1");
      assert.equal(meta.agentId, "sub-1");
    });
  });

  describe("subagent_delivery_target", () => {
    it("records agent.subagent_delivery", () => {
      fireHook(api, "subagent_delivery_target",
        {
          childSessionKey: "csk-1", requesterSessionKey: "rsk-1",
          spawnMode: "run", expectsCompletionMessage: true,
          requesterOrigin: { channel: "telegram", to: "user-1" },
        },
        { requesterSessionKey: "rsk-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.subagent_delivery");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.childSessionKey, "csk-1");
      assert.equal(meta.spawnMode, "run");
      assert.equal(meta.expectsCompletionMessage, true);
      assert.equal(meta.deliveryChannel, "telegram");
      assert.equal(meta.deliveryTo, "user-1");
    });
  });

  describe("subagent_ended", () => {
    it("records agent.subagent_ended with outcome", () => {
      fireHook(api, "subagent_ended",
        { targetSessionKey: "csk-1", targetKind: "subagent", reason: "completed", outcome: "ok", runId: "r-1" },
        { requesterSessionKey: "rsk-1" },
      );

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "agent.subagent_ended");
      assert.ok(events[0].description.includes("ok"));
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.targetSessionKey, "csk-1");
      assert.equal(meta.outcome, "ok");
      assert.equal(meta.reason, "completed");
      assert.equal(meta.runId, "r-1");
    });

    it("records error outcome", () => {
      fireHook(api, "subagent_ended",
        { targetSessionKey: "csk-1", targetKind: "subagent", reason: "crash", outcome: "error", error: "OOM" },
        { requesterSessionKey: "rsk-1" },
      );

      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      assert.equal(meta.outcome, "error");
      assert.equal(meta.error, "OOM");
    });
  });

  describe("gateway_start", () => {
    it("records gateway.start with port", () => {
      fireHook(api, "gateway_start", { port: 9001 }, {});

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "gateway.start");
      assert.equal(events[0].category, "gateway");
      assert.ok(events[0].description.includes("9001"));
      assert.equal(JSON.parse(events[0].metadata).port, 9001);
    });
  });

  describe("gateway_stop", () => {
    it("records gateway.stop with reason", () => {
      fireHook(api, "gateway_stop", { reason: "SIGTERM" }, {});

      const events = getEvents(dbPath);
      assert.equal(events[0].event_type, "gateway.stop");
      assert.equal(events[0].category, "gateway");
      assert.ok(events[0].description.includes("SIGTERM"));
      assert.equal(JSON.parse(events[0].metadata).reason, "SIGTERM");
    });

    it("handles missing reason", () => {
      fireHook(api, "gateway_stop", {}, {});
      assert.ok(getEvents(dbPath)[0].description.includes("shutdown"));
    });
  });

  describe("fail-open", () => {
    it("does not throw when store is closed", () => {
      store.close();
      fireHook(api, "before_model_resolve", {}, { sessionId: "s1" });
      store = new AuditStore(makeTempDb());
    });
  });
});

// --- Redaction ---

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function readContent(dbPath: string, sequence = 1): string | null {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT content_gz FROM audit_events WHERE sequence = ?").get(sequence) as
    | { content_gz: Uint8Array | null }
    | undefined;
  db.close();
  if (!row?.content_gz) return null;
  return gunzipSync(row.content_gz).toString();
}

describe("redactToolArgs", () => {
  let dbPath: string;
  let store: AuditStore;
  let api: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    api = createMockApi();
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("flag off: tool.invoked metadata.args is sanitized object", () => {
    registerHooks(api, store, undefined, {});
    fireHook(api, "before_tool_call",
      { toolName: "read_file", params: { path: "/tmp/x", apiKey: "secret" } },
      { sessionId: "s1" },
    );
    const meta = JSON.parse(getEvents(dbPath)[0].metadata);
    assert.equal(meta.args.path, "/tmp/x");
    assert.equal(meta.args.apiKey, "[REDACTED]");
    assert.ok(!("hash" in meta.args));
  });

  it("flag on: metadata.args is { hash: 'sha256:<hex>' } only", () => {
    registerHooks(api, store, undefined, { redactToolArgs: true });
    fireHook(api, "before_tool_call",
      { toolName: "read_file", params: { path: "/tmp/x", apiKey: "secret" } },
      { sessionId: "s1" },
    );
    const meta = JSON.parse(getEvents(dbPath)[0].metadata);
    assert.deepEqual(Object.keys(meta.args), ["hash"]);
    assert.match(meta.args.hash, /^sha256:[0-9a-f]{64}$/);
  });

  it("flag on: hash is computed over canonicalized post-sanitize args", () => {
    registerHooks(api, store, undefined, { redactToolArgs: true });
    const params = { path: "/tmp/x", password: "hunter2" };
    fireHook(api, "before_tool_call",
      { toolName: "t", params },
      { sessionId: "s1" },
    );
    const meta = JSON.parse(getEvents(dbPath)[0].metadata);
    const expected = "sha256:" + sha256Hex(sdk.canonicalize({ path: "/tmp/x", password: "[REDACTED]" }));
    assert.equal(meta.args.hash, expected);
  });

  it("flag on: hash is stable across identical inputs", () => {
    registerHooks(api, store, undefined, { redactToolArgs: true });
    fireHook(api, "before_tool_call", { toolName: "t", params: { a: 1 } }, { sessionId: "s1" });
    fireHook(api, "before_tool_call", { toolName: "t", params: { a: 1 } }, { sessionId: "s1" });
    const events = getEvents(dbPath);
    const h1 = JSON.parse(events[0].metadata).args.hash;
    const h2 = JSON.parse(events[1].metadata).args.hash;
    assert.equal(h1, h2);
  });
});

describe("redactPromptText", () => {
  let dbPath: string;
  let store: AuditStore;
  let api: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    api = createMockApi();
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  const contentCases: Array<{
    hook: string;
    event: (content: string) => Record<string, unknown>;
    ctx: Record<string, unknown>;
    eventType: string;
  }> = [
    {
      hook: "llm_input",
      event: (content) => ({ provider: "p", model: "m", prompt: content, historyMessages: [], imagesCount: 0 }),
      ctx: { sessionId: "s1" },
      eventType: "prompt.input",
    },
    {
      hook: "llm_output",
      event: (content) => ({ provider: "p", model: "m", assistantTexts: [content], usage: {} }),
      ctx: { sessionId: "s1" },
      eventType: "prompt.response",
    },
    {
      hook: "message_received",
      event: (content) => ({ from: "user-1", content }),
      ctx: { channelId: "telegram", conversationId: "c1" },
      eventType: "message.received",
    },
    {
      hook: "message_sent",
      event: (content) => ({ to: "user-1", content, success: true }),
      ctx: { channelId: "telegram", conversationId: "c1" },
      eventType: "message.sent",
    },
    {
      hook: "message_sending",
      event: (content) => ({ to: "user-1", content }),
      ctx: { channelId: "discord", conversationId: "c1" },
      eventType: "message.sending",
    },
  ];

  for (const { hook, event, ctx, eventType } of contentCases) {
    it(`flag off: ${eventType} stores plaintext content`, () => {
      registerHooks(api, store, undefined, {});
      const content = `plaintext for ${eventType}`;
      fireHook(api, hook, event(content), ctx);
      assert.equal(readContent(dbPath), content);
    });

    it(`flag on: ${eventType} stores sha256 hash of original content`, () => {
      registerHooks(api, store, undefined, { redactPromptText: true });
      const content = `sensitive prompt for ${eventType}`;
      fireHook(api, hook, event(content), ctx);
      assert.equal(readContent(dbPath), "sha256:" + sha256Hex(content));
    });

    it(`flag on: ${eventType} preserves metadata length fields`, () => {
      registerHooks(api, store, undefined, { redactPromptText: true });
      const content = "a".repeat(100);
      fireHook(api, hook, event(content), ctx);
      const meta = JSON.parse(getEvents(dbPath)[0].metadata);
      const recordedLength =
        meta.contentLength ?? meta.promptLength;
      if (recordedLength !== undefined) assert.equal(recordedLength, 100);
    });
  }

  it("flag on: tool.result content is NOT hashed (category is tool)", () => {
    registerHooks(api, store, undefined, { redactPromptText: true });
    fireHook(api, "after_tool_call",
      { toolName: "bash", durationMs: 10, result: "script output here", params: {} },
      { sessionId: "s1" },
    );
    assert.equal(readContent(dbPath), "script output here");
  });

  it("flag on: prompt event without content is a no-op (prompt.build has no content field)", () => {
    registerHooks(api, store, undefined, { redactPromptText: true });
    fireHook(api, "before_prompt_build",
      { prompt: "short", messages: [] },
      { sessionId: "s1" },
    );
    assert.equal(readContent(dbPath), null);
  });
});
