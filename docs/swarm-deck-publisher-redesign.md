# Audit-plugin → swarm-deck gateway: envelope redesign around the SMT

**Status:** design proposal — review-only. No code changes yet on either side.
**Authors:** openclaw-audit-plugin team.
**Audience:** swarm-deck gateway-proxy maintainers (`apps/gateway-proxy/src/audit-ingest`), `packages/database` migrations.
**Created:** 2026-05-14.

## Problem

The plugin's gateway publisher fails to deliver to swarm-deck with `400 Bad Request`. Two root causes were found:

1. **Path mismatch.** The plugin POSTs to `/admin/audit/ingest` but the gateway controller is mounted at `/api/v1/audit/ingest` (`apps/gateway-proxy/src/audit-ingest/audit-ingest.controller.ts:46,53`). The `/admin/audit/ingest` references elsewhere in the gateway repo are stale comments. Today the request falls through to the catch-all `ProxyController @All("*")` which treats it as LLM traffic and the LLM pipeline returns 400.

2. **Payload schema drift.** The gateway DTO (`apps/gateway-proxy/src/audit-ingest/types.ts`) expects spec §11.3:

   ```ts
   { machineId, events: [{...standard fields..., contentHash, previousHash?}] }
   ```

   under `ValidationPipe({whitelist, forbidNonWhitelisted, transform})` (`apps/gateway-proxy/src/main.ts:109-115`). The plugin sends `{events: [AuditEvent]}` with no envelope `machineId`, no per-event `contentHash`, and includes `orgId`/`syncedAt` which are forbidden by `forbidNonWhitelisted`.

A band-aid fix exists (omit `previousHash`, add `contentHash`, drop forbidden fields, fix path). We chose **not** to ship it. The §11.3 design predates the plugin's SMT-first integrity model and duplicates work; we want to redesign the wire format around the SMT before paying down code on the wrong shape.

## Background

- The plugin's authoritative integrity primitive is the **Sparse Merkle Tree** in `src/services/smt-service.ts`. Each event becomes one (or two) SMT leaves; the SMT root is what gets anchored to Digital Evidence via `audit_checkpoint` rows (`smt_root`, optional `de_tx_hash`).
- The plugin **already dropped** `content_hash` / `previous_hash` columns in its own schema (v3; see `src/store/schema.ts:128-129`). Reintroducing them just to feed the gateway would duplicate the SMT's job and add a second chain to maintain.
- The plugin **does not populate** `AuditEvent.orgId` anywhere. The gateway derives orgId from `request.gatewayApiKey.orgId` (`apps/gateway-proxy/src/audit-ingest/audit-ingest.controller.ts:81`). Confirmed: `AuditEventInsert.orgId` is optional and untouched across all `safeAppend` callsites in `src/hooks.ts`, `src/rate-limiter.ts`, and `src/services/*`.
- The SMT computes two stateless, deterministic hashes per event (`src/services/smt-service.ts`):
  - `computeRawHash(event)` — sha256 over the canonicalized `{id, sequence, eventType, category, description, metadata, content}`. The SMT leaf key.
  - `computeCensoredHash(event)` — sha256 over `{id, eventType, category, createdAt}`. Privacy-preserving lookup key.
- Stable anchor points already exist as `audit_checkpoint` rows. The recent UI work surfaces verify-on-demand against these (`/plugins/audit/api/events/:id/verify`).
- The gateway is multi-tenant durable storage. The plugin's local SMT + DE anchor is the integrity mechanism. The gateway's job for audit events is durable forwarding, per-org indexing, dashboard reads — not a parallel cryptographic chain.

## Proposed envelope

