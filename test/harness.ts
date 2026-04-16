/**
 * Standalone harness that simulates an openclaw session:
 *   1. Creates a temp audit store + SMT service + rate limiter
 *   2. Registers hooks via a mock plugin API
 *   3. Fires a realistic sequence of lifecycle events
 *   4. Prints the audit trail and SMT root
 *
 * Usage:  npx tsx test/harness.ts
 */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../src/store/audit-store.js";
import { SmtService } from "../src/services/smt-service.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { registerHooks } from "../src/hooks.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// ── helpers ──────────────────────────────────────────────────────────

type HookEntry = {
  handler: (event: unknown, ctx: unknown) => unknown;
  options?: { priority?: number };
};

function createMockApi(config: Record<string, unknown> = {}) {
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
    id: "test-harness",
    name: "test-harness",
    source: "test",
    resolvePath: (p: string) => p,
  } as unknown as OpenClawPluginApi & { hooks: Map<string, HookEntry> };
}

function fire(api: ReturnType<typeof createMockApi>, name: string, event: unknown, ctx: unknown = {}) {
  const entry = api.hooks.get(name);
  if (!entry) {
    console.error(`  [skip] hook "${name}" not registered`);
    return;
  }
  entry.handler(event, ctx);
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "audit-harness-"));
  const dbPath = join(dir, "harness.db");
  const checkpointDir = join(dir, "smt-checkpoints");

  console.log("=== Audit Plugin Harness ===\n");
  console.log(`DB:          ${dbPath}`);
  console.log(`Checkpoints: ${checkpointDir}\n`);

  const config: Record<string, unknown> = {
    dbPath,
    smt: { checkpointDir, checkpointIntervalMs: 0 },
  };

  const store = new AuditStore(dbPath);
  const smtService = new SmtService(config);
  const limiter = new RateLimiter(store, config);
  limiter.setSmtService(smtService);

  await smtService.start();

  const api = createMockApi(config);
  registerHooks(api, store, limiter);

  const sessionId = "session-001";
  const ctx = { sessionId, trigger: "user", channelId: "terminal", conversationId: "conv-001" };

  let prevRoot: string | null = null;
  let prevEntryCount = 0;
  let errors = 0;

  function assertSmt(label: string, expectedNewEntries: number) {
    const root = smtService.getRoot();
    if (!root) {
      console.error(`  FAIL [${label}]: no SMT tree exists`);
      errors++;
      return;
    }
    const rootChanged = prevRoot !== null && root.root !== prevRoot;
    const entriesAdded = root.entryCount - prevEntryCount;

    if (root.entryCount === 0) {
      console.error(`  FAIL [${label}]: SMT has 0 entries`);
      errors++;
    } else if (entriesAdded !== expectedNewEntries) {
      console.error(`  FAIL [${label}]: expected ${expectedNewEntries} new entries, got ${entriesAdded} (total: ${root.entryCount})`);
      errors++;
    } else if (prevRoot !== null && !rootChanged) {
      console.error(`  FAIL [${label}]: root did not change after insert`);
      errors++;
    } else {
      console.log(`  OK   [${label}]: +${entriesAdded} entries, root=${root.root.slice(0, 16)}…`);
    }

    prevRoot = root.root;
    prevEntryCount = root.entryCount;
  }

  // ── simulate session lifecycle ──

  console.log("--- Firing events & validating SMT ---\n");

  fire(api, "session_start", { sessionId, sessionKey: "sk-001" }, ctx);
  assertSmt("session_start", 2);

  fire(api, "before_model_resolve", { prompt: "Explain how the audit plugin works" }, ctx);
  assertSmt("before_model_resolve (model_resolve)", 3);

  fire(api, "before_prompt_build", {
    prompt: "Explain how the audit plugin works",
    messages: [{ role: "user", content: "Explain how the audit plugin works" }],
  }, ctx);
  assertSmt("before_prompt_build", 2);

  fire(api, "llm_input", {
    provider: "anthropic",
    model: "claude-opus-4-6",
    prompt: "You are an expert assistant.\n\nExplain how the audit plugin works",
    historyMessages: [],
    imagesCount: 0,
  }, ctx);
  assertSmt("llm_input", 2);

  fire(api, "before_tool_call", {
    toolName: "Read",
    params: { file_path: "/home/user/project/src/index.ts" },
  }, ctx);
  assertSmt("before_tool_call (Read)", 2);

  fire(api, "after_tool_call", {
    toolName: "Read",
    durationMs: 12,
    result: "import { definePluginEntry } from ...",
  }, ctx);
  assertSmt("after_tool_call (Read)", 2);

  fire(api, "before_tool_call", {
    toolName: "Grep",
    params: { pattern: "registerHooks", path: "/home/user/project/src" },
  }, ctx);
  assertSmt("before_tool_call (Grep)", 2);

  fire(api, "after_tool_call", {
    toolName: "Grep",
    durationMs: 45,
    result: "src/hooks.ts:62:export function registerHooks(...)",
  }, ctx);
  assertSmt("after_tool_call (Grep)", 2);

  fire(api, "llm_output", {
    provider: "anthropic",
    model: "claude-opus-4-6",
    assistantTexts: ["The audit plugin captures lifecycle events from openclaw hooks..."],
    usage: { input: 1200, output: 350, cacheRead: 800, cacheWrite: 0 },
  }, ctx);
  assertSmt("llm_output", 2);

  fire(api, "message_received", {
    content: "Now show me the SMT root",
    from: "gabriel",
    metadata: { surface: "terminal" },
    timestamp: Date.now(),
  }, ctx);
  assertSmt("message_received", 2);

  fire(api, "message_sending", {
    content: "Here is the current SMT root...",
    to: "gabriel",
  }, ctx);
  assertSmt("message_sending", 2);

  fire(api, "message_sent", {
    content: "Here is the current SMT root...",
    to: "gabriel",
    success: true,
  }, ctx);
  assertSmt("message_sent", 2);

  fire(api, "before_compaction", {
    messageCount: 20,
    compactingCount: 15,
    tokenCount: 8000,
  }, ctx);
  assertSmt("before_compaction", 2);

  fire(api, "after_compaction", {
    messageCount: 20,
    compactedCount: 15,
    tokenCount: 3000,
  }, ctx);
  assertSmt("after_compaction", 2);

  fire(api, "agent_end", { durationMs: 4200, success: true, messages: [] }, ctx);
  assertSmt("agent_end", 2);

  fire(api, "session_end", { sessionId, sessionKey: "sk-001", messageCount: 6, durationMs: 12000 }, ctx);
  assertSmt("session_end", 2);

  // ── validate every event has a valid SMT proof ──

  const events = store.query({ limit: 100, includeContent: true });
  console.log(`\n--- Audit Store: ${events.length} events ---\n`);
  for (const e of events.reverse()) {
    const time = e.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
    console.log(`  #${e.sequence} ${time} [${e.category}] ${e.eventType} — ${e.description}`);
  }

  // SMT summary
  const trees = smtService.listTrees();
  console.log(`\n--- SMT: ${trees.length} tree(s) ---\n`);
  for (const tree of trees) {
    console.log(`  Tree "${tree.key}": root=${tree.root.slice(0, 24)}…, ${tree.entryCount} entries, ${tree.size} nodes`);
  }

  const root = smtService.getRoot();
  if (root) {
    console.log(`\n  Current root: ${root.root}`);
    console.log(`  Entry count:  ${root.entryCount}`);
  }

  // Verify all events have valid membership proofs
  console.log(`\n--- Proof verification (all ${events.length} events) ---\n`);
  let proofsPassed = 0;
  let proofsFailed = 0;

  for (const event of events) {
    const rawHash = smtService.computeRawHash(event);
    const proof = smtService.createProof(rawHash);
    if (proof && proof.membership && smtService.verifyProofWithRoots(proof).status === "valid") {
      proofsPassed++;
    } else {
      console.error(`  FAIL proof for event #${event.sequence} (${event.eventType}): membership=${proof?.membership}, valid=${proof ? smtService.verifyProofWithRoots(proof).status : "no proof"}`);
      proofsFailed++;
      errors++;
    }

    const censoredHash = smtService.computeCensoredHash(event);
    const censoredProof = smtService.createProof(censoredHash);
    if (censoredProof && censoredProof.membership && smtService.verifyProofWithRoots(censoredProof).status === "valid") {
      proofsPassed++;
    } else {
      console.error(`  FAIL censored proof for event #${event.sequence} (${event.eventType})`);
      proofsFailed++;
      errors++;
    }
  }

  console.log(`  Raw + censored proofs: ${proofsPassed} passed, ${proofsFailed} failed`);

  // Cleanup
  limiter.flush();
  await smtService.stop();
  store.close();

  if (errors > 0) {
    console.error(`\n=== FAILED: ${errors} error(s) ===\n`);
    process.exit(1);
  } else {
    console.log(`\n=== ALL CHECKS PASSED ===\n`);
  }
}

main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(1);
});
