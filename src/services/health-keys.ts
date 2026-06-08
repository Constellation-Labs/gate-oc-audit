// Lightweight, dependency-free home for service_health row names that are
// shared across modules. Kept separate from de-anchor.ts so consumers (e.g.
// report builders) can reference a key without eagerly loading the DE SDK
// that de-anchor.ts requires at module top.

/**
 * service_health row holding the set of checkpoint IDs whose DE transaction
 * was confirmed missing (a 404 during verification). Authoritative signal for
 * "anchored but truly absent from DE", as opposed to merely pending.
 */
export const ANCHOR_NOT_FOUND_HEALTH_NAME = "anchor-not-found";
