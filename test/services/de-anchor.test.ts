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
import {ANCHOR_NOT_FOUND_HEALTH_NAME} from "../../src/services/health-keys.js";
import type {AuditEventInsert} from "../../src/types/events.js";
import {deAnchorLog} from "../../src/util/logger.js";
import {captureLogger} from "../test-utils/capture-logger.js";

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
        delete process.env.DE_TEST_URL;
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

                process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deEnv: "test",
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

                process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deEnv: "test",
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

                process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deEnv: "test",
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

                process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deEnv: "test",
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

                process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deEnv: "test",
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
            const capture = captureLogger(deAnchorLog);
            try {
                const service = createDeAnchorService(store, {});
                assert.equal(service.isActive(), false);
                assert.ok(capture.messages.some((e) => e.includes("anchoring disabled")));
            } finally {
                capture.restore();
            }
        });

        it("returns NoOpAnchorService when API key without org/tenant", () => {
            const capture = captureLogger(deAnchorLog);
            try {
                const service = createDeAnchorService(store, {deApiKey: "test-key"});
                assert.equal(service.isActive(), false);
                assert.ok(capture.messages.some((e) => e.includes("deOrgId and deTenantId missing")));
                assert.ok(capture.messages.some((e) => e.includes("anchoring disabled")));
            } finally {
                capture.restore();
            }
        });

        it("returns NoOpAnchorService when wallet key file does not exist", () => {
            const capture = captureLogger(deAnchorLog);
            try {
                const service = createDeAnchorService(store, {
                    deWalletKeyFile: "/nonexistent/wallet.key",
                });
                assert.equal(service.isActive(), false);
                assert.ok(capture.messages.some((e) => e.includes("not found")));
                assert.ok(capture.messages.some((e) => e.includes("anchoring disabled")));
            } finally {
                capture.restore();
            }
        });

        it("returns NoOpAnchorService when wallet key file contains invalid key", () => {
            const keyFile = join(dirname(dbPath), "bad-wallet.key");
            writeFileSync(keyFile, "not-a-valid-hex-key");

            const capture = captureLogger(deAnchorLog);
            try {
                const service = createDeAnchorService(store, {deWalletKeyFile: keyFile});
                assert.equal(service.isActive(), false);
                assert.ok(capture.messages.some((e) => e.includes("invalid private key")));
                assert.ok(capture.messages.some((e) => e.includes("anchoring disabled")));
            } finally {
                capture.restore();
            }
        });

        it("API key takes precedence over wallet key file", () => {
            const kp = dedCore.generateKeyPair();
            const keyFile = join(dirname(dbPath), "wallet.key");
            writeFileSync(keyFile, kp.privateKey);

            const capture = captureLogger(deAnchorLog);
            try {
                process.env.DE_TEST_URL = "http://localhost:9999/v1";
                const service = createDeAnchorService(store, {
                    deApiKey: "test-key",
                    deEnv: "test",
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deWalletKeyFile: keyFile,
                });
                assert.equal(service.isActive(), true);
                assert.ok(capture.messages.some((e) => e.includes("API key takes precedence")));
                assert.ok(!capture.messages.some((e) => e.includes("Wallet loaded")));
            } finally {
                capture.restore();
            }
        });
    });

    it("stop is idempotent", async () => {
        const service = createDeAnchorService(store, {});
        await service.stop();
        await service.stop();
    });

    describe("wallet key file", () => {
        it("loads wallet key file and creates x402 client", () => {
            const kp = dedCore.generateKeyPair();
            const keyFile = join(dirname(dbPath), "wallet.key");
            writeFileSync(keyFile, kp.privateKey);

            const capture = captureLogger(deAnchorLog);
            try {
                const service = createDeAnchorService(store, {deWalletKeyFile: keyFile});
                assert.equal(service.isActive(), true);
                assert.ok(capture.messages.some((e) => e.includes("Wallet loaded")));
                assert.ok(capture.messages.some((e) => e.includes("auth: x402")));
            } finally {
                capture.restore();
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

                process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
                const service = new WalletAnchorService(store, keyFile, {
                    deEnv: "test",
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

            const capture = captureLogger(deAnchorLog);
            try {
                const service = createDeAnchorService(store, {deWalletKeyFile: keyFile});
                assert.equal(service.isActive(), true);
                assert.ok(capture.messages.some((e) => e.includes("Wallet loaded")));
            } finally {
                capture.restore();
            }
        });
    });

    describe("health() (R6)", () => {
        it("NoOp anchor returns isActive=false with zeroed counters", () => {
            const service = createDeAnchorService(store, {});
            assert.deepEqual(service.health(), {
                isActive: false,
                consecutiveFailures: 0,
                circuitOpenUntil: 0,
                lastAnchorAt: undefined,
                lastTxHash: undefined,
                anchoredToday: 0,
                pendingSinceLastCheckpoint: 0,
            });
        });

        it("active anchor reflects lastAnchorAt + anchoredToday after a successful anchor", async () => {
            const server = createServer((_req, res) => {
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify([{accepted: true, hash: "de-tx-h", eventId: "evt-x", errors: []}]));
            });
            await new Promise<void>((r) => server.listen(0, r));
            const port = (server.address() as { port: number }).port;

            try {
                for (let i = 0; i < 6; i++) insert(store, {metadata: {i}});

                process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
                const service = new ApiKeyAnchorService(store, {
                    deApiKey: "test-key",
                    deEnv: "test",
                    deOrgId: "11111111-1111-1111-1111-111111111111",
                    deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    deEventThreshold: 5,
                });
                const mockSmtService = {getCurrentSmtRoot: () => "a".repeat(64)} as any;
                service.setSmtService(mockSmtService);

                // Append more events before anchoring so pendingSinceLastCheckpoint is non-zero post-anchor.
                await service.anchorIfNeeded();
                for (let i = 0; i < 2; i++) insert(store, {metadata: {pendingI: i}});

                const h = service.health();
                assert.equal(h.isActive, true);
                assert.equal(h.consecutiveFailures, 0);
                assert.equal(h.lastTxHash, "de-tx-h");
                assert.ok(h.lastAnchorAt, "lastAnchorAt should be populated from the checkpoint");
                assert.equal(h.anchoredToday, 1);
                assert.equal(h.pendingSinceLastCheckpoint, 2);

                // Persistence: service_health row written on success.
                const persisted = store.getServiceHealth("anchor");
                assert.ok(persisted, "service_health row should exist after a successful anchor");
                const payload = persisted.payload as { lastTxHash: string };
                assert.equal(payload.lastTxHash, "de-tx-h");
            } finally {
                await new Promise<void>((r) => server.close(() => r()));
            }
        });
    });

    describe("verifyCheckpoints (re-verify)", () => {
        // A controllable mock DE server. Submit (POST) always accepts; verify
        // (GET /v1/fingerprints/{hash}) returns whatever `verifyStatus` is set
        // to, so a test can flip a checkpoint from 404 (not found on DE) to 200
        // (confirmed) and observe the service react.
        function makeDeServer() {
            let verifyStatus = 404;
            const server = createServer((req, res) => {
                if (req.method === "POST") {
                    res.writeHead(200, {"Content-Type": "application/json"});
                    res.end(JSON.stringify([{accepted: true, hash: "detx-mid", eventId: "evt-1", errors: []}]));
                    return;
                }
                // GET — verification lookup by hash.
                res.writeHead(verifyStatus, {"Content-Type": "application/json"});
                res.end(verifyStatus === 200 ? JSON.stringify({status: "FINALIZED"}) : JSON.stringify({error: "not found"}));
            });
            return {
                server,
                listen: () =>
                    new Promise<number>((r) => server.listen(0, () => r((server.address() as {port: number}).port))),
                setVerifyStatus: (s: number) => {
                    verifyStatus = s;
                },
            };
        }

        function makeService(port: number, overrides: Record<string, unknown> = {}) {
            process.env.DE_TEST_URL = `http://localhost:${port}/v1`;
            const service = new ApiKeyAnchorService(store, {
                deApiKey: "test-key",
                deEnv: "test",
                deOrgId: "11111111-1111-1111-1111-111111111111",
                deTenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                deEventThreshold: 1000,
                ...overrides,
            });
            service.setSmtService({getCurrentSmtRoot: () => "a".repeat(64)} as any);
            return service;
        }

        function notFoundSet(): Set<string> {
            const row = store.getServiceHealth(ANCHOR_NOT_FOUND_HEALTH_NAME);
            return new Set(Array.isArray(row?.payload) ? (row!.payload as string[]) : []);
        }

        async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (predicate()) return;
                await new Promise((r) => setTimeout(r, 10));
            }
            assert.fail(`condition not met within ${timeoutMs}ms`);
        }

        it("startup verify confirms a pending checkpoint and clears a recovered not-found entry", async () => {
            const de = makeDeServer();
            const port = await de.listen();
            try {
                // A checkpoint that was previously 404'd (recorded in the
                // not-found set) but is now confirmable on DE.
                store.insertCheckpoint("cp-recovered", 1, 10, "a".repeat(64), 10, "detx-recovered");
                store.upsertServiceHealth(ANCHOR_NOT_FOUND_HEALTH_NAME, ["cp-recovered"]);
                de.setVerifyStatus(200);

                const service = makeService(port);
                try {
                    await service.start();
                    // start() awaits the startup verifyCheckpoints() pass.
                    assert.equal(store.getUnverifiedCheckpoints().length, 0, "checkpoint should be verified");
                    assert.equal(notFoundSet().has("cp-recovered"), false, "recovered checkpoint dropped from not-found set");
                } finally {
                    await service.stop();
                }
            } finally {
                await new Promise<void>((r) => de.server.close(() => r()));
            }
        });

        it("periodic timer re-verifies a checkpoint that DE confirms after startup", async () => {
            const de = makeDeServer();
            const port = await de.listen();
            try {
                // Anchored mid-session, DE hasn't confirmed it yet.
                store.insertCheckpoint("cp-mid", 1, 10, "a".repeat(64), 10, "detx-mid");

                const service = makeService(port, {deIntervalMs: 40});
                try {
                    // Startup pass: DE 404s — stays unverified, recorded as not-found.
                    await service.start();
                    assert.equal(store.getUnverifiedCheckpoints().length, 1, "still pending after startup 404");
                    assert.equal(notFoundSet().has("cp-mid"), true, "404 recorded in not-found set");

                    // DE catches up; the interval timer must pick it up without a restart.
                    de.setVerifyStatus(200);
                    await waitFor(() => store.getUnverifiedCheckpoints().length === 0);
                    assert.equal(notFoundSet().has("cp-mid"), false, "confirmed checkpoint dropped from not-found set");
                } finally {
                    await service.stop();
                }
            } finally {
                await new Promise<void>((r) => de.server.close(() => r()));
            }
        });
    });
});
