import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyBrokerProviderPatch,
  applyGateInstallPatch,
  isJsonObject,
  readOpenclawConfig,
  writeOpenclawConfig,
  type JsonObject,
} from "../src/util/openclaw-config-writer.js";
import {
  GateInstallError,
  installGate,
  normalizeAndValidateUrl,
  readGateStatus,
  validateApiKeyOrThrow,
} from "../src/services/gate-installer.js";

function makeOpenclawDir(): string {
  return mkdtempSync(join(tmpdir(), "openclaw-cfg-"));
}

const baseInstallPatch = {
  gatewayUrl: "https://gate.example.com",
  gatewayApiKey: "sk-gw-aaaa",
  addToAllowlist: true,
  grantConversationAccess: true,
  allowPrivateHost: false,
  enable: true,
} as const;

describe("openclaw-config-writer: applyGateInstallPatch", () => {
  it("populates an empty config with all expected keys", () => {
    const content: JsonObject = {};
    const changes = applyGateInstallPatch(content, { ...baseInstallPatch });

    assert.deepEqual(changes.sort(), [
      "plugins.allow",
      "plugins.entries.constellation-audit-plugin.config.gatewayApiKey",
      "plugins.entries.constellation-audit-plugin.config.gatewayUrl",
      "plugins.entries.constellation-audit-plugin.enabled",
      "plugins.entries.constellation-audit-plugin.hooks.allowConversationAccess",
    ].sort());

    const plugins = content.plugins as JsonObject;
    assert.deepEqual(plugins.allow, ["constellation-audit-plugin"]);
    const entry = (plugins.entries as JsonObject)["constellation-audit-plugin"] as JsonObject;
    assert.equal(entry.enabled, true);
    assert.equal((entry.hooks as JsonObject).allowConversationAccess, true);
    assert.equal((entry.config as JsonObject).gatewayUrl, "https://gate.example.com");
    assert.equal((entry.config as JsonObject).gatewayApiKey, "sk-gw-aaaa");
  });

  it("is idempotent — re-applying the same patch makes no changes", () => {
    const content: JsonObject = {};
    applyGateInstallPatch(content, { ...baseInstallPatch });
    const second = applyGateInstallPatch(content, { ...baseInstallPatch });
    assert.deepEqual(second, []);
  });

  it("preserves unrelated keys in plugins.allow", () => {
    const content: JsonObject = {
      plugins: { allow: ["other-plugin"] },
    };
    applyGateInstallPatch(content, { ...baseInstallPatch });
    assert.deepEqual(
      (content.plugins as JsonObject).allow,
      ["other-plugin", "constellation-audit-plugin"],
    );
  });

  it("skips allowlist when addToAllowlist is false", () => {
    const content: JsonObject = {};
    const changes = applyGateInstallPatch(content, { ...baseInstallPatch, addToAllowlist: false });
    assert.equal(changes.includes("plugins.allow"), false);
    assert.equal((content.plugins as JsonObject).allow, undefined);
  });

  it("does not overwrite a different gatewayUrl with the same key", () => {
    const content: JsonObject = {};
    applyGateInstallPatch(content, { ...baseInstallPatch, gatewayUrl: "https://old.example.com", addToAllowlist: false, grantConversationAccess: false });
    const changes = applyGateInstallPatch(content, { ...baseInstallPatch, gatewayUrl: "https://new.example.com", addToAllowlist: false, grantConversationAccess: false });
    assert.deepEqual(changes, ["plugins.entries.constellation-audit-plugin.config.gatewayUrl"]);
    const entry = ((content.plugins as JsonObject).entries as JsonObject)["constellation-audit-plugin"] as JsonObject;
    assert.equal((entry.config as JsonObject).gatewayUrl, "https://new.example.com");
  });

  it("persists gatewayAllowPrivateHost only when allowPrivateHost is set", () => {
    const content: JsonObject = {};
    applyGateInstallPatch(content, { ...baseInstallPatch, allowPrivateHost: true });
    const entry = ((content.plugins as JsonObject).entries as JsonObject)["constellation-audit-plugin"] as JsonObject;
    assert.equal((entry.config as JsonObject).gatewayAllowPrivateHost, true);

    const content2: JsonObject = {};
    applyGateInstallPatch(content2, { ...baseInstallPatch, allowPrivateHost: false });
    const entry2 = ((content2.plugins as JsonObject).entries as JsonObject)["constellation-audit-plugin"] as JsonObject;
    assert.equal((entry2.config as JsonObject).gatewayAllowPrivateHost, undefined);
  });

  it("does not re-enable a deliberately disabled plugin", () => {
    const content: JsonObject = {
      plugins: { entries: { "constellation-audit-plugin": { enabled: false } } },
    };
    const changes = applyGateInstallPatch(content, { ...baseInstallPatch });
    assert.equal(changes.includes("plugins.entries.constellation-audit-plugin.enabled"), false);
    const entry = ((content.plugins as JsonObject).entries as JsonObject)["constellation-audit-plugin"] as JsonObject;
    assert.equal(entry.enabled, false);
  });

  it("respects enable: false (leaves enabled untouched on first install)", () => {
    const content: JsonObject = {};
    const changes = applyGateInstallPatch(content, { ...baseInstallPatch, enable: false });
    assert.equal(changes.includes("plugins.entries.constellation-audit-plugin.enabled"), false);
  });
});

