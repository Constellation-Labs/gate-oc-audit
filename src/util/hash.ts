const MAX_DEPTH = 100;

function stableStringify(value: unknown, seen = new WeakSet(), depth = 0): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (depth >= MAX_DEPTH) {
    return '"[TooDeep]"';
  }

  if (seen.has(value as object)) {
    return '"[Circular]"';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v, seen, depth + 1)).join(",") + "]";
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue; // omit undefined keys, same as JSON.stringify
    pairs.push(JSON.stringify(k) + ":" + stableStringify(obj[k], seen, depth + 1));
  }
  return "{" + pairs.join(",") + "}";
}

/**
 * Produces a deterministic canonical JSON string with sorted keys.
 * Used for both storage and hashing so metadata is only serialized once.
 */
export function canonicalize(value: Record<string, unknown>): string {
  return stableStringify(value);
}

