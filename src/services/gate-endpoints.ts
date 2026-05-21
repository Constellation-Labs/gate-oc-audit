/** swarm-deck's audit-ingest controller path. Used by both the
 * install-time probe (`gate-client`) and the runtime batch publisher
 * (`gateway-publisher`); centralised here so the broker contract has a
 * single source of truth. */
export const INGEST_PATH = "/api/v1/audit/ingest";

/** Pinned Gate broker endpoint while the service is in staging. Imported
 * by the CLI install wizard and the control-UI setup form so both ship
 * the same URL. Pure-constants module — safe for Vite to pull into the
 * browser bundle (no Node-only imports). */
export const STAGING_GATE_URL = "https://api-staging.constellationgate.ai";

/** Where operators issue API keys for the staging Gate. */
export const STAGING_GATE_KEYS_URL = "https://staging.constellationgate.ai/";
