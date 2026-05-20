import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureAuthProfileStore, listProfilesForProvider } from "openclaw/plugin-sdk/provider-auth";

import {
  cliProviderAddOpenAIHandler,
  cliProviderListHandler,
  cliProviderRemoveHandler,
} from "../src/cli-provider.js";
import { clearConfigCache } from "openclaw/plugin-sdk/config-runtime";

/**
 * The CLI under test now writes through the SDK's auth-profile store
 * rather than touching `models.providers.*` directly. Tests pass an
 * isolated tmp dir as `openclawDir`; the SDK derives the profile-store
 * paths from there.
 *
 * OAuth (`--oauth`) is not unit-tested: it requires the full SDK
 * wizard flow against a live auth.openai.com (or a heavy mock). The
 * SDK's own tests cover that path; we cover the api-key path here.
 */

function captureStdoutStderr(): { stop: () => { stdout: string; stderr: string } } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    if (typeof c === "string") out.push(c);
    else return origOut(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    if (typeof c === "string") err.push(c);
    else return origErr(c);
    return true;
  }) as typeof process.stderr.write;
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
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-provider-"));
    process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
    clearConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
    process.exitCode = 0;
  });

  it("emits 'No OpenAI provider profiles configured.' on a fresh dir", () => {
    const cap = captureStdoutStderr();
    cliProviderListHandler({ openclawDir: dir });
    const { stdout } = cap.stop();
    assert.match(stdout, /No OpenAI provider profiles configured/);
  });

  it("returns { profiles: [] } as JSON on a fresh dir", () => {
    const cap = captureStdoutStderr();
    cliProviderListHandler({ openclawDir: dir, json: true });
    const { stdout } = cap.stop();
    assert.deepEqual(JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? ""), { profiles: [] });
  });

  it("does not include the API key value in the listing", async () => {
    await cliProviderAddOpenAIHandler({ apiKey: "sk-test-aaaa", yes: true, openclawDir: dir });
    process.exitCode = 0;
    const cap = captureStdoutStderr();
    cliProviderListHandler({ openclawDir: dir, json: true });
    const { stdout } = cap.stop();
    assert.equal(stdout.includes("sk-test-aaaa"), false);
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "");
    assert.equal(parsed.profiles.length, 1);
    assert.equal(parsed.profiles[0].provider, "openai");
    assert.equal(parsed.profiles[0].type, "api_key");
    assert.ok(typeof parsed.profiles[0].profileId === "string");
  });
});

describe("cliProviderRemoveHandler", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-provider-"));
    process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
    clearConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
    process.exitCode = 0;
  });

  it("removes all profiles for a provider", async () => {
    await cliProviderAddOpenAIHandler({ apiKey: "sk-test", yes: true, openclawDir: dir });
    process.exitCode = 0;
    await cliProviderRemoveHandler("openai", { openclawDir: dir, json: true });
    // The on-disk store is the canonical assertion target; the captured
    // stdout may include node:test reporter output if tests interleave.
    const store = ensureAuthProfileStore(dir);
    assert.deepEqual(listProfilesForProvider(store, "openai"), []);
  });

  it("refuses to remove the 'gate' broker key (exit 1)", async () => {
    const cap = captureStdoutStderr();
    await cliProviderRemoveHandler("gate", { openclawDir: dir });
    const { stderr } = cap.stop();
    assert.match(stderr, /gate.*managed by/i);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});

describe("cliProviderAddOpenAIHandler — API-key path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-provider-"));
    process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
    clearConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_OPENAI_API_KEY;
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
    process.exitCode = 0;
  });

  it("writes a profile via the SDK auth-profile store", async () => {
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ apiKey: "sk-test-aaaa", yes: true, json: true, openclawDir: dir });
    const { stdout } = cap.stop();
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.provider, "openai");
    assert.equal(parsed.mode, "api_key");
    assert.ok(typeof parsed.profileId === "string");

    const store = ensureAuthProfileStore(dir);
    const profileIds = listProfilesForProvider(store, "openai");
    assert.equal(profileIds.length, 1);
    const cred = store.profiles?.[profileIds[0]];
    assert.ok(cred);
    assert.equal(cred!.type, "api_key");
    assert.equal(cred!.provider, "openai");
  });

  it("reads the key from OPENCLAW_OPENAI_API_KEY when no flag given", async () => {
    process.env.OPENCLAW_OPENAI_API_KEY = "sk-from-env";
    const cap = captureStdoutStderr();
    await cliProviderAddOpenAIHandler({ yes: true, openclawDir: dir });
    cap.stop();
    const store = ensureAuthProfileStore(dir);
    assert.equal(listProfilesForProvider(store, "openai").length, 1);
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
