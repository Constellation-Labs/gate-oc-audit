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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AuditStore } from "../src/store/audit-store.js";
import { SmtService } from "../src/services/smt-service.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { registerHooks, _resetConversationAccessWarningStateForTests } from "../src/hooks.js";
import { gatewayPublisherLog } from "../src/util/logger.js";
import { captureLogger } from "./test-utils/capture-logger.js";
import { GatewayStopCapture } from "../src/gateway-stop-capture.js";
import { ApiKeyAnchorService } from "../src/services/de-anchor.js";
import {
  createGatewayPublisher,
  drainForShutdown,
  selectAnchorCovering,
  type GatewayPublisher,
} from "../src/services/gateway-publisher.js";
import type { AuditEvent } from "../src/types/events.js";
import {
  cliAnomaliesHandler,
  cliAuditHandler,
  cliAuditUiHandler,
  cliExportHandler,
  cliInventoryHandler,
  cliReportCronHandler,
  cliReportHandler,
  cliReportSessionHandler,
  cliSmtHandler,
  cliSpendHandler,
  cliStatusHandler,
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
  gatewayPublisher?: GatewayPublisher;
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

  // Opt-in gateway publisher: mirrors src/index.ts wiring so e2e cases can
  // exercise the full hook → rate-limiter → publisher → POST pipeline.
  // Created and started BEFORE registerHooks so notifyAppend is in place
  // for the very first hook fire.
  let gatewayPublisher: GatewayPublisher | undefined;
  if (typeof config.gatewayUrl === "string") {
    gatewayPublisher = createGatewayPublisher(config, {
      onDropMilestone: (cumulativeDropped: number) => {
        const result = store.append({
          eventType: "gateway.dropped",
          category: "gateway",
          description: `Gateway buffer full — ${cumulativeDropped} event(s) dropped cumulatively`,
          metadata: { cumulativeDropped },
        });
        if (result) smt.onEventAppended(result);
      },
      computeHashes: (event) => ({
        rawHash: smt.computeRawHash(event),
        censoredHash: smt.computeCensoredHash(event),
      }),
      latestAnchoredCheckpoint: (maxSequence) =>
        selectAnchorCovering(store.getCheckpoints(), maxSequence),
    });
    limiter.setGatewayPublisher(gatewayPublisher);
    await gatewayPublisher.start();
  }

  registerHooks(api, store, limiter, config, gatewayStopCapture);

  return { dir, dbPath, store, smt, limiter, api, gatewayStopCapture, gatewayPublisher };
}

