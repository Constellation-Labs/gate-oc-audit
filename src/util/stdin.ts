/**
 * Shared stdin reader for the `--api-key-stdin` flag across the audit
 * CLI surfaces.
 *
 * Errors when stdin is a TTY (so the operator can't accidentally hang
 * a piped-input command). Bytes are accumulated through individual
 * `data` events until a newline appears; remaining bytes after the
 * newline are dropped so a multi-line paste doesn't dump the tail to
 * the shell after the process exits.
 */

/**
 * Thrown when the operator passed `--api-key-stdin` but stdin is a
 * TTY. Carries a stable `code` so CLI handlers can recognise it and
 * print the friendly hint instead of letting the stack bubble out.
 */
export class StdinTtyError extends Error {
  readonly code = "stdin-tty" as const;
  constructor(message: string) {
   super(message);
   this.name = "StdinTtyError";
  }
}

export async function readStdinLine(commandHint: string): Promise<string> {
  if (process.stdin.isTTY) {
   throw new StdinTtyError(
    `--api-key-stdin requires the key to be piped in, e.g. \`echo $KEY | ${commandHint} --api-key-stdin\``,
   );
  }
  return await new Promise<string>((resolve, reject) => {
   let buf = "";
   const onData = (chunk: Buffer): void => {
    buf += chunk.toString("utf8");
    const newlineIdx = buf.indexOf("\n");
    if (newlineIdx >= 0) {
     cleanup();
     resolve(buf.slice(0, newlineIdx).replace(/\r$/, ""));
    }
   };
   const onEnd = (): void => {
    cleanup();
    resolve(buf.replace(/\r$/, ""));
   };
   const onError = (err: Error): void => {
    cleanup();
    reject(err);
   };
   const cleanup = (): void => {
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("error", onError);
   };
   process.stdin.on("data", onData);
   process.stdin.once("end", onEnd);
   process.stdin.once("error", onError);
  });
}
