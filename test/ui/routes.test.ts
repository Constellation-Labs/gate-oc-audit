/**
 * UI server tests — Tier 1 (HTTP route shapes) and Tier 2 (verification
 * semantics + Verifier service). Each describe block builds its own rig
 * (fresh tmp dir / DB / SMT) so the cases can mutate state without bleeding
 * into neighbors.
 *
 * Approach: register the plugin's HTTP routes against a real http.Server on
 * an ephemeral port, then exercise them via fetch. This catches header,
 * content-type, streaming, and prefix-routing bugs that a mock req/res
 * couldn't.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AuditStore } from "../../src/store/audit-store.js";
import { SmtService } from "../../src/services/smt-service.js";
import { Verifier } from "../../src/services/verifier.js";
import { registerAuditUiRoutes } from "../../src/ui/routes.js";
import type { AuditEvent, AuditEventInsert } from "../../src/types/events.js";

type RouteEntry = {
  path: string;
  match?: "exact" | "prefix";
  auth: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
};

interface UiRig {
  dir: string;
  store: AuditStore;
  smt: SmtService;
  verifier: Verifier;
  server: Server;
  baseUrl: string;
  /** Append + insert into SMT, like the rate-limiter does. */
  appendTracked: (insert: AuditEventInsert) => AuditEvent;
  /** Append only, bypass SMT — for untracked-status tests. */
  appendUntracked: (insert: AuditEventInsert) => AuditEvent;
  destroy: () => Promise<void>;
}

async function createUiRig(opts: { deBaseUrl?: string } = {}): Promise<UiRig> {
  const dir = mkdtempSync(join(tmpdir(), "audit-ui-test-"));
  const dbPath = join(dir, "audit.db");
  const config = {
    dbPath,
    smt: { checkpointDir: join(dir, "smt-checkpoints"), checkpointIntervalMs: 0 },
  };

  const store = new AuditStore(dbPath);
  const smt = new SmtService(config);
  await smt.start();
  const verifier = new Verifier(store, smt);

  const routes: RouteEntry[] = [];
  const api = { registerHttpRoute: (r: RouteEntry) => { routes.push(r); } };
  registerAuditUiRoutes(api as never, store, smt, verifier, opts.deBaseUrl);

  // Longest path wins so /plugins/audit/api/ matches before /plugins/audit/.
  routes.sort((a, b) => b.path.length - a.path.length);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      for (const route of routes) {
        const ok = route.match === "exact"
          ? url.pathname === route.path
          : url.pathname.startsWith(route.path);
        if (!ok) continue;
        const handled = await route.handler(req, res);
        if (handled || res.headersSent || res.writableEnded) return;
      }
      if (!res.headersSent) {
        res.statusCode = 404;
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : String(err));
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const appendTracked = (insert: AuditEventInsert): AuditEvent => {
    const ev = store.append(insert);
    if (!ev) throw new Error("store.append returned undefined");
    smt.onEventAppended(ev);
    return ev;
  };
  const appendUntracked = (insert: AuditEventInsert): AuditEvent => {
    const ev = store.append(insert);
    if (!ev) throw new Error("store.append returned undefined");
    return ev;
  };

  const destroy = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await smt.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { dir, store, smt, verifier, server, baseUrl, appendTracked, appendUntracked, destroy };
}

const sampleInsert = (overrides: Partial<AuditEventInsert> = {}): AuditEventInsert => ({
  eventType: "session.start",
  category: "agent",
  description: "test event",
  metadata: {},
  ...overrides,
});

// ───────────────────────────────────────────────────────────────────────────
// Tier 1 — HTTP route shapes
// ───────────────────────────────────────────────────────────────────────────

