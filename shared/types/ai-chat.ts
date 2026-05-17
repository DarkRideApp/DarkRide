// ── Message content blocks ──────────────────────────────────────────

/** Plain text block inside an assistant message */
export interface AiTextBlock {
  type: 'text';
  text: string;
}

/** Tool invocation block inside an assistant message */
export interface AiToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

// ── Conversation messages (stored in DB, sent to LLM) ───────────────

/** User-originated message */
export interface AiUserMessage {
  role: 'user';
  content: string;
}

/** Assistant response with text and/or tool calls */
export interface AiAssistantMessage {
  role: 'assistant';
  content: Array<AiTextBlock | AiToolUseBlock>;
}

/** Result of a tool invocation, fed back to the LLM */
export interface AiToolResultMessage {
  role: 'tool_result';
  toolUseId: string;
  content: string;
}

/** Any message in a conversation */
export type AiMessage = AiUserMessage | AiAssistantMessage | AiToolResultMessage;

// ── Tool definitions ────────────────────────────────────────────────

/** Schema for a tool the agent can invoke */
export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  /** Which page contexts this tool is available in (e.g. ['devices', 'automations']) */
  context: string[];
}

// ── Stream events (provider → agent loop) ───────────────────────────

export interface AiStreamTextEvent {
  type: 'text';
  text: string;
}

export interface AiStreamToolUseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface AiStreamUsageEvent {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
}

/** Events emitted by the LLM provider during streaming */
export type AiStreamEvent =
  | AiStreamTextEvent
  | AiStreamToolUseEvent
  | AiStreamUsageEvent;

// ── WebSocket events (backend ↔ frontend) ───────────────────────────

// Client → Server

/** Send a new user message to the AI */
export interface AiChatSendMessage {
  action: 'ai:message';
  conversationId?: number;
  pageContext: string;
  contextId?: string;
  message: string;
}

/** Cancel an in-progress AI response */
export interface AiChatCancelMessage {
  action: 'ai:cancel';
  conversationId: number;
}

/** User responds to a tool confirmation prompt */
export interface AiToolConfirmResponseMessage {
  action: 'ai:tool-confirm-response';
  toolUseId: string;
  allowed: boolean;
}

// Server → Client

/** Streamed text token */
export interface AiTokenEvent {
  type: 'ai:token';
  conversationId: number;
  text: string;
}

/** Agent started executing a tool */
export interface AiToolStartEvent {
  type: 'ai:tool-start';
  conversationId: number;
  toolUseId: string;
  toolName: string;
  input: Record<string, any>;
  toolUseCount: number;
  turnsRemaining: number;
}

/** Tool execution completed */
export interface AiToolResultEvent {
  type: 'ai:tool-result';
  conversationId: number;
  toolUseId: string;
  result: string;
  durationMs: number;
}

/** AI response finished */
export interface AiDoneEvent {
  type: 'ai:done';
  conversationId: number;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  /** True when the agent stopped because it ran out of tool-loop turns */
  turnLimitReached?: boolean;
}

/** AI response error */
export interface AiErrorEvent {
  type: 'ai:error';
  conversationId: number;
  error: string;
}

/** Context window usage update (emitted after each agent turn) */
export interface AiContextUsageEvent {
  type: 'ai:context-usage';
  conversationId: number | null;
  percent: number;
}

/** A tool requires user confirmation before executing */
export interface AiToolConfirmEvent {
  type: 'ai:tool-confirm';
  conversationId: number | null;
  toolUseId: string;
  toolName: string;
  input: Record<string, any>;
}

/** Union of all server → client AI events */
export type AiServerEvent =
  | AiTokenEvent
  | AiToolStartEvent
  | AiToolResultEvent
  | AiDoneEvent
  | AiErrorEvent
  | AiContextUsageEvent
  | AiToolConfirmEvent;

// ── Conversation (API response shape) ───────────────────────────────

/** Full conversation as returned by the REST API */
export interface AiConversation {
  id: number;
  pageContext: string;
  contextId: string | null;
  title: string | null;
  messages: AiMessage[];
  createdAt: number;
  updatedAt: number;
}
