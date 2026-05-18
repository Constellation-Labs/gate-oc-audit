import type { ConfigChangeMetadata, ScanFinding } from "../types/events.js";
import {log} from "../util/logger.js";
import { isUnsafeWebhookUrl, postJsonWebhook } from "../util/webhook.js";

const ARTIFACT_LABELS: Record<string, string> = {
  tools: "Tool",
  skills: "Skill",
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

export class NotificationService {
  private webhookUrl: string | undefined;

  constructor(webhookUrl?: string) {
    if (webhookUrl) {
      const reason = isUnsafeWebhookUrl(webhookUrl);
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
              `*Local root:* \`${localRoot.length > 20 ? localRoot.slice(0, 16) + "..." : localRoot}\``,
              `*DE root:* \`${deRoot.length > 20 ? deRoot.slice(0, 16) + "..." : deRoot}\``,
              `*Detected:* ${new Date().toISOString()}`,
            ].join("\n"),
          },
        },
      ],
    });
  }

  private async send(payload: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) return;
    const result = await postJsonWebhook(this.webhookUrl, payload);
    if (!result.ok) {
      if (result.status !== undefined) {
        log.error(`Notification webhook returned ${result.status}: ${result.error}`);
      } else {
        log.error(`Notification webhook failed: ${result.error}`);
      }
    }
  }
}