describe("ui: events list endpoint", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("returns empty list when no events", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    const json = await res.json();
    assert.deepEqual(json.events, []);
    assert.equal(json.total, 0);
    assert.equal(json.limit, 10);
    assert.equal(json.offset, 0);
    assert.equal(json.degraded, false);
  });

  it("returns events with verification field and default page size 10", async () => {
    for (let i = 0; i < 12; i++) {
      rig.appendTracked(sampleInsert({ description: `event #${i}` }));
    }
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events`);
    const json = await res.json();
    assert.equal(json.events.length, 10);
    assert.equal(json.total, 12);
    for (const ev of json.events) {
      assert.ok(ev.verification, "every event carries a verification field");
      assert.ok(["verified", "pending", "tampered", "untracked"].includes(ev.verification.status));
    }
  });

  it("honours type/category/session filters", async () => {
    const session = "sess-xyz";
    rig.appendTracked(sampleInsert({ eventType: "agent.end", category: "agent", sessionId: session, description: "ended" }));

    const byType = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events?type=agent.end`)).json();
    assert.ok(byType.events.every((e: AuditEvent) => e.eventType === "agent.end"));

    const bySession = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events?session=${session}`)).json();
    assert.ok(bySession.events.every((e: AuditEvent) => e.sessionId === session));
    assert.ok(bySession.events.length >= 1);
  });

  it("clamps limit to [1,100]", async () => {
    const tooHigh = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events?limit=9999`)).json();
    assert.equal(tooHigh.limit, 100);
    const tooLow = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events?limit=0`)).json();
    assert.equal(tooLow.limit, 1);
  });
});

describe("ui: single event detail endpoint", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("returns the full event including content", async () => {
    const ev = rig.appendTracked(sampleInsert({ content: "full body text", description: "with content" }));
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events/${ev.id}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.event.id, ev.id);
    assert.equal(json.event.content, "full body text");
  });

  it("returns 404 for unknown id", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events/does-not-exist`);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error, "event not found");
  });
});

describe("ui: per-event verify endpoint", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig({ deBaseUrl: "https://example.test" }); });
  after(async () => { await rig.destroy(); });

  it("returns rawHash, censoredHash, valid proof, and deBaseUrl", async () => {
    const ev = rig.appendTracked(sampleInsert({ content: "hello" }));
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events/${ev.id}/verify`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.match(json.rawHash, /^[0-9a-f]{64}$/);
    assert.match(json.censoredHash, /^[0-9a-f]{64}$/);
    assert.ok(json.proof);
    assert.equal(json.proof.membership, true);
    assert.equal(json.verification.status, "valid");
    assert.equal(json.deBaseUrl, "https://example.test");
    assert.equal(json.anchoredAt, null); // no DE-anchored checkpoint yet
  });

  it("reports anchoredAt when a DE-anchored checkpoint covers the event", async () => {
    const ev = rig.appendTracked(sampleInsert({ content: "anchored" }));
    const root = rig.smt.getRoot()?.root ?? "";
    rig.store.insertCheckpoint("cp-anchor", ev.sequence, ev.sequence, root, 1, "0xfeedface");
    const json = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events/${ev.id}/verify`)).json();
    assert.ok(json.anchoredAt);
    assert.equal(json.anchoredAt.deTxHash, "0xfeedface");
    assert.equal(json.anchoredAt.checkpointId, "cp-anchor");
  });
});

describe("ui: trees and checkpoints endpoints", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig({ deBaseUrl: "https://digitalevidence.example" }); });
  after(async () => { await rig.destroy(); });

  it("trees endpoint reflects SMT state", async () => {
    rig.appendTracked(sampleInsert());
    const json = await (await fetch(`${rig.baseUrl}/plugins/audit/api/trees`)).json();
    assert.ok(Array.isArray(json.trees));
    assert.ok(json.trees.length >= 1);
    const t = json.trees[0];
    assert.match(t.root, /^[0-9a-f]+$/);
    assert.ok(t.entryCount >= 1);
  });

  it("checkpoints endpoint includes deBaseUrl", async () => {
    rig.store.insertCheckpoint("cp-1", 1, 1, "deadbeef", 1, "0xtx1");
    rig.store.insertCheckpoint("cp-2", 2, 2, "cafef00d", 1, null);
    const json = await (await fetch(`${rig.baseUrl}/plugins/audit/api/checkpoints`)).json();
    assert.equal(json.deBaseUrl, "https://digitalevidence.example");
    assert.ok(json.checkpoints.length >= 2);
    const anchored = json.checkpoints.find((cp: { id: string }) => cp.id === "cp-1");
    assert.equal(anchored.deTxHash, "0xtx1");
  });
});

