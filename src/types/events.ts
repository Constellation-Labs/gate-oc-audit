export type EventCategory =
  | "prompt"
  | "message"
  | "tool"
  | "system"
  | "agent"
  | "gateway";

export type EventType =
  | "prompt.response"
  | "prompt.input"
  | "prompt.model_resolve"
  | "prompt.build"
  | "tool.invoked"
  | "tool.result"
  | "tool.persisted"
  | "message.received"
  | "message.sending"
  | "message.sent"
  | "message.claimed"
  | "message.dispatched"
  | "message.write"
  | "agent.start"
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
  | "gateway.stop";

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
