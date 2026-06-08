// Health verdict derivation for the Status page.
//
// Pure (no DOM/Lit) so the severity matrix can be unit-tested in a node test.
// Combines the point-in-time `StatusSnapshot` health signals with the live
// `AnomalyView` detector findings into a single overall verdict.

import type { StatusSnapshot, AnomalyView } from "./api.ts";

export type HealthLevel = "ok" | "warn" | "err";

export interface Issue {
  level: Exclude<HealthLevel, "ok">;
  message: string;
  /** Optional hash route to drill into the detail behind this issue. */
  href?: string;
}

export interface HealthVerdict {
  level: HealthLevel;
  issues: Issue[];
  /** Neutral, non-issue notes (e.g. anchoring not configured). */
  notes: string[];
}

const LEVEL_RANK: Record<HealthLevel, number> = { ok: 0, warn: 1, err: 2 };

/**
 * Derive the overall health verdict. `anomalies` is null when the anomaly scan
 * could not be fetched — the verdict is then computed from snapshot signals
 * alone and a note records that the scan was unavailable.
 */
export function computeHealthVerdict(
  s: StatusSnapshot,
  anomalies: AnomalyView | null,
): HealthVerdict {
  const issues: Issue[] = [];
  const notes: string[] = [];

  // ── Errors ────────────────────────────────────────────────────────────
  if (s.degraded) {
    issues.push({ level: "err", message: "Store is in degraded mode — some events may be missing." });
  }
  if (s.anchor.circuitOpen) {
    issues.push({ level: "err", message: "DE anchor circuit breaker is open — anchoring is backing off after repeated failures." });
  }
  if (s.securityScan.highFindings > 0) {
    issues.push({
      level: "err",
      message: `${s.securityScan.highFindings} high-severity security finding${s.securityScan.highFindings === 1 ? "" : "s"}.`,
      href: "#/inventory",
    });
  }

  // ── Warnings (snapshot) ───────────────────────────────────────────────
  if (s.anchor.consecutiveFailures > 0) {
    issues.push({
      level: "warn",
      message: `DE anchor failing — ${s.anchor.consecutiveFailures} consecutive failure${s.anchor.consecutiveFailures === 1 ? "" : "s"}.`,
    });
  }
  if (s.securityScan.mediumFindings > 0) {
    issues.push({
      level: "warn",
      message: `${s.securityScan.mediumFindings} medium-severity security finding${s.securityScan.mediumFindings === 1 ? "" : "s"}.`,
      href: "#/inventory",
    });
  }
  if (s.integrity.conversationAccess === "enabled-but-silent") {
    issues.push({
      level: "warn",
      message: "Conversation access is enabled but no prompt traffic seen in 24h — the host opt-in may be missing.",
    });
  }

  // ── Anomaly detector findings ─────────────────────────────────────────
  if (anomalies) {
    const iv = anomalies.anomalies.integrityViolations;
    // pendingVerification is a normal, expected state (AG-231) — not a violation.
    if (iv.tamperedEvents.length > 0) {
      issues.push({
        level: "err",
        message: `${iv.tamperedEvents.length} tampered event${iv.tamperedEvents.length === 1 ? "" : "s"} detected.`,
        href: "#/anomalies",
      });
    }
    if (iv.notFoundOnDe.length > 0) {
      issues.push({
        level: "err",
        message: `${iv.notFoundOnDe.length} checkpoint${iv.notFoundOnDe.length === 1 ? "" : "s"} confirmed missing on DE.`,
        href: "#/anomalies",
      });
    }
    if (anomalies.anomalies.denialSpikes.length > 0) {
      issues.push({
        level: "warn",
        message: `${anomalies.anomalies.denialSpikes.length} denial spike${anomalies.anomalies.denialSpikes.length === 1 ? "" : "s"} in the last 24h.`,
        href: "#/anomalies",
      });
    }
    if (anomalies.anomalies.duplicateOutbound.length > 0) {
      issues.push({
        level: "warn",
        message: `${anomalies.anomalies.duplicateOutbound.length} duplicate outbound send${anomalies.anomalies.duplicateOutbound.length === 1 ? "" : "s"} in the last 24h.`,
        href: "#/anomalies",
      });
    }
    if (anomalies.counts.capped) {
      issues.push({
        level: "warn",
        message: "Anomaly scan hit the event cap — results are inconclusive; treat empty findings with caution.",
        href: "#/anomalies",
      });
    }
  } else {
    notes.push("Anomaly scan unavailable — verdict reflects status signals only.");
  }

  // ── Neutral notes ─────────────────────────────────────────────────────
  if (!s.anchor.configured) {
    notes.push("DE anchoring is not configured — events are logged locally only.");
  }

  const level = issues.reduce<HealthLevel>(
    (worst, i) => (LEVEL_RANK[i.level] > LEVEL_RANK[worst] ? i.level : worst),
    "ok",
  );
  return { level, issues, notes };
}
