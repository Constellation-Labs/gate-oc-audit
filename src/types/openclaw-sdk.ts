export interface HookOptions {
  priority?: number;
}

export interface BeforeAgentStartContext {
  sessionId: string;
  userId?: string;
  orgId?: string;
  prompt?: string;
  config: Record<string, unknown>;
}

export interface AgentEndContext {
  sessionId: string;
  durationMs: number;
  success: boolean;
  stats: {
    tokensUsed: number;
    toolCalls: number;
  };
}

export interface BeforeToolCallContext {
  sessionId: string;
  toolName: string;
  params: Record<string, unknown>;
  requestId: string;
}

export interface AfterToolCallContext {
  sessionId: string;
  toolName: string;
  result?: string;
  exitCode?: number;
  durationMs: number;
  requestId: string;
  error?: string;
}

export interface ToolResultPersistContext {
  sessionId: string;
  toolName: string;
  result?: string;
  requestId: string;
}

export interface MessageReceivedContext {
  sessionId: string;
  channel: string;
  content?: string;
  role: string;
  model?: string;
}

export interface MessageSentContext {
  sessionId: string;
  channel: string;
  content?: string;
  role: string;
  success: boolean;
  model?: string;
}

export interface ModelUsageDiagnostic {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  durationMs: number;
  costUsd?: number;
  sessionId?: string;
}

type HookName =
  | "before_agent_start"
  | "after_tool_call"
  | "before_tool_call"
  | "tool_result_persist"
  | "message_received"
  | "message_sent"
  | "agent_end";

type HookContextMap = {
  before_agent_start: BeforeAgentStartContext;
  agent_end: AgentEndContext;
  before_tool_call: BeforeToolCallContext;
  after_tool_call: AfterToolCallContext;
  tool_result_persist: ToolResultPersistContext;
  message_received: MessageReceivedContext;
  message_sent: MessageSentContext;
};

export interface OpenClawPluginApi {
  on<H extends HookName>(
    hook: H,
    handler: (ctx: HookContextMap[H]) => void | Promise<void>,
    options?: HookOptions,
  ): void;

  onDiagnosticEvent(
    event: "model.usage",
    handler: (data: ModelUsageDiagnostic) => void,
  ): void;

  registerService(service: { start(): void | Promise<void>; stop(): void | Promise<void> }): void;

  registerCli(command: {
    command: string;
    description: string;
    handler: (args: string[]) => void | Promise<void>;
  }): void;

  registerTool(tool: {
    name: string;
    description: string;
    handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
  }): void;

  config: {
    plugins: {
      entries: Record<string, { config: Record<string, unknown> }>;
    };
  };
}