```
POST /api/v1/audit/ingest
X-Gateway-Api-Key: sk-gw-...
Content-Type: application/json

{
  "machineId": "<plugin-machineId>",              // envelope-level, required
  "events": [
    {
      "id":           "<uuidv7>",
      "sequence":     <int>,
      "source":       "openclaw-plugin",
      "machineId":    "<must match envelope>",
      "sessionId":    "<optional>",
      "userId":       "<optional>",
      "eventType":    "...",
      "category":     "...",
      "description":  "...",
      "metadata":     { ... },                     // optional
      "content":      "...",                        // optional, gated by `gatewayIncludeContent`
      "rawHash":      "<64-char sha256 hex>",       // SmtService.computeRawHash — REQUIRED
      "censoredHash": "<64-char sha256 hex>",       // SmtService.computeCensoredHash — REQUIRED
      "createdAt":    "<iso8601>",
      "receivedAt":   "<iso8601 optional>"
    },
    ...
  ],
  "smtCheckpoint": {                                // OPTIONAL
    "smtRoot":       "<hex>",
    "sequenceStart": <int>,
    "sequenceEnd":   <int>,
    "deTxHash":      "<hex>",
    "createdAt":     "<iso8601>"
  }
}
```

### Key shifts from §11.3

| Field | §11.3 today | Proposed | Why |
|---|---|---|---|
| envelope `machineId` | required | unchanged | already correct |
| per-event `contentHash` | required, `sha256(content ?? "")` | **renamed** `rawHash`, `sha256(canonicalize({id,sequence,eventType,category,description,metadata,content}))` | matches the actual SMT leaf key; gateway stores the authoritative chain identity instead of a parallel content-only chain |
| per-event `censoredHash` | absent | **new**, required | enables privacy-preserving lookups on the gateway without storing content |
| per-event `previousHash` | optional | **dropped** | gap-detection is subsumed by SMT replay against `smtCheckpoint.smtRoot` |
| envelope `smtCheckpoint` | absent | **new**, optional | binds the batch to the most recent DE-anchored checkpoint; gateway stores it so downstream auditors have the on-chain receipt |

## Gateway-side changes (swarm-deck)

### `apps/gateway-proxy/src/audit-ingest/types.ts`

- Rename `contentHash` validator → `rawHash`. Same constraint (`@IsString @MaxLength(64)`, lowercase hex).
- Add `censoredHash` (required, same constraint).
- Remove `previousHash`.
- Add optional `smtCheckpoint` nested DTO with validators for `smtRoot` (hex string), `sequenceStart`/`sequenceEnd` (`@IsInt @Min(0)`), `deTxHash` (hex string), `createdAt` (`@IsISO8601`).

### `apps/gateway-proxy/src/audit-ingest/audit-ingest.controller.ts`

- Remove the `contentHash`-vs-`sha256(content)` recheck at `audit-ingest.controller.ts:110-115`. The plugin's `rawHash` covers more than `content` alone, so the gateway can't re-derive it without the DE SDK's `canonicalize`. Two options for the replacement (see Open Questions):
  - **A.** Accept `rawHash` as attestation (no recompute).
  - **B.** Vendor `@constellation-network/digital-evidence-sdk` into the gateway and recompute. Catches transit corruption + plugin bugs at the cost of a dependency.
- When `smtCheckpoint` is present and `deTxHash` is non-null, persist the rows as cryptographically anchored. Otherwise mark them anchor-pending.

### Database migration

A new migration in `packages/database/src/migrations/`:

- `plugin_audit_events.content_hash` → `raw_hash` (rename, semantic shift).
- Add `plugin_audit_events.censored_hash` (text, not null after backfill TBD).
- Drop `plugin_audit_events.previous_hash`.
- New table OR new columns on `plugin_audit_events` for `smtCheckpoint` linkage. Two shapes considered (see Open Questions):
  - **Per-row:** add `last_smt_root`, `last_de_tx_hash`, `last_seq_start`, `last_seq_end`, `last_checkpoint_at` columns. Cheap reads; data repeats across rows in the same batch.
  - **Separate table:** `plugin_audit_checkpoints(org_id, machine_id, smt_root, seq_start, seq_end, de_tx_hash, created_at)` plus a nullable `last_checkpoint_id` FK on `plugin_audit_events`. Normalized; one extra join for verifier queries.

### Repository