describe("openclaw-config-writer: applyBrokerProviderPatch", () => {
  it("writes a provider entry with default key 'gate'", () => {
    const content: JsonObject = {};
    const changes = applyBrokerProviderPatch(content, {
      baseUrl: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
    });
    assert.deepEqual(changes.sort(), [
      "models.providers.gate.apiKey",
      "models.providers.gate.auth",
      "models.providers.gate.baseUrl",
      "models.providers.gate.models",
    ]);
    const provider = ((content.models as JsonObject).providers as JsonObject).gate as JsonObject;
    assert.equal(provider.baseUrl, "https://gate.example.com");
    assert.equal(provider.auth, "api-key");
    assert.equal(provider.apiKey, "sk-gw-aaaa");
    assert.deepEqual(provider.models, []);
  });

  it("honors a custom providerKey", () => {
    const content: JsonObject = {};
    applyBrokerProviderPatch(content, {
      providerKey: "my-broker",
      baseUrl: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
    });
    const providers = (content.models as JsonObject).providers as JsonObject;
    assert.ok(providers["my-broker"]);
    assert.ok(!providers.gate);
  });

  it("is idempotent — re-applying the same broker patch makes no changes", () => {
    const content: JsonObject = {};
    applyBrokerProviderPatch(content, { baseUrl: "https://gate.example.com", apiKey: "sk-gw-aaaa" });
    const second = applyBrokerProviderPatch(content, { baseUrl: "https://gate.example.com", apiKey: "sk-gw-aaaa" });
    assert.deepEqual(second, []);
  });

  it("switches baseUrl in place when the URL changes", () => {
    const content: JsonObject = {};
    applyBrokerProviderPatch(content, { baseUrl: "https://old.example.com", apiKey: "sk-gw-aaaa" });
    const changes = applyBrokerProviderPatch(content, { baseUrl: "https://new.example.com", apiKey: "sk-gw-aaaa" });
    assert.deepEqual(changes, ["models.providers.gate.baseUrl"]);
    const provider = ((content.models as JsonObject).providers as JsonObject).gate as JsonObject;
    assert.equal(provider.baseUrl, "https://new.example.com");
  });
});

