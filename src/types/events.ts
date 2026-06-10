export type EventCategory =
  | "prompt"
  | "message"
  | "tool"
  | "cron"
  | "system"
  | "agent"
  | "gateway"
  | "config"
  | "security";

export type EventType =
  | "prompt.response"
  | "prompt.input"
  | "prompt.model_resolve"
  | "prompt.build"
  | "tool.invoked"
  | "tool.result"
  | "tool.denied"
  | "tool.persisted"

  | "cron.executed"
  | "cron.failed"

  | "message.received"
  | "message.sending"
  | "message.sent"
  | "message.claimed"
  | "message.dispatched"
  | "message.write"
  | "agent.end"
  | "agent.compaction_start"
  | "agent.compaction_end"
  | "agent.reset"
  | "agent.subagent_spawning"
  | "agent.subagent_spawned"
  | "agent.subagent_delivery"
  | "agent.subagent_ended"
  | "session.start"
  | "session.end"
  | "gateway.start"
  | "gateway.stop"

  | "config.tool_changed"
  | "config.skill_changed"
  | "config.workspace_changed"
  // Legacy: emitted by older versions for `<root>/*.soul.*` files. Retained so
  // historical events still type-check; superseded by config.workspace_changed.
  | "config.soul_changed"
  | "config.cron_changed"
  | "security.scan_result"
  | "system.file_changed"
  | "system.install"
  | "system.install_hook_unavailable";

export type ConfigChangeType = "added" | "modified" | "removed";

export interface ConfigChangeMetadata {
  artifactName: string;
  artifactType: "skills" | "tools" | "workspace" | "soul" | "cron";
  changeType: ConfigChangeType;
  filePath: string;
  contentHash: string;
  previousHash?: string;
  diffSummary?: string;
}

export interface ScanFinding {
  check: string;
  severity: "medium" | "high";
  description: string;
  line?: number;
}

export interface ScanResultMetadata {
  toolName: string;
  // Present for file scans (config-watcher); omitted for tool-invocation scans.
  filePath?: string;
  // Distinguishes a static file scan from a runtime tool-argument scan.
  source?: "file" | "tool_invocation";
  findings: ScanFinding[];
}

export interface FileChangeMetadata {
  filePath: string;
  changeType: ConfigChangeType;
  contentHash: string;
  previousHash?: string;
  fileSize?: number;
}

export interface PromptMetadata {
  model: string;
  provider?: string;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  costUsd?: number;
}

export interface ToolMetadata {
  toolName: string;
  args?: Record<string, unknown>;
  exitCode?: number;
  durationMs?: number;
  error?: string;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  source: "openclaw-plugin" | "gateway" | "dashboard-api";
  machineId: string;
  sessionId?: string;
  orgId?: string;
  userId?: string;
  eventType: EventType;
  category: EventCategory;
  description: string;
  metadata: Record<string, unknown>;
  content?: string;
  contentHash: string;
  previousHash?: string;
  createdAt: string;
  receivedAt?: string;
  syncedAt?: string;
}

export interface AuditEventInsert {
  source?: AuditEvent["source"];
  sessionId?: string;
  orgId?: string;
  userId?: string;
  eventType: EventType;
  category: EventCategory;
  description: string;
  metadata: Record<string, unknown>;
  /** Full content to store gzipped. */
  content?: string;
}
