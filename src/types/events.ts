export type EventCategory =
  | "prompt"
  | "message"
  | "tool"
  | "cron"
  | "config"
  | "security"
  | "system";

export type EventType =
  | "prompt.sent"
  | "prompt.response"
  | "tool.invoked"
  | "tool.result"
  | "tool.persisted"
  | "tool.denied"
  | "cron.executed"
  | "cron.failed"
  | "config.tool_changed"
  | "config.skill_changed"
  | "config.soul_changed"
  | "config.cron_changed"
  | "security.scan_result"
  | "message.received"
  | "message.sent"
  | "session.start"
  | "session.end";

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
  contentHash: string;
  previousHash: string;
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
