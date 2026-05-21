/**
 * Normalise an `unknown` error value to a string message. Centralises the
 * `err instanceof Error ? err.message : "Unknown error"` idiom that
 * otherwise appears ~50 times across the codebase. Use this at every
 * try/catch site that funnels into a log line so the wording stays
 * consistent and a future change  has one place to land.
 */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return "Unknown error";
}
