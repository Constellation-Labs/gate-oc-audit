/**
 * Direct stdout/stderr writers shared by the audit CLI surfaces
 * (`cli.ts`, `cli-gate.ts`, `cli-provider.ts`).
 *
 * Bypasses `console.log` on purpose — openclaw's CLI dispatch path
 * captures and re-routes `console.*` for log-stream collation, which
 * corrupts the JSON-on-one-line invariant we rely on for
 * `--json` outputs. Writing straight to the file descriptor keeps the
 * wire format predictable.
 */

export function outLine(s: string): void {
  process.stdout.write(`${s}\n`);
}

export function errLine(s: string): void {
  process.stderr.write(`${s}\n`);
}
