import type { ConfigChangeMetadata, ScanFinding } from "../types/events.js";
import {log} from "../util/logger.js";
import { isUnsafeWebhookUrl, postJsonWebhook } from "../util/webhook.js";

const ARTIFACT_LABELS: Record<string, string> = {
  tools: "Tool",
  skills: "Skill",
  workspace: "Workspace file",
  soul: "Soul file",
  cron: "Cron prompt",
};

export interface NotificationPayload {
  text: string;
  blocks: Array<{
    type: "section";
    text: { type: "mrkdwn"; text: string };
  }>;
}

/** Truncate an SMT/DE root for display: keeps the first 16 hex chars then
 *  an ellipsis. Short non-hash values pass through unchanged. */
function formatRoot(s: string): string {
  return s.length > 20 ? s.slice(0, 16) + "..." : s;
}

export interface NotificationOptions {
  /**
   * Operator opt-in for posting notifications to a private/link-local host
   * (e.g. an intranet Slack proxy). Off by default; with it off, the shared
   * outbound-URL policy applies.
   */
  allowPrivateHost?: boolean;
}

export class NotificationService {
  private webhookUrl: string | undefined;
  /** Mirrors the config-time SSRF opt-in so the send-time DNS re-check in
   *  `postJsonWebhook` applies the same allow/deny intent. */
  private readonly allowPrivateHost: boolean;

  constructor(webhookUrl?: string, opts: NotificationOptions = {}) {
    this.allowPrivateHost = opts.allowPrivateHost === true;
    if (webhookUrl) {
      const reason = isUnsafeWebhookUrl(webhookUrl, { allowPrivateHost: this.allowPrivateHost });
      if (reason) {
        log.warn(`Webhook URL rejected (${reason}), notifications disabled`);
      } else {
        this.webhookUrl = webhookUrl;
      }
    }
  }

  async notifyConfigChange(
    change: ConfigChangeMetadata,
    scanFindings?: ScanFinding[],
    machineName?: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    const label = ARTIFACT_LABELS[change.artifactType] ?? "Config artifact";

    const lines = [
      `*${label} ${change.changeType}:* \`${change.artifactName}\``,
      change.diffSummary ? `*Change:* ${change.diffSummary}` : undefined,
      `*Detected:* ${new Date().toISOString()}`,
      machineName ? `*Machine:* ${machineName}` : undefined,
    ].filter(Boolean);

    const blocks: NotificationPayload["blocks"] = [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    ];

    if (scanFindings && scanFindings.length > 0) {
      const findingLines = scanFindings.map(
        (f) => `- ${f.severity.toUpperCase()}: ${f.description}${f.line ? ` (line ${f.line})` : ""}`,
      );
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Scan result:* ${scanFindings.length} finding(s)\n${findingLines.join("\n")}`,
        },
      });
    }

    await this.send({
      text: `OpenClaw config change detected: ${change.artifactName} ${change.changeType}`,
      blocks,
    });
  }

  async notifyToolArgScan(
    toolName: string,
    scanFindings: ScanFinding[],
    machineName?: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;
    if (!scanFindings || scanFindings.length === 0) return;

    const lines = [
      `*Tool invocation scan:* \`${toolName}\``,
      `*Detected:* ${new Date().toISOString()}`,
      machineName ? `*Machine:* ${machineName}` : undefined,
    ].filter(Boolean);

    const findingLines = scanFindings.map(
      (f) => `- ${f.severity.toUpperCase()}: ${f.description}${f.line ? ` (line ${f.line})` : ""}`,
    );

    await this.send({
      text: `OpenClaw tool-invocation scan: ${scanFindings.length} finding(s) in ${toolName}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Scan result:* ${scanFindings.length} finding(s)\n${findingLines.join("\n")}`,
          },
        },
      ],
    });
  }

  async notifyIntegrityViolation(
    sequence: number,
    error: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    await this.send({
      text: "OpenClaw audit trail integrity violation detected",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              "*Integrity violation detected*",
              `*Sequence:* ${sequence}`,
              `*Error:* ${error}`,
              `*Detected:* ${new Date().toISOString()}`,
            ].join("\n"),
          },
        },
      ],
    });
  }

  async notifyDeAnchorDivergence(
    checkpointId: string,
    localRoot: string,
    deRoot: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    await this.send({
      text: "OpenClaw DE anchor divergence detected",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              "*Digital Evidence anchor divergence*",
              `*Checkpoint:* \`${checkpointId}\``,
              `*Local root:* \`${formatRoot(localRoot)}\``,
              `*DE root:* \`${formatRoot(deRoot)}\``,
              `*Detected:* ${new Date().toISOString()}`,
            ].join("\n"),
          },
        },
      ],
    });
  }

  // DE returned 404 for a previously-submitted checkpoint: the local root is
  // intact but DE has no record of the tx hash. Distinct from divergence —
  // there is no DE-side root to compare against. Callers dedup repeats
  // across restarts so the operator gets one notification per checkpoint.
  async notifyDeAnchorNotFound(
    checkpointId: string,
    smtRoot: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    await this.send({
      text: "OpenClaw DE anchor missing on Digital Evidence",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              "*Digital Evidence anchor not found*",
              `*Checkpoint:* \`${checkpointId}\``,
              `*Local root:* \`${formatRoot(smtRoot)}\``,
              "*Reason:* DE returned 404 for the recorded tx hash — the fingerprint may need re-submission.",
              `*Detected:* ${new Date().toISOString()}`,
            ].join("\n"),
          },
        },
      ],
    });
  }

  private async send(payload: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) return;
    // postJsonWebhook re-validates the resolved IP on every send (closing the
    // "validated once at construction" gap), so no separate re-validation is
    // needed here.
    const result = await postJsonWebhook(this.webhookUrl, payload, {
      allowPrivateHost: this.allowPrivateHost,
    });
    if (!result.ok) {
      if (result.status !== undefined) {
        log.error(`Notification webhook returned ${result.status}: ${result.error}`);
      } else {
        log.error(`Notification webhook failed: ${result.error}`);
      }
    }
  }
}
