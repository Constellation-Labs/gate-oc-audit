import {describe, it, beforeEach, afterEach} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {createRequire} from "module";
import {AuditStore} from "../../src/store/audit-store.js";
import {
    createDeAnchorService,
    ApiKeyAnchorService,
    WalletAnchorService,
} from "../../src/services/de-anchor.js";
import type {AuditEventInsert} from "../../src/types/events.js";

const require2 = createRequire(import.meta.url);
const dedCore = require2("@constellation-network/digital-evidence-sdk") as typeof import("@constellation-network/digital-evidence-sdk");

function makeTempDb(): string {
    return join(mkdtempSync(join(tmpdir(), "audit-deanchor-")), "test.db");
}

function insert(store: AuditStore, overrides: Partial<AuditEventInsert> = {}) {
    return store.append({
        sessionId: "sess-1",
        eventType: "session.start",
        category: "system",
        description: "test",
        metadata: {test: true},
        ...overrides,
    })!;
}

describe("DeAnchorService", () => {
    let dbPath: string;
    let store: AuditStore;

    beforeEach(() => {
        dbPath = makeTempDb();
        store = new AuditStore(dbPath);
    });

    afterEach(() => {
        store.close();
        rmSync(dirname(dbPath), {recursive: true, force: true});
    });

    describe("anchorIfNeeded", () => {
        it("does not anchor when below event threshold", async () => {
            let received = false;
            const server = createServer((req, res) => {
                received = true;
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify([{accepted: true, hash: "should-not-reach", eventId: "evt-1", errors: []}]));
            });

            await new Promise<void>((r) => server.listen(0, r));
            const port = (server.address() as { port: number }).port;

            try {
                for (let i = 0; i < 5; i++) insert(store);

                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deApiUrl: `http://localhost:${port}/v1`,
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deEventThreshold: 100,
                });

                const mockSmtService = {getCurrentSmtRoot: () => "a".repeat(64)} as any;
                service.setSmtService(mockSmtService);

                await service.anchorIfNeeded();
                assert.equal(store.getLastCheckpoint(), undefined);
                assert.ok(!received, "DE API should not have been called when below threshold");
            } finally {
                await new Promise<void>((r) => server.close(() => r()));
            }
        });

        it("anchors when threshold reached", async () => {
            let received = false;
            const server = createServer((req, res) => {
                received = true;
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify([{accepted: true, hash: "de-tx-hash-123", eventId: "evt-1", errors: []}]));
            });

            await new Promise<void>((r) => server.listen(0, r));
            const port = (server.address() as { port: number }).port;

            try {
                for (let i = 0; i < 10; i++) insert(store, {metadata: {i}});

                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deApiUrl: `http://localhost:${port}/v1`,
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deEventThreshold: 5,
                });

                const mockSmtService = {getCurrentSmtRoot: () => "a".repeat(64)} as any;
                service.setSmtService(mockSmtService);

                await service.anchorIfNeeded();

                assert.ok(received, "DE API should have been called");

                const checkpoint = store.getLastCheckpoint();
                assert.ok(checkpoint);
                assert.equal(checkpoint!.eventCount, 10);
                assert.equal(checkpoint!.deTxHash, "de-tx-hash-123");
                assert.equal(checkpoint!.smtRoot, "a".repeat(64));
            } finally {
                await new Promise<void>((r) => server.close(() => r()));
            }
        });

        it("anchors below threshold when minEvents override is provided", async () => {
            let received = false;
            const server = createServer((req, res) => {
                received = true;
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify([{accepted: true, hash: "timer-tx-hash", eventId: "evt-1", errors: []}]));
            });

            await new Promise<void>((r) => server.listen(0, r));
            const port = (server.address() as { port: number }).port;

            try {
                for (let i = 0; i < 3; i++) insert(store, {metadata: {i}});

                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deApiUrl: `http://localhost:${port}/v1`,
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deEventThreshold: 100,
                });

                const mockSmtService = {getCurrentSmtRoot: () => "a".repeat(64)} as any;
                service.setSmtService(mockSmtService);

                // Without override — should NOT anchor (3 < 100)
                await service.anchorIfNeeded();
                assert.ok(!received, "Should not anchor with default threshold");

                // With minEvents=1 — should anchor (3 >= 1)
                await service.anchorIfNeeded(1);
                assert.ok(received, "Should anchor when minEvents=1");

                const checkpoint = store.getLastCheckpoint();
                assert.ok(checkpoint);
                assert.equal(checkpoint!.eventCount, 3);
                assert.equal(checkpoint!.deTxHash, "timer-tx-hash");
            } finally {
                await new Promise<void>((r) => server.close(() => r()));
            }
        });

        it("does not anchor when below custom timerMinEvents", async () => {
            let received = false;
            const server = createServer((req, res) => {
                received = true;
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify([{accepted: true, hash: "min3-tx-hash", eventId: "evt-1", errors: []}]));
            });

            await new Promise<void>((r) => server.listen(0, r));
            const port = (server.address() as { port: number }).port;

            try {
                for (let i = 0; i < 2; i++) insert(store, {metadata: {i}});

                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deApiUrl: `http://localhost:${port}/v1`,
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deEventThreshold: 100,
                    deTimerMinEvents: 3,
                });

                const mockSmtService = {getCurrentSmtRoot: () => "a".repeat(64)} as any;
                service.setSmtService(mockSmtService);

                // 2 events < timerMinEvents of 3 — should NOT anchor
                await service.anchorIfNeeded(3);
                assert.ok(!received, "Should not anchor when below timerMinEvents");

                // Add one more event (total 3) — should anchor
                insert(store, {metadata: {i: 2}});
                await service.anchorIfNeeded(3);
                assert.ok(received, "Should anchor when at timerMinEvents");

                const checkpoint = store.getLastCheckpoint();
                assert.ok(checkpoint);
                assert.equal(checkpoint!.eventCount, 3);
            } finally {
                await new Promise<void>((r) => server.close(() => r()));
            }
        });

        it("respects circuit breaker after failures", async () => {
            let callCount = 0;
            const server = createServer((req, res) => {
                callCount++;
                res.writeHead(500);
                res.end("error");
            });

            await new Promise<void>((r) => server.listen(0, r));
            const port = (server.address() as { port: number }).port;

            try {
                for (let i = 0; i < 10; i++) insert(store, {metadata: {i}});

                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deApiUrl: `http://localhost:${port}/v1`,
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deEventThreshold: 5,
                });

                const mockSmtService = {getCurrentSmtRoot: () => "a".repeat(64)} as any;
                service.setSmtService(mockSmtService);

                for (let i = 0; i < 6; i++) {
                    await service.anchorIfNeeded();
                }

                const callsAfterOpen = callCount;
                await service.anchorIfNeeded();
                assert.equal(callCount, callsAfterOpen);
            } finally {
                await new Promise<void>((r) => server.close(() => r()));
            }
        });
    });

    describe("factory", () => {
        it("returns NoOpAnchorService when no credentials configured", () => {
            const warnings: string[] = [];
            const origWarn = console.warn;
            console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

            try {
                const service = createDeAnchorService(store, {});
                assert.equal(service.isActive(), false);
                assert.ok(warnings.some((e) => e.includes("anchoring disabled")));
            } finally {
                console.warn = origWarn;
            }
        });

        it("returns NoOpAnchorService when API key without org/tenant", () => {
            const warnings: string[] = [];
            const origWarn = console.warn;
            console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

            try {
                const service = createDeAnchorService(store, {deApiKey: "test-key"});
                assert.equal(service.isActive(), false);
                assert.ok(warnings.some((e) => e.includes("deOrgId and deTenantId missing")));
                assert.ok(warnings.some((e) => e.includes("anchoring disabled")));
            } finally {
                console.warn = origWarn;
            }
        });

        it("returns NoOpAnchorService when wallet key file does not exist", () => {
            const warnings: string[] = [];
            const origWarn = console.warn;
            console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

            try {
                const service = createDeAnchorService(store, {
                    deWalletKeyFile: "/nonexistent/wallet.key",
                });
                assert.equal(service.isActive(), false);
                assert.ok(warnings.some((e) => e.includes("not found")));
                assert.ok(warnings.some((e) => e.includes("anchoring disabled")));
            } finally {
                console.warn = origWarn;
            }
        });

        it("returns NoOpAnchorService when wallet key file contains invalid key", () => {
            const keyFile = join(dirname(dbPath), "bad-wallet.key");
            writeFileSync(keyFile, "not-a-valid-hex-key");

            const warnings: string[] = [];
            const origWarn = console.warn;
            console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

            try {
                const service = createDeAnchorService(store, {deWalletKeyFile: keyFile});
                assert.equal(service.isActive(), false);
                assert.ok(warnings.some((e) => e.includes("invalid private key")));
                assert.ok(warnings.some((e) => e.includes("anchoring disabled")));
            } finally {
                console.warn = origWarn;
            }
        });

        it("API key takes precedence over wallet key file", () => {
            const kp = dedCore.generateKeyPair();
            const keyFile = join(dirname(dbPath), "wallet.key");
            writeFileSync(keyFile, kp.privateKey);

            const warnings: string[] = [];
            const origWarn = console.warn;
            console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

            try {
                const service = createDeAnchorService(store, {
                    deApiKey: "test-key",
                    deApiUrl: "http://localhost:9999/v1",
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deWalletKeyFile: keyFile,
                });
                assert.equal(service.isActive(), true);
                assert.ok(warnings.some((e) => e.includes("API key takes precedence")));
                assert.ok(!warnings.some((e) => e.includes("Wallet loaded")));
            } finally {
                console.warn = origWarn;
            }
        });
    });

    it("stop is idempotent", () => {
        const service = createDeAnchorService(store, {});
        service.stop();
        service.stop();
    });

    describe("wallet key file", () => {
        it("loads wallet key file and creates x402 client", () => {
            const kp = dedCore.generateKeyPair();
            const keyFile = join(dirname(dbPath), "wallet.key");
            writeFileSync(keyFile, kp.privateKey);

            const infos: string[] = [];
            const origInfo = console.info;
            console.info = (...args: unknown[]) => infos.push(args.join(" "));

            try {
                const service = createDeAnchorService(store, {deWalletKeyFile: keyFile});
                assert.equal(service.isActive(), true);
                assert.ok(infos.some((e) => e.includes("Wallet loaded")));
                assert.ok(infos.some((e) => e.includes("auth: x402")));
            } finally {
                console.info = origInfo;
            }
        });

        it("wallet path submits via x402 client", async () => {
            let received = false;
            const server = createServer((req, res) => {
                if (req.url?.includes("/fingerprints") && req.method === "POST") {
                    received = true;
                    res.writeHead(200, {"Content-Type": "application/json"});
                    res.end(JSON.stringify([{accepted: true, hash: "x402-tx-hash", eventId: "evt-1", errors: []}]));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });

            await new Promise<void>((r) => server.listen(0, r));
            const port = (server.address() as { port: number }).port;

            try {
                const kp = dedCore.generateKeyPair();
                const keyFile = join(dirname(dbPath), "wallet.key");
                writeFileSync(keyFile, kp.privateKey);

                for (let i = 0; i < 10; i++) insert(store, {metadata: {i}});

                const service = new WalletAnchorService(store, keyFile, {
                    deApiUrl: `http://localhost:${port}/v1`,
                    deEventThreshold: 5,
                });
                const mockSmtService = {getCurrentSmtRoot: () => "b".repeat(64)} as any;
                service.setSmtService(mockSmtService);

                await service.anchorIfNeeded();

                assert.ok(received, "x402 API should have been called");
                const checkpoint = store.getLastCheckpoint();
                assert.ok(checkpoint);
                assert.equal(checkpoint!.eventCount, 10);
            } finally {
                await new Promise<void>((r) => server.close(() => r()));
            }
        });

        it("strips 0x prefix from wallet key", () => {
            const kp = dedCore.generateKeyPair();
            const keyFile = join(dirname(dbPath), "wallet.key");
            writeFileSync(keyFile, `0x${kp.privateKey}`);

            const infos: string[] = [];
            const origInfo = console.info;
            console.info = (...args: unknown[]) => infos.push(args.join(" "));

            try {
                const service = createDeAnchorService(store, {deWalletKeyFile: keyFile});
                assert.equal(service.isActive(), true);
                assert.ok(infos.some((e) => e.includes("Wallet loaded")));
            } finally {
                console.info = origInfo;
            }
        });
    });
});
