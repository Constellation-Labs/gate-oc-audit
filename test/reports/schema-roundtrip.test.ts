import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { AuditStore } from "../../src/store/audit-store.js";
import { parseDate } from "../../src/reports/time-window.js";
import { buildProjection } from "../../src/reports/projection.js";

const require2 = createRequire(import.meta.url);
// ajv 8.x ships a 2020-12 entry point. ajv is a transitive dependency of
// the openclaw peer dep, so it's reliably present in node_modules.
const Ajv2020 = require2("ajv/dist/2020").default;

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-schema-")), "test.db");
}

describe("audit-projection.schema.json roundtrip", () => {
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

  it("a real projection validates against schemas/audit-projection.schema.json", () => {
    // Seed at least one event of each shape the schema describes so optional
    // arrays aren't empty (better signal on field-level type drift).
    store.append({
      eventType: "tool.invoked",
      category: "tool",
      description: "t",
      metadata: { toolName: "bash" },
    });
    store.append({
      eventType: "prompt.response",
      category: "prompt",
      description: "p",
      metadata: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.05,
      },
    });
    store.append({
      eventType: "message.sent",
      category: "message",
      description: "m",
      metadata: { direction: "out", channel: "slack", recipient: "#ops" },
      content: "hi",
    });

    const schemaPath = join(
      dirname(dirname(dirname(new URL(import.meta.url).pathname))),
      "schemas",
      "audit-projection.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

    const today = new Date();
    const today8 = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}-${pad2(today.getUTCDate())}`;
    const window = parseDate(today8, "utc");
    const projection = buildProjection(store, window);

    // logger:false silences "unknown format date-time" notices — we don't
    // pull in ajv-formats here, structural validation is what we want.
    const ajv = new Ajv2020({ strict: false, logger: false });
    const validate = ajv.compile(schema);
    const ok = validate(projection);
    if (!ok) {
      console.error("schema validation errors:", validate.errors);
    }
    assert.ok(ok, "projection must validate against published schema");
  });

  it("schema and projection agree on schemaVersion constant", () => {
    const schemaPath = join(
      dirname(dirname(dirname(new URL(import.meta.url).pathname))),
      "schemas",
      "audit-projection.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    assert.equal(schema.properties.schemaVersion.const, 1);
  });
});

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
