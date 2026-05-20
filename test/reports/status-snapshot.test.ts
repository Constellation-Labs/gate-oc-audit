import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../../src/store/audit-store.js";
import { SmtService } from "../../src/services/smt-service.js";
import { buildStatusSnapshot, STATUS_SCHEMA_VERSION } from "../../src/reports/status-snapshot.js";
import { formatStatusText } from "../../src/reports/format-status.js";
import type { AnchorHealth } from "../../src/services/de-anchor.js";
import type { GatewayHealth } from "../../src/services/gateway-publisher.js";
import type { RetentionHealth } from "../../src/services/retention.js";

const require2 = createRequire(import.meta.url);
const Ajv2020 = require2("ajv/dist/2020").default;

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-status-")), "test.db");
}

function backdate(dbPath: string, eventId: string, createdAt: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(createdAt, eventId);
  db.close();
}

function makeSmtService(): SmtService {
  return new SmtService({
    smt: {
      checkpointIntervalMs: 0,
      pruneAfterEpochs: 0,
      checkpointDir: `/tmp/smt-status-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

function baseInputs(store: AuditStore, smtService: SmtService, overrides: Partial<Parameters<typeof buildStatusSnapshot>[0]> = {}) {
  const retentionHealth: RetentionHealth = {
    nextPruneAt: "2026-05-20T00:30:00Z",
    retentionDays: 365,
    maxSizeMb: 500,
  };
  return {
    pluginName: "@constellation-network/openclaw-audit-plugin",
    pluginVersion: "0.2.3",
    machineId: "test-machine-01",
    now: new Date("2026-05-20T00:00:00Z"),
    store,
    smtService,
    anchorHealth: undefined,
    gatewayHealth: undefined,
    gatewayUrl: undefined,
    retentionHealth,
    filePatterns: { watched: 0, ignored: 0 },
    inventorySummary: { plugins: 0, skills: 0, tools: 0, soul: 0, crons: 0 },
    allowConversationAccess: false,
    ...overrides,
  };
}

describe("buildStatusSnapshot", () => {
  let dbPath: string;
  let store: AuditStore;
  let smt: SmtService;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    smt = makeSmtService();
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("returns a structurally-complete snapshot on an empty DB", () => {
    const s = buildStatusSnapshot(baseInputs(store, smt));
    assert.equal(s.schemaVersion, STATUS_SCHEMA_VERSION);
    assert.equal(s.storage.eventCount, 0);
    assert.equal(s.storage.oldestEventAt, null);
    assert.equal(s.integrity.sequenceAtHead, 0);
    assert.equal(s.integrity.smtTreeCount, 0);
    assert.equal(s.integrity.smtRoot, null);
    assert.equal(s.integrity.conversationAccess, "disabled");
    assert.equal(s.anchor.isActive, false);
    assert.equal(s.gateway.isActive, false);
    assert.equal(s.securityScan.lastScanAt, null);
  });

  it("reports sequenceAtHead from the most recent event", () => {
    store.append({ eventType: "tool.invoked", category: "tool", description: "a", metadata: {} });
    const last = store.append({ eventType: "tool.invoked", category: "tool", description: "b", metadata: {} });
    const s = buildStatusSnapshot(baseInputs(store, smt));
    assert.equal(s.integrity.sequenceAtHead, last.sequence);
    assert.equal(s.storage.eventCount, 2);
    assert.notEqual(s.storage.oldestEventAt, null);
  });

  it("classifies conversation-access posture", () => {
    // disabled when config flag is false regardless of activity
    store.append({ eventType: "prompt.input", category: "prompt", description: "x", metadata: {} });
    let s = buildStatusSnapshot(baseInputs(store, smt, { allowConversationAccess: false }));
    assert.equal(s.integrity.conversationAccess, "disabled");

    // enabled when config flag is true AND prompt.input observed in last 24h
    s = buildStatusSnapshot(baseInputs(store, smt, { allowConversationAccess: true }));
    assert.equal(s.integrity.conversationAccess, "enabled");
  });

  it("flags allowConversationAccess=true with no prompt.input in 24h as silent", () => {
    // Append a prompt.input event but backdate it >24h before "now" so the
    // 24h window query returns zero — simulates a host that opted in but
    // hasn't seen any conversation traffic recently.
    const ev = store.append({
      eventType: "prompt.input",
      category: "prompt",
      description: "old prompt",
      metadata: {},
    })!;
    backdate(dbPath, ev.id, "2026-05-18T00:00:00.000Z");
    const s = buildStatusSnapshot(baseInputs(store, smt, {
      allowConversationAccess: true,
      now: new Date("2026-05-20T00:00:00Z"),
    }));
    assert.equal(s.integrity.conversationAccess, "enabled-but-silent");
  });

  it("counts file-watch activity in the last 24h", () => {
    // Recent change inside the 24h window
    const recent = store.append({
      eventType: "config.tool_changed",
      category: "config",
      description: "edit",
      metadata: { artifactName: "x", artifactType: "tools", changeType: "modified" },
    })!;
    backdate(dbPath, recent.id, "2026-05-19T12:00:00.000Z");
    // Older change outside the window
    const old = store.append({
      eventType: "config.tool_changed",
      category: "config",
      description: "edit",
      metadata: { artifactName: "x", artifactType: "tools", changeType: "modified" },
    })!;
    backdate(dbPath, old.id, "2026-05-15T12:00:00.000Z");
    const s = buildStatusSnapshot(baseInputs(store, smt, {
      filePatterns: { watched: 3, ignored: 1 },
      now: new Date("2026-05-20T00:00:00Z"),
    }));
    assert.equal(s.fileWatch.patternsWatched, 3);
    assert.equal(s.fileWatch.patternsIgnored, 1);
    assert.equal(s.fileWatch.recentChanges24h, 1);
  });

  it("surfaces anchor and gateway health when present", () => {
    const anchorHealth: AnchorHealth = {
      isActive: true,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      lastAnchorAt: "2026-05-19T09:02:00Z",
      lastTxHash: "0x4a91" + "0".repeat(60) + "e2",
      anchoredToday: 3,
      pendingSinceLastCheckpoint: 12,
    };
    const gatewayHealth: GatewayHealth = {
      isActive: true,
      buffered: 0,
      droppedToday: 0,
      circuitOpen: false,
      lastSuccessAt: "2026-05-19T20:57:00Z",
      lastErrorAt: undefined,
    };
    const s = buildStatusSnapshot(baseInputs(store, smt, {
      anchorHealth,
      gatewayHealth,
      gatewayUrl: "https://gateway.example",
    }));
    assert.equal(s.anchor.isActive, true);
    assert.equal(s.anchor.anchoredToday, 3);
    assert.equal(s.anchor.lastTxHash?.startsWith("0x4a91"), true);
    assert.equal(s.gateway.isActive, true);
    assert.equal(s.gateway.url, "https://gateway.example");
  });

  it("reads the most recent security scan and counts findings by severity", () => {
    const scan = store.append({
      eventType: "security.scan_result",
      category: "security",
      description: "scan",
      metadata: {
        findings: [
          { severity: "high", line: 1, description: "shell injection" },
          { severity: "high", line: 2, description: "command-substitution" },
          { severity: "medium", line: 3, description: "weak regex" },
        ],
      },
    })!;
    backdate(dbPath, scan.id, "2026-05-19T04:00:00.000Z");
    const s = buildStatusSnapshot(baseInputs(store, smt));
    assert.equal(s.securityScan.highFindings, 2);
    assert.equal(s.securityScan.mediumFindings, 1);
    assert.equal(s.securityScan.lastScanAt, "2026-05-19T04:00:00.000Z");
  });
});

describe("formatStatusText", () => {
  let dbPath: string;
  let store: AuditStore;
  let smt: SmtService;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    smt = makeSmtService();
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("renders the seven PRD-mock sections", () => {
    const s = buildStatusSnapshot(baseInputs(store, smt));
    const text = formatStatusText(s);
    assert.match(text, /^@constellation-network\/openclaw-audit-plugin v/);
    assert.match(text, /\nStorage\n/);
    assert.match(text, /\nIntegrity\n/);
    assert.match(text, /\nDigital Evidence anchor\n/);
    assert.match(text, /\nGateway publisher\n/);
    assert.match(text, /\nFile watching\n/);
    assert.match(text, /\nInventory\n/);
    assert.match(text, /Last security scan/);
  });

  it("surfaces the silent conversation-access warning verbatim so operators see it", () => {
    const ev = store.append({
      eventType: "prompt.input",
      category: "prompt",
      description: "old",
      metadata: {},
    })!;
    backdate(dbPath, ev.id, "2026-05-15T00:00:00.000Z");
    const s = buildStatusSnapshot(baseInputs(store, smt, {
      allowConversationAccess: true,
      now: new Date("2026-05-20T00:00:00Z"),
    }));
    const text = formatStatusText(s);
    assert.match(text, /no prompt\.input observed in 24h/);
  });
});

describe("audit-status.schema.json roundtrip", () => {
  let dbPath: string;
  let store: AuditStore;
  let smt: SmtService;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    smt = makeSmtService();
  });
  afterEach(() => {
    store.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it("a snapshot from a populated DB validates against the schema", () => {
    store.append({ eventType: "tool.invoked", category: "tool", description: "t", metadata: { toolName: "exec" } });
    store.append({
      eventType: "security.scan_result",
      category: "security",
      description: "scan",
      metadata: { findings: [{ severity: "high", line: 1, description: "x" }] },
    });

    const anchorHealth: AnchorHealth = {
      isActive: true,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      lastAnchorAt: "2026-05-19T09:02:00Z",
      lastTxHash: null,
      anchoredToday: 1,
      pendingSinceLastCheckpoint: 0,
    };
    const snapshot = buildStatusSnapshot(baseInputs(store, smt, {
      anchorHealth,
      gatewayUrl: "https://example.test",
    }));

    const schemaPath = join(
      dirname(dirname(dirname(new URL(import.meta.url).pathname))),
      "schemas",
      "audit-status.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    const ajv = new Ajv2020({ strict: false, logger: false });
    const validate = ajv.compile(schema);
    // Round-trip through JSON so `undefined` keys get dropped and we match
    // what consumers actually receive over the wire.
    const wireForm = JSON.parse(JSON.stringify(snapshot));
    const ok = validate(wireForm);
    if (!ok) console.error("status schema errors:", validate.errors);
    assert.ok(ok, "status snapshot must validate against published schema");
  });

  it("schema schemaVersion matches the projection's constant", () => {
    const schemaPath = join(
      dirname(dirname(dirname(new URL(import.meta.url).pathname))),
      "schemas",
      "audit-status.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    assert.equal(schema.properties.schemaVersion.const, STATUS_SCHEMA_VERSION);
  });
});
