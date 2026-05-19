import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  cliProviderAddOpenAIHandler,
  cliProviderListHandler,
  cliProviderRemoveHandler,
} from "../src/cli-provider.js";

function captureStdoutStderr(): { stop: () => { stdout: string; stderr: string } } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(typeof c === "string" ? c : Buffer.from(c).toString()); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(typeof c === "string" ? c : Buffer.from(c).toString()); return true; }) as typeof process.stderr.write;
  return {
    stop() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { stdout: out.join(""), stderr: err.join("") };
    },
  };
}

describe("cliProviderListHandler", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cli-provider-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; });

  it("emits 'No providers configured.' on a fresh dir (human output)", () => {
    const cap = captureStdoutStderr();
    cliProviderListHandler({ openclawDir: dir });
    const { stdout } = cap.stop();
    assert.match(stdout, /No providers configured/);
  });

  it("returns { providers: [] } as JSON on a fresh dir", () => {
    const cap = captureStdoutStderr();
    cliProviderListHandler({ openclawDir: dir, json: true });
    const { stdout } = cap.stop();
    assert.deepEqual(JSON.parse(stdout.trim()), { providers: [] });
  });

  it("does not include the API key value in the listing", async () => {
    await cliProviderAddOpenAIHandler({ apiKey: "sk-test-aaaa", yes: true, openclawDir: dir });
    process.exitCode = 0;
    const cap = captureStdoutStderr();
    cliProviderListHandler({ openclawDir: dir, json: true });
    const { stdout } = cap.stop();
    assert.equal(stdout.includes("sk-test-aaaa"), false);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.providers.length, 1);
    assert.equal(parsed.providers[0].key, "openai");
    assert.equal(parsed.providers[0].hasApiKey, true);
  });

  it("surfaces (malformed) when openclawAudit.oauth.expiresAt is non-string", async () => {
    await cliProviderAddOpenAIHandler({ apiKey: "sk-test-aaaa", yes: true, openclawDir: dir });
    process.exitCode = 0;
    // Hand-corrupt the config
    const path = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    cfg.models.providers.openai.openclawAudit = { oauth: { expiresAt: 1234 } };
    writeFileSync(path, JSON.stringify(cfg));
    const cap = captureStdoutStderr();
    cliProviderListHandler({ openclawDir: dir, json: true });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.providers[0].oauthExpiresAt, "(malformed)");
  });
});

describe("cliProviderRemoveHandler", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cli-provider-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; });

  it("removes a configured provider", async () => {
    await cliProviderAddOpenAIHandler({ apiKey: "sk-test", yes: true, openclawDir: dir });
    process.exitCode = 0;
    const cap = captureStdoutStderr();
    cliProviderRemoveHandler("openai", { openclawDir: dir, json: true });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.trim());
    assert.ok(parsed.changes.includes("models.providers.openai"));
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    assert.equal(cfg.models?.providers?.openai, undefined);
  });

  it("refuses to remove the 'gate' broker key (exit 1)", () => {
    const cap = captureStdoutStderr();
    cliProviderRemoveHandler("gate", { openclawDir: dir });
    const { stderr } = cap.stop();
    assert.match(stderr, /broker|reserved/i);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it("reports no-op for a non-existent provider", () => {
    const cap = captureStdoutStderr();
    cliProviderRemoveHandler("anthropic", { openclawDir: dir });
    const { stdout } = cap.stop();
    assert.match(stdout, /No provider named/);
  });
});

describe("cliProviderAddOpenAIHandler — API-key path", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cli-provider-")); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
    delete process.env.OPENCLAW_OPENAI_API_KEY;
  });

  it("writes the provider entry with the supplied API key", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ apiKey: "sk-test-aaaa", yes: true, json: true, openclawDir: dir });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.providerKey, "openai");
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    assert.equal(cfg.models.providers.openai.apiKey, "sk-test-aaaa");
  });

  it("reads the key from OPENCLAW_OPENAI_API_KEY when no flag given", async () => {
    process.env.OPENCLAW_OPENAI_API_KEY = "sk-from-env";
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ yes: true, openclawDir: dir });
    cap.stop();
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    assert.equal(cfg.models.providers.openai.apiKey, "sk-from-env");
  });

  it("rejects --oauth combined with --api-key", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ oauth: true, apiKey: "sk-x", yes: true, openclawDir: dir });
    const { stderr } = cap.stop();
    assert.match(stderr, /pick --oauth OR --api-key/);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it("rejects --api-key combined with --api-key-stdin", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ apiKey: "sk-x", apiKeyStdin: true, yes: true, openclawDir: dir });
    const { stderr } = cap.stop();
    assert.match(stderr, /pick --api-key OR --api-key-stdin/);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it("refuses providerKey: 'gate' (broker is managed by `audit gate install`)", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ apiKey: "sk-x", providerKey: "gate", yes: true, openclawDir: dir });
    const { stderr } = cap.stop();
    assert.match(stderr, /broker|reserved/i);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it("rejects whitespace in the API key", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ apiKey: "sk with space", yes: true, openclawDir: dir });
    const { stderr } = cap.stop();
    assert.match(stderr, /whitespace/);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });

  it("fails (exit 1) when no key source is available in --yes mode", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ yes: true, openclawDir: dir });
    cap.stop();
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});

describe("cliProviderAddOpenAIHandler — handle persist failure", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cli-provider-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; });

  it("does not write any config when providerKey is reserved", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ apiKey: "sk-x", providerKey: "gate", yes: true, openclawDir: dir });
    cap.stop();
    assert.equal(existsSync(join(dir, "config.json")), false);
    process.exitCode = 0;
  });
});
