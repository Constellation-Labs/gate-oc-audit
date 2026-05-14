import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, resolve as resolvePath, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

/**
 * Serve a single file from `rootDir`. `requestPath` is the path *within*
 * the static root (e.g. "index.html", "assets/main-abc.js"); the caller is
 * responsible for stripping the route prefix before calling.
 *
 * Returns true when a response was written, false when the file was not
 * found (caller may chain to another handler or write a 404).
 */
export async function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
  requestPath: string,
): Promise<boolean> {
  // Normalize and reject path traversal.
  const cleaned = normalize(requestPath).replace(/^[/\\]+/, "");
  const absRoot = resolvePath(rootDir);
  const absPath = resolvePath(join(absRoot, cleaned));
  if (!absPath.startsWith(absRoot + "/") && absPath !== absRoot) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  let st;
  try {
    st = await stat(absPath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const mime = MIME[extname(absPath).toLowerCase()] ?? "application/octet-stream";
  // Vite emits fingerprinted asset filenames (e.g. main-abc123.js); cache them
  // aggressively. index.html stays no-cache so SPA shell updates are picked up.
  const isFingerprinted = /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/i.test(absPath) && !absPath.endsWith("index.html");
  res.statusCode = 200;
  res.setHeader("content-type", mime);
  res.setHeader("content-length", String(st.size));
  res.setHeader(
    "cache-control",
    isFingerprinted ? "public, max-age=31536000, immutable" : "no-cache",
  );

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
  return true;
}
