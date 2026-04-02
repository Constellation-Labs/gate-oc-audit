import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import plugin from "../src/index.js";
import type { OpenClawPluginApi, HookOptions } from "../src/types/openclaw-sdk.js";

const testDbPath = `/tmp/audit-plugin-test-${process.pid}.db`;

function cleanupTestDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = testDbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

function createMockApi(dbPath: string): OpenClawPluginApi & {
  registeredHooks: string[];
  registeredDiagnostics: string[];
} {
  const registeredHooks: string[] = [];
  const registeredDiagnostics: string[] = [];

  return {
    registeredHooks,
    registeredDiagnostics,
    on(hook: string, _handler: unknown, _options?: HookOptions) {
      registeredHooks.push(hook);
    },
    onDiagnosticEvent(event: string, _handler: unknown) {
      registeredDiagnostics.push(event);
    },
    registerService() {},
    registerCli() {},
    registerTool() {},
    config: {
      plugins: {
        entries: {
          "constellation-audit": {
            config: { dbPath },
          },
        },
      },
    },
  } as unknown as OpenClawPluginApi & {
    registeredHooks: string[];
    registeredDiagnostics: string[];
  };
}

describe("plugin entry point", () => {
  afterEach(() => {
    cleanupTestDb();
  });

  it("exports an object with id, name, description", () => {
    assert.equal(plugin.id, "constellation-audit");
    assert.equal(plugin.name, "Constellation Audit Trail");
    assert.ok(plugin.description);
  });

  it("has a register function", () => {
    assert.equal(typeof plugin.register, "function");
  });

  it("register calls api.on for hooks", () => {
    const api = createMockApi(testDbPath);

    plugin.register(api);

    assert.equal(api.registeredHooks.length, 7);
    assert.equal(api.registeredDiagnostics.length, 1);
    assert.ok(api.registeredHooks.includes("before_agent_start"));
    assert.ok(api.registeredDiagnostics.includes("model.usage"));
  });
});
