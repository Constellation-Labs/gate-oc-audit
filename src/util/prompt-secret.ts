import type { Interface as ReadlineInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";

/**
 * Read a secret from a TTY without echoing it. The fallback path (when
 * stdin is not a real TTY or `setRawMode` fails) reads a line — no
 * masking, but still better than crashing. We don't try to be cleverer
 * than that here; mature secret entry belongs in the SDK, not this
 * plugin.
 *
 * Multi-byte safety: a single `data` event may split a UTF-8 codepoint
 * across continuation bytes (rare on a TTY, possible on paste), so we
 * accumulate raw bytes through a `StringDecoder` and only emit complete
 * characters. After the terminator, any remaining bytes in the chunk
 * are discarded so a multi-line paste does not flush the tail to the
 * shell after the process exits.
 */
export async function promptSecret(rl: ReadlineInterface, prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
   return (await rl.question(prompt)).trim();
  }

  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  const decoder = new StringDecoder("utf8");

  return await new Promise<string>((resolve, reject) => {
   let buf = "";
   const onData = (chunk: Buffer): void => {
    const s = decoder.write(chunk);
    for (let i = 0; i < s.length; i++) {
     const ch = s[i];
     const code = ch.charCodeAt(0);
     if (code === 0x03) {
      finish();
      process.stdout.write("\n");
      reject(new Error("aborted (Ctrl-C)"));
      return;
     }
     if (code === 0x0d || code === 0x0a) {
      // Drain anything after the line terminator in this same chunk
      // and discard it so a multi-line paste doesn't dump its tail
      // into the post-exit shell.
      finish();
      process.stdout.write("\n");
      resolve(buf.trim());
      return;
     }
     if (code === 0x7f || code === 0x08) {
      buf = buf.slice(0, -1);
      continue;
     }
     buf += ch;
    }
   };
   const onEnd = (): void => {
    finish();
    reject(new Error("aborted (stdin closed)"));
   };
   const onError = (err: Error): void => {
    finish();
    reject(err);
   };
   const finish = (): void => {
    try { stdin.setRawMode(false); } catch { /* swallow */ }
    stdin.pause();
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    stdin.off("close", onEnd);
    stdin.off("error", onError);
   };
   stdin.on("data", onData);
   stdin.once("end", onEnd);
   stdin.once("close", onEnd);
   stdin.once("error", onError);
  });
}
