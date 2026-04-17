import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../src/store/audit-store.js";
import { cliAuditHandler, cliVerifyHandler, cliExportHandler } from "../src/cli.js";
import type { AuditEventInsert } from "../src/types/events.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-cli-")), "test.db");
}

function insert(store: AuditStore, overrides: Partial<AuditEventInsert> = {}) {
  return store.append({
    sessionId: "sess-1",
    eventType: "session.start",
    category: "system",
    description: "test event",
    metadata: { test: true },
    ...overrides,
  })!;
}

function captureConsole(fn: () => void): { stdout: string; stderr: string } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.info = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origErr;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

async function captureConsoleAsync(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.info = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origErr;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

describe("CLI: audit list", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("shows 'No audit events found' for empty store", () => {
    const { stdout } = captureConsole(() => cliAuditHandler(store, {}));
    assert.ok(stdout.includes("No audit events"));
  });

  it("lists events with sequence numbers", () => {
    insert(store, { description: "first" });
    insert(store, { description: "second" });

    const { stdout } = captureConsole(() => cliAuditHandler(store, {}));
    assert.ok(stdout.includes("#1"));
    assert.ok(stdout.includes("#2"));
    assert.ok(stdout.includes("first"));
    assert.ok(stdout.includes("second"));
  });

  it("respects --last flag", () => {
    for (let i = 0; i < 10; i++) insert(store, { description: `e-${i}` });

    const { stdout } = captureConsole(() => cliAuditHandler(store, { last: "3" }));
    assert.ok(stdout.includes("Showing 3 of 10"));
  });

  it("filters by --type", () => {
    insert(store, { eventType: "session.start" });
    insert(store, { eventType: "tool.invoked", category: "tool", description: "tool event" });

    const { stdout } = captureConsole(() => cliAuditHandler(store, { type: "tool.invoked" }));
    assert.ok(stdout.includes("tool event"));
    assert.ok(!stdout.includes("session.start"));
  });

  it("shows content preview in list output", () => {
    insert(store, { description: "msg", content: "Hello from the content field" });

    const { stdout } = captureConsole(() => cliAuditHandler(store, {}));
    assert.ok(stdout.includes("Hello from the content field"));
  });

  it("filters by --session", () => {
    insert(store, { sessionId: "aaa", description: "match" });
    insert(store, { sessionId: "bbb", description: "no match" });

    const { stdout } = captureConsole(() => cliAuditHandler(store, { session: "aaa" }));
    assert.ok(stdout.includes("match"));
    assert.ok(stdout.includes("Showing 1"));
  });
});

describe("CLI: audit verify", () => {
  let dbPath: string;
  let store: AuditStore;

  const mockSmtService = {
    ensureReady: () => Promise.resolve(),
    listTrees: () => [],
    getRoot: () => null,
    createProof: () => null,
    verifyProof: () => false,
    computeRawHash: () => "aa".repeat(32),
    computeCensoredHash: () => "bb".repeat(32),
  } as any;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("reports status for empty SMT", async () => {
    for (let i = 0; i < 5; i++) insert(store, { metadata: { i } });

    const { stdout } = await captureConsoleAsync(() => cliVerifyHandler(mockSmtService, store));
    assert.ok(stdout.includes("No SMT trees found"));
  });
});

describe("CLI: audit export", () => {
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("exports JSON by default (one JSON object per line)", () => {
    insert(store, { description: "ev1" });
    insert(store, { description: "ev2" });

    const { stdout } = captureConsole(() => cliExportHandler(store));
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 2);

    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed.id);
    assert.ok(parsed.eventType);
  });

  it("exports CSV with format=csv", () => {
    insert(store, { description: "ev1" });
    insert(store, { description: "ev2" });

    const { stdout } = captureConsole(() => cliExportHandler(store, "csv"));
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 3); // header + 2 rows
    assert.ok(lines[0].includes("id,sequence,source"));
    assert.ok(lines[0].includes("metadata"));
    assert.ok(lines[1].includes("ev1"));
  });

  it("excludes content from JSON export by default", () => {
    insert(store, { description: "ev1", content: "full body" });

    const { stdout } = captureConsole(() => cliExportHandler(store));
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.content, undefined);
  });

  it("includes content in JSON export with --include-content", () => {
    insert(store, { description: "ev1", content: "full body" });

    const { stdout } = captureConsole(() =>
      cliExportHandler(store, undefined, { includeContent: true }),
    );
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.content, "full body");
  });

  it("includes content column in CSV export with --include-content", () => {
    insert(store, { description: "ev1", content: "csv body" });

    const { stdout } = captureConsole(() =>
      cliExportHandler(store, "csv", { includeContent: true }),
    );
    const lines = stdout.trim().split("\n");
    assert.ok(lines[0].includes("content"));
    assert.ok(lines[1].includes("csv body"));
  });

  it("filters exports by --type", () => {
    insert(store, { eventType: "session.start" });
    insert(store, { eventType: "tool.invoked", category: "tool" });

    const { stdout } = captureConsole(() =>
      cliExportHandler(store, undefined, { type: "tool.invoked" }),
    );
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("tool.invoked"));
  });
});