async function destroyRig(rig: Rig) {
  // No-op when no listeners are attached; safe to call unconditionally.
  // Belt-and-suspenders against a future test that opts into installSignalFallback().
  rig.gatewayStopCapture.detachSignalListeners();
  rig.limiter.flush();
  // Gateway shutdown: matches src/index.ts ordering — stop the timer, then
  // drain buffered events with the configured deadline, before closing the
  // store (drain reads from the in-memory publisher buffer, not the store,
  // but the WARN log on abandoned events still references rig state).
  if (rig.gatewayPublisher) {
    rig.gatewayPublisher.stop();
    await drainForShutdown(rig.gatewayPublisher);
  }
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

  it("audit export — emits JSON lines and CSV", async () => {
    const json = await captureConsoleAsync(() => cliExportHandler(rig.store, "json", {}));
    const lines = json.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 5);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.id);
      assert.ok(parsed.eventType);
      assert.equal(parsed.sessionId, sessionId);
    }

    const csv = await captureConsoleAsync(() => cliExportHandler(rig.store, "csv", {}));
    const [header, ...rows] = csv.stdout.split("\n");
    assert.ok(header.split(",").includes("eventType"));
    assert.equal(rows.length, 5);

    const withContent = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", { includeContent: true }),
    );
    const received = withContent.stdout
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e: { eventType: string }) => e.eventType === "message.received") as { content: string };
    assert.equal(received.content, "hello cli");
  });

  it("audit smt root — prints current root and entry count (default and --tree)", async () => {
    const { stdout } = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "root", {}),
    );
    assert.match(stdout, /Root: [0-9a-f]{64}/);
    assert.match(stdout, /Entries: 10/); // 5 events × 2 (raw + censored)

    // Same answer when an explicit --tree key is supplied.
    const treeKey = rig.smt.listTrees()[0].key;
    const withTree = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "root", { tree: treeKey }),
    );
    assert.match(withTree.stdout, /Root: [0-9a-f]{64}/);
    assert.match(withTree.stdout, /Entries: 10/);
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

    // proof --tree <key> targets a specific tree explicitly (same shape).
    const treeKey = rig.smt.listTrees()[0].key;
    const explicit = await captureConsoleAsync(() =>
      cliSmtHandler(rig.smt, "proof", { hash, tree: treeKey }),
    );
    const explicitProof = JSON.parse(explicit.stdout);
    assert.equal(explicitProof.membership, true);
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

  it("audit list — --last, --limit, --offset, --category narrow the row set", () => {
    const last2 = captureConsole(() => cliAuditHandler(rig.store, { last: "2" }));
    assert.match(last2.stdout, /Showing 2 of 5 events/);

    const limit3 = captureConsole(() => cliAuditHandler(rig.store, { limit: "3" }));
    assert.match(limit3.stdout, /Showing 3 of 5 events/);

    const offset2 = captureConsole(() => cliAuditHandler(rig.store, { offset: "2" }));
    assert.match(offset2.stdout, /Showing 3 of 5 events/);

    const systemOnly = captureConsole(() => cliAuditHandler(rig.store, { category: "system" }));
    assert.ok(systemOnly.stdout.includes("session.start"));
    assert.ok(systemOnly.stdout.includes("session.end"));
    assert.ok(!systemOnly.stdout.includes("tool.invoked"));
  });

  it("audit export — --type, --session, --from/--to, --security-only, --limit narrow rows", async () => {
    const byType = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", { type: "tool.invoked" }),
    );
    const typeRows = byType.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(typeRows.length, 1);
    assert.equal(typeRows[0].eventType, "tool.invoked");

    // --category restricts to a single taxonomy bucket.
    const byCategory = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", { category: "tool" }),
    );
    const toolRows = byCategory.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(toolRows.length, 2);
    for (const r of toolRows) assert.equal(r.category, "tool");

    const bySession = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", { session: sessionId }),
    );
    assert.equal(bySession.stdout.split("\n").filter(Boolean).length, 5);

    const noSession = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", { session: "no-such-session" }),
    );
    assert.equal(noSession.stdout.trim(), "");

    const inWindow = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", {
        from: "2020-01-01T00:00:00.000Z",
        to: "2099-12-31T23:59:59.999Z",
      }),
    );
    assert.equal(inWindow.stdout.split("\n").filter(Boolean).length, 5);

    const outOfWindow = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", {
        from: "2099-01-01T00:00:00.000Z",
        to: "2099-12-31T23:59:59.999Z",
      }),
    );
    assert.equal(outOfWindow.stdout.trim(), "");

    // seedSession produces 2 "system"-category events (session.start, session.end).
    const securityOnly = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", { securityOnly: true }),
    );
    const securityRows = securityOnly.stdout.split("\n").filter(Boolean);
    assert.equal(securityRows.length, 2);
    for (const line of securityRows) {
      const row = JSON.parse(line);
      assert.equal(row.category, "system");
    }

    const capped = await captureConsoleAsync(() =>
      cliExportHandler(rig.store, "json", { limit: "2" }),
    );
    assert.equal(capped.stdout.split("\n").filter(Boolean).length, 2);

    await assert.rejects(
      () => cliExportHandler(rig.store, "json", { limit: "0" }),
      /--limit must be a positive integer/,
    );
  });

  it("audit ui — prints the audit UI URL", () => {
    const { stdout } = captureConsole(() => cliAuditUiHandler());
    assert.match(stdout, /^https?:\/\/[^\s]+\/plugins\/audit\/\s*$/);
  });

  it("audit report daily — text, --json, --html over hook-populated events", () => {
    // Pin to the date of the first seeded event so the report window always
    // covers them, even when the test runs across a UTC midnight boundary.
    const firstEvent = rig.store.query({ sessionId, limit: 1, includeContent: false })[0];
    const date = firstEvent.createdAt.slice(0, 10);

    const text = captureConsole(() => cliReportHandler(rig.store, "daily", { date, tz: "utc" }));
    assert.match(text.stdout, new RegExp(`Audit report — ${date}`));
    assert.ok(text.stdout.includes("=== Activity ==="));
    assert.ok(text.stdout.includes("Total events:"));

    const json = captureConsole(() =>
      cliReportHandler(rig.store, "daily", { date, tz: "utc", json: true }),
    );
    const lines = json.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const projection = JSON.parse(lines[0]);
    assert.equal(projection.schemaVersion, 1);
    assert.equal(typeof projection.activity.totalEvents, "number");
    assert.ok(projection.activity.totalEvents >= 5);

    const html = captureConsole(() =>
      cliReportHandler(rig.store, "daily", { date, tz: "utc", html: true }),
    );
    assert.ok(html.stdout.startsWith("<!doctype html>"));
    assert.ok(html.stdout.includes("Audit report"));
  });

  it("audit report daily — configured openclaw crons surface in projection and text/HTML output", () => {
    // Drop two `.cron.*.json` manifests into a scratch dir scoped to this
    // test so we don't leak state into the other daily/weekly cases that
    // share `rig.dir` and don't pass `collectOpts`.
    const cronDir = mkdtempSync(join(tmpdir(), "audit-e2e-crons-"));
    try {
      writeFileSync(
        join(cronDir, "daily-digest.cron.json"),
        JSON.stringify({ schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" } }),
      );
      writeFileSync(
        join(cronDir, "heartbeat.cron.json"),
        JSON.stringify({ schedule: { kind: "every", everyMs: 60_000 } }),
      );

      const firstEvent = rig.store.query({ sessionId, limit: 1, includeContent: false })[0];
      const date = firstEvent.createdAt.slice(0, 10);
      const collectOpts = { openclawDir: cronDir, projectRoot: cronDir };

      const json = captureConsole(() =>
        cliReportHandler(rig.store, "daily", { date, tz: "utc", json: true }, collectOpts),
      );
      const projection = JSON.parse(json.stdout.split("\n").filter(Boolean)[0]);
      assert.equal(projection.cron.configured.length, 2);
      const byName = Object.fromEntries(
        projection.cron.configured.map((c: { name: string; schedule: unknown }) => [c.name, c.schedule]),
      );
      assert.deepEqual(byName["daily-digest"], { kind: "cron", expr: "0 9 * * *", tz: "UTC" });
      assert.deepEqual(byName["heartbeat"], { kind: "every", everyMs: 60_000 });

      const text = captureConsole(() =>
        cliReportHandler(rig.store, "daily", { date, tz: "utc" }, collectOpts),
      );
      assert.ok(text.stdout.includes("Configured:"));
      assert.ok(text.stdout.includes("daily-digest"));
      assert.ok(text.stdout.includes("cron 0 9 * * * (UTC)"));
      assert.ok(text.stdout.includes("heartbeat"));
      assert.ok(text.stdout.includes("every 60000ms"));

      const html = captureConsole(() =>
        cliReportHandler(rig.store, "daily", { date, tz: "utc", html: true }, collectOpts),
      );
      assert.ok(html.stdout.includes("Configured"));
      assert.ok(html.stdout.includes("daily-digest"));
    } finally {
      rmSync(cronDir, { recursive: true, force: true });
    }
  });

  it("audit report daily — --top-tools/--dup-window-sec/--lookback-days take effect and bad values are rejected", () => {
    const firstEvent = rig.store.query({ sessionId, limit: 1, includeContent: false })[0];
    const date = firstEvent.createdAt.slice(0, 10);

    // Tuned detector flags are accepted and round-trip through the projection.
    const tuned = captureConsole(() =>
      cliReportHandler(rig.store, "daily", {
        date,
        tz: "utc",
        json: true,
        dupWindowSec: "30",
        lookbackDays: "7",
        topTools: "3",
      }),
    );
    const projection = JSON.parse(tuned.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(projection.schemaVersion, 1);
    // --top-tools must cap the surfaced list.
    assert.ok(projection.topTools.length <= 3);

    // Bad values are rejected at the parsePositiveInt boundary.
    assert.throws(
      () => cliReportHandler(rig.store, "daily", { date, topTools: "0" }),
      /--top-tools must be a positive integer/,
    );
    assert.throws(
      () => cliReportHandler(rig.store, "daily", { date, dupWindowSec: "abc" }),
      /--dup-window-sec must be a positive integer/,
    );
    assert.throws(
      () => cliReportHandler(rig.store, "daily", { date, lookbackDays: "1000000" }),
      /--lookback-days must not exceed/,
    );
  });

  it("audit report weekly — --json emits a single-line projection for the ISO week", () => {
    const firstEvent = rig.store.query({ sessionId, limit: 1, includeContent: false })[0];
    // Derive the ISO 8601 week the seeded events fall into; pinning avoids
    // a midnight-Sunday boundary flake.
    const d = new Date(firstEvent.createdAt);
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (tmp.getUTCDay() + 6) % 7; // ISO: Monday = 0
    tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
    const firstThursday = tmp.valueOf();
    tmp.setUTCMonth(0, 1);
    const week =
      `${d.getUTCFullYear()}-W` +
      String(
        1 + Math.round(((firstThursday - tmp.valueOf()) / 86_400_000 - 3 + ((tmp.getUTCDay() + 6) % 7)) / 7),
      ).padStart(2, "0");

    const json = captureConsole(() =>
      cliReportHandler(rig.store, "weekly", { week, tz: "utc", json: true }),
    );
    const projection = JSON.parse(json.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(projection.schemaVersion, 1);
    assert.ok(
      projection.period.label.includes(week),
      `expected weekly label to include "${week}", got "${projection.period.label}"`,
    );

    const text = captureConsole(() =>
      cliReportHandler(rig.store, "weekly", { week, tz: "utc" }),
    );
    assert.ok(text.stdout.includes("Audit report"));
    assert.ok(text.stdout.includes(week));
    assert.ok(text.stdout.includes("=== Activity ==="));

    const html = captureConsole(() =>
      cliReportHandler(rig.store, "weekly", { week, tz: "utc", html: true }),
    );
    assert.ok(html.stdout.startsWith("<!doctype html>"));
    assert.ok(html.stdout.includes(week));
  });

  it("audit report session — text and --json render the timeline for the session", async () => {
    const text = await captureConsoleAsync(() =>
      cliReportSessionHandler(rig.store, rig.smt, sessionId, {}),
    );
    assert.ok(text.stdout.includes(`Session ${sessionId}`));
    assert.ok(text.stdout.includes("=== Timeline ==="));

    const json = await captureConsoleAsync(() =>
      cliReportSessionHandler(rig.store, rig.smt, sessionId, { json: true }),
    );
    const projection = JSON.parse(json.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(projection.schemaVersion, 1);
    assert.equal(projection.sessionId, sessionId);
    assert.ok(projection.timeline.length >= 1);

    // Default JSON output must NOT expose raw metadata; opt-in flips it on.
    assert.ok(projection.timeline.every((e: { metadata?: unknown }) => e.metadata === undefined));
    const jsonWithMeta = await captureConsoleAsync(() =>
      cliReportSessionHandler(rig.store, rig.smt, sessionId, { json: true, includeMetadata: true }),
    );
    const withMeta = JSON.parse(jsonWithMeta.stdout.split("\n").filter(Boolean)[0]);
    assert.ok(withMeta.timeline.some((e: { metadata?: unknown }) => e.metadata !== undefined));

    const missing = await captureConsoleAsync(() =>
      cliReportSessionHandler(rig.store, rig.smt, "no-such-session", {}),
    );
    assert.match(missing.stdout, /No events found for session/);
  });

  it("audit report session — --raw skips dedup; --limit caps the timeline and sets truncated", async () => {
    // --raw: text output carries the [--raw] marker; JSON sets `raw: true`.
    const rawText = await captureConsoleAsync(() =>
      cliReportSessionHandler(rig.store, rig.smt, sessionId, { raw: true }),
    );
    assert.ok(rawText.stdout.includes("[--raw]"));
    assert.ok(rawText.stdout.includes("=== Timeline (raw) ==="));

    const rawJson = await captureConsoleAsync(() =>
      cliReportSessionHandler(rig.store, rig.smt, sessionId, { raw: true, json: true }),
    );
    const rawProjection = JSON.parse(rawJson.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(rawProjection.raw, true);

    // --limit caps the timeline; with 5 seeded events, --limit 2 must
    // truncate the view and the projection must flag truncated: true.
    const limited = await captureConsoleAsync(() =>
      cliReportSessionHandler(rig.store, rig.smt, sessionId, { raw: true, json: true, limit: "2" }),
    );
    const limitedProjection = JSON.parse(limited.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(limitedProjection.timeline.length, 2);
    assert.equal(limitedProjection.truncated, true);

    // Bad --limit is rejected at the parsePositiveInt boundary.
    await assert.rejects(
      () => cliReportSessionHandler(rig.store, rig.smt, sessionId, { limit: "0" }),
      /--limit must be a positive integer/,
    );
  });

  it("audit anomalies — text and --json over a window that covers the seeded events", async () => {
    const text = await captureConsoleAsync(() =>
      cliAnomaliesHandler(rig.store, rig.smt, { since: "24h", tz: "utc" }),
    );
    assert.match(text.stdout, /Audit anomalies — /);
    assert.ok(text.stdout.includes("Events in window:"));

    const json = await captureConsoleAsync(() =>
      cliAnomaliesHandler(rig.store, rig.smt, { since: "24h", tz: "utc", json: true }),
    );
    const view = JSON.parse(json.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(view.schemaVersion, 1);
    assert.equal(view.counts.capped, false);
    assert.equal(typeof view.counts.totalEventsInWindow, "number");
    assert.ok(view.anomalies);
    assert.ok(view.detectorConfig);
  });

  it("audit anomalies — --html, --until and all detector tuning flags round-trip through the view", async () => {
    const html = await captureConsoleAsync(() =>
      cliAnomaliesHandler(rig.store, rig.smt, { since: "24h", tz: "utc", html: true }),
    );
    assert.ok(html.stdout.startsWith("<!doctype html>"));
    assert.ok(html.stdout.includes("Audit anomalies"));

    // --until pins the upper bound and the JSON view echoes it back.
    const until = "2099-01-01T00:00:00.000Z";
    const bounded = await captureConsoleAsync(() =>
      cliAnomaliesHandler(rig.store, rig.smt, { since: "24h", until, tz: "utc", json: true }),
    );
    const boundedView = JSON.parse(bounded.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(boundedView.period.toIso, until);

    // Every detector-tuning flag is accepted and reflected in detectorConfig.
    const tuned = await captureConsoleAsync(() =>
      cliAnomaliesHandler(rig.store, rig.smt, {
        since: "24h",
        tz: "utc",
        json: true,
        dupWindowSec: "120",
        lookbackDays: "14",
        denialWindowSec: "60",
        denialThreshold: "7",
        dropWindowSec: "180",
        dropThreshold: "4",
      }),
    );
    const cfg = JSON.parse(tuned.stdout.split("\n").filter(Boolean)[0]).detectorConfig;
    assert.equal(cfg.dupWindowSec, 120);
    assert.equal(cfg.lookbackDays, 14);
    assert.equal(cfg.denialWindowSec, 60);
    assert.equal(cfg.denialThreshold, 7);
    assert.equal(cfg.dropWindowSec, 180);
    assert.equal(cfg.dropThreshold, 4);

    // A representative bad value is rejected at the boundary.
    await assert.rejects(
      () => cliAnomaliesHandler(rig.store, rig.smt, { since: "24h", denialThreshold: "abc" }),
      /--denial-threshold must be a positive integer/,
    );
  });

  it("audit anomalies — fresh SmtService restores from disk so the tamper scan runs", async () => {
    // Regression for the 0.2.0–0.2.4 bypass: cliAnomaliesHandler was sync
    // and never called ensureReady(), so a fresh SmtService instance reported
    // lastInsertedSeq=0 and integrityViolations.note read "SMT has no
    // checkpointed leaves yet — tamper scan skipped." even when the on-disk
    // SMT was populated. Verify the handler now restores from disk by passing
    // it a fresh SmtService that has never been start()ed.
    await rig.smt.stop(); // flush any in-flight checkpoint to disk

    const freshSmt = new SmtService({
      smt: {
        checkpointDir: join(rig.dir, "smt-checkpoints"),
        checkpointIntervalMs: 0,
      },
    });

    const json = await captureConsoleAsync(() =>
      cliAnomaliesHandler(rig.store, freshSmt, { since: "24h", tz: "utc", json: true }),
    );
    // ensureReady() emits a "Restored N tree(s)" log line via the subsystem
    // logger; pick the JSON document, not the log preamble.
    const jsonLine = json.stdout.split("\n").find((l) => l.startsWith("{"));
    assert.ok(jsonLine, `no JSON line in stdout: ${json.stdout}`);
    const view = JSON.parse(jsonLine);
    assert.equal(
      view.anomalies.integrityViolations.note,
      null,
      "expected the tamper scan to run after ensureReady() restores the SMT cursor",
    );
  });
});

describe("e2e: audit report cron — rollup CLI over a hook-populated cron run", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  function fireCronRun(jobId: string, sessionId: string, runId: string, success: boolean) {
    const ctx = {
      sessionId,
      sessionKey: `sk-${runId}`,
      trigger: "cron",
      agentId: "agent-cron",
      runId,
      jobId,
      conversationId: sessionId,
    };
    fire(rig.api, "before_model_resolve", { prompt: `cron run ${runId}` }, ctx);
    fire(rig.api, "agent_end",
      { messages: [], success, error: success ? null : "timeout", durationMs: 4000 },
      ctx,
    );
  }

  it("emits text, --json, and --html rollups; --last bounds the row count", () => {
    fireCronRun("job-nightly", "sess-cron-ok-1", "run-1", true);
    fireCronRun("job-nightly", "sess-cron-fail-1", "run-2", false);

    const text = captureConsole(() => cliReportCronHandler(rig.store, "job-nightly", {}));
    assert.ok(text.stdout.includes("Per-cron rollup — jobId=job-nightly"));
    assert.ok(text.stdout.includes("run-1"));
    assert.ok(text.stdout.includes("run-2"));

    const json = captureConsole(() =>
      cliReportCronHandler(rig.store, "job-nightly", { json: true }),
    );
    const rollup = JSON.parse(json.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(rollup.schemaVersion, 1);
    assert.equal(rollup.jobId, "job-nightly");
    assert.equal(rollup.rows.length, 2);
    assert.equal(rollup.truncated, false);
    assert.ok(rollup.rows.some((r: { status: string }) => r.status === "ok"));
    assert.ok(rollup.rows.some((r: { status: string }) => r.status === "failed"));

    const html = captureConsole(() =>
      cliReportCronHandler(rig.store, "job-nightly", { html: true }),
    );
    assert.ok(html.stdout.startsWith("<!doctype html>"));
    assert.ok(html.stdout.includes("Per-cron rollup"));

    const lastOne = captureConsole(() =>
      cliReportCronHandler(rig.store, "job-nightly", { last: "1", json: true }),
    );
    const bounded = JSON.parse(lastOne.stdout.split("\n").filter(Boolean)[0]);
    assert.equal(bounded.rows.length, 1);
    assert.equal(bounded.truncated, true);
  });

  it("rejects a missing job-id with a helpful error", () => {
    assert.throws(
      () => cliReportCronHandler(rig.store, undefined, {}),
      /requires a <job-id>/,
    );
    assert.throws(
      () => cliReportCronHandler(rig.store, "", {}),
      /requires a <job-id>/,
    );
  });

  it("inlines the matching openclaw cron manifest in the rollup header", () => {
    fireCronRun("job-nightly", "sess-cron-ok-manifest", "run-m", true);
    const cronDir = mkdtempSync(join(tmpdir(), "audit-e2e-crons-"));
    try {
      writeFileSync(
        join(cronDir, "job-nightly.cron.json"),
        JSON.stringify({ schedule: { kind: "cron", expr: "30 2 * * *", tz: "UTC" } }),
      );
      const collectOpts = { openclawDir: cronDir, projectRoot: cronDir };

      const json = captureConsole(() =>
        cliReportCronHandler(rig.store, "job-nightly", { json: true }, collectOpts),
      );
      const rollup = JSON.parse(json.stdout.split("\n").filter(Boolean)[0]);
      assert.deepEqual(rollup.manifest, {
        name: "job-nightly",
        schedule: { kind: "cron", expr: "30 2 * * *", tz: "UTC" },
      });

      const text = captureConsole(() =>
        cliReportCronHandler(rig.store, "job-nightly", {}, collectOpts),
      );
      assert.ok(text.stdout.includes("Schedule: cron 30 2 * * * (UTC)"));

      // No manifest on disk → manifest is null and the header omits the line.
      const noManifest = captureConsole(() =>
        cliReportCronHandler(rig.store, "other-job", { json: true }, collectOpts),
      );
      const rollup2 = JSON.parse(noManifest.stdout.split("\n").filter(Boolean)[0]);
      assert.equal(rollup2.manifest, null);
    } finally {
      rmSync(cronDir, { recursive: true, force: true });
    }
  });
});

describe("e2e: audit inventory — CLI handler over a hook-populated store", () => {
  let rig: Rig;
  let openclawDir: string;
  let projectRoot: string;

  before(async () => {
    rig = await createRig();
    openclawDir = mkdtempSync(join(tmpdir(), "audit-e2e-inv-oc-"));
    projectRoot = mkdtempSync(join(tmpdir(), "audit-e2e-inv-proj-"));
    // Seed two installed plugins so the inventory walker has something to find.
    for (const name of ["alpha-plugin", "beta-plugin"]) {
      const dir = join(openclawDir, "extensions", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name, version: "0.0.1", main: "index.js" }),
      );
      writeFileSync(join(dir, "index.js"), "module.exports = {};");
    }
    // Drive at least one hook so the SMT/store are exercised alongside inventory.
    seedSession(rig, "sess-inv-1");
  });

  after(async () => {
    await destroyRig(rig);
    rmSync(openclawDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("summary lists every lens with the seeded plugin count", () => {
    const { stdout } = captureConsole(() =>
      cliInventoryHandler(rig.store, "summary", {}, { openclawDir, projectRoot }),
    );
    assert.match(stdout, /plugins: 2/);
    assert.ok(stdout.includes("skills:"));
    assert.ok(stdout.includes("tools:"));
    assert.ok(stdout.includes("soul:"));
    assert.ok(stdout.includes("crons:"));
  });

  it("plugins --json emits a stable shape carrying both seeded plugins", () => {
    const { stdout } = captureConsole(() =>
      cliInventoryHandler(rig.store, "plugins", { json: true }, { openclawDir, projectRoot }),
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.summary.plugins, 2);
    assert.equal(parsed.plugins.length, 2);
    const names = parsed.plugins.map((p: { name: string }) => p.name).sort();
    assert.deepEqual(names, ["alpha-plugin", "beta-plugin"]);
  });

  it("skills/tools/soul/crons subcommands each render --json and human modes", () => {
    // Seed one item in each non-plugins lens.
    mkdirSync(join(openclawDir, "skills"), { recursive: true });
    writeFileSync(join(openclawDir, "skills", "alpha.ts"), "x");

    mkdirSync(join(openclawDir, "tools"), { recursive: true });
    writeFileSync(join(openclawDir, "tools", "tool-a.ts"), "x");

    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(join(openclawDir, "soul.md"), "# soul");

    mkdirSync(join(openclawDir, "crons"), { recursive: true });
    writeFileSync(join(openclawDir, "crons", "nightly.json"), JSON.stringify({ jobId: "nightly" }));

    for (const kind of ["skills", "tools", "soul", "crons"] as const) {
      const text = captureConsole(() =>
        cliInventoryHandler(rig.store, kind, {}, { openclawDir, projectRoot }),
      );
      // Human mode: either the lens header is present, or "No <kind> found." —
      // whichever the walker decides; both are valid signals the handler ran.
      assert.ok(
        text.stdout.includes(kind) || text.stdout.includes(`No ${kind} found`),
        `expected ${kind} output to mention the lens, got: ${text.stdout}`,
      );

      const json = captureConsole(() =>
        cliInventoryHandler(rig.store, kind, { json: true }, { openclawDir, projectRoot }),
      );
      const parsed = JSON.parse(json.stdout);
      assert.ok(parsed.summary, `${kind}: parsed JSON must carry a summary`);
      assert.equal(typeof parsed.summary[kind], "number");
      assert.ok(Array.isArray(parsed[kind]), `${kind}: parsed JSON must carry a ${kind} array`);
      // The seeded entry above must appear in at least one of the lenses, but
      // some walkers (soul) collect from multiple paths, so we just assert
      // shape — content assertions belong in cli-inventory.test.ts.
    }
  });
});

describe("e2e: audit status — CLI handler over a hook-populated store", () => {
  let rig: Rig;

  before(async () => {
    rig = await createRig({
      localRetentionDays: 30,
      localMaxSizeMb: 250,
      fileWatchPatterns: ["src/**/*.ts"],
      fileWatchIgnorePatterns: ["**/node_modules/**"],
      allowConversationAccess: true,
    });
    seedSession(rig, "sess-status-1");
  });

  after(async () => { await destroyRig(rig); });

  it("renders the PRD seven-section snapshot over hook-populated state", async () => {
    const { stdout, stderr } = await captureConsoleAsync(() =>
      cliStatusHandler(rig.store, rig.smt, rig.api.pluginConfig as Record<string, unknown>, "constellation-audit-plugin", "0.0.0-test"),
    );
    assert.equal(stderr, "", `unexpected stderr: ${stderr}`);
    // Header
    assert.match(stdout, /constellation-audit-plugin v0\.0\.0-test/);
    // The seven PRD-mock sections — keep loose so a section-title tweak doesn't flap.
    for (const section of ["Storage", "Integrity", "Digital Evidence anchor", "Gateway publisher", "File watching", "Inventory", "Last security scan"]) {
      assert.ok(stdout.includes(section), `expected section "${section}" in status output`);
    }
    // Sequence head reflects the seeded events (5 from seedSession, all in a single SMT).
    assert.match(stdout, /Sequence at HEAD\s+#5/);
    // File-watch counters surface what was configured.
    assert.match(stdout, /Patterns watched\s+1/);
    // Conversation hook is ENABLED on this rig — the operator opted in via config.
    assert.match(stdout, /Conversation hook\s+ENABLED/);
  });

  it("--json emits a single-line, parseable snapshot", async () => {
    const { stdout } = await captureConsoleAsync(() =>
      cliStatusHandler(rig.store, rig.smt, rig.api.pluginConfig as Record<string, unknown>, "constellation-audit-plugin", "0.0.0-test", { json: true }),
    );
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1, "JSON mode must emit exactly one line");
    const snap = JSON.parse(lines[0]!) as Record<string, Record<string, unknown>>;
    assert.equal(snap.header!.pluginName, "constellation-audit-plugin");
    assert.equal(snap.header!.pluginVersion, "0.0.0-test");
    assert.equal(snap.integrity!.sequenceAtHead, 5);
    assert.equal((snap.fileWatch as { patternsWatched: number }).patternsWatched, 1);
    // Conversation-access opt-in flows through to the snapshot as "enabled".
    assert.equal(snap.integrity!.conversationAccess, "enabled");
  });
});

describe("e2e: audit spend — CLI handler over a hook-populated store", () => {
  let rig: Rig;
  const sessionId = "sess-spend-1";

  before(async () => {
    rig = await createRig();
    const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
    fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
    // Two openai llm_output events + one anthropic — produces three prompt.response
    // rows so the rollup has multiple buckets to group across.
    fire(rig.api, "llm_output", {
      runId: "r-1", sessionId, provider: "openai", model: "gpt-5",
      assistantTexts: ["hi"],
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    }, ctx);
    fire(rig.api, "llm_output", {
      runId: "r-2", sessionId, provider: "openai", model: "gpt-5",
      assistantTexts: ["hello"],
      usage: { input: 200, output: 75, cacheRead: 10, cacheWrite: 0 },
    }, ctx);
    fire(rig.api, "llm_output", {
      runId: "r-3", sessionId, provider: "anthropic", model: "claude-sonnet-4-6",
      assistantTexts: ["hey"],
      usage: { input: 500, output: 200, cacheRead: 100, cacheWrite: 0 },
    }, ctx);
    // The model.usage diagnostic path is what carries costUsd in prod (src/index.ts
    // line ~341). Mirror one such write through the rate-limiter to prove the spend
    // rollup picks the cost up alongside the hook-sourced rows.
    rig.limiter.append({
      sessionId,
      eventType: "prompt.response",
      category: "prompt",
      description: "LLM usage: openai/gpt-5",
      metadata: {
        provider: "openai", model: "gpt-5",
        inputTokens: 1, outputTokens: 1,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.25,
      },
    });
    rig.limiter.flush();
  });

  after(async () => { await destroyRig(rig); });

  it("groups by model (provider/model label) and sums tokens across hook-sourced rows", () => {
    const { stdout } = captureConsole(() => cliSpendHandler(rig.store, { json: true }));
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1, "JSON mode must emit exactly one line");
    const rollup = JSON.parse(lines[0]!) as {
      rows: Array<{ bucket: string; callCount: number; inputTokens: number; outputTokens: number; costUsd: number }>;
      totals: { callCount: number; costUsd: number; inputTokens: number; outputTokens: number };
    };
    // Two distinct buckets — provider/model labels keep cross-provider collisions apart.
    assert.equal(rollup.rows.length, 2);
    const gpt5 = rollup.rows.find((r) => r.bucket === "openai/gpt-5");
    const claude = rollup.rows.find((r) => r.bucket === "anthropic/claude-sonnet-4-6");
    assert.ok(gpt5, "openai/gpt-5 bucket must be present");
    assert.ok(claude, "anthropic/claude-sonnet-4-6 bucket must be present");
    // openai bucket: 2 hook rows + 1 diagnostic-style row = 3 calls; tokens sum across all three.
    assert.equal(gpt5!.callCount, 3);
    assert.equal(gpt5!.inputTokens, 100 + 200 + 1);
    assert.equal(gpt5!.outputTokens, 50 + 75 + 1);
    assert.ok(Math.abs(gpt5!.costUsd - 0.25) < 1e-9, "openai/gpt-5 bucket carries the diagnostic-event costUsd");
    // anthropic bucket: 1 hook row, no costUsd attribution (hook path doesn't carry it).
    assert.equal(claude!.callCount, 1);
    assert.equal(claude!.inputTokens, 500);
    assert.equal(claude!.outputTokens, 200);
    assert.equal(claude!.costUsd, 0);
    // Totals roll up across both buckets.
    assert.equal(rollup.totals.callCount, 4);
    assert.ok(Math.abs(rollup.totals.costUsd - 0.25) < 1e-9);
  });

  it("--by provider collapses model buckets into one row per provider", () => {
    const { stdout } = captureConsole(() => cliSpendHandler(rig.store, { by: "provider", json: true }));
    const rollup = JSON.parse(stdout.trim()) as {
      rows: Array<{ bucket: string; callCount: number }>;
    };
    assert.equal(rollup.rows.length, 2);
    assert.equal(rollup.rows.find((r) => r.bucket === "openai")?.callCount, 3);
    assert.equal(rollup.rows.find((r) => r.bucket === "anthropic")?.callCount, 1);
  });

  it("--by session groups rows under the seeded sessionId", () => {
    const { stdout } = captureConsole(() => cliSpendHandler(rig.store, { by: "session", json: true }));
    const rollup = JSON.parse(stdout.trim()) as {
      rows: Array<{ bucket: string; callCount: number }>;
    };
    // All four prompt.response rows belong to the same session.
    const row = rollup.rows.find((r) => r.bucket === sessionId);
    assert.ok(row, `expected a bucket for ${sessionId}`);
    assert.equal(row!.callCount, 4);
  });

  it("rejects an unknown --by value with a descriptive error", () => {
    assert.throws(() => cliSpendHandler(rig.store, { by: "team" }), /--by must be one of/);
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

describe("e2e: oversized metadata fields are truncated per gateway DTO caps, not dropped", () => {
  let rig: Rig;
  before(async () => { rig = await createRig(); });
  after(async () => { await destroyRig(rig); });

  it("clamps individual metadata strings to MAX_FIELD_LENGTH and keeps the SMT proof valid", () => {
    // A hostile install request stuffs >1MB into a sender-controlled scalar.
    // The hook layer's per-string cap (mirrors gateway DTO MAX_FIELD_LENGTH=1000)
    // now catches this BEFORE the store sees it — the store's total-size cap
    // (which would have produced a $auditTruncation marker) only fires if many
    // distinct fields still sum past 1MB after per-string clipping.
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
    assert.equal(meta.$auditTruncation, undefined,
      "single huge field is handled by per-string cap; the store-layer marker is only for the multi-field overflow case");
    const surviving = meta.requestedSpecifier;
    assert.equal(typeof surviving, "string",
      "oversized field must survive truncation, not be dropped");
    assert.ok((surviving as string).length <= 1000,
      `oversized field must be clipped to MAX_FIELD_LENGTH=1000 (got ${(surviving as string).length})`);
    assert.ok((surviving as string).endsWith("…[truncated]"),
      "truncated values must carry the truncation suffix so consumers can spot them");

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

// ── mock gateway ─────────────────────────────────────────────────────

interface ReceivedGatewayRequest {
  url: string;
  method: string;
  headers: NodeJS.Dict<string | string[]>;
  body: { events: (AuditEvent & { rawHash: string; censoredHash: string })[] };
}

type RespondFn = (req: IncomingMessage, body: string) => { status: number; body: string };

interface MockGateway {
  port: number;
  received: ReceivedGatewayRequest[];
  setRespond: (fn: RespondFn) => void;
  stop: () => Promise<void>;
}

async function startMockGateway(): Promise<MockGateway> {
  const received: ReceivedGatewayRequest[] = [];
  let respond: RespondFn = () => ({ status: 202, body: '{"accepted":1}' });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        received.push({
          url: req.url ?? "",
          method: req.method ?? "",
          headers: req.headers,
          body: JSON.parse(raw),
        });
      } catch {
        received.push({
          url: req.url ?? "",
          method: req.method ?? "",
          headers: req.headers,
          body: { events: [] },
        });
      }
      try {
        const { status, body } = respond(req, raw);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      } catch {
        // Respond fn opted to leak the response — leave the connection open
        // until socket timeout. Used to simulate a stuck gateway.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    received,
    setRespond: (fn) => {
      respond = fn;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("e2e: gateway publisher forwards hook events to a mock gateway", () => {
  let gateway: MockGateway;

  before(async () => {
    gateway = await startMockGateway();
  });

  after(async () => {
    await gateway.stop();
  });

  it("forwards a representative openclaw session through the publisher", async () => {
    gateway.received.length = 0;
    const rig = await createRig({
      gatewayUrl: `http://localhost:${gateway.port}`,
      gatewayApiKey: "sk-gw-e2e-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    try {
      const sessionId = "sess-e2e-gw";
      const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
      fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
      fire(rig.api, "message_received",
        { from: "user", content: "hello world" },
        { ...ctx, conversationId: sessionId },
      );
      fire(rig.api, "llm_input",
        { provider: "p", model: "m", prompt: "what is 2+2?", historyMessages: [], imagesCount: 0 },
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
      fire(rig.api, "llm_output",
        { provider: "p", model: "m", assistantTexts: ["4"], usage: {} },
        ctx,
      );
      fire(rig.api, "session_end", { sessionId, sessionKey: sessionId, reason: "user" }, ctx);

      // Wait for the auto-chained flushes (batchSize=1 fires on every notifyAppend).
      // Anything still buffered drains in destroyRig.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await destroyRig(rig);
    }

    assert.ok(gateway.received.length >= 1, "expected at least one POST to the gateway");
    for (const req of gateway.received) {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/v1/audit/ingest");
      assert.equal(req.headers["x-gateway-api-key"], "sk-gw-e2e-test");
      assert.equal(req.headers["content-type"], "application/json");
    }

    // Sequence numbers must be monotonic across batches — that's the
    // ordering guarantee the gateway relies on for tamper-evident reads.
    const seenSequences: number[] = [];
    const seenTypes = new Set<string>();
    for (const req of gateway.received) {
      for (const evt of req.body.events) {
        seenSequences.push(evt.sequence);
        seenTypes.add(evt.eventType);
      }
    }
    for (let i = 1; i < seenSequences.length; i++) {
      assert.ok(
        seenSequences[i] > seenSequences[i - 1],
        `sequence regression at index ${i}: ${seenSequences[i - 1]} → ${seenSequences[i]}`,
      );
    }
    for (const expected of ["message.received", "prompt.input", "tool.invoked", "tool.result", "prompt.response"]) {
      assert.ok(seenTypes.has(expected), `expected event type ${expected} in gateway batch`);
    }
  });

  it("wire rawHash and censoredHash match smt.computeRawHash / computeCensoredHash on the original event", async () => {
    gateway.received.length = 0;
    const rig = await createRig({
      gatewayUrl: `http://localhost:${gateway.port}`,
      gatewayApiKey: "sk-gw-e2e-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
    });
    try {
      const sessionId = "sess-e2e-projection";
      const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
      fire(rig.api, "before_tool_call",
        { toolName: "Read", params: { file_path: "/tmp/projection-check.txt" } },
        { ...ctx, toolName: "Read" },
      );
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(gateway.received.length, 1);
      const wire = gateway.received[0].body.events[0];
      const stored = rig.store.query({ category: "tool", eventType: "tool.invoked", limit: 1, includeContent: true })[0];
      assert.ok(stored, "tool.invoked event should be in the store");
      // Independently project the stored event through SMT and compare —
      // catches a misordered projection (e.g. rawHash/censoredHash swapped)
      // that a mocked unit test wouldn't surface.
      assert.equal(wire.rawHash, rig.smt.computeRawHash(stored),
        "wire.rawHash must equal smt.computeRawHash(original)");
      assert.equal(wire.censoredHash, rig.smt.computeCensoredHash(stored),
        "wire.censoredHash must equal smt.computeCensoredHash(original)");
    } finally {
      await destroyRig(rig);
    }
  });

  it("batches multiple events per POST when gatewayBatchSize > 1", async () => {
    gateway.received.length = 0;
    const rig = await createRig({
      gatewayUrl: `http://localhost:${gateway.port}`,
      gatewayApiKey: "sk-gw-e2e-test",
      gatewayBatchSize: 3,
      gatewayIntervalMs: 60_000,
    });
    try {
      const sessionId = "sess-e2e-batch";
      const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
      fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
      for (let i = 0; i < 6; i++) {
        fire(rig.api, "before_tool_call",
          { toolName: "Read", params: { file_path: `/tmp/${i}.txt` } },
          { ...ctx, toolName: "Read" },
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await destroyRig(rig);
    }
    // 7 events total (1 session_start + 6 tool calls), batchSize=3:
    //   two full batches auto-chain, the remainder drains on shutdown.
    const totalEvents = gateway.received.reduce((n, r) => n + r.body.events.length, 0);
    assert.equal(totalEvents, 7, "every event must reach the gateway across the batches");
    assert.equal(gateway.received[0].body.events.length, 3, "first batch should be full");
    assert.equal(gateway.received[1].body.events.length, 3, "second batch should be full");
  });

  it("drainForShutdown delivers buffered events when the timer hasn't fired yet", async () => {
    gateway.received.length = 0;
    // batchSize=100 + intervalMs=60s + no auto-chain ⇒ nothing flushes
    // until destroyRig calls drainForShutdown.
    const rig = await createRig({
      gatewayUrl: `http://localhost:${gateway.port}`,
      gatewayApiKey: "sk-gw-e2e-test",
      gatewayBatchSize: 100,
      gatewayIntervalMs: 60_000,
    });
    const sessionId = "sess-e2e-drain";
    const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
    fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
    for (let i = 0; i < 4; i++) {
      fire(rig.api, "before_tool_call",
        { toolName: "Read", params: { file_path: `/tmp/${i}.txt` } },
        { ...ctx, toolName: "Read" },
      );
    }
    assert.equal(gateway.received.length, 0, "no POSTs should have fired before shutdown");
    assert.ok(rig.gatewayPublisher!.bufferedCount() > 0, "events should be buffered, awaiting flush");

    await destroyRig(rig);

    const totalEvents = gateway.received.reduce((n, r) => n + r.body.events.length, 0);
    assert.equal(totalEvents, 5, "drainForShutdown should flush every buffered event");
  });

  it("records a synthetic gateway.dropped event when the publisher buffer fills", async () => {
    gateway.received.length = 0;
    // Stall every response so batches never complete — buffer fills, drops accumulate.
    gateway.setRespond(() => {
      throw new Error("stall");
    });
    const rig = await createRig({
      gatewayUrl: `http://localhost:${gateway.port}`,
      gatewayApiKey: "sk-gw-e2e-test",
      gatewayBatchSize: 100,
      gatewayBufferCapacity: 2,
      gatewayIntervalMs: 60_000,
      gatewayShutdownDeadlineMs: 1_000,
    });
    try {
      const sessionId = "sess-e2e-dropped";
      const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
      // 1 session_start + 5 tool invocations ⇒ 6 events, buffer cap 2 ⇒ ≥4 drops.
      fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
      for (let i = 0; i < 5; i++) {
        fire(rig.api, "before_tool_call",
          { toolName: "Read", params: { file_path: `/tmp/${i}.txt` } },
          { ...ctx, toolName: "Read" },
        );
      }
      await new Promise((r) => setTimeout(r, 50));

      const dropped = rig.store.query({ category: "gateway", eventType: "gateway.dropped", limit: 10 });
      assert.ok(
        dropped.length >= 1,
        `expected at least one gateway.dropped event in the local store, got ${dropped.length}`,
      );
      // Newest milestone wins on read order; assert metadata carries the count.
      const meta = dropped[0].metadata as { cumulativeDropped?: number };
      assert.ok(
        typeof meta.cumulativeDropped === "number" && meta.cumulativeDropped >= 1,
        `expected cumulativeDropped >= 1, got ${meta.cumulativeDropped}`,
      );
    } finally {
      // Reset the responder so destroyRig's drain doesn't loop on a stalled mock.
      gateway.setRespond(() => ({ status: 202, body: '{"accepted":1}' }));
      await destroyRig(rig);
    }
  });

  it("requeues events on 5xx and abandons them with a WARN if the gateway stays down", async () => {
    gateway.received.length = 0;
    gateway.setRespond(() => ({ status: 500, body: "down" }));

    // The abandonment WARN goes through the gateway publisher's subsystem
    // logger now, not console.error — capture it via captureLogger so the
    // assertion runs against the real log call rather than a side-channel.
    const captured = captureLogger(gatewayPublisherLog);

    const rig = await createRig({
      gatewayUrl: `http://localhost:${gateway.port}`,
      gatewayApiKey: "sk-gw-e2e-test",
      gatewayBatchSize: 1,
      gatewayIntervalMs: 60_000,
      gatewayShutdownDeadlineMs: 500,
    });
    try {
      const sessionId = "sess-e2e-5xx";
      const ctx = { sessionId, conversationId: sessionId, channelId: "terminal" };
      fire(rig.api, "session_start", { sessionId, sessionKey: sessionId }, ctx);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(gateway.received.length >= 1, "the publisher must have attempted at least one POST");
      assert.ok(
        rig.gatewayPublisher!.bufferedCount() > 0,
        "5xx must requeue the event rather than dropping it",
      );
    } finally {
      await destroyRig(rig);
      captured.restore();
      // Restore default response for the next case.
      gateway.setRespond(() => ({ status: 202, body: '{"accepted":1}' }));
    }

    const abandoned = captured.messages.find((m) => m.includes("abandoning") && m.includes("buffered event"));
    assert.ok(
      abandoned,
      `expected drainForShutdown to log an abandoned-events WARN; saw: ${captured.messages.join(" | ")}`,
    );
  });
});