import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  cliGateInstallHandler,
  cliGateStatusHandler,
  cliGateTestHandler,
} from "../src/cli-gate.js";
import { clearConfigCache } from "openclaw/plugin-sdk/config-runtime";

function captureStdoutStderr(): {
  stop: () => { stdout: string; stderr: string };
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    // Only collect string writes. The node:test --test runner emits its
    // worker protocol as Buffer chunks on the same stream; passing those
    // through unchanged keeps the runner functional and keeps the capture
    // free of binary garbage.
    if (typeof chunk === "string") stdoutChunks.push(chunk);
    else return origOut(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") stderrChunks.push(chunk);
    else return origErr(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    stop() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
    },
  };
}

describe("cliGateInstallHandler — --json --skip-probe happy path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-gate-"));
    process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
    clearConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
    process.exitCode = 0;
  });

  it("emits a JSON report listing the keys it wrote", async () => {
    const cap = captureStdoutStderr();
    await cliGateInstallHandler({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      skipProbe: true,
      yes: true,
      json: true,
    });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.probe, "skipped");
    assert.ok(parsed.changes.length > 0);
    assert.ok(parsed.changes.includes("plugins.entries.constellation-audit-plugin.config.gatewayUrl"));
  });

  it("respects --no-broker by setting broker: false and skipping the provider entry", async () => {
    const cap = captureStdoutStderr();
    await cliGateInstallHandler({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      broker: false,
      skipProbe: true,
      yes: true,
      json: true,
    });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "");
    assert.ok(!parsed.changes.some((c: string) => c.startsWith("models.providers")));
  });

  it("fails (exit 1) when --yes is set and required inputs are missing", async () => {
    const cap = captureStdoutStderr();
    await cliGateInstallHandler({
      yes: true,
    });
    cap.stop();
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});

describe("cliGateInstallHandler — env var", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-gate-"));
    process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
    clearConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_GATE_API_KEY;
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
    process.exitCode = 0;
  });

  it("reads the API key from OPENCLAW_GATE_API_KEY when no flag is given", async () => {
    process.env.OPENCLAW_GATE_API_KEY = "sk-gw-from-env";
    const cap = captureStdoutStderr();
    await cliGateInstallHandler({
      url: "https://gate.example.com",
      skipProbe: true,
      yes: true,
      json: true,
    });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "");
    assert.equal(parsed.ok, true);
  });
});

describe("cliGateStatusHandler", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-gate-"));
    process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
    clearConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
  });

  it("emits JSON not-configured state for an empty dir", async () => {
    const cap = captureStdoutStderr();
    await cliGateStatusHandler({ json: true });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "");
    assert.equal(parsed.configured, false);
    assert.equal(parsed.hasApiKey, false);
  });

  it("does not leak the API key into JSON output", async () => {
    const cap = captureStdoutStderr();
    await cliGateInstallHandler({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      skipProbe: true,
      yes: true,
      json: true,
    });
    cap.stop();

    const cap2 = captureStdoutStderr();
    await cliGateStatusHandler({ json: true });
    const { stdout } = cap2.stop();
    assert.ok(!stdout.includes("sk-gw-aaaa"), "status JSON must not include the API key value");
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "");
    assert.equal(parsed.hasApiKey, true);
  });
});

describe("cliGateTestHandler — --url-without-key exfil guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-gate-"));
    process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
    clearConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_GATE_API_KEY;
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
    process.exitCode = 0;
  });

  it("refuses to probe an --url override without an explicit --api-key", async () => {
    // Pre-install so a saved key exists on disk.
    await cliGateInstallHandler({
      url: "https://gate.example.com",
      apiKey: "sk-gw-saved",
      skipProbe: true,
      yes: true,
    });
    process.exitCode = 0;

    const cap = captureStdoutStderr();
    await cliGateTestHandler({
      url: "https://attacker.example.com",
    });
    const { stderr } = cap.stop();

    assert.match(stderr, /--api-key/);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it("allows --url + --api-key together (both overrides supplied — guard does not trip)", async () => {
    // Use a malformed API key so the handler fails at validation, not
    // at the network. That's a deterministic failure mode that proves
    // we got past the "--url override requires --api-key" guard.
    const cap = captureStdoutStderr();
    await cliGateTestHandler({
      url: "https://gate.example.com",
      apiKey: "bad key with space",
      json: true,
    });
    const { stdout, stderr } = cap.stop();
    // We did *not* hit the --url-without-key guard
    assert.equal(/--url override requires/.test(stderr), false);
    // We did hit the API-key validator (proving we got past the guard)
    const combined = stdout + stderr;
    assert.match(combined, /api[ -]?key/i);
    process.exitCode = 0;
  });
});
