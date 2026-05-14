import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";

const DEFAULT_PORT = 18789;
const DEFAULT_HOST = "127.0.0.1";

export interface GatewayUrlInfo {
  baseUrl: string;
  bindMode: string;
  /** True when the bind mode would expose audit UI beyond loopback. */
  nonLoopback: boolean;
}

/**
 * Resolve the gateway base URL (no trailing slash) using the live openclaw
 * runtime config snapshot. Falls back to http://127.0.0.1:18789 when the
 * snapshot is unavailable.
 */
export function resolveGatewayBaseUrl(): GatewayUrlInfo {
  const snap = (() => {
    try { return getRuntimeConfigSnapshot(); } catch { return null; }
  })();
  const gw = snap?.gateway ?? {};
  const port = typeof gw.port === "number" ? gw.port : DEFAULT_PORT;
  const tls = gw.tls?.enabled === true;
  const scheme = tls ? "https" : "http";
  const bindMode = typeof gw.bind === "string" ? gw.bind : "loopback";

  let host = DEFAULT_HOST;
  if (bindMode === "custom" && typeof gw.customBindHost === "string" && gw.customBindHost.length > 0) {
    host = gw.customBindHost;
  }

  const basePath = typeof gw.controlUi?.basePath === "string" ? gw.controlUi.basePath.replace(/\/+$/, "") : "";
  const baseUrl = `${scheme}://${host}:${port}${basePath}`;

  const nonLoopback = bindMode !== "loopback" && bindMode !== "auto";
  return { baseUrl, bindMode, nonLoopback };
}

export function resolveAuditUiUrl(): string {
  return `${resolveGatewayBaseUrl().baseUrl}/plugins/audit/`;
}
