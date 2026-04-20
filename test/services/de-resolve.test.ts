import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveBaseUrl, validateTestUrl } from "../../src/services/de-anchor.js";

describe("resolveBaseUrl", () => {
  afterEach(() => {
    delete process.env.DE_TEST_URL;
  });

  it("integration returns static URL", () => {
    const url = resolveBaseUrl("integration");
    assert.match(url, /integrationnet/);
  });

  it("mainnet returns static URL", () => {
    const url = resolveBaseUrl("mainnet");
    assert.match(url, /lb-mainnet/);
    assert.doesNotMatch(url, /integrationnet/);
  });

  it("test with valid DE_TEST_URL returns that URL", () => {
    process.env.DE_TEST_URL = "http://localhost:8080/v1";
    assert.equal(resolveBaseUrl("test"), "http://localhost:8080/v1");
  });

  it("test with missing DE_TEST_URL throws", () => {
    delete process.env.DE_TEST_URL;
    assert.throws(() => resolveBaseUrl("test"), /DE_TEST_URL/);
  });

  it("test with empty DE_TEST_URL throws", () => {
    process.env.DE_TEST_URL = "";
    assert.throws(() => resolveBaseUrl("test"), /DE_TEST_URL/);
  });

  it("test with public host in DE_TEST_URL throws", () => {
    process.env.DE_TEST_URL = "http://example.com/v1";
    assert.throws(() => resolveBaseUrl("test"), /loopback/);
  });

  it("test with private non-loopback IP in DE_TEST_URL throws", () => {
    process.env.DE_TEST_URL = "http://10.0.0.5/v1";
    assert.throws(() => resolveBaseUrl("test"), /loopback/);
  });

  it("test with file:// URL throws", () => {
    process.env.DE_TEST_URL = "file:///etc/passwd";
    assert.throws(() => resolveBaseUrl("test"), /http/);
  });

  it("test with javascript: URL throws", () => {
    process.env.DE_TEST_URL = "javascript:alert(1)";
    assert.throws(() => resolveBaseUrl("test"), /http/);
  });
});

describe("validateTestUrl", () => {
  for (const url of [
    "http://localhost",
    "http://localhost/",
    "http://localhost:8080",
    "http://localhost:8080/v1",
    "http://127.0.0.1",
    "http://127.0.0.1:8080/v1",
    "https://localhost",
    "https://localhost:8443/v1",
    "https://127.0.0.1:8443/v1",
    "http://[::1]:8080/v1",
    "https://[::1]/",
  ]) {
    it(`accepts ${url}`, () => assert.doesNotThrow(() => validateTestUrl(url)));
  }

  for (const url of [
    "http://example.com",
    "http://example.com/v1",
    "http://10.0.0.5/v1",
    "http://192.168.1.1/v1",
    "http://172.16.0.1/v1",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://localhost/",
    "not a url",
    "",
  ]) {
    it(`rejects ${JSON.stringify(url)}`, () => assert.throws(() => validateTestUrl(url)));
  }
});