describe("ui: POST /api/verify endpoint", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("rejects missing from/to with 400", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /from and to.*required/i);
  });

  it("rejects non-ISO timestamps with 400", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "yesterday", to: "today" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns anchor-pending on a chain with no DE anchors", async () => {
    rig.appendTracked(sampleInsert({ description: "evt" }));
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, "anchor-pending");
  });
});

describe("ui: static asset serving", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("serves index.html for the SPA root", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /<audit-app><\/audit-app>/);
  });

  it("falls back to index.html for unknown extensionless paths (SPA routing)", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/some-deep/route`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });

  it("returns 404 for unknown assets with extensions", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/no-such-file.js`);
    assert.equal(res.status, 404);
  });

  it("neutralises path traversal attempts", async () => {
    // Both vectors below are normalised away before our handler decides what
    // to serve: literal "../" segments collapse at URL parse time (so the
    // request stops matching the /plugins/audit/ prefix), and "%2f" stays
    // encoded inside a single path segment that doesn't escape the static
    // root. Whatever the handler responds with, it must NOT be a filesystem
    // file outside dist/control-ui.
    const r1 = await fetch(`${rig.baseUrl}/plugins/audit/..%2f..%2fetc%2fpasswd`);
    const body1 = await r1.text();
    assert.doesNotMatch(body1, /root:.*:0:0:/, "must not leak /etc/passwd");
    // Literal "../" — URL parser collapses; we should not see the etc/passwd path resolve.
    const r2 = await fetch(`${rig.baseUrl}/plugins/audit/../../../etc/passwd`);
    const body2 = await r2.text();
    assert.doesNotMatch(body2, /root:.*:0:0:/, "must not leak /etc/passwd via literal ../");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tier 2 — verification semantics
// ───────────────────────────────────────────────────────────────────────────

describe("verification status: verified / pending / tampered / untracked", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("classifies a row as 'pending' when in SMT but no DE anchor covers its sequence", async () => {
    const ev = rig.appendTracked(sampleInsert({ description: "pending row" }));
    const json = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events`)).json();
    const found = json.events.find((e: AuditEvent) => e.id === ev.id) as AuditEvent & { verification: { status: string } };
    assert.equal(found.verification.status, "pending");
  });

  it("classifies a row as 'verified' once a DE-anchored checkpoint covers its sequence", async () => {
    const ev = rig.appendTracked(sampleInsert({ description: "verified row" }));
    const root = rig.smt.getRoot()?.root ?? "";
    rig.store.insertCheckpoint(`cp-${ev.sequence}`, ev.sequence, ev.sequence, root, 1, "0xanchored");
    const json = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events`)).json();
    const found = json.events.find((e: AuditEvent) => e.id === ev.id) as AuditEvent & { verification: { status: string } };
    assert.equal(found.verification.status, "verified");
  });

  it("classifies a row as 'tampered' when its content is mutated post-insert", async () => {
    const ev = rig.appendTracked(sampleInsert({ description: "original" }));
    // Mutate the row directly in SQLite, bypassing append/SMT, so the current
    // rawHash diverges from the leaf already in the tree.
    rig.store["db"].prepare("UPDATE audit_events SET description = ? WHERE id = ?")
      .run("MUTATED", ev.id);
    const json = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events`)).json();
    const found = json.events.find((e: AuditEvent) => e.id === ev.id) as AuditEvent & { verification: { status: string } };
    assert.equal(found.verification.status, "tampered");
  });

  it("classifies a row as 'untracked' when appended without SMT insertion (SIGINT path)", async () => {
    // Bump SMT past the highest seq from the prior tracked events so the
    // untracked event we're about to add has event.sequence > smtLastSeq.
    rig.appendTracked(sampleInsert());
    rig.appendTracked(sampleInsert());

    const untracked = rig.appendUntracked(sampleInsert({
      eventType: "gateway.stop",
      category: "gateway",
      description: "SIGINT bypass",
    }));
    const json = await (await fetch(`${rig.baseUrl}/plugins/audit/api/events`)).json();
    const found = json.events.find((e: AuditEvent) => e.id === untracked.id) as AuditEvent & { verification: { status: string } };
    assert.equal(found.verification.status, "untracked");
  });
});

describe("verifier: chain replay result states", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("reports anchor-pending when no DE anchor exists yet", () => {
    rig.appendTracked(sampleInsert());
    const result = rig.verifier.verifyRange({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" });
    assert.equal(result.status, "anchor-pending");
  });

  it("reports verified when the chain is clean and a DE anchor covers the range", () => {
    const a = rig.appendTracked(sampleInsert({ description: "a" }));
    const b = rig.appendTracked(sampleInsert({ description: "b" }));
    const root = rig.smt.getRoot()?.root ?? "";
    rig.store.insertCheckpoint("cp-clean", a.sequence, b.sequence, root, 2, "0xanchor");
    const result = rig.verifier.verifyRange({ from: "2020-01-01T00:00:00Z", to: "2020-01-02T00:00:00Z" });
    assert.equal(result.status, "verified");
    if (result.status === "verified") {
      assert.ok(result.checkpointsChecked >= 1);
    }
  });

  it("reports mismatch-at-interval when a row was modified after insertion", () => {
    // Fresh rig: prior test contaminated state with a real checkpoint, so use
    // a tweak that's local — append, anchor, mutate, replay.
    const ev = rig.appendTracked(sampleInsert({ description: "before tampering" }));
    const root = rig.smt.getRoot()?.root ?? "";
    rig.store.insertCheckpoint("cp-tamper", ev.sequence, ev.sequence, root, 1, "0xtampertx");
    // Mutate the persisted row so the verifier's fresh replay diverges from
    // the checkpoint root.
    rig.store["db"].prepare("UPDATE audit_events SET description = ? WHERE id = ?")
      .run("AFTER TAMPERING", ev.id);
    const result = rig.verifier.verifyRange({ from: "2020-01-01T00:00:00Z", to: "2020-01-02T00:00:00Z" });
    assert.equal(result.status, "mismatch-at-interval");
    if (result.status === "mismatch-at-interval") {
      assert.equal(result.mismatchAt.reason, "root-mismatch");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tier 3 — export endpoint (AG-102)
// ───────────────────────────────────────────────────────────────────────────

function parseNdjson<T = unknown>(body: string): T[] {
  return body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function parseCsv(body: string): { headers: string[]; rows: string[][] } {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inQuotes) {
      if (c === '"' && body[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { inQuotes = false; continue; }
      field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); out.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); out.push(row); }
  const headers = out[0] ?? [];
  return { headers, rows: out.slice(1) };
}

describe("ui: export endpoint", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("rejects invalid format", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=xml`);
    assert.equal(res.status, 400);
  });

  it("rejects non-ISO 8601 from/to", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/export?from=yesterday`);
    assert.equal(res.status, 400);
  });

  it("JSON format streams NDJSON with one event per line plus an anchor field", async () => {
    const a = rig.appendTracked(sampleInsert({ description: "first" }));
    const b = rig.appendTracked(sampleInsert({ description: "second" }));
    // Anchor the first event only.
    const root = rig.smt.getRoot()?.root ?? "";
    rig.store.insertCheckpoint("cp-export-1", a.sequence, a.sequence, root, 1, "0xanchor-a");

    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="audit-export-.+\.ndjson"/);

    const rows = parseNdjson<{ id: string; anchor: unknown }>(await res.text());
    assert.equal(rows.length, 2);
    const rowA = rows.find((r) => r.id === a.id)!;
    const rowB = rows.find((r) => r.id === b.id)!;
    assert.ok(rowA.anchor, "anchored event should carry an anchor object");
    assert.equal((rowA.anchor as { deTxHash: string }).deTxHash, "0xanchor-a");
    assert.equal(rowB.anchor, null, "unanchored event should have anchor: null");
  });

  it("CSV format has a stable header row and the same row count as NDJSON", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="audit-export-.+\.csv"/);

    const { headers, rows } = parseCsv(await res.text());
    // Stable prefix the dashboard / spreadsheet template depends on.
    assert.deepEqual(headers.slice(0, 6), ["id", "sequence", "source", "machineId", "sessionId", "orgId"]);
    assert.ok(headers.includes("anchor_de_tx_hash"));
    assert.ok(headers.includes("metadata_json"));
    // Header column ordering is the same in every export.
    const res2 = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=csv`);
    const second = parseCsv(await res2.text());
    assert.deepEqual(second.headers, headers);
    assert.equal(rows.length, 2);
  });

  it("escapes CSV fields containing commas / quotes / newlines", async () => {
    // Build a fresh rig so the escape-prone row is the only row in the export.
    const local = await createUiRig();
    try {
      local.appendTracked(sampleInsert({
        description: 'has, "commas" and\nnewline',
      }));
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=csv`);
      const body = await res.text();
      const { headers, rows } = parseCsv(body);
      const descIdx = headers.indexOf("description");
      assert.ok(descIdx >= 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]![descIdx], 'has, "commas" and\nnewline');
    } finally {
      await local.destroy();
    }
  });

  it("time-range filter limits the export to events in [from, to]", async () => {
    const local = await createUiRig();
    try {
      const beforeCutoff = local.appendTracked(sampleInsert({ description: "early" }));
      // SQLite's createdAt has millisecond resolution but inserts in the same
      // tick can land on the same ms. Wait a beat so `afterCutoff` has a
      // strictly-greater timestamp than `beforeCutoff`.
      await new Promise((r) => setTimeout(r, 20));
      const afterCutoff = local.appendTracked(sampleInsert({ description: "late" }));
      assert.ok(afterCutoff.createdAt > beforeCutoff.createdAt, "afterCutoff must have a later timestamp");

      // from is inclusive: at the second event's exact timestamp, only the
      // second event should be in range.
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json&from=${encodeURIComponent(afterCutoff.createdAt)}`);
      const rows = parseNdjson<{ id: string }>(await res.text());
      const ids = rows.map((r) => r.id);
      assert.ok(!ids.includes(beforeCutoff.id), "early event should be excluded by from filter");
      assert.ok(ids.includes(afterCutoff.id), "late event should be included");
    } finally {
      await local.destroy();
    }
  });

  it("securityOnly=true restricts to security/config/system categories", async () => {
    const local = await createUiRig();
    try {
      const securityEv = local.appendTracked(sampleInsert({ eventType: "security.scan_result", category: "security", description: "scan" }));
      const configEv = local.appendTracked(sampleInsert({ eventType: "config.tool_changed", category: "config", description: "config touch" }));
      const systemEv = local.appendTracked(sampleInsert({ eventType: "system.install", category: "system", description: "install" }));
      const noiseEv = local.appendTracked(sampleInsert({ eventType: "tool.invoked", category: "tool", description: "noise" }));

      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json&securityOnly=true`);
      const rows = parseNdjson<{ id: string; category: string }>(await res.text());
      const ids = new Set(rows.map((r) => r.id));
      assert.ok(ids.has(securityEv.id));
      assert.ok(ids.has(configEv.id));
      assert.ok(ids.has(systemEv.id));
      assert.ok(!ids.has(noiseEv.id), "tool-category events excluded under securityOnly");
      for (const r of rows) {
        assert.ok(["security", "config", "system"].includes(r.category));
      }
    } finally {
      await local.destroy();
    }
  });

  it("includeContent=true emits a content column / field; default omits it", async () => {
    const local = await createUiRig();
    try {
      local.appendTracked(sampleInsert({ description: "with content", content: "secret payload" }));

      const without = await (await fetch(`${local.baseUrl}/plugins/audit/api/export?format=csv`)).text();
      const { headers: h1 } = parseCsv(without);
      assert.ok(!h1.includes("content"), "content column omitted by default");

      const withContent = await (await fetch(`${local.baseUrl}/plugins/audit/api/export?format=csv&includeContent=true`)).text();
      const { headers: h2, rows } = parseCsv(withContent);
      assert.ok(h2.includes("content"));
      const idx = h2.indexOf("content");
      assert.equal(rows[0]![idx], "secret payload");
    } finally {
      await local.destroy();
    }
  });

  it("streams a larger batch beyond a single page without crashing", async () => {
    // Two batches' worth (BATCH_SIZE=1000 in export.ts). Smoke test that the
    // pagination loop terminates and the wire format stays well-formed for
    // exports that don't fit in a single store.query page.
    const local = await createUiRig();
    try {
      for (let i = 0; i < 1500; i++) {
        local.appendTracked(sampleInsert({ description: `row ${i}` }));
      }
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json`);
      assert.equal(res.status, 200);
      const rows = parseNdjson(await res.text());
      assert.equal(rows.length, 1500);
    } finally {
      await local.destroy();
    }
  });
});
