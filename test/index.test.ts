import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import plugin from "../src/index.js";
import { AuditStore } from "../src/store/audit-store.js";

const testDbPath = `/tmp/audit-plugin-test-${process.pid}.db`;

function cleanupTestDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = testDbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

interface RegisteredTool {
  name: string;
  handler: (params: Record<string, unknown>) => unknown;
}

function createMockApi(dbPath: string) {
  const registeredHooks: string[] = [];
  const registeredCli: unknown[] = [];
  const registeredServices: unknown[] = [];
  const registeredTools: RegisteredTool[] = [];

  return {
    registeredHooks,
    registeredCli,
    registeredServices,
    registeredTools,
    on(hook: string) { registeredHooks.push(hook); },
    registerHook() {},
    registerService(s: unknown) { registeredServices.push(s); },
    registerCli(r: unknown, opts?: unknown) { registeredCli.push({ r, opts }); },
    registerTool(tool: RegisteredTool) { registeredTools.push(tool); },
    registerCommand() {},
    registerHttpRoute() {},
    pluginConfig: { dbPath },
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtime: {},
    registrationMode: "full" as const,
    id: "constellation-audit-plugin",
    name: "@constellation-network/openclaw-audit-plugin",
    source: "test",
    resolvePath: (p: string) => p,
  };
}

describe("plugin entry point", () => {
  afterEach(() => {
    cleanupTestDb();
  });

  it("exports id, name, description, register", () => {
    assert.equal(plugin.id, "constellation-audit-plugin");
    assert.equal(plugin.name, "@constellation-network/openclaw-audit-plugin");
    assert.ok(plugin.description);
    assert.equal(typeof plugin.register, "function");
  });

  it("registers hooks, CLI, and services", () => {
    const api = createMockApi(testDbPath);
    plugin.register(api as any);

    assert.equal(api.registeredHooks.length, 26);
    assert.ok(api.registeredHooks.includes("before_model_resolve"));
    assert.ok(api.registeredHooks.includes("llm_output"));
    assert.ok(api.registeredHooks.includes("before_install"));

    assert.equal(api.registeredCli.length, 1);
    assert.equal(api.registeredServices.length, 6); // smt, retention, config-watcher, de-anchor, gateway-publisher, file-watcher

    // audit_smt verify returns unverifiable when no trees exist
    const smtTool = api.registeredTools.find((t) => t.name === "audit_smt");
    assert.ok(smtTool, "audit_smt tool should be registered");

    const result = smtTool.handler({ action: "verify", proof: { root: "ab".repeat(32), key: "00", siblings: [], membership: true } }) as any;
    assert.equal(result.valid, false);
    assert.equal(result.unverifiable, true);
    assert.ok(result.error.includes("No SMT trees or checkpoints"));

    // audit_smt verify rejects foreign root when known roots exist
    // Insert a checkpoint so getCheckpointedRoots() returns a non-empty set
    const helperStore = new AuditStore(testDbPath);
    helperStore.insertCheckpoint("cp-1", 1, 1, "cc".repeat(32), 1, null);
    helperStore.close();

    const foreignResult = smtTool.handler({ action: "verify", proof: { root: "dd".repeat(32), key: "00", siblings: [], membership: true } }) as any;
    assert.equal(foreignResult.valid, false);
    assert.equal(foreignResult.unverifiable, undefined);
    assert.ok(foreignResult.error.includes("does not match any known"));
  });
});
