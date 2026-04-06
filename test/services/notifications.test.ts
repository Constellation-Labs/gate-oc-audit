import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { NotificationService } from "../../src/services/notifications.js";
import type { ConfigChangeMetadata, ScanFinding } from "../../src/types/events.js";

describe("NotificationService", () => {
  let server: Server;
  let port: number;
  let receivedPayloads: unknown[];

  beforeEach(async () => {
    receivedPayloads = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedPayloads.push(JSON.parse(body));
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends config change notification with scan findings", async () => {
    const notifier = new NotificationService(`http://localhost:${port}/webhook`);

    const change: ConfigChangeMetadata = {
      artifactName: "web_search",
      artifactType: "tools",
      changeType: "modified",
      filePath: "/home/user/.openclaw/tools/web_search.ts",
      contentHash: "abc123",
      previousHash: "def456",
    };

    const findings: ScanFinding[] = [
      { check: "shell_exec", severity: "high", description: "Shell execution detected", line: 42 },
    ];

    await notifier.notifyConfigChange(change, findings);

    assert.equal(receivedPayloads.length, 1);
    const payload = receivedPayloads[0] as { text: string; blocks: Array<{ type: string; text: { text: string } }> };
    assert.ok(payload.text.includes("web_search"));
    assert.equal(payload.blocks.length, 2); // change block + scan block
    assert.ok(payload.blocks[1].text.text.includes("HIGH"));
    assert.ok(payload.blocks[1].text.text.includes("Shell execution"));
  });

  it("sends config change without scan findings", async () => {
    const notifier = new NotificationService(`http://localhost:${port}/webhook`);

    const change: ConfigChangeMetadata = {
      artifactName: "my_skill",
      artifactType: "skills",
      changeType: "added",
      filePath: "/home/user/.openclaw/skills/my_skill.ts",
      contentHash: "abc123",
    };

    await notifier.notifyConfigChange(change);

    assert.equal(receivedPayloads.length, 1);
    const payload = receivedPayloads[0] as { blocks: Array<unknown> };
    assert.equal(payload.blocks.length, 1);
  });

  it("sends integrity violation notification", async () => {
    const notifier = new NotificationService(`http://localhost:${port}/webhook`);

    await notifier.notifyIntegrityViolation(42, "expected123", "actual456");

    assert.equal(receivedPayloads.length, 1);
    const payload = receivedPayloads[0] as { text: string };
    assert.ok(payload.text.includes("integrity violation"));
  });

  it("sends DE anchor divergence notification", async () => {
    const notifier = new NotificationService(`http://localhost:${port}/webhook`);

    await notifier.notifyDeAnchorDivergence("cp-001", "localroot123", "deroot456");

    assert.equal(receivedPayloads.length, 1);
    const payload = receivedPayloads[0] as { text: string };
    assert.ok(payload.text.includes("divergence"));
  });

  it("does nothing when webhook URL is not configured", async () => {
    const notifier = new NotificationService();

    await notifier.notifyConfigChange({
      artifactName: "test",
      artifactType: "tools",
      changeType: "added",
      filePath: "/test",
      contentHash: "abc",
    });

    assert.equal(receivedPayloads.length, 0);
  });

  it("handles webhook errors gracefully", async () => {
    // Close server to force connection error
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const notifier = new NotificationService(`http://localhost:${port}/webhook`);

    // Should not throw
    await notifier.notifyConfigChange({
      artifactName: "test",
      artifactType: "tools",
      changeType: "added",
      filePath: "/test",
      contentHash: "abc",
    });
  });
});
