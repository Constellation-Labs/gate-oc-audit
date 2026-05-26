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

async function createUiRig(opts: {
  deBaseUrl?: string;
  isNonLoopback?: () => boolean;
  allowExportOnNonLoopback?: boolean;
  allowVerifyOnNonLoopback?: boolean;
  openclawDir?: string;
  withStatusContext?: boolean;
  statusConfig?: Record<string, unknown>;
} = {}): Promise<UiRig> {
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
  registerAuditUiRoutes(api as never, store, smt, verifier, {
    deBaseUrl: opts.deBaseUrl,
    isNonLoopback: opts.isNonLoopback,
    allowExportOnNonLoopback: opts.allowExportOnNonLoopback,
    allowVerifyOnNonLoopback: opts.allowVerifyOnNonLoopback,
    openclawDir: opts.openclawDir,
    statusContext: opts.withStatusContext
      ? {
          pluginName: "@constellation-network/openclaw-audit-plugin",
          pluginVersion: "0.0.0-test",
          config: opts.statusConfig ?? {},
        }
      : undefined,
  });

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

describe("ui: events list focusSeq offset-snap", () => {
  let rig: UiRig;
  let seqs: number[];
  before(async () => {
    rig = await createUiRig();
    // 25 events → with limit=10 that's pages [25..16], [15..6], [5..1].
    seqs = [];
    for (let i = 0; i < 25; i++) {
      seqs.push(rig.appendTracked(sampleInsert({ description: `e-${i}` })).sequence);
    }
  });
  after(async () => { await rig.destroy(); });

  it("snaps offset to the page containing focusSeq (mid-log)", async () => {
    // seq 15 is at desc-index count(seq>15) = 10 → offset 10, page [15..6].
    const target = seqs[14];
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events?focusSeq=${target}&limit=10`);
    const json = await res.json();
    assert.equal(json.offset, 10);
    assert.equal(json.total, 25);
    assert.ok(json.events.some((e: AuditEvent) => e.sequence === target),
      "focused row must be on the returned page");
    assert.equal(json.events[0].sequence, 15);
  });

  it("snaps to offset 0 when focusSeq is the highest sequence", async () => {
    const target = seqs[seqs.length - 1];
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events?focusSeq=${target}&limit=10`);
    const json = await res.json();
    assert.equal(json.offset, 0);
    assert.equal(json.events[0].sequence, target);
  });

  it("snaps to the last page when focusSeq is the lowest sequence", async () => {
    const target = seqs[0];
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events?focusSeq=${target}&limit=10`);
    const json = await res.json();
    assert.equal(json.offset, 20);
    assert.ok(json.events.some((e: AuditEvent) => e.sequence === target));
  });

  it("rejects focusSeq < 1 by falling back to the client offset", async () => {
    // focusSeq=0 / focusSeq=-5 must not snap to the last page.
    for (const bad of ["0", "-5"]) {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events?focusSeq=${bad}&limit=10&offset=0`);
      const json = await res.json();
      assert.equal(json.offset, 0, `focusSeq=${bad} should not override offset`);
    }
  });

  it("drops filters when focusSeq is set so the focused row stays on the page", async () => {
    // Append a tool-category row that doesn't match category=agent and pin
    // focusSeq to it. The row would be filtered out by category=agent, but
    // the server must drop filters when focusSeq is in play.
    const odd = rig.appendTracked(sampleInsert({ category: "tool", eventType: "tool.invoked", description: "tool" }));
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/events?focusSeq=${odd.sequence}&category=agent&limit=10`);
    const json = await res.json();
    assert.ok(json.events.some((e: AuditEvent) => e.sequence === odd.sequence),
      "filter must be ignored when focusSeq is set");
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

  it("returns 403 when the gateway is non-loopback and no opt-in is set", async () => {
    const local = await createUiRig({ isNonLoopback: () => true });
    try {
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" }),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.match(body.error, /allowVerifyOnNonLoopback/);
    } finally {
      await local.destroy();
    }
  });

  it("allows verify when allowVerifyOnNonLoopback opts in on a non-loopback bind", async () => {
    const local = await createUiRig({ isNonLoopback: () => true, allowVerifyOnNonLoopback: true });
    try {
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" }),
      });
      assert.equal(res.status, 200);
    } finally {
      await local.destroy();
    }
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

  it("classifies a row as 'untracked' (not 'tampered') when SmtService marked the sequence as skipped", async () => {
    // Insert a row through the SMT, then mutate its persisted content so
    // the current rawHash no longer matches any leaf. Without the
    // wasSkipped consult in classifyEvent this would flip to "tampered" —
    // the test asserts the skip-by-policy branch suppresses that.
    const local = await createUiRig();
    try {
      const ev = local.appendTracked(sampleInsert({ description: "to-skip" }));
      local.store["db"].prepare("UPDATE audit_events SET description = ? WHERE id = ?")
        .run("MUTATED", ev.id);
      (local.smt as unknown as { skippedSeqs: Set<number> }).skippedSeqs.add(ev.sequence);

      const json = await (await fetch(`${local.baseUrl}/plugins/audit/api/events`)).json();
      const found = json.events.find((e: AuditEvent) => e.id === ev.id) as AuditEvent & { verification: { status: string } };
      assert.equal(found.verification.status, "untracked");
    } finally {
      await local.destroy();
    }
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

  it("leaves tamperedStart/tamperedEnd unset for the events-missing branch", async () => {
    const localRig = await createUiRig();
    try {
      const evs = [
        localRig.appendTracked(sampleInsert({ description: "a" })),
        localRig.appendTracked(sampleInsert({ description: "b" })),
        localRig.appendTracked(sampleInsert({ description: "c" })),
      ];
      const root = localRig.smt.getRoot()?.root ?? "";
      localRig.store.insertCheckpoint("cp-missing", evs[0]!.sequence, evs[2]!.sequence, root, evs.length, "0xanchor");
      // Drop the rows underneath the anchored checkpoint to force the
      // events-missing branch in verifyRange.
      localRig.store["db"].prepare("DELETE FROM audit_events").run();

      const result = localRig.verifier.verifyRange({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" });
      assert.equal(result.status, "mismatch-at-interval");
      if (result.status === "mismatch-at-interval") {
        assert.equal(result.mismatchAt.reason, "events-missing");
        assert.equal(result.mismatchAt.tamperedStart, undefined);
        assert.equal(result.mismatchAt.tamperedEnd, undefined);
      }
    } finally {
      await localRig.destroy();
    }
  });

  it("excludes events past smtLastSeq from the tampered range (untracked tail)", async () => {
    const localRig = await createUiRig();
    try {
      // Five events go through the SMT.
      const tracked = [
        localRig.appendTracked(sampleInsert({ description: "t1" })),
        localRig.appendTracked(sampleInsert({ description: "t2" })),
        localRig.appendTracked(sampleInsert({ description: "tamper-me" })),
        localRig.appendTracked(sampleInsert({ description: "t4" })),
        localRig.appendTracked(sampleInsert({ description: "t5" })),
      ];
      const root = localRig.smt.getRoot()?.root ?? "";
      localRig.store.insertCheckpoint(
        "cp-tail",
        tracked[0]!.sequence,
        tracked[tracked.length - 1]!.sequence,
        root,
        tracked.length,
        "0xanchor",
      );
      // One extra row appended without inserting into the SMT — simulates
      // the SIGINT-captured gateway.stop path. Its sequence is > smtLastSeq.
      const untracked = localRig.appendUntracked(sampleInsert({ description: "untracked-tail" }));
      assert.ok(untracked.sequence > localRig.smt.getLastInsertedSequence());

      // Tamper one tracked row so root-mismatch triggers and findTamperedRange runs.
      const target = tracked[2]!;
      localRig.store["db"].prepare("UPDATE audit_events SET description = ? WHERE id = ?")
        .run("MUTATED", target.id);

      const result = localRig.verifier.verifyRange({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" });
      assert.equal(result.status, "mismatch-at-interval");
      if (result.status === "mismatch-at-interval") {
        assert.equal(result.mismatchAt.reason, "root-mismatch");
        assert.equal(result.mismatchAt.tamperedStart, target.sequence);
        assert.equal(result.mismatchAt.tamperedEnd, target.sequence,
          "untracked tail row past smtLastSeq must not extend the tampered range");
      }
    } finally {
      await localRig.destroy();
    }
  });

  it("excludes wasSkipped sequences from the tampered range (skip-by-policy)", async () => {
    const local = await createUiRig();
    try {
      const a = local.appendTracked(sampleInsert({ description: "a" }));
      const skipped = local.appendTracked(sampleInsert({ description: "to-skip" }));
      const c = local.appendTracked(sampleInsert({ description: "c" }));
      const root = local.smt.getRoot()?.root ?? "";
      local.store.insertCheckpoint("cp-skip", a.sequence, c.sequence, root, 3, "0xanchor");
      // Mutate the middle row so the verifier's fresh replay diverges from
      // the checkpoint root (forces findTamperedRange to run), then mark
      // that sequence as skipped on the live SMT so the wasSkipped branch
      // in findTamperedRange is exercised.
      local.store["db"].prepare("UPDATE audit_events SET description = ? WHERE id = ?")
        .run("MUTATED", skipped.id);
      (local.smt as unknown as { skippedSeqs: Set<number> }).skippedSeqs.add(skipped.sequence);

      const result = local.verifier.verifyRange({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" });
      assert.equal(result.status, "mismatch-at-interval");
      if (result.status === "mismatch-at-interval") {
        assert.equal(result.mismatchAt.reason, "root-mismatch");
        // The mutated row is the only divergence and it's wasSkipped, so
        // findTamperedRange must not bracket any tampered window.
        assert.equal(result.mismatchAt.tamperedStart, undefined);
        assert.equal(result.mismatchAt.tamperedEnd, undefined);
      }
    } finally {
      await local.destroy();
    }
  });

  it("narrows tamperedStart/tamperedEnd to actually-tampered rows inside the checkpoint", async () => {
    const localRig = await createUiRig();
    try {
      const events = [
        localRig.appendTracked(sampleInsert({ description: "clean 1" })),
        localRig.appendTracked(sampleInsert({ description: "clean 2" })),
        localRig.appendTracked(sampleInsert({ description: "to-tamper a" })),
        localRig.appendTracked(sampleInsert({ description: "clean 3" })),
        localRig.appendTracked(sampleInsert({ description: "to-tamper b" })),
        localRig.appendTracked(sampleInsert({ description: "clean 4" })),
      ];
      const root = localRig.smt.getRoot()?.root ?? "";
      const first = events[0]!.sequence;
      const last = events[events.length - 1]!.sequence;
      localRig.store.insertCheckpoint("cp-multi", first, last, root, events.length, "0xanchor");

      // Tamper the 3rd and 5th rows — verifier should bracket [#3 .. #5].
      const tamperedA = events[2]!;
      const tamperedB = events[4]!;
      localRig.store["db"].prepare("UPDATE audit_events SET description = ? WHERE id = ?")
        .run("MUTATED A", tamperedA.id);
      localRig.store["db"].prepare("UPDATE audit_events SET description = ? WHERE id = ?")
        .run("MUTATED B", tamperedB.id);

      const result = localRig.verifier.verifyRange({ from: "2020-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" });
      assert.equal(result.status, "mismatch-at-interval");
      if (result.status === "mismatch-at-interval") {
        assert.equal(result.mismatchAt.reason, "root-mismatch");
        assert.equal(result.mismatchAt.sequenceStart, first);
        assert.equal(result.mismatchAt.sequenceEnd, last);
        assert.equal(result.mismatchAt.tamperedStart, tamperedA.sequence);
        assert.equal(result.mismatchAt.tamperedEnd, tamperedB.sequence);
      }
    } finally {
      await localRig.destroy();
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

  it("neutralises CSV-formula payloads (=, +, -, @) by prefixing a single quote", async () => {
    const local = await createUiRig();
    try {
      local.appendTracked(sampleInsert({ description: '=cmd|"/c calc"!A1' }));
      local.appendTracked(sampleInsert({ description: "+1+1" }));
      local.appendTracked(sampleInsert({ description: "-1234" }));
      local.appendTracked(sampleInsert({ description: "@SUM(A1:A9)" }));

      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=csv`);
      const { headers, rows } = parseCsv(await res.text());
      const descIdx = headers.indexOf("description");
      assert.ok(descIdx >= 0);
      assert.equal(rows.length, 4);
      // parseCsv strips the RFC-4180 outer quotes, so the leading `'` we
      // injected survives as the first character of the unquoted value.
      for (const row of rows) {
        assert.ok(row[descIdx]!.startsWith("'"), `expected leading apostrophe, got: ${row[descIdx]}`);
      }
    } finally {
      await local.destroy();
    }
  });

  it("returns 403 when the gateway is non-loopback and no opt-in is set", async () => {
    const local = await createUiRig({ isNonLoopback: () => true });
    try {
      local.appendTracked(sampleInsert({ description: "secret" }));
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json`);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.match(body.error, /allowExportOnNonLoopback/);
    } finally {
      await local.destroy();
    }
  });

  it("allows the export when allowExportOnNonLoopback opts in even on a non-loopback bind", async () => {
    const local = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: true });
    try {
      local.appendTracked(sampleInsert({ description: "shared" }));
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json`);
      assert.equal(res.status, 200);
    } finally {
      await local.destroy();
    }
  });

  it("400s on non-ISO from/to (Date.parse-tolerated strings rejected)", async () => {
    // `2020-1-1` (no zero-padding, no time, no TZ) is happily accepted by
    // Date.parse but doesn't match the stored ISO timestamps lexicographically.
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=json&from=2020-1-1`);
    assert.equal(res.status, 400);

    const res2 = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=json&to=Jan%201%202020`);
    assert.equal(res2.status, 400);
  });

  it("HTTP limit query param caps the row count", async () => {
    const local = await createUiRig();
    try {
      for (let i = 0; i < 25; i++) local.appendTracked(sampleInsert({ description: `r${i}` }));
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json&limit=7`);
      const rows = parseNdjson(await res.text());
      assert.equal(rows.length, 7);
    } finally {
      await local.destroy();
    }
  });

  it("rejects non-integer / non-positive limit values", async () => {
    const res1 = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=json&limit=0`);
    assert.equal(res1.status, 400);
    const res2 = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=json&limit=abc`);
    assert.equal(res2.status, 400);
    const res3 = await fetch(`${rig.baseUrl}/plugins/audit/api/export?format=json&limit=-5`);
    assert.equal(res3.status, 400);
  });

  it("rows for events without a covering DE-anchored checkpoint emit anchor: null", async () => {
    const local = await createUiRig();
    try {
      const ev = local.appendTracked(sampleInsert({ description: "anchor-pending" }));
      // Insert a checkpoint without a DE tx hash — it must NOT appear as an anchor.
      const root = local.smt.getRoot()?.root ?? "";
      local.store.insertCheckpoint("cp-no-detx", ev.sequence, ev.sequence, root, 1, null);

      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json`);
      const rows = parseNdjson<{ id: string; anchor: unknown }>(await res.text());
      const found = rows.find((r) => r.id === ev.id)!;
      assert.equal(found.anchor, null);
    } finally {
      await local.destroy();
    }
  });

  it("category= and session= filters compose on the HTTP export", async () => {
    const local = await createUiRig();
    try {
      const wantedSession = "sess-target";
      const wanted = local.appendTracked(sampleInsert({
        eventType: "tool.invoked", category: "tool", sessionId: wantedSession, description: "want",
      }));
      local.appendTracked(sampleInsert({ eventType: "tool.invoked", category: "tool", sessionId: "other", description: "wrong session" }));
      local.appendTracked(sampleInsert({ eventType: "session.start", category: "agent", sessionId: wantedSession, description: "wrong category" }));

      const res = await fetch(
        `${local.baseUrl}/plugins/audit/api/export?format=json&category=tool&session=${wantedSession}`,
      );
      const rows = parseNdjson<{ id: string }>(await res.text());
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, wanted.id);
    } finally {
      await local.destroy();
    }
  });

  it("findAnchor returns an earlier wider anchor when a later narrow anchor doesn't cover the row", async () => {
    // Simulate the overlap shape the de-anchor allocator doesn't produce
    // today but a future backfill could. cp-wide covers 1..100; cp-narrow
    // re-anchors row 50 only. Row 75 must still resolve to cp-wide.
    const local = await createUiRig();
    try {
      // Append 100 rows so sequences 1..100 exist.
      const evs = Array.from({ length: 100 }, (_, i) => local.appendTracked(sampleInsert({ description: `r${i}` })));
      const root = local.smt.getRoot()?.root ?? "";
      local.store.insertCheckpoint("cp-wide", 1, 100, root, 100, "0xwide");
      local.store.insertCheckpoint("cp-narrow", 50, 50, root, 1, "0xnarrow");

      const res = await fetch(`${local.baseUrl}/plugins/audit/api/export?format=json`);
      const rows = parseNdjson<{ id: string; anchor: { checkpointId: string } | null }>(await res.text());
      const row75 = rows.find((r) => r.id === evs[74]!.id)!;
      assert.equal(row75.anchor?.checkpointId, "cp-wide");
      const row50 = rows.find((r) => r.id === evs[49]!.id)!;
      // cp-narrow is the rightmost candidate AND it covers row 50, so it wins.
      assert.equal(row50.anchor?.checkpointId, "cp-narrow");
    } finally {
      await local.destroy();
    }
  });
});

