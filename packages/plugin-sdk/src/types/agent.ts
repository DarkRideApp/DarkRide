// Minimal duplicates of HandleMessageParams / HandleMessageResult from
// backend/services/ai-agent — kept here so shared/plugins/types.ts does not
// import from backend/ (which would create a circular dep boundary violation).
// Keep in sync with the canonical definitions in ai-agent.ts.
export interface PluginAgentHandleMessageParams {
  conversationId: number | null;
  message: string;
  pageContext: string;
  contextId: string;
  onToken: (text: string) => void;
  onToolStart: (toolUseId: string, toolName: string, input: unknown, toolUseCount: number, turnsRemaining: number) => void;
  onToolResult: (toolUseId: string, toolName: string, output: unknown, durationMs: number) => void;
  onContextUsage?: (percent: number) => void;
  signal?: AbortSignal;
  maxTurns?: number;
  mode: 'silent' | 'streaming';
}

export interface PluginAgentHandleMessageResult {
  conversationId: number;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  turnLimitReached?: boolean;
}

export interface PluginAgent {
  readonly identity: {
    identityType: 'plugin' | 'plugin-acting-for-user';
    actorUserId: number;
    effectiveScopes: string[];
    onBehalfOfPlugin?: string;
    actingForUserId?: number;
  };
  /**
   * Rejects when no model could serve the request, including when every model declined it
   * (`ModelRefusedError`). A model that declines before producing anything is retried on the next model
   * of the tier first. A refusal after the model started answering is part of the returned text, not a rejection.
   */
  handleMessage(params: PluginAgentHandleMessageParams): Promise<PluginAgentHandleMessageResult>;
}
