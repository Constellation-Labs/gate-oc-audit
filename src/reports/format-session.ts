import type { SessionProjection, SessionTimelineEntry } from "./session-projection.js";
import { padRight, fmtUsd } from "./text-utils.js";

/**
 * Serialize a SessionProjection for `--json` output. The `metadata` blob on
 * each timeline entry can carry tool args (e.g. command lines when
 * redactToolArgs is off) the text formatter never prints — mirror the
 * `export --include-content` pattern and gate the raw blob behind an opt-in
 * flag so the JSON surface doesn't leak data text consumers would not see.
 */
export function serializeSessionProjectionJson(
  projection: SessionProjection,
  includeMetadata: boolean,
): string {
  if (includeMetadata) return JSON.stringify(projection);
  return JSON.stringify({
    ...projection,
    timeline: projection.timeline.map(({ metadata: _omit, ...rest }) => rest),
  });
}

/**
 * Human-readable rendering of a SessionProjection — the per-conversation
 * rollup specified in PRD R4. In default mode the Timeline section shows
 * the deduplicated stream; in --raw mode it shows every row. The Outbound
 * messages section always shows distinct bodies regardless of mode.
 */
export function formatSessionProjectionText(p: SessionProjection): string {
  const lines: string[] = [];

  lines.push(`Session ${p.sessionId}${p.jobId ? ` (cron ${p.jobId})` : ""}`);
  if (p.startedAt && p.endedAt) {
    const dur = p.durationMs !== null ? `  ${(p.durationMs / 1000).toFixed(1)}s` : "";
    lines.push(`  ${p.startedAt} → ${p.endedAt}${dur}`);
  } else {
    lines.push("  (no events for this session)");
  }
  lines.push(`  Generated ${p.generatedAt}${p.raw ? "  [--raw]" : ""}`);
  if (p.truncated) {
    lines.push(`  WARNING: event fetch truncated; some session rows are not in this report.`);
  }
  lines.push("");

  lines.push(p.raw ? "=== Timeline (raw) ===" : "=== Timeline ===");
  if (p.timeline.length === 0) {
    lines.push("  (no events)");
  } else {
    for (const entry of p.timeline) {
      lines.push(formatTimelineEntry(entry));
    }
  }
  lines.push("");

  lines.push(`=== Tools used (${p.toolsUsed.length}) ===`);
  if (p.toolsUsed.length === 0) {
    lines.push("  (no tool invocations)");
  } else {
    for (const t of p.toolsUsed) {
      const dur = (t.totalDurationMs / 1000).toFixed(2);
      lines.push(`  ${padRight(t.toolName, 24)}  calls=${t.calls}  errors=${t.errors}  ${dur}s`);
    }
  }
  lines.push("");

  lines.push("=== LLM cost ===");
  if (p.llmCost.totalCalls === 0) {
    lines.push("  (no LLM calls)");
  } else {
    const c = p.llmCost;
    lines.push(
      `  Calls ${c.totalCalls}  in=${c.inputTokens}  out=${c.outputTokens}  ` +
        `cacheR=${c.cacheReadTokens}  cacheW=${c.cacheWriteTokens}  ${fmtUsd(c.totalCostUsd)}`,
    );
    for (const m of c.byModel) {
      const provider = m.provider ? `${m.provider}/` : "";
      lines.push(
        `    ${padRight(provider + m.model, 32)}  calls=${m.calls}  in=${m.inputTokens}  out=${m.outputTokens}  ${fmtUsd(m.costUsd)}`,
      );
    }
  }
  lines.push("");

  const totalSends = p.outboundMessages.reduce((s, m) => s + m.sends.length, 0);
  lines.push(`=== Outbound messages (${p.outboundMessages.length} unique ${pluralize("body", p.outboundMessages.length, "bodies")}, ${totalSends} ${pluralize("send", totalSends)}) ===`);
  if (p.outboundMessages.length === 0) {
    lines.push("  (no outbound messages)");
  } else {
    for (const m of p.outboundMessages) {
      lines.push(`  sha256=${m.contentHash.slice(0, 16)}…  ${m.sends.length} send${m.sends.length === 1 ? "" : "s"}`);
      for (const s of m.sends) {
        const len = s.contentLength !== null ? `${s.contentLength} chars` : "size unknown";
        const status = s.success === null ? "" : s.success ? "  ok" : "  FAILED";
        lines.push(`    #${s.sequence}  ${s.createdAt}  ${s.channel}  ${s.recipient}  ${len}${status}`);
      }
      if (m.bodyPreview) {
        lines.push(`    Body: ${truncate(m.bodyPreview, 240)}`);
      }
    }
  }
  lines.push("");

  lines.push("=== Integrity ===");
  const i = p.integrity;
  if (i.eventCount === 0) {
    lines.push("  (no events to verify)");
  } else {
    const range = i.firstSequence !== null && i.lastSequence !== null
      ? `  (#${i.firstSequence}-#${i.lastSequence})`
      : "";
    lines.push(`  Events       ${i.eventCount}${range}`);
    lines.push(
      `  SMT proofs   verified=${i.proofsVerified}  failed=${i.proofsFailed}  unavailable=${i.proofsUnavailable}`,
    );
    if (i.smtRoot) {
      lines.push(`  SMT root     ${i.smtRoot}`);
    }
  }

  return lines.join("\n") + "\n";
}

function formatTimelineEntry(entry: SessionTimelineEntry): string {
  const collapsed = entry.collapsedCount && entry.collapsedCount > 1
    ? ` (×${entry.collapsedCount} consecutive identical-body rows: #${entry.collapsedSequences?.join(", #")})`
    : "";
  const preview = entry.contentPreview
    ? `\n    ${truncate(entry.contentPreview, 500)}`
    : "";
  return `  #${entry.sequence}  ${entry.createdAt}  ${entry.eventType} — ${entry.description}${collapsed}${preview}`;
}


function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function pluralize(word: string, n: number, plural?: string): string {
  return n === 1 ? word : (plural ?? `${word}s`);
}
