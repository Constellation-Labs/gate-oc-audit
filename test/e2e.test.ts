/**
 * End-to-end tests that simulate openclaw firing realistic lifecycle events
 * through the plugin's hook pipeline (store + rate limiter + SMT service),
 * and verify the full audit trail — including sequencing, content storage,
 * SMT root evolution, and inclusion proofs.
 *
 * These tests use the same hook-registration path the openclaw gateway
 * uses at runtime (api.on via registerHooks) rather than constructing
 * store/limiter calls directly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AuditStore } from "../src/store/audit-store.js";
import { SmtService } from "../src/services/smt-service.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { registerHooks, _resetConversationAccessWarningStateForTests } from "../src/hooks.js";
import { GatewayStopCapture } from "../src/gateway-stop-capture.js";
import { ApiKeyAnchorService } from "../src/services/de-anchor.js";
import {
  cliAuditHandler,
  cliExportHandler,
  cliSmtHandler,
  cliVerifyHandler,
} from "../src/cli.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const require2 = createRequire(import.meta.url);
const sdk = require2("@constellation-network/digital-evidence-sdk") as {
  canonicalize: (obj: unknown) => string;
};

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

// ── mock openclaw API ────────────────────────────────────────────────

type HookEntry = {
  handler: (event: unknown, ctx: unknown) => unknown;
  options?: { priority?: number };
};

type MockApi = OpenClawPluginApi & { hooks: Map<string, HookEntry> };

function createMockApi(config: Record<string, unknown> = {}): MockApi {
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
    pluginConfig: config,
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtime: {},
    registrationMode: "full" as const,
    id: "e2e-test",
    name: "e2e-test",
    source: "test",
    resolvePath: (p: string) => p,
  } as unknown as MockApi;
}

function fire(api: MockApi, name: string, event: unknown, ctx: unknown = {}) {
  const entry = api.hooks.get(name);
  if (!entry) throw new Error(`hook not registered: ${name}`);
  entry.handler(event, ctx);
}

// ── test rig ─────────────────────────────────────────────────────────

interface Rig {
  dir: string;
  dbPath: string;
  store: AuditStore;
  smt: SmtService;
  limiter: RateLimiter;
  api: MockApi;
  gatewayStopCapture: GatewayStopCapture;
}

async function createRig(extra: Record<string, unknown> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "audit-e2e-"));
  const dbPath = join(dir, "audit.db");
  const config: Record<string, unknown> = {
    dbPath,
    smt: {
      checkpointDir: join(dir, "smt-checkpoints"),
      checkpointIntervalMs: 0,
    },
    ...extra,
  };

  const store = new AuditStore(dbPath);
  const smt = new SmtService(config);
  const limiter = new RateLimiter(store, config);
  limiter.setSmtService(smt);

  await smt.start();

  // Each rig is its own "process" semantically: clear the module-scope
  // conversation-access warning flags so tests don't depend on which file
  // ran first under node:test's lexicographic ordering.
  _resetConversationAccessWarningStateForTests();

  const api = createMockApi(config);
  const gatewayStopCapture = new GatewayStopCapture(store);
  registerHooks(api, store, limiter, config, gatewayStopCapture);

  return { dir, dbPath, store, smt, limiter, api, gatewayStopCapture };
}

async function destroyRig(rig: Rig) {
  // No-op when no listeners are attached; safe to call unconditionally.
  // Belt-and-suspenders against a future test that opts into installSignalFallback().
  rig.gatewayStopCapture.detachSignalListeners();
  rig.limiter.flush();
  await rig.smt.stop();
  rig.store.close();
  rmSync(rig.dir, { recursive: true, force: true });
}

// ── scenarios ────────────────────────────────────────────────────────

describe("e2e: openclaw session simulation", () => {
  let rig: Rig;

  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  const sessionId = "sess-e2e-001";
  const ctx = {
    sessionId,
    sessionKey: "sk-001",
    trigger: "user",
    channelId: "terminal",
    conversationId: sessionId,
    agentId: "agent-1",
  };

  it("captures a full user turn (session start → tools → llm → reply → session end)", () => {
    fire(rig.api, "session_start", { sessionId, sessionKey: "sk-001" }, ctx);
    fire(rig.api, "message_received",
      { from: "gabriel", content: "Summarize src/hooks.ts", timestamp: Date.now() },
      ctx,
    );
    fire(rig.api, "before_model_resolve", { prompt: "Summarize src/hooks.ts" }, ctx);
    fire(rig.api, "before_prompt_build", {
      prompt: "Summarize src/hooks.ts",
      messages: [{ role: "user", content: "Summarize src/hooks.ts" }],
    }, ctx);
    fire(rig.api, "llm_input", {
      runId: "r-1", sessionId, provider: "anthropic", model: "claude-sonnet-4-6",
      prompt: "You are an expert assistant.\n\nSummarize src/hooks.ts",
      historyMessages: [], imagesCount: 0,
    }, ctx);
    fire(rig.api, "before_tool_call", {
      toolName: "Read",
      params: { file_path: "/home/gabriel/project/src/hooks.ts" },
    }, { ...ctx, toolName: "Read" });
    fire(rig.api, "after_tool_call", {
      toolName: "Read", durationMs: 12,
      result: "export function registerHooks(api, store, limiter) { ... }",
    }, { ...ctx, toolName: "Read" });
    fire(rig.api, "llm_output", {
      runId: "r-1", sessionId, provider: "anthropic", model: "claude-sonnet-4-6",
      assistantTexts: ["The hooks module subscribes to lifecycle events..."],
      usage: { input: 1500, output: 420, cacheRead: 900, cacheWrite: 0 },
    }, ctx);
    fire(rig.api, "message_sending",
      { to: "gabriel", content: "The hooks module subscribes to..." },
      ctx,
    );
    fire(rig.api, "message_sent",
      { to: "gabriel", content: "The hooks module subscribes to...", success: true },
      ctx,
    );
    fire(rig.api, "agent_end", { messages: [], success: true, durationMs: 3100 }, ctx);
    fire(rig.api, "session_end",
      { sessionId, sessionKey: "sk-001", messageCount: 4, durationMs: 8000 },
      ctx,
    );

    const events = rig.store.query({ sessionId, limit: 100 });
    assert.equal(events.length, 12, "expected 12 events from a full turn");

    const types = events.map((e) => e.eventType);
    assert.deepEqual(types, [
      "session.end",
      "agent.end",
      "message.sent",
      "message.sending",
      "prompt.response",
      "tool.result",
      "tool.invoked",
      "prompt.input",
      "prompt.build",
      "prompt.model_resolve",
      "message.received",
      "session.start",
    ], "default query returns events in descending sequence");

    const ascending = events.slice().reverse();
    for (let i = 1; i < ascending.length; i++) {
      assert.ok(
        ascending[i].sequence > ascending[i - 1].sequence,
        `event ${i} sequence not monotonic`,
      );
    }
  });

  it("stores message content gzipped and decompresses on demand", () => {
    const probe = new DatabaseSync(rig.dbPath);
    let raw: { content_gz: Uint8Array | null };
    try {
      raw = probe
        .prepare(`SELECT content_gz FROM audit_events
                  WHERE event_type = 'message.received' ORDER BY sequence DESC LIMIT 1`)
        .get() as { content_gz: Uint8Array | null };
    } finally {
      probe.close();
    }
    assert.ok(raw.content_gz, "message.received should persist gzipped content");
    assert.equal(gunzipSync(raw.content_gz).toString(), "Summarize src/hooks.ts");

    const [hydrated] = rig.store.query({
      sessionId, eventType: "message.received", limit: 1, includeContent: true,
    });
    assert.equal(hydrated.content, "Summarize src/hooks.ts");
  });

  it("advances the SMT root on every append and produces verifiable proofs", () => {
    const root = rig.smt.getRoot();
    assert.ok(root, "tree should exist after events were appended");
    // Every event contributes 2 SMT entries (raw + censored hash).
    assert.equal(root.entryCount, 24, "entryCount = events * 2");

    const events = rig.store.query({ sessionId, limit: 100, includeContent: true });
    const knownRoots = rig.smt.getKnownRoots();
    let raw = 0, censored = 0;
    for (const evt of events) {
      const r = rig.smt.createProof(rig.smt.computeRawHash(evt));
      assert.ok(r?.membership && rig.smt.verifyProofWithRoots(r, knownRoots).status === "valid",
        `raw proof failed for seq ${evt.sequence}`);
      raw++;

      const c = rig.smt.createProof(rig.smt.computeCensoredHash(evt));
      assert.ok(c?.membership && rig.smt.verifyProofWithRoots(c, knownRoots).status === "valid",
        `censored proof failed for seq ${evt.sequence}`);
      censored++;
    }
    assert.equal(raw + censored, 24);
  });

  it("rejects a proof whose root doesn't match a known root", () => {
    const evt = rig.store.query({ sessionId, limit: 1, includeContent: true })[0];
    const proof = rig.smt.createProof(rig.smt.computeRawHash(evt));
    assert.ok(proof);

    const tampered = { ...proof, root: "dead".repeat(16) };
    const knownRoots = rig.smt.getKnownRoots();
    const result = rig.smt.verifyProofWithRoots(tampered, knownRoots);
    assert.equal(result.status, "invalid");
  });
});

describe("e2e: tool-call sanitization through the hook pipeline", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("redacts sensitive params before they reach the store", () => {
    const sessionId = "sess-sanitize";
    const ctx = { sessionId, toolName: "http_request" };

    fire(rig.api, "before_tool_call", {
      toolName: "http_request",
      params: {
        url: "https://api.example.com/data",
        headers: {
          Authorization: "Bearer sk-live-abc123",
          Accept: "application/json",
        },
        body: { apiKey: "sk-abcdef", user: "gabriel" },
      },
    }, ctx);

    const [evt] = rig.store.query({ sessionId, eventType: "tool.invoked", limit: 1 });
    const meta = evt.metadata as Record<string, unknown>;
    const args = meta.args as Record<string, unknown>;
    const headers = args.headers as Record<string, unknown>;
    const body = args.body as Record<string, unknown>;
    assert.equal(args.url, "https://api.example.com/data");
    assert.equal(headers.Authorization, "[REDACTED]");
    assert.equal(headers.Accept, "application/json");
    assert.equal(body.apiKey, "[REDACTED]");
    assert.equal(body.user, "gabriel");
  });
});

describe("e2e: subagent spawn and completion flow", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("records spawning, delivery, spawned, and ended for a subagent", () => {
    const requesterSessionKey = "sk-parent";
    const childSessionKey = "sk-child";

    fire(rig.api, "subagent_spawning",
      { agentId: "Explore", childSessionKey, label: "find-usages", mode: "run", threadRequested: false },
      { requesterSessionKey },
    );
    fire(rig.api, "subagent_spawned",
      { agentId: "Explore", childSessionKey, runId: "run-42", label: "find-usages", mode: "run", threadRequested: false },
      { requesterSessionKey },
    );
    fire(rig.api, "subagent_delivery_target",
      {
        childSessionKey, requesterSessionKey,
        spawnMode: "run", expectsCompletionMessage: true,
        requesterOrigin: { channel: "terminal", to: "gabriel" },
      },
      { requesterSessionKey },
    );
    fire(rig.api, "subagent_ended",
      {
        targetSessionKey: childSessionKey, targetKind: "subagent",
        reason: "completed", outcome: "ok", runId: "run-42",
      },
      { requesterSessionKey },
    );

    const events = rig.store.query({ sessionId: requesterSessionKey, limit: 10 });
    const types = events.map((e) => e.eventType).reverse();
    assert.deepEqual(types, [
      "agent.subagent_spawning",
      "agent.subagent_spawned",
      "agent.subagent_delivery",
      "agent.subagent_ended",
    ]);

    const ended = events.find((e) => e.eventType === "agent.subagent_ended");
    assert.equal((ended!.metadata as Record<string, unknown>).outcome, "ok");
    assert.equal((ended!.metadata as Record<string, unknown>).runId, "run-42");
  });
});

describe("e2e: multi-session isolation", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("keeps events from different sessions separately queryable but in one SMT", () => {
    for (const [sessionId, prompt] of [
      ["sess-a", "hello from A"],
      ["sess-b", "hello from B"],
      ["sess-c", "hello from C"],
    ] as const) {
      const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
      fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
      fire(rig.api, "message_received",
        { from: "user", content: prompt, timestamp: Date.now() },
        ctx,
      );
      fire(rig.api, "session_end",
        { sessionId, sessionKey: sessionId, messageCount: 1, durationMs: 100 },
        ctx,
      );
    }

    for (const s of ["sess-a", "sess-b", "sess-c"]) {
      const events = rig.store.query({ sessionId: s, limit: 10 });
      assert.equal(events.length, 3, `session ${s} should have 3 events`);
      for (const e of events) assert.equal(e.sessionId, s);
    }

    assert.equal(rig.store.count(), 9);

    const root = rig.smt.getRoot();
    assert.ok(root);
    assert.equal(root.entryCount, 18, "9 events * 2 hashes each");
  });
});

describe("e2e: rate limiter coalesces high-volume events but preserves system ones", () => {
  let rig: Rig;
  before(async () => {
    // Use an explicit low rate so coalescing kicks in deterministically.
    const dir = mkdtempSync(join(tmpdir(), "audit-e2e-ratelimit-"));
    const dbPath = join(dir, "audit.db");
    const config: Record<string, unknown> = {
      dbPath,
      rateLimitPerSec: 3,
      rateLimitBufferSize: 50,
      smt: { checkpointDir: join(dir, "smt-checkpoints"), checkpointIntervalMs: 0 },
    };
    const store = new AuditStore(dbPath);
    const smt = new SmtService(config);
    const limiter = new RateLimiter(store, config);
    limiter.setSmtService(smt);
    await smt.start();
    _resetConversationAccessWarningStateForTests();
    const api = createMockApi(config);
    const gatewayStopCapture = new GatewayStopCapture(store);
    registerHooks(api, store, limiter, {}, gatewayStopCapture);
    rig = { dir, dbPath, store, smt, limiter, api, gatewayStopCapture };
  });
  after(async () => { await destroyRig(rig); });

  it("buffers a tool-call storm but writes session events immediately", () => {
    const sessionId = "sess-storm";
    const ctx = { sessionId, channelId: "terminal", conversationId: sessionId };

    fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);

    for (let i = 0; i < 20; i++) {
      fire(rig.api, "before_tool_call",
        { toolName: "Read", params: { file_path: `/tmp/f${i}.txt` } },
        { ...ctx, toolName: "Read" },
      );
    }

    // session.start is in the "system" full-fidelity category and bypasses coalescing.
    const sysEvents = rig.store.query({ sessionId, category: "system", limit: 10 });
    assert.ok(sysEvents.some((e) => e.eventType === "session.start"),
      "session.start must hit the store immediately even under load");

    // After flush, every buffered tool.invoked event lands (possibly coalesced,
    // but all tool events for this session should be accounted for in the store).
    rig.limiter.flush();
    const toolEvents = rig.store.query({ sessionId, category: "tool", limit: 100 });
    assert.ok(toolEvents.length > 0, "tool events should flush to the store");
  });
});

describe("e2e: gateway lifecycle events are captured", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("records gateway start and stop", () => {
    fire(rig.api, "gateway_start", { port: 9090 }, {});
    fire(rig.api, "gateway_stop", { reason: "SIGTERM" }, {});

    const events = rig.store.query({ category: "gateway", limit: 10 });
    const types = events.map((e) => e.eventType).sort();
    assert.deepEqual(types, ["gateway.start", "gateway.stop"]);

    const start = events.find((e) => e.eventType === "gateway.start")!;
    assert.equal((start.metadata as Record<string, unknown>).port, 9090);
  });
});

describe("e2e: channel inbound → dispatch → message write", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("captures inbound_claim, before_dispatch, and before_message_write", () => {
    const conversationId = "conv-telegram-1";
    const sessionKey = "sk-telegram-1";

    fire(rig.api, "inbound_claim",
      {
        content: "hi bot", channel: "telegram",
        senderId: "tg-user-7", senderName: "Alice", isGroup: false,
      },
      { channelId: "telegram", conversationId },
    );
    fire(rig.api, "before_dispatch",
      {
        content: "hi bot", channel: "telegram",
        senderId: "tg-user-7", isGroup: false,
      },
      { channelId: "telegram", conversationId, sessionKey, senderId: "tg-user-7" },
    );
    fire(rig.api, "before_message_write",
      { message: { role: "assistant", content: "hello" } },
      { sessionKey, agentId: "agent-telegram" },
    );

    const byConv = rig.store.query({ sessionId: conversationId, limit: 10 });
    const claim = byConv.find((e) => e.eventType === "message.claimed");
    assert.ok(claim, "message.claimed should be stored");
    const claimMeta = claim!.metadata as Record<string, unknown>;
    assert.equal(claimMeta.channel, "telegram");
    assert.equal(claimMeta.senderId, "tg-user-7");
    assert.equal(claimMeta.senderName, "Alice");

    const dispatch = byConv.find((e) => e.eventType === "message.dispatched");
    assert.ok(dispatch, "message.dispatched should be stored");
    assert.equal((dispatch!.metadata as Record<string, unknown>).channel, "telegram");

    const write = rig.store.query({ sessionId: sessionKey, eventType: "message.write", limit: 1 });
    assert.equal(write.length, 1);
    assert.equal((write[0].metadata as Record<string, unknown>).agentId, "agent-telegram");
  });
});

describe("e2e: tool_result_persist captures synthetic and real results", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("records both synthetic and real tool.persisted events", () => {
    const sessionKey = "sk-tool-persist";

    fire(rig.api, "tool_result_persist",
      { toolName: "Read", message: { role: "tool", content: "ok" }, isSynthetic: false },
      { sessionKey, toolName: "Read" },
    );
    fire(rig.api, "tool_result_persist",
      { toolName: "Bash", message: { role: "tool", content: "synth" }, isSynthetic: true },
      { sessionKey, toolName: "Bash" },
    );

    const events = rig.store.query({ sessionId: sessionKey, eventType: "tool.persisted", limit: 10 });
    assert.equal(events.length, 2);
    const syntheticFlags = events.map((e) => (e.metadata as Record<string, unknown>).isSynthetic);
    assert.ok(syntheticFlags.includes(true));
    assert.ok(syntheticFlags.includes(false));
  });
});

describe("e2e: compaction and reset flow", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("captures before_compaction, after_compaction, and before_reset", () => {
    const sessionId = "sess-compact";
    const ctx = { sessionId };

    fire(rig.api, "before_compaction",
      { messageCount: 120, compactingCount: 100, tokenCount: 60000 },
      ctx,
    );
    fire(rig.api, "after_compaction",
      { messageCount: 20, compactedCount: 100, tokenCount: 4500 },
      ctx,
    );
    fire(rig.api, "before_reset", { reason: "user:/reset" }, ctx);

    const events = rig.store.query({ sessionId, limit: 10 });
    const types = events.map((e) => e.eventType).reverse();
    assert.deepEqual(types, [
      "agent.compaction_start",
      "agent.compaction_end",
      "agent.reset",
    ]);

    const start = events.find((e) => e.eventType === "agent.compaction_start")!;
    assert.equal((start.metadata as Record<string, unknown>).compactingCount, 100);

    const end = events.find((e) => e.eventType === "agent.compaction_end")!;
    assert.equal((end.metadata as Record<string, unknown>).compactedCount, 100);

    const reset = events.find((e) => e.eventType === "agent.reset")!;
    assert.equal((reset.metadata as Record<string, unknown>).reason, "user:/reset");
  });
});

describe("e2e: redactPromptText hashes prompt/message content end-to-end", () => {
  let rig: Rig;
  before(async () => { rig = await createRig({ redactPromptText: true }); });
  after(async () => { await destroyRig(rig); });

  it("stores sha256 hash instead of plaintext for prompt and message categories, leaves tool content untouched, and SMT proofs still verify", () => {
    const sessionId = "sess-redact-prompt";
    const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };

    const userPrompt = "tell me a secret";
    const llmOut = "I will not.";
    const toolOut = "plain tool output";

    fire(rig.api, "message_received",
      { from: "user", content: userPrompt, timestamp: Date.now() },
      ctx,
    );
    fire(rig.api, "llm_input",
      { runId: "r", sessionId, provider: "anthropic", model: "claude-sonnet-4-6",
        prompt: userPrompt, historyMessages: [], imagesCount: 0 },
      ctx,
    );
    fire(rig.api, "llm_output",
      { runId: "r", sessionId, provider: "anthropic", model: "claude-sonnet-4-6",
        assistantTexts: [llmOut], usage: { input: 10, output: 5 } },
      ctx,
    );
    fire(rig.api, "message_sent",
      { to: "user", content: llmOut, success: true },
      ctx,
    );
    fire(rig.api, "after_tool_call",
      { toolName: "Bash", durationMs: 5, result: toolOut, params: {} },
      { sessionId, toolName: "Bash" },
    );

    const events = rig.store.query({ sessionId, limit: 20, includeContent: true });
    const byType = new Map(events.map((e) => [e.eventType, e]));

    assert.equal(byType.get("message.received")!.content, "sha256:" + sha256Hex(userPrompt));
    assert.equal(byType.get("prompt.input")!.content, "sha256:" + sha256Hex(userPrompt));
    assert.equal(byType.get("prompt.response")!.content, "sha256:" + sha256Hex(llmOut));
    assert.equal(byType.get("message.sent")!.content, "sha256:" + sha256Hex(llmOut));

    // tool.result is category="tool" so its content must NOT be redacted.
    assert.equal(byType.get("tool.result")!.content, toolOut);

    // Length metadata on the redacted prompt/message events is still accurate.
    const promptInput = byType.get("prompt.input")!.metadata as Record<string, unknown>;
    assert.equal(promptInput.promptLength, userPrompt.length);
    const messageReceived = byType.get("message.received")!.metadata as Record<string, unknown>;
    assert.equal(messageReceived.contentLength, userPrompt.length);

    const knownRoots = rig.smt.getKnownRoots();
    for (const e of events) {
      const proof = rig.smt.createProof(rig.smt.computeRawHash(e));
      assert.ok(proof?.membership, `proof missing for seq ${e.sequence}`);
      assert.equal(
        rig.smt.verifyProofWithRoots(proof, knownRoots).status, "valid",
        `proof invalid for seq ${e.sequence} (${e.eventType})`,
      );
    }
  });
});

describe("e2e: redactToolArgs hashes tool.invoked args end-to-end", () => {
  let rig: Rig;
  before(async () => { rig = await createRig({ redactToolArgs: true }); });
  after(async () => { await destroyRig(rig); });

  it("replaces args with { hash } after key sanitization, leaves tool.result unchanged, and SMT proofs still verify", () => {
    const sessionId = "sess-redact-tool";
    const ctx = { sessionId, toolName: "http_request" };

    fire(rig.api, "before_tool_call",
      {
        toolName: "http_request",
        params: {
          url: "https://api.example.com/data",
          headers: { Authorization: "Bearer sk-live", Accept: "application/json" },
        },
      },
      ctx,
    );
    fire(rig.api, "after_tool_call",
      { toolName: "http_request", durationMs: 42, result: "{\"ok\":true}", params: {} },
      ctx,
    );

    const [invoked] = rig.store.query({ sessionId, eventType: "tool.invoked", limit: 1 });
    const args = (invoked.metadata as Record<string, unknown>).args as Record<string, unknown>;
    assert.deepEqual(Object.keys(args), ["hash"]);
    assert.match(args.hash as string, /^sha256:[0-9a-f]{64}$/);

    // Hash must be deterministic over the post-sanitize canonical form.
    const expected = "sha256:" + sha256Hex(sdk.canonicalize({
      url: "https://api.example.com/data",
      headers: { Authorization: "[REDACTED]", Accept: "application/json" },
    }));
    assert.equal(args.hash, expected);

    // tool.result payload is not affected by the redactToolArgs flag.
    const [result] = rig.store.query({ sessionId, eventType: "tool.result", limit: 1, includeContent: true });
    assert.equal(result.content, "{\"ok\":true}");

    const knownRoots = rig.smt.getKnownRoots();
    for (const e of [invoked, result]) {
      const proof = rig.smt.createProof(rig.smt.computeRawHash(e));
      assert.ok(proof?.membership);
      assert.equal(rig.smt.verifyProofWithRoots(proof, knownRoots).status, "valid");
    }
  });
});

// ── CLI helpers ──────────────────────────────────────────────────────

function captureConsole(fn: () => void): { stdout: string; stderr: string } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStdout = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logs.push(typeof chunk === "string" ? chunk.replace(/\n$/, "") : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try { fn(); } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdout;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

async function captureConsoleAsync(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStdout = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logs.push(typeof chunk === "string" ? chunk.replace(/\n$/, "") : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try { await fn(); } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdout;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

function seedSession(rig: Rig, sessionId = "sess-cli") {
  const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
  fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
  fire(rig.api, "message_received",
    { from: "user", content: "hello cli", timestamp: Date.now() },
    ctx,
  );
  fire(rig.api, "before_tool_call",
    { toolName: "Read", params: { file_path: "/tmp/x.txt" } },
    { ...ctx, toolName: "Read" },
  );
  fire(rig.api, "after_tool_call",
    { toolName: "Read", durationMs: 5, result: "file contents", params: {} },
    { ...ctx, toolName: "Read" },
  );
  fire(rig.api, "session_end",
    { sessionId, sessionKey: sessionId, messageCount: 2, durationMs: 100 },
    ctx,
  );
  return sessionId;
}

describe("e2e: CLI handlers run against a store populated by the hook pipeline", () => {
  let rig: Rig;
  let sessionId: string;
  before(async () => {
    rig = await createRig();
    sessionId = seedSession(rig);
  });
  after(async () => { await destroyRig(rig); });

  it("audit list — shows count, event types, and session filter", () => {
    const all = captureConsole(() => cliAuditHandler(rig.store, {}));
    assert.match(all.stdout, /Showing 5 of 5 events/);
    for (const t of ["session.start", "message.received", "tool.invoked", "tool.result", "session.end"]) {
      assert.ok(all.stdout.includes(t), `expected ${t} in output`);
    }

    const filtered = captureConsole(() =>
      cliAuditHandler(rig.store, { type: "tool.invoked" }),
    );
    assert.ok(filtered.stdout.includes("tool.invoked"));
    assert.ok(!filtered.stdout.includes("session.start"));

    const bySession = captureConsole(() =>
      cliAuditHandler(rig.store, { session: sessionId }),
    );
    assert.match(bySession.stdout, /Showing 5 of 5 events/);

    const none = captureConsole(() =>
      cliAuditHandler(rig.store, { session: "no-such-session" }),
    );
    assert.ok(none.stdout.includes("No audit events"));
  });

  it("audit export — emits JSON lines and CSV", () => {
    const json = captureConsole(() => cliExportHandler(rig.store, "json", {}));
    const lines = json.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 5);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.id);
      assert.ok(parsed.eventType);
      assert.equal(parsed.sessionId, sessionId);
    }

    const csv = captureConsole(() => cliExportHandler(rig.store, "csv", {}));
    const [header, ...rows] = csv.stdout.split("\n");
    assert.ok(header.split(",").includes("eventType"));
    assert.equal(rows.length, 5);

    const withContent = captureConsole(() =>
      cliExportHandler(rig.store, "json", { includeContent: true }),
    );
    const received = withContent.stdout
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e: { eventType: string }) => e.eventType === "message.received") as { content: string };
    assert.equal(received.content, "hello cli");
  });

  it("audit smt root — prints current root and entry count", async () => {
    const { stdout } = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "root", {}),
    );
    assert.match(stdout, /Root: [0-9a-f]{64}/);
    assert.match(stdout, /Entries: 10/); // 5 events × 2 (raw + censored)
  });

  it("audit smt trees — lists the tree created by hook activity", async () => {
    const { stdout } = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "trees", {}),
    );
    assert.match(stdout, /entries, .* nodes/);
  });

  it("audit smt proof + verify — full round-trip via CLI handlers", async () => {
    const evt = rig.store.query({ sessionId, limit: 1, includeContent: true })[0];
    const hash = rig.smt.computeRawHash(evt);

    const proofRun = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "proof", { hash }),
    );
    const proof = JSON.parse(proofRun.stdout);
    assert.equal(proof.membership, true);

    const verifyRun = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "verify-proof", { proof: JSON.stringify(proof) }, rig.store),
    );
    assert.ok(verifyRun.stdout.includes("OK"), "verify-proof should report OK");

    const tampered = { ...proof, root: "dead".repeat(16) };
    const beforeCode = process.exitCode;
    const badRun = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "verify-proof", { proof: JSON.stringify(tampered) }, rig.store),
    );
    assert.match(badRun.stderr, /INVALID|UNVERIFIABLE/);
    process.exitCode = beforeCode; // reset so a non-zero code doesn't leak into node:test
  });

  it("audit smt chain — prints chain entries for the session's conversationId", async () => {
    const tree = rig.smt.listTrees()[0];
    const { stdout } = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "chain", { tree: tree.key, conversationId: sessionId }),
    );
    assert.match(stdout, /#\d+/, "chain output should contain sequenced entries");
  });

  it("audit verify — reports SMT trees and sampled proof validity", async () => {
    const beforeCode = process.exitCode;
    const { stdout } = await captureConsoleAsync(() =>
      cliVerifyHandler(rig.smt, rig.store),
    );
    assert.ok(stdout.includes("SMT tree"), "should report the tree");
    assert.match(stdout, /Sampled \d+ event proof\(s\) — all valid/);
    assert.ok(stdout.includes("OK"), "should conclude OK when no proofs fail");
    process.exitCode = beforeCode;
  });
});

describe("e2e: Digital Evidence anchoring publishes SMT roots and persists checkpoints", () => {
  type DeRequest = { body: unknown };
  const received: DeRequest[] = [];
  let server: Server;
  let port: number;

  let rig: Rig;
  let anchor: ApiKeyAnchorService;
  const nextTxHash = { value: "de-tx-hash-e2e" as string | null };

  before(async () => {
    // Local HTTP server standing in for the DE ingestion API.
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => { data += c; });
      req.on("end", () => {
        received.push({ body: data ? JSON.parse(data) : null });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{
          accepted: true,
          hash: nextTxHash.value,
          eventId: "evt-e2e",
          errors: [],
        }]));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
    process.env.DE_TEST_URL = `http://localhost:${port}/v1`;

    rig = await createRig();

    // High threshold so notifyAppend never fires a background anchor
    // (would race with the explicit anchorIfNeeded calls below).
    anchor = new ApiKeyAnchorService(rig.store, {
      deApiKey: "test-key",
      deEnv: "test",
      deOrgId: "11111111-1111-1111-1111-111111111111",
      deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      deEventThreshold: 10_000,
    });
    anchor.setSmtService(rig.smt);
    rig.limiter.setDeAnchor(anchor);
  });

  after(async () => {
    anchor.stop();
    await destroyRig(rig);
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.DE_TEST_URL;
  });

  it("submits a fingerprint to DE when anchoring is triggered and persists a checkpoint", async () => {
    const sessionId = "sess-de-anchor";
    const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };

    fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
    for (let i = 0; i < 4; i++) {
      fire(rig.api, "before_tool_call",
        { toolName: "Read", params: { file_path: `/tmp/f${i}.txt` } },
        { ...ctx, toolName: "Read" },
      );
    }
    // Simulate a timer tick that anchors whatever has accumulated.
    await anchor.anchorIfNeeded(1);

    assert.equal(received.length, 1, "DE API should have been called exactly once");

    const checkpoint = rig.store.getLastCheckpoint();
    assert.ok(checkpoint, "a checkpoint row should be persisted after anchoring");
    assert.equal(checkpoint!.deTxHash, "de-tx-hash-e2e");
    assert.equal(checkpoint!.eventCount, 5);
    assert.equal(checkpoint!.smtRoot, rig.smt.getCurrentSmtRoot());
  });

  it("binds the checkpoint to the SMT root that was current at submission time", () => {
    const checkpoint = rig.store.getLastCheckpoint()!;
    assert.match(checkpoint.smtRoot, /^[0-9a-f]{64}$/);

    const submitted = received[0].body as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(submitted) && submitted.length === 1,
      "DE submission should carry exactly one fingerprint");
    const fingerprint = submitted[0] as Record<string, unknown>;
    // The fingerprint is a signed envelope; it carries the SMT root as documentRef
    // under the document field. We don't reach into the signature — just confirm
    // the submitted payload references the same root we checkpointed.
    const doc = fingerprint.document as Record<string, unknown> | undefined;
    if (doc && typeof doc.documentRef === "string") {
      assert.equal(doc.documentRef, checkpoint.smtRoot);
    }
  });

  it("does not re-anchor when no new events have accumulated since the last checkpoint", async () => {
    const before = received.length;
    await anchor.anchorIfNeeded(1);
    assert.equal(received.length, before, "no fresh events means no new submission");
    assert.equal(rig.store.getCheckpoints().length, 1);
  });

  it("anchors a second batch into a new checkpoint after more events arrive", async () => {
    nextTxHash.value = "de-tx-hash-batch-2";
    const sessionId = "sess-de-anchor-2";
    const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
    for (let i = 0; i < 5; i++) {
      fire(rig.api, "before_tool_call",
        { toolName: "Grep", params: { pattern: `p${i}` } },
        { ...ctx, toolName: "Grep" },
      );
    }
    await anchor.anchorIfNeeded(1);

    const checkpoints = rig.store.getCheckpoints();
    assert.equal(checkpoints.length, 2);
    const latest = checkpoints[checkpoints.length - 1];
    assert.equal(latest.deTxHash, "de-tx-hash-batch-2");
    assert.ok(latest.sequenceEnd > latest.sequenceStart);
  });

  it("audit verify CLI reports anchored checkpoints after DE publish", async () => {
    const { stdout } = await captureConsoleAsync(() =>
      cliVerifyHandler(rig.smt, rig.store),
    );
    assert.match(stdout, /Verifying 2 DE checkpoint\(s\)/);
    assert.match(stdout, /2 anchored to DE/);
    assert.ok(stdout.includes("All checkpoints have DE transaction hashes"));
  });
});

describe("e2e: Digital Evidence anchoring handles failure without crashing the pipeline", () => {
  let server: Server;
  let rig: Rig;
  let anchor: ApiKeyAnchorService;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ accepted: false, errors: ["simulated rejection"] }]));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    process.env.DE_TEST_URL = `http://localhost:${port}/v1`;

    rig = await createRig();
    anchor = new ApiKeyAnchorService(rig.store, {
      deApiKey: "test-key",
      deEnv: "test",
      deOrgId: "11111111-1111-1111-1111-111111111111",
      deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      deEventThreshold: 10_000,
    });
    anchor.setSmtService(rig.smt);
    rig.limiter.setDeAnchor(anchor);
  });

  after(async () => {
    anchor.stop();
    await destroyRig(rig);
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.DE_TEST_URL;
  });

  it("records events normally and leaves no checkpoint when DE rejects", async () => {
    const sessionId = "sess-de-reject";
    const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
    fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
    fire(rig.api, "message_received",
      { from: "user", content: "hi", timestamp: Date.now() },
      ctx,
    );
    fire(rig.api, "message_sent",
      { to: "user", content: "hello", success: true },
      ctx,
    );
    await anchor.anchorIfNeeded(1);

    assert.equal(rig.store.getCheckpoints().length, 0,
      "failed anchor should not persist a checkpoint");
    assert.equal(rig.store.query({ sessionId, limit: 10 }).length, 3,
      "audit events are still captured despite DE rejection");
  });
});

describe("e2e: cron-triggered run captures jobId on cron.executed and cron.failed", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("records cron.executed with jobId and cron.failed with the same jobId on agent failure", () => {
    const sessionId = "sess-cron-1";
    const ctx = {
      sessionId,
      sessionKey: "sk-cron-1",
      trigger: "cron",
      agentId: "agent-cron",
      runId: "r-cron-1",
      jobId: "job-nightly-summary",
    };

    fire(rig.api, "before_model_resolve", { prompt: "Run nightly summary" }, ctx);
    fire(rig.api, "agent_end",
      { messages: [], success: false, error: "timeout", durationMs: 9000 },
      ctx,
    );

    const events = rig.store.query({ sessionId, limit: 10 });
    const executed = events.find((e) => e.eventType === "cron.executed");
    const failed = events.find((e) => e.eventType === "cron.failed");
    assert.ok(executed, "expected cron.executed event");
    assert.ok(failed, "expected cron.failed event");
    assert.equal((executed!.metadata as Record<string, unknown>).jobId, "job-nightly-summary");
    assert.equal((failed!.metadata as Record<string, unknown>).jobId, "job-nightly-summary");
    assert.equal((failed!.metadata as Record<string, unknown>).error, "timeout");
  });
});

describe("e2e: openclaw 2026.4.x correlation fields survive the full pipeline", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("captures runId/jobId/modelProviderId/modelId on agent.end and message correlation fields end-to-end", () => {
    const sessionId = "sess-correlation-1";
    const conversationId = sessionId;
    const ctx = {
      sessionId,
      sessionKey: "sk-corr-1",
      conversationId,
      channelId: "telegram",
      trigger: "user",
      runId: "r-corr-1",
      agentId: "agent-corr",
      modelProviderId: "anthropic",
      modelId: "claude-opus-4-7",
    };

    fire(rig.api, "message_received",
      {
        from: "gabriel", content: "hi",
        threadId: 12345, messageId: "in-1", senderId: "tg-gabriel", timestamp: Date.now(),
      },
      ctx,
    );
    fire(rig.api, "message_sending",
      { to: "gabriel", content: "ok", replyToId: "in-1", threadId: 12345 },
      ctx,
    );
    fire(rig.api, "message_sent",
      { to: "gabriel", content: "ok", success: true, messageId: "out-1" },
      ctx,
    );
    fire(rig.api, "agent_end",
      { messages: [], success: true, durationMs: 800 },
      ctx,
    );

    const inbound = rig.store
      .query({ sessionId: conversationId, eventType: "message.received", limit: 1 })[0];
    const inboundMeta = inbound.metadata as Record<string, unknown>;
    assert.equal(inboundMeta.threadId, 12345);
    assert.equal(inboundMeta.messageId, "in-1");
    assert.equal(inboundMeta.senderId, "tg-gabriel");
    assert.equal(inboundMeta.sessionKey, "sk-corr-1");
    assert.equal(inboundMeta.runId, "r-corr-1");

    const outboundDraft = rig.store
      .query({ sessionId: conversationId, eventType: "message.sending", limit: 1 })[0];
    const outboundDraftMeta = outboundDraft.metadata as Record<string, unknown>;
    assert.equal(outboundDraftMeta.replyToId, "in-1");
    assert.equal(outboundDraftMeta.threadId, 12345);
    assert.equal(outboundDraftMeta.sessionKey, "sk-corr-1");
    assert.equal(outboundDraftMeta.runId, "r-corr-1");

    const outbound = rig.store
      .query({ sessionId: conversationId, eventType: "message.sent", limit: 1 })[0];
    const outboundMeta = outbound.metadata as Record<string, unknown>;
    assert.equal(outboundMeta.messageId, "out-1");
    assert.equal(outboundMeta.sessionKey, "sk-corr-1");
    assert.equal(outboundMeta.runId, "r-corr-1");

    const agentEnd = rig.store
      .query({ sessionId, eventType: "agent.end", limit: 1 })[0];
    const agentMeta = agentEnd.metadata as Record<string, unknown>;
    assert.equal(agentMeta.runId, "r-corr-1");
    assert.equal(agentMeta.modelProviderId, "anthropic");
    assert.equal(agentMeta.modelId, "claude-opus-4-7");
  });

  it("captures sessionFile on compaction/reset and reason+sessionFile on session.end", () => {
    const sessionId = "sess-files-1";
    const ctx = { sessionId };
    const sessionFile = "/var/openclaw/sess-files-1.jsonl";

    fire(rig.api, "before_compaction",
      { messageCount: 10, compactingCount: 8, tokenCount: 4000, sessionFile },
      ctx,
    );
    fire(rig.api, "after_compaction",
      { messageCount: 2, compactedCount: 8, tokenCount: 800, sessionFile },
      ctx,
    );
    fire(rig.api, "before_reset",
      { reason: "idle-timeout", sessionFile },
      ctx,
    );
    fire(rig.api, "session_end",
      {
        sessionId, sessionKey: "sk-files-1", messageCount: 8, durationMs: 12000,
        reason: "reset", sessionFile, transcriptArchived: true,
        nextSessionId: "sess-files-2", nextSessionKey: "sk-files-2",
      },
      ctx,
    );

    const compactStart = rig.store.query({ sessionId, eventType: "agent.compaction_start", limit: 1 })[0];
    assert.equal((compactStart.metadata as Record<string, unknown>).sessionFile, sessionFile);

    const compactEnd = rig.store.query({ sessionId, eventType: "agent.compaction_end", limit: 1 })[0];
    assert.equal((compactEnd.metadata as Record<string, unknown>).sessionFile, sessionFile);

    const reset = rig.store.query({ sessionId, eventType: "agent.reset", limit: 1 })[0];
    const resetMeta = reset.metadata as Record<string, unknown>;
    assert.equal(resetMeta.reason, "idle-timeout");
    assert.equal(resetMeta.sessionFile, sessionFile);

    const sessionEnd = rig.store.query({ sessionId, eventType: "session.end", limit: 1 })[0];
    const endMeta = sessionEnd.metadata as Record<string, unknown>;
    assert.equal(endMeta.reason, "reset");
    assert.equal(endMeta.sessionFile, sessionFile);
    assert.equal(endMeta.transcriptArchived, true);
    assert.equal(endMeta.nextSessionId, "sess-files-2");
    assert.equal(endMeta.nextSessionKey, "sk-files-2");
    assert.ok(sessionEnd.description.includes("reset"),
      "description should reflect the reason when openclaw provides one");
  });

  it("captures threadId/messageId/runId on inbound_claim", () => {
    const conversationId = "conv-claim-1";

    fire(rig.api, "inbound_claim",
      {
        content: "hi bot", channel: "discord",
        senderId: "u-1", senderName: "Alice", isGroup: false,
        threadId: "thread-77", messageId: "claim-1",
      },
      { channelId: "discord", conversationId, sessionKey: "sk-claim-1", runId: "r-claim-1" },
    );

    const claim = rig.store
      .query({ sessionId: conversationId, eventType: "message.claimed", limit: 1 })[0];
    const meta = claim.metadata as Record<string, unknown>;
    assert.equal(meta.threadId, "thread-77");
    assert.equal(meta.messageId, "claim-1");
    assert.equal(meta.sessionKey, "sk-claim-1");
    assert.equal(meta.runId, "r-claim-1");
  });
});

describe("e2e: before_install records system.install events end-to-end", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("records a plugin install with scan summary and SMT-proves the resulting event", () => {
    fire(rig.api, "before_install",
      {
        targetType: "plugin",
        targetName: "@example/cool-plugin",
        sourcePath: "/tmp/cool-plugin",
        sourcePathKind: "directory",
        origin: "npm",
        request: { kind: "plugin-npm", mode: "install", requestedSpecifier: "@example/cool-plugin@1.2.3" },
        builtinScan: { status: "ok", scannedFiles: 12, critical: 0, warn: 1, info: 3, findings: [] },
        plugin: { pluginId: "cool", contentType: "package", packageName: "@example/cool-plugin", version: "1.2.3" },
      },
      { targetType: "plugin", requestKind: "plugin-npm", origin: "npm" },
    );
    fire(rig.api, "before_install",
      {
        targetType: "skill",
        targetName: "code-search",
        sourcePath: "/tmp/code-search",
        sourcePathKind: "directory",
        request: { kind: "skill-install", mode: "install" },
        builtinScan: { status: "ok", scannedFiles: 4, critical: 0, warn: 0, info: 0, findings: [] },
        skill: { installId: "install-abc" },
      },
      {},
    );

    const events = rig.store.query({ category: "system", eventType: "system.install", limit: 10 });
    assert.equal(events.length, 2);
    const targets = events.map((e) => (e.metadata as Record<string, unknown>).targetType).sort();
    assert.deepEqual(targets, ["plugin", "skill"]);

    const pluginInstall = events.find((e) => (e.metadata as Record<string, unknown>).targetType === "plugin")!;
    const pmeta = pluginInstall.metadata as Record<string, unknown>;
    assert.equal(pmeta.targetName, "@example/cool-plugin");
    assert.equal(pmeta.requestKind, "plugin-npm");
    assert.equal(pmeta.requestMode, "install");
    assert.equal(pmeta.requestedSpecifier, "@example/cool-plugin@1.2.3");
    assert.equal(pmeta.pluginId, "cool");
    assert.equal(pmeta.version, "1.2.3");
    assert.equal(pmeta.scanStatus, "ok");
    assert.equal(pmeta.scannedFiles, 12);
    assert.equal(pmeta.scanWarn, 1);

    const skillInstall = events.find((e) => (e.metadata as Record<string, unknown>).targetType === "skill")!;
    assert.equal((skillInstall.metadata as Record<string, unknown>).installId, "install-abc");

    // SMT proof must remain valid for the new event type — confirms the censored
    // hash includes system.install in its category set without breaking the tree.
    const root = rig.smt.getRoot()!;
    const knownRoots = rig.smt.getKnownRoots(rig.store.getCheckpointedRoots());
    for (const evt of events) {
      const censored = rig.smt.computeCensoredHash(evt);
      const proof = rig.smt.createProof(censored);
      assert.ok(proof?.membership, `expected membership proof for ${evt.eventType}`);
      assert.equal(rig.smt.verifyProofWithRoots(proof!, knownRoots).status, "valid");
    }
    assert.ok(root.entryCount > 0);
  });
});

describe("e2e: registration failure on before_install records system.install_hook_unavailable", () => {
  // Simulates an older or future openclaw runtime that throws on unknown hook
  // names. The plugin's outer try/catch must convert the registration miss
  // into an audit row, not a console-only warning.
  it("appends a system.install_hook_unavailable event when api.on throws for before_install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-e2e-fail-"));
    const dbPath = join(dir, "audit.db");
    const config = {
      dbPath,
      smt: { checkpointDir: join(dir, "smt-checkpoints"), checkpointIntervalMs: 0 },
    };
    const store = new AuditStore(dbPath);
    const smt = new SmtService(config);
    const limiter = new RateLimiter(store, config);
    limiter.setSmtService(smt);
    await smt.start();
    _resetConversationAccessWarningStateForTests();

    const hooks = new Map<string, HookEntry>();
    const flakyApi = {
      hooks,
      on(name: string, handler: HookEntry["handler"], opts?: HookEntry["options"]) {
        if (name === "before_install") {
          throw new Error("unknown typed hook: before_install");
        }
        hooks.set(name, { handler, options: opts });
      },
      registerHook() {},
      registerService() {},
      registerCli() {},
      registerTool() {},
      registerCommand() {},
      registerHttpRoute() {},
      pluginConfig: config,
      config: {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      runtime: {},
      registrationMode: "full" as const,
      id: "e2e-flaky",
      name: "e2e-flaky",
      source: "test",
      resolvePath: (p: string) => p,
    } as unknown as MockApi;

    registerHooks(flakyApi, store, limiter, config, new GatewayStopCapture(store));

    const events = store.query({ category: "system", limit: 10 });
    const miss = events.find((e) => e.eventType === "system.install_hook_unavailable");
    assert.ok(miss, "expected a system.install_hook_unavailable audit row");
    // Category MUST stay "system" so the row bypasses rate-limit coalescing
    // (see FULL_FIDELITY_CATEGORIES in src/rate-limiter.ts). If a future change
    // moves it to e.g. "agent", a burst of registration failures would coalesce
    // into a summary row and the operator's forensic signal would be lost.
    assert.equal(miss!.category, "system");
    assert.ok(
      ((miss!.metadata as Record<string, unknown>).error as string).includes("before_install"),
      "metadata should record the underlying error",
    );

    limiter.flush();
    await smt.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("e2e: oversized metadata is recorded with a truncation marker rather than dropped", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("preserves the audit signal AND keeps the SMT proof valid when sender-controlled fields blow past the 1MB metadata cap", () => {
    // A hostile install request stuffs >1MB into a sender-controlled scalar.
    const hostileSpecifier = "x".repeat(1024 * 1024 + 100);
    fire(rig.api, "before_install",
      {
        targetType: "plugin",
        targetName: "@example/large",
        sourcePath: "/tmp/large",
        sourcePathKind: "directory",
        request: {
          kind: "plugin-npm",
          mode: "install",
          requestedSpecifier: hostileSpecifier,
        },
        builtinScan: { status: "ok", scannedFiles: 1, critical: 0, warn: 0, info: 0, findings: [] },
      },
      {},
    );

    const events = rig.store.query({ category: "system", eventType: "system.install", limit: 10 });
    assert.equal(events.length, 1,
      "event must still be recorded — silent skipping would erase forensic signal");
    const meta = events[0].metadata as Record<string, unknown>;
    const marker = meta.$auditTruncation as Record<string, unknown>;
    assert.ok(marker, "marker must live under reserved $auditTruncation key");
    assert.equal(marker.reason, "size-cap");
    assert.ok(typeof marker.originalSize === "number");
    assert.equal("requestedSpecifier" in meta, false,
      "oversized field must not survive truncation");

    // Tamper-evidence regression guard: SMT membership proof must still
    // verify against the persisted row. Earlier versions of this code
    // returned the original metadata to the SMT pipeline while persisting
    // the marker, producing a hash mismatch that broke proofs for every
    // truncated row.
    const knownRoots = rig.smt.getKnownRoots(rig.store.getCheckpointedRoots());
    const rawHash = rig.smt.computeRawHash(events[0]);
    const proof = rig.smt.createProof(rawHash);
    assert.ok(proof?.membership,
      "expected membership proof for the truncated row — store and SMT diverged");
    assert.equal(rig.smt.verifyProofWithRoots(proof!, knownRoots).status, "valid");
  });

});

describe("e2e: every PluginHookName is registered and exercised", () => {
  // Guard test: if openclaw adds a new hook or we forget to cover one in e2e,
  // this test fails loudly. The e2e file must exercise each hook at least once.
  const ALL_HOOKS = [
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
    "before_install",
  ];

  it("the e2e file fires each hook at least once", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL(import.meta.url), "utf-8");
    for (const hook of ALL_HOOKS) {
      assert.ok(
        src.includes(`fire(rig.api, "${hook}"`),
        `e2e coverage missing for hook: ${hook}`,
      );
    }
  });
});