describe("ui: /api/report endpoint", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("rejects missing or invalid period", async () => {
    const res1 = await fetch(`${rig.baseUrl}/plugins/audit/api/report`);
    assert.equal(res1.status, 400);
    const res2 = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=hourly`);
    assert.equal(res2.status, 400);
  });

  it("rejects invalid tz", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=daily&tz=cest`);
    assert.equal(res.status, 400);
  });

  it("rejects bad date or week strings with a 400", async () => {
    const r1 = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=daily&date=not-a-date`);
    assert.equal(r1.status, 400);
    const r2 = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=weekly&week=2026-Wxx`);
    assert.equal(r2.status, 400);
  });

  it("enforces parameter caps on dupWindowSec/lookbackDays/topTools", async () => {
    const r1 = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=daily&lookbackDays=1000000`);
    assert.equal(r1.status, 400);
    const r2 = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=daily&dupWindowSec=99999`);
    assert.equal(r2.status, 400);
    const r3 = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=daily&topTools=99999`);
    assert.equal(r3.status, 400);
  });

  it("default JSON response validates the schemaVersion + period kind", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=daily&tz=utc&date=2026-05-18`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { schemaVersion: number; period: { kind: string; tz: string } };
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.period.kind, "daily");
    assert.equal(body.period.tz, "utc");
  });

  it("format=html returns a self-contained HTML document", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=daily&tz=utc&date=2026-05-18&format=html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const text = await res.text();
    assert.ok(text.startsWith("<!doctype html>"));
    assert.ok(text.includes("Audit report"));
  });

  it("weekly period accepts --week", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report?period=weekly&tz=utc&week=2026-W21`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { period: { kind: string; label: string } };
    assert.equal(body.period.kind, "weekly");
    assert.match(body.period.label, /2026-W21/);
  });

  it("blocks the report when gateway is non-loopback and opt-in is off", async () => {
    const local = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: false });
    try {
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/report?period=daily&tz=utc&date=2026-05-18`);
      assert.equal(res.status, 403);
    } finally {
      await local.destroy();
    }
  });

  it("allows the report on a non-loopback bind when allowExportOnNonLoopback is set", async () => {
    const local = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: true });
    try {
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/report?period=daily&tz=utc&date=2026-05-18`);
      assert.equal(res.status, 200);
    } finally {
      await local.destroy();
    }
  });
});

describe("ui: /api/report/cron/<job-id> endpoint", () => {
  let rig: UiRig;
  before(async () => { rig = await createUiRig(); });
  after(async () => { await rig.destroy(); });

  it("default JSON response carries schemaVersion 1 and the requested jobId", async () => {
    rig.appendUntracked({
      sessionId: "sess-1",
      eventType: "cron.executed" as any,
      category: "cron" as any,
      description: "cron.executed",
      metadata: { jobId: "nightly-job", runId: "run-001" },
    });
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/cron/nightly-job`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { schemaVersion: number; jobId: string; rows: Array<{ runId: string }> };
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.jobId, "nightly-job");
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].runId, "run-001");
  });

  it("returns an empty rollup for an unknown jobId", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/cron/no-such-job`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { jobId: string; rows: unknown[]; truncated: boolean };
    assert.equal(body.jobId, "no-such-job");
    assert.equal(body.rows.length, 0);
    assert.equal(body.truncated, false);
  });

  it("format=html returns a self-contained HTML document", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/cron/nightly-job?format=html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const text = await res.text();
    assert.ok(text.startsWith("<!doctype html>"));
    assert.ok(text.includes("Per-cron rollup"));
  });

  it("rejects out-of-range last with a 400", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/cron/nightly-job?last=99999`);
    assert.equal(res.status, 400);
  });

  it("rejects an unknown format with a 400", async () => {
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/cron/nightly-job?format=xml`);
    assert.equal(res.status, 400);
  });

  it("percent-decodes the job-id from the path", async () => {
    rig.appendUntracked({
      sessionId: "sess-2",
      eventType: "cron.executed" as any,
      category: "cron" as any,
      description: "cron.executed",
      metadata: { jobId: "weird/id with spaces", runId: "run-007" },
    });
    const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/cron/${encodeURIComponent("weird/id with spaces")}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { jobId: string; rows: Array<{ runId: string }> };
    assert.equal(body.jobId, "weird/id with spaces");
    assert.equal(body.rows[0].runId, "run-007");
  });

  it("blocks the rollup when gateway is non-loopback and opt-in is off", async () => {
    const local = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: false });
    try {
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/report/cron/nightly-job`);
      assert.equal(res.status, 403);
    } finally {
      await local.destroy();
    }
  });

  it("allows the rollup on a non-loopback bind when allowExportOnNonLoopback is set", async () => {
    const local = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: true });
    try {
      const res = await fetch(`${local.baseUrl}/plugins/audit/api/report/cron/nightly-job`);
      assert.equal(res.status, 200);
    } finally {
      await local.destroy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /api/status — mirror of `audit status --json` for the SPA dashboard
// ───────────────────────────────────────────────────────────────────────────

describe("ui: /api/status endpoint", () => {
  it("returns a snapshot when statusContext is configured", async () => {
    const rig = await createUiRig({
      withStatusContext: true,
      statusConfig: {
        localRetentionDays: 60,
        localMaxSizeMb: 200,
        fileWatchPatterns: ["src/**/*.ts", "config/*.json"],
        fileWatchIgnorePatterns: ["**/*.test.ts"],
      },
    });
    try {
      rig.appendTracked(sampleInsert());
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/status`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, any>;
      assert.equal(body.header.pluginName, "@constellation-network/openclaw-audit-plugin");
      assert.equal(body.header.pluginVersion, "0.0.0-test");
      assert.equal(typeof body.header.machineId, "string");
      assert.equal(typeof body.header.generatedAt, "string");
      assert.equal(typeof body.storage.eventCount, "number");
      assert.equal(body.storage.retentionDays, 60);
      assert.equal(body.storage.maxSizeMb, 200);
      assert.equal(body.fileWatch.patternsWatched, 2);
      assert.equal(body.fileWatch.patternsIgnored, 1);
      assert.equal(body.integrity.conversationAccess, "disabled");
      assert.equal(body.degraded, false);
      assert.equal(body.schemaVersion, 2);
    } finally {
      await rig.destroy();
    }
  });

  it("returns 503 when statusContext is not configured on this plugin instance", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/status`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not configured/);
    } finally {
      await rig.destroy();
    }
  });

  it("blocks status when gateway is non-loopback and opt-in is off", async () => {
    const rig = await createUiRig({
      isNonLoopback: () => true,
      allowExportOnNonLoopback: false,
      withStatusContext: true,
    });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/status`);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /allowExportOnNonLoopback/);
    } finally {
      await rig.destroy();
    }
  });

  it("allows status on a non-loopback bind when allowExportOnNonLoopback is set", async () => {
    const rig = await createUiRig({
      isNonLoopback: () => true,
      allowExportOnNonLoopback: true,
      withStatusContext: true,
    });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/status`);
      assert.equal(res.status, 200);
    } finally {
      await rig.destroy();
    }
  });

  it("reports conversationAccess=\"enabled\" when allowConversationAccess and a recent prompt.input exist", async () => {
    const rig = await createUiRig({
      withStatusContext: true,
      statusConfig: { allowConversationAccess: true },
    });
    try {
      rig.appendTracked(sampleInsert({
        eventType: "prompt.input" as any,
        category: "prompt" as any,
        description: "user prompt",
      }));
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/status`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { integrity: { conversationAccess: string } };
      assert.equal(body.integrity.conversationAccess, "enabled");
    } finally {
      await rig.destroy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /api/report/session/:id — mirror of `audit report session --json` for the
// SPA per-conversation drilldown.
// ───────────────────────────────────────────────────────────────────────────

describe("ui: /api/report/session/:id endpoint", () => {
  it("returns a projection for an existing session", async () => {
    const rig = await createUiRig();
    try {
      const sessionId = "sess-rollup-1";
      rig.appendTracked(sampleInsert({
        sessionId,
        eventType: "session.start" as any,
        category: "agent" as any,
        description: "session start",
      }));
      rig.appendTracked(sampleInsert({
        sessionId,
        eventType: "tool.invoked" as any,
        category: "tool" as any,
        description: "tool fired",
        metadata: { toolName: "Bash" },
      }));
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/session/${encodeURIComponent(sessionId)}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, any>;
      assert.equal(body.sessionId, sessionId);
      assert.equal(body.schemaVersion, 1);
      assert.equal(body.timeline.length >= 1, true);
      assert.equal(body.integrity.eventCount >= 2, true);
      assert.equal(body.degraded, false);
    } finally {
      await rig.destroy();
    }
  });

  it("strips metadata from timeline entries by default", async () => {
    const rig = await createUiRig();
    try {
      const sessionId = "sess-meta-strip";
      rig.appendTracked(sampleInsert({
        sessionId,
        eventType: "tool.invoked" as any,
        category: "tool" as any,
        description: "tool fired",
        metadata: { toolName: "Bash", command: "secret-command" },
      }));
      const stripped = await fetch(`${rig.baseUrl}/plugins/audit/api/report/session/${encodeURIComponent(sessionId)}`);
      const strippedBody = (await stripped.json()) as { timeline: Array<Record<string, unknown>> };
      assert.equal("metadata" in (strippedBody.timeline[0] ?? {}), false);

      const full = await fetch(`${rig.baseUrl}/plugins/audit/api/report/session/${encodeURIComponent(sessionId)}?includeMetadata=true`);
      const fullBody = (await full.json()) as { timeline: Array<{ metadata?: Record<string, unknown> }> };
      assert.equal(fullBody.timeline[0]?.metadata?.command, "secret-command");
    } finally {
      await rig.destroy();
    }
  });

  it("returns an empty timeline for an unknown session id", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/session/no-such-session`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { timeline: unknown[]; integrity: { eventCount: number } };
      assert.equal(body.timeline.length, 0);
      assert.equal(body.integrity.eventCount, 0);
    } finally {
      await rig.destroy();
    }
  });

  it("rejects a non-positive limit with 400", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/session/sess-x?limit=0`);
      assert.equal(res.status, 400);
    } finally {
      await rig.destroy();
    }
  });

  it("blocks the rollup when gateway is non-loopback and opt-in is off", async () => {
    const rig = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: false });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/session/sess-x`);
      assert.equal(res.status, 403);
    } finally {
      await rig.destroy();
    }
  });

  it("allows the rollup on a non-loopback bind when allowExportOnNonLoopback is set", async () => {
    const rig = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: true });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/report/session/sess-x`);
      assert.equal(res.status, 200);
    } finally {
      await rig.destroy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /api/anomalies — mirror of `audit anomalies --json` for the SPA view.
// ───────────────────────────────────────────────────────────────────────────

describe("ui: /api/anomalies endpoint", () => {
  it("returns an empty anomaly view on a fresh store", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/anomalies`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, any>;
      assert.equal(body.schemaVersion, 1);
      assert.equal(body.anomalies.duplicateOutbound.length, 0);
      assert.equal(body.anomalies.firstSeenTools.length, 0);
      assert.equal(body.counts.totalEventsInWindow, 0);
      assert.equal(body.degraded, false);
    } finally {
      await rig.destroy();
    }
  });

  it("echoes detector knobs in detectorConfig", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/anomalies?dupWindowSec=120&lookbackDays=7&denialWindowSec=600&denialThreshold=3`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { detectorConfig: Record<string, number> };
      assert.equal(body.detectorConfig.dupWindowSec, 120);
      assert.equal(body.detectorConfig.lookbackDays, 7);
      assert.equal(body.detectorConfig.denialWindowSec, 600);
      assert.equal(body.detectorConfig.denialThreshold, 3);
    } finally {
      await rig.destroy();
    }
  });

  it("rejects an out-of-range detector knob with 400", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/anomalies?dupWindowSec=-1`);
      assert.equal(res.status, 400);
    } finally {
      await rig.destroy();
    }
  });

  it("rejects an invalid since duration with 400", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/anomalies?since=not-a-duration`);
      assert.equal(res.status, 400);
    } finally {
      await rig.destroy();
    }
  });

  it("blocks anomalies when gateway is non-loopback and opt-in is off", async () => {
    const rig = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: false });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/anomalies`);
      assert.equal(res.status, 403);
    } finally {
      await rig.destroy();
    }
  });

  it("allows anomalies on a non-loopback bind when allowExportOnNonLoopback is set", async () => {
    const rig = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: true });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/anomalies`);
      assert.equal(res.status, 200);
    } finally {
      await rig.destroy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /api/spend — mirror of `audit spend --json` for the SPA spend view.
// ───────────────────────────────────────────────────────────────────────────

describe("ui: /api/spend endpoint", () => {
  it("returns an empty rollup grouped by model on a fresh store", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/spend`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, any>;
      assert.equal(body.schemaVersion, 1);
      assert.equal(body.groupBy, "model");
      assert.equal(body.rows.length, 0);
      assert.equal(body.totals.callCount, 0);
      assert.equal(body.degraded, false);
    } finally {
      await rig.destroy();
    }
  });

  it("honours the by= group parameter", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/spend?by=session`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { groupBy: string };
      assert.equal(body.groupBy, "session");
    } finally {
      await rig.destroy();
    }
  });

  it("rejects an unknown by= value with 400", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/spend?by=bogus`);
      assert.equal(res.status, 400);
    } finally {
      await rig.destroy();
    }
  });

  it("rejects a non-positive limit with 400", async () => {
    const rig = await createUiRig();
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/spend?limit=0`);
      assert.equal(res.status, 400);
    } finally {
      await rig.destroy();
    }
  });

  it("blocks spend when gateway is non-loopback and opt-in is off", async () => {
    const rig = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: false });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/spend`);
      assert.equal(res.status, 403);
    } finally {
      await rig.destroy();
    }
  });

  it("allows spend on a non-loopback bind when allowExportOnNonLoopback is set", async () => {
    const rig = await createUiRig({ isNonLoopback: () => true, allowExportOnNonLoopback: true });
    try {
      const res = await fetch(`${rig.baseUrl}/plugins/audit/api/spend`);
      assert.equal(res.status, 200);
    } finally {
      await rig.destroy();
    }
  });
});
