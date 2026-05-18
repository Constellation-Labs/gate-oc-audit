import { createHash } from "node:crypto";

/**
 * R5a — duplicate-outbound detector. Flags pairs of `message.sent` events
 * with byte-identical content, sent to the same channel+recipient within
 * `windowSec`. The "consecutive" wording in the PRD is per (channel,
 * recipient) ordered by createdAt — not global event order — because two
 * channels can interleave outbound replies in the same second without
 * implicating each other.
 *
 * Why not reuse SMT rawHash for equality? `computeRawHash` mixes in
 * event.id and event.sequence (src/services/smt-service.ts:262-275), so
 * two byte-identical sends always differ. We hash `content` (the
 * decompressed message body) directly here. content === undefined collapses
 * to sha256(""), which is fine — empty-content events are unlikely to
 * legitimately duplicate, but if they do the report should still flag them.
 */
export interface MessageSentRow {
  id: string;
  sequence: number;
  createdAt: string;
  sessionId?: string;
  channel: string;
  recipient: string;
  content?: string;
}

export interface DuplicateOutboundFinding {
  contentSha256: string;
  channel: string;
  recipient: string;
  /** Always 2+ events. The first entry is the "original", the rest are "duplicates within window". */
  events: Array<{ id: string; sequence: number; createdAt: string; sessionId?: string }>;
  deltaSeconds: number;
}

export function detectDuplicateOutbound(
  rows: ReadonlyArray<MessageSentRow>,
  windowSec: number,
): DuplicateOutboundFinding[] {
  if (rows.length < 2) return [];
  if (windowSec <= 0) return [];

  // Bucket by (channel, recipient, contentSha256). Within each bucket, walk
  // events in createdAt order and emit a finding whenever the gap between
  // consecutive sends is ≤ windowSec. We don't collapse all duplicates in a
  // bucket into a single finding because two pairs separated by a long gap
  // are independent incidents.
  type Bucket = MessageSentRow & { contentSha256: string };
  const buckets = new Map<string, Bucket[]>();
  for (const row of rows) {
    const sha = sha256(row.content ?? "");
    const key = `${row.channel}\x00${row.recipient}\x00${sha}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push({ ...row, contentSha256: sha });
  }

  const findings: DuplicateOutboundFinding[] = [];
  const windowMs = windowSec * 1000;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    let runStart = 0;
    for (let i = 1; i <= bucket.length; i++) {
      const prevTime = Date.parse(bucket[i - 1].createdAt);
      const curTime = i < bucket.length ? Date.parse(bucket[i].createdAt) : Number.POSITIVE_INFINITY;
      const inRun = curTime - prevTime <= windowMs;
      if (!inRun) {
        // Close the current run if it contains ≥ 2 events.
        if (i - runStart >= 2) {
          const slice = bucket.slice(runStart, i);
          const first = Date.parse(slice[0].createdAt);
          const last = Date.parse(slice[slice.length - 1].createdAt);
          findings.push({
            contentSha256: slice[0].contentSha256,
            channel: slice[0].channel,
            recipient: slice[0].recipient,
            events: slice.map((r) => ({
              id: r.id,
              sequence: r.sequence,
              createdAt: r.createdAt,
              sessionId: r.sessionId,
            })),
            deltaSeconds: (last - first) / 1000,
          });
        }
        runStart = i;
      }
    }
  }
  // Stable sort by first-event sequence so the report listing is deterministic.
  findings.sort((a, b) => a.events[0].sequence - b.events[0].sequence);
  return findings;
}

/**
 * R5b — first-seen tool detector. Returns tool names invoked inside `today`
 * that were not present in `prior`. Set semantics; ordering of the result
 * follows insertion order from the today list so heavy-usage names surface
 * first when the caller passes a count-sorted array.
 */
export function detectFirstSeenTools(today: ReadonlyArray<string>, prior: ReadonlyArray<string>): string[] {
  const priorSet = new Set(prior);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of today) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!priorSet.has(name)) out.push(name);
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