- `apps/gateway-proxy/src/audit-ingest/plugin-audit-events.repository.ts`: extend the row input shape to carry `rawHash`, `censoredHash`, and the checkpoint linkage.

## Plugin-side changes (applied after gateway change is merged)

### `src/services/gateway-publisher.ts`

- `INGEST_PATH = "/api/v1/audit/ingest"`.
- `buildPayload(batch)`:
  - Derive envelope `machineId` from `batch[0].machineId`; assert all events share it (the publisher only batches single-machine events). On mismatch, log warn and drop the batch.
  - Per event, project to the DTO: keep `id, sequence, source, machineId, sessionId, userId, eventType, category, description, metadata, content` (gated by `gatewayIncludeContent`), `createdAt, receivedAt`. **Add** `rawHash = smtService.computeRawHash(event)` and `censoredHash = smtService.computeCensoredHash(event)`. **Drop** `orgId, syncedAt`.
  - Compute `smtCheckpoint` once per batch: scan `store.getCheckpoints()` for the highest `sequenceEnd ≤ batch[last].sequence` with `deTxHash !== null`. Attach if found, omit otherwise.
- `send(body)`: append response body to the thrown error so future contract drift self-explains. One-line diff:

  ```ts
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gateway returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  ```

### Wiring

The publisher currently has no `SmtService` handle (only `RateLimiter` does). Plumb it through `createGatewayPublisher(config, { onDropMilestone, smtService })`. `src/index.ts` already constructs `activeSmt` before the publisher; pass it in.

### Tests

`test/services/gateway-publisher.test.ts`:

- Update HTTP-mock assertions to expect the new path.
- Expect envelope `machineId`.
- Expect each event in `events[]` to carry `rawHash` and `censoredHash`, and to NOT carry `orgId` or `syncedAt`.
- Add a case with a known DE-anchored checkpoint and assert `smtCheckpoint` is present + matches the latest anchored row.
- Add a case with no anchored checkpoint and assert `smtCheckpoint` is omitted.

## Open questions (resolve before code lands)

1. **Does the gateway re-verify `rawHash`?**
   - A: accept as attestation, no recompute. Simpler, no dependency. Loses today's transit-corruption check against `contentHash`.
   - B: vendor DE SDK's `canonicalize` + `hashDocument` into the gateway and recompute. Adds a dependency; catches transit corruption.

2. **Storage shape for `smtCheckpoint`.** Per-row columns vs separate `plugin_audit_checkpoints` table. Affects query patterns in `dashboard-api`.

3. **Rollout / back-compat.** Hard cut DTO (force plugin lockstep upgrade) or accept both shapes via a discriminator (`apiVersion` or shape-sniffing) for one release? Plugin is third-party-installable, so a transition window is preferable.

4. **`smtCheckpoint.smtRoot` semantics.** Confirm we want the *latest DE-anchored* checkpoint, not the *latest* checkpoint regardless of `deTxHash` state. Otherwise the field's value can't be trusted for verification.

5. **Anchor-pending events.** A batch's events may all be newer than the most recent anchored checkpoint. We'd send `smtCheckpoint: null` or omit. Confirm the gateway accepts those rows (stored as anchor-pending) rather than rejecting.

## Out of scope

- Re-introducing a content-hash chain on the plugin side.
- Reintroducing `previousHash` (subsumed by SMT replay).
- Bumping the audit-plugin version. The 400 will continue to fire on the current 0.2.2 against local gateways until both sides land — this is expected and called out in the plugin README/CHANGELOG when shipping.

## References

- Plugin: `src/services/gateway-publisher.ts`, `src/services/smt-service.ts`, `src/store/audit-store.ts`, `src/store/schema.ts`, `src/services/de-anchor.ts`.
- Gateway: `apps/gateway-proxy/src/audit-ingest/{audit-ingest.controller.ts, types.ts, plugin-audit-events.repository.ts}`, `apps/gateway-proxy/src/main.ts`, `apps/gateway-proxy/src/proxy/proxy.controller.ts`, `packages/database/src/migrations/28-api-key-audit-ingest-scope.ts`.
