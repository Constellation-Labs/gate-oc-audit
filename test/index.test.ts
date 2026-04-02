import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import plugin from "../src/index.js";

const testDbPath = `/tmp/audit-plugin-test-${process.pid}.db`;

function cleanupTestDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = testDbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

function createMockApi(dbPath: string) {
  const registeredHooks: string[] = [];
  const registeredCli: unknown[] = [];
  const registeredServices: unknown[] = [];

  return {
    registeredHooks,
    registeredCli,
    registeredServices,
    on(hook: string) { registeredHooks.push(hook); },
    registerHook() {},
    registerService(s: unknown) { registeredServices.push(s); },
    registerCli(r: unknown, opts?: unknown) { registeredCli.push({ r, opts }); },
    registerTool() {},
    registerCommand() {},
    registerHttpRoute() {},
    pluginConfig: { dbPath },
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtime: {},
    registrationMode: "full" as const,
    id: "constellation-audit",
    name: "Constellation Audit Trail",
    source: "test",
    resolvePath: (p: string) => p,
  };
}

describe("plugin entry point", () => {
  afterEach(() => {
    cleanupTestDb();
  });

  it("exports id, name, description, register", () => {
    assert.equal(plugin.id, "constellation-audit");
    assert.equal(plugin.name, "Constellation Audit Trail");
    assert.ok(plugin.description);
    assert.equal(typeof plugin.register, "function");
  });

  it("registers hooks, CLI, and services", () => {
    const api = createMockApi(testDbPath);
    plugin.register(api as any);

    assert.equal(api.registeredHooks.length, 8);
    assert.ok(api.registeredHooks.includes("before_agent_start"));
    assert.ok(api.registeredHooks.includes("llm_output"));

    assert.equal(api.registeredCli.length, 1);
    assert.equal(api.registeredServices.length, 1);
  });
});