describe("openclaw-config-writer: write atomicity & permissions", () => {
  let dir: string;
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { dir = makeOpenclawDir(); });

  it("creates a .bak when overwriting an existing file", () => {
    const path = join(dir, "config.json");
    writeOpenclawConfig(path, { initial: true });
    writeOpenclawConfig(path, { updated: true });

    assert.ok(existsSync(`${path}.bak`));
    const bak = JSON.parse(readFileSync(`${path}.bak`, "utf-8"));
    assert.equal(bak.initial, true);

    const current = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(current.updated, true);
  });

  it("writes the .bak file with mode 0o600 so the prior API key isn't world-readable", () => {
    const path = join(dir, "config.json");
    writeOpenclawConfig(path, { initial: true });
    writeOpenclawConfig(path, { updated: true });
    const mode = statSync(`${path}.bak`).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("writes the main config file with mode 0o600", () => {
    const path = join(dir, "config.json");
    writeOpenclawConfig(path, { hello: "world" });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("writes nothing to .bak on first write", () => {
    const path = join(dir, "config.json");
    writeOpenclawConfig(path, { hello: "world" });
    assert.ok(!existsSync(`${path}.bak`));
  });

  it("writes through a symlinked config without replacing the symlink", () => {
    // Some operators dotfile-manage ~/.openclaw — the symlink must survive.
    const realDir = mkdtempSync(join(tmpdir(), "openclaw-real-"));
    const realPath = join(realDir, "config.json");
    writeFileSync(realPath, JSON.stringify({ initial: true }));
    const linkPath = join(dir, "config.json");
    symlinkSync(realPath, linkPath);

    writeOpenclawConfig(linkPath, { updated: true });

    // The symlink itself still exists and still points at the real file.
    const stats = statSync(linkPath);
    assert.ok(stats.isFile());
    // Real file was updated through the symlink target.
    const real = JSON.parse(readFileSync(realPath, "utf-8"));
    assert.equal(real.updated, true);

    rmSync(realDir, { recursive: true, force: true });
  });

  it("readOpenclawConfig returns empty object when file does not exist", () => {
    const { content } = readOpenclawConfig(dir);
    assert.deepEqual(content, {});
  });

  it("readOpenclawConfig rejects non-object top-level JSON", () => {
    const path = join(dir, "config.json");
    writeOpenclawConfig(path, {} as JsonObject);
    writeFileSync(path, '"a string, not an object"');
    assert.throws(() => readOpenclawConfig(dir), /must contain a JSON object/);
  });
});

describe("openclaw-config-writer: isJsonObject", () => {
  it("returns true only for plain JSON objects", () => {
    assert.equal(isJsonObject({}), true);
    assert.equal(isJsonObject({ a: 1 }), true);
    assert.equal(isJsonObject(null), false);
    assert.equal(isJsonObject(undefined), false);
    assert.equal(isJsonObject([]), false);
    assert.equal(isJsonObject("string"), false);
    assert.equal(isJsonObject(42), false);
  });
});

describe("gate-installer: validation helpers", () => {
  it("normalizes and validates a good URL", () => {
    assert.equal(
      normalizeAndValidateUrl("https://gate.example.com/", false),
      "https://gate.example.com",
    );
  });

  it("rejects http:// to non-loopback", () => {
    assert.throws(
      () => normalizeAndValidateUrl("http://gate.example.com", false),
      (err: unknown) => err instanceof GateInstallError && err.code === "invalid-url",
    );
  });

  it("rejects URLs with userinfo (basic auth)", () => {
    assert.throws(
      () => normalizeAndValidateUrl("https://user:secret@gate.example.com", false),
      (err: unknown) => err instanceof GateInstallError && err.code === "invalid-url" && /userinfo/.test(err.message),
    );
  });

  it("rejects URLs with only a username", () => {
    assert.throws(
      () => normalizeAndValidateUrl("https://justuser@gate.example.com", false),
      (err: unknown) => err instanceof GateInstallError && err.code === "invalid-url",
    );
  });

  it("rejects empty API key", () => {
    assert.throws(
      () => validateApiKeyOrThrow(""),
      (err: unknown) => err instanceof GateInstallError && err.code === "invalid-api-key",
    );
  });

  it("rejects whitespace-bearing API keys", () => {
    assert.throws(
      () => validateApiKeyOrThrow("sk-gw with space"),
      (err: unknown) => err instanceof GateInstallError && err.code === "invalid-api-key",
    );
  });
});

describe("gate-installer: installGate", () => {
  let dir: string;
  beforeEach(() => { dir = makeOpenclawDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes config and registers broker by default when --skip-probe", async () => {
    const report = await installGate({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      registerBroker: true,
      allowPrivateHost: false,
      skipProbe: true,
      openclawDir: dir,
    });

    assert.ok(report.changes.length > 0);
    assert.equal(report.probe, null);

    const written = JSON.parse(readFileSync(report.configPath, "utf-8"));
    assert.equal(
      written.plugins.entries["constellation-audit-plugin"].config.gatewayUrl,
      "https://gate.example.com",
    );
    assert.equal(written.models.providers.gate.baseUrl, "https://gate.example.com");
  });

  it("is idempotent at the disk level — second install does not bump mtime or create a .bak", async () => {
    const firstReport = await installGate({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      registerBroker: true,
      allowPrivateHost: false,
      skipProbe: true,
      openclawDir: dir,
    });
    const mtimeAfterFirst = statSync(firstReport.configPath).mtimeMs;
    assert.equal(existsSync(`${firstReport.configPath}.bak`), false);

    // Sleep just enough that any second write would produce a different mtime.
    await new Promise((r) => setTimeout(r, 50));

    const secondReport = await installGate({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      registerBroker: true,
      allowPrivateHost: false,
      skipProbe: true,
      openclawDir: dir,
    });

    assert.deepEqual(secondReport.changes, []);
    assert.equal(statSync(secondReport.configPath).mtimeMs, mtimeAfterFirst);
    assert.equal(existsSync(`${secondReport.configPath}.bak`), false);
  });

  it("does not write broker entry when registerBroker is false", async () => {
    const report = await installGate({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      registerBroker: false,
      allowPrivateHost: false,
      skipProbe: true,
      openclawDir: dir,
    });
    assert.ok(!report.changes.some((c) => c.startsWith("models.providers")));
    const written = JSON.parse(readFileSync(report.configPath, "utf-8"));
    assert.equal(written.models, undefined);
  });

  it("persists gatewayAllowPrivateHost when the URL actually needs it", async () => {
    const report = await installGate({
      url: "https://10.0.0.5",
      apiKey: "sk-gw-aaaa",
      registerBroker: false,
      allowPrivateHost: true,
      skipProbe: true,
      openclawDir: dir,
    });
    const written = JSON.parse(readFileSync(report.configPath, "utf-8"));
    assert.equal(
      written.plugins.entries["constellation-audit-plugin"].config.gatewayAllowPrivateHost,
      true,
    );
    assert.ok(report.changes.includes("plugins.entries.constellation-audit-plugin.config.gatewayAllowPrivateHost"));
  });

  it("does not persist gatewayAllowPrivateHost when the URL is loopback (doesn't need it)", async () => {
    const report = await installGate({
      url: "http://127.0.0.1:8080",
      apiKey: "sk-gw-aaaa",
      registerBroker: false,
      allowPrivateHost: true,
      skipProbe: true,
      openclawDir: dir,
    });
    const written = JSON.parse(readFileSync(report.configPath, "utf-8"));
    assert.equal(
      written.plugins.entries["constellation-audit-plugin"].config.gatewayAllowPrivateHost,
      undefined,
    );
    assert.equal(report.changes.includes("plugins.entries.constellation-audit-plugin.config.gatewayAllowPrivateHost"), false);
  });
});

describe("gate-installer: readGateStatus", () => {
  let dir: string;
  beforeEach(() => { dir = makeOpenclawDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reports 'not configured' when no file exists", () => {
    const status = readGateStatus(dir);
    assert.equal(status.configured, false);
    assert.equal(status.hasApiKey, false);
    assert.equal(status.allowlisted, false);
  });

  it("reports configured state after install", async () => {
    await installGate({
      url: "https://gate.example.com",
      apiKey: "sk-gw-aaaa",
      registerBroker: true,
      allowPrivateHost: false,
      skipProbe: true,
      openclawDir: dir,
    });
    const status = readGateStatus(dir);
    assert.equal(status.configured, true);
    assert.equal(status.url, "https://gate.example.com");
    assert.equal(status.hasApiKey, true);
    assert.equal(status.allowlisted, true);
    assert.equal(status.conversationAccess, true);
    assert.equal(status.enabled, true);
    assert.equal(status.brokerProviderKey, "gate");
  });

  it("prefers the conventional 'gate' provider key when multiple providers share the URL", () => {
    const path = join(dir, "config.json");
    const config = {
      plugins: { entries: { "constellation-audit-plugin": {
        config: { gatewayUrl: "https://gate.example.com", gatewayApiKey: "sk-gw-aaaa" },
      } } },
      models: { providers: {
        "my-other-thing": { baseUrl: "https://gate.example.com" },
        gate: { baseUrl: "https://gate.example.com" },
      } },
    };
    writeFileSync(path, JSON.stringify(config));
    const status = readGateStatus(dir);
    assert.equal(status.brokerProviderKey, "gate");
  });

  it("falls back to URL scan when no 'gate' key is present", () => {
    const path = join(dir, "config.json");
    const config = {
      plugins: { entries: { "constellation-audit-plugin": {
        config: { gatewayUrl: "https://gate.example.com", gatewayApiKey: "sk-gw-aaaa" },
      } } },
      models: { providers: { custom: { baseUrl: "https://gate.example.com" } } },
    };
    writeFileSync(path, JSON.stringify(config));
    const status = readGateStatus(dir);
    assert.equal(status.brokerProviderKey, "custom");
  });

  it("does not crash on malformed JSON — reports not configured", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{not json");
    const status = readGateStatus(dir);
    assert.equal(status.configured, false);
  });
});
