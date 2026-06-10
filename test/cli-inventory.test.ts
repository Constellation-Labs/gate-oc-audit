import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../src/store/audit-store.js";
import { cliInventoryHandler } from "../src/cli.js";

function makeTempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "audit-inv-cli-")), "test.db");
}

// Keep stdout and stderr strictly separated. `outLine` (the production helper)
// only writes to process.stdout.write — anything that lands in `stderr` here
// is a regression to `console.log` or a stray `console.error`.
function captureStreams(fn: () => void): { stdout: string; stderr: string } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStdout = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => stderrChunks.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderrChunks.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdout;
  }
  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("\n") };
}

describe("CLI: audit inventory", () => {
  let dbPath: string;
  let store: AuditStore;
  let openclawDir: string;
  let projectRoot: string;
  let homeDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new AuditStore(dbPath);
    openclawDir = mkdtempSync(join(tmpdir(), "audit-inv-cli-oc-"));
    projectRoot = mkdtempSync(join(tmpdir(), "audit-inv-cli-proj-"));
    // Isolate HOME so the personal-agent skills root (~/.agents/skills) can't
    // leak the developer's real skills into count assertions.
    homeDir = mkdtempSync(join(tmpdir(), "audit-inv-cli-home-"));
    origHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    store.close();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(dirname(dbPath), { recursive: true, force: true });
    rmSync(openclawDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("summary lists all five lenses with counts of zero", () => {
    const { stdout, stderr } = captureStreams(() =>
      cliInventoryHandler(store, "summary", {}, { openclawDir, projectRoot }),
    );
    assert.ok(stdout.includes("plugins:   0"));
    assert.ok(stdout.includes("skills:    0"));
    assert.ok(stdout.includes("tools:     0"));
    assert.ok(stdout.includes("workspace: 0"));
    assert.ok(stdout.includes("crons:     0"));
    // Inventory output must never land in stderr — guards against accidental
    // console.log regression masked by the SDK's routeLogsToStderr().
    assert.equal(stderr, "");
  });

  it("plugins subcommand lists each directory under ~/.openclaw/extensions", () => {
    for (const name of ["alpha-plugin", "beta-plugin"]) {
      const dir = join(openclawDir, "extensions", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.1" }));
    }

    const { stdout, stderr } = captureStreams(() =>
      cliInventoryHandler(store, "plugins", {}, { openclawDir, projectRoot }),
    );
    assert.ok(stdout.includes("plugins (2)"));
    assert.ok(stdout.includes("alpha-plugin"));
    assert.ok(stdout.includes("beta-plugin"));
    assert.equal(stderr, "");
  });

  it("--json emits a parseable, stable shape with summary + items", () => {
    const dir = join(openclawDir, "extensions", "sample");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sample", version: "1.0.0" }));

    const { stdout } = captureStreams(() =>
      cliInventoryHandler(store, "plugins", { json: true }, { openclawDir, projectRoot }),
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.summary.plugins, 1);
    assert.equal(parsed.plugins.length, 1);
    assert.equal(parsed.plugins[0].name, "sample");
    assert.equal(parsed.plugins[0].version, "1.0.0");
  });

  it("--json output is deterministic across two runs", () => {
    mkdirSync(join(openclawDir, "skills"), { recursive: true });
    writeFileSync(join(openclawDir, "skills", "zeta.ts"), "x");
    writeFileSync(join(openclawDir, "skills", "alpha.ts"), "x");

    const first = captureStreams(() =>
      cliInventoryHandler(store, "skills", { json: true }, { openclawDir, projectRoot }),
    ).stdout;
    const second = captureStreams(() =>
      cliInventoryHandler(store, "skills", { json: true }, { openclawDir, projectRoot }),
    ).stdout;
    assert.equal(first, second);
  });

  it("plugins acceptance: includes content_hash from config_manifests when present", () => {
    const dir = join(openclawDir, "extensions", "captured-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "captured-plugin", version: "9.9.9", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};");

    const entryFile = join(dir, "index.js");
    store.upsertManifest(`plugins:${entryFile}`, "plugins", "feedface", entryFile);

    const { stdout } = captureStreams(() =>
      cliInventoryHandler(store, "plugins", { json: true }, { openclawDir, projectRoot }),
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.plugins[0].contentHash, "feedface");
    assert.equal(parsed.plugins[0].capturedInManifests, true);
    assert.ok(parsed.plugins[0].capturedAt);
  });

  it("'No <kind> found.' when a lens is empty", () => {
    const { stdout } = captureStreams(() =>
      cliInventoryHandler(store, "crons", {}, { openclawDir, projectRoot }),
    );
    assert.ok(stdout.includes("No crons found."));
  });

  it("sanitises CR/LF in attacker-controlled plugin name in --json output", () => {
    const dir = join(openclawDir, "extensions", "evil-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "ok-plugin\r\nfake-row evil 0.0.1",
      version: "0.0.1",
    }));

    const { stdout } = captureStreams(() =>
      cliInventoryHandler(store, "plugins", { json: true }, { openclawDir, projectRoot }),
    );
    const parsed = JSON.parse(stdout);
    // Neither raw CR nor raw LF should reach the consumer; they must be
    // visibly escaped in the rendered string.
    assert.ok(!parsed.plugins[0].name.includes("\r"));
    assert.ok(!parsed.plugins[0].name.includes("\n"));
    assert.ok(parsed.plugins[0].name.includes("\\r"));
    assert.ok(parsed.plugins[0].name.includes("\\n"));
  });
});
