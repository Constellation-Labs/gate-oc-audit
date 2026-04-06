import type { ConfigChangeMetadata, ScanFinding } from "../types/events.js";

const SEND_TIMEOUT_MS = 10_000;

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
    this.webhookUrl = webhookUrl;
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
    expectedHash: string,
    actualHash: string,
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
              `*Expected hash:* \`${expectedHash.slice(0, 16)}...\``,
              `*Actual hash:* \`${actualHash.slice(0, 16)}...\``,
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
              `*Local root:* \`${localRoot.slice(0, 16)}...\``,
              `*DE root:* \`${deRoot.slice(0, 16)}...\``,
              `*Detected:* ${new Date().toISOString()}`,
            ].join("\n"),
          },
        },
      ],
    });
  }

  private async send(payload: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(
          `[audit-plugin] Notification webhook returned ${response.status}: ${response.statusText}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[audit-plugin] Notification webhook failed:", message);
    }
  }
}
