import type { DialectId } from '../lib/ai-provider-catalog';

// ── Message content blocks ──────────────────────────────────────────

/**
 * Data a provider needs back on a later turn, kept with the block it arrived with and stored with the conversation.
 * Only the dialect named in `dialect` reads it, and only for the model that wrote it; every other consumer passes it on
 * untouched or ignores it.
 */
export interface AiProviderData {
  dialect: DialectId;
  /** Model id the data was written for. A different model gets none of it. */
  model: string;
  data: Record<string, unknown>;
}

/** Plain text block inside an assistant message */
export interface AiTextBlock {
  type: 'text';
  text: string;
  providerData?: AiProviderData;
}

/** Tool invocation block inside an assistant message */
export interface AiToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
  providerData?: AiProviderData;
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
  /** Data for the turn's text block. A turn keeps the last one it sees; the text can be empty when only the data arrives. */
  providerData?: AiProviderData;
}

export interface AiStreamToolUseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
  providerData?: AiProviderData;
}

export interface AiStreamUsageEvent {
  type: 'usage';
  /** Total prompt tokens for this call, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache (reads only). */
  cachedInputTokens?: number;
  /** Prompt tokens written to the provider's cache on this request (Anthropic `cache_creation_input_tokens`). */
  cacheCreationInputTokens?: number;
  /** Model id the request actually ran on, for example `claude-opus-5-5`. Set by the provider layer. */
  model?: string;
  /** Provider type id the request ran on, for example `anthropic`. Set by the provider layer. */
  providerType?: string;
  /** Models skipped or failed before this one served the request, with a short reason. Set by the router. */
  fallbacks?: Array<{ model: string; error: string }>;
}

/**
 * The model declined after it had already streamed output. Last event of the stream. A consumer drops the text and tool
 * calls it received before this event, because they are incomplete, and shows `message` in their place. A refusal before
 * any output is a ModelRefusedError instead.
 */
export interface AiStreamRefusalEvent {
  type: 'refusal';
  message: string;
}

/** Events emitted by the LLM provider during streaming */
export type AiStreamEvent =
  | AiStreamTextEvent
  | AiStreamToolUseEvent
  | AiStreamUsageEvent
  | AiStreamRefusalEvent;

// ── WebSocket events (backend ↔ frontend) ───────────────────────────

// Client → Server

/** Send a new user message to the AI */
export interface AiChatSendMessage {
  action: 'ai:message';
  conversationId?: number;
  pageContext: string;
  contextId?: string;
  message: string;
  requestId?: string;
  /** App path the chat is started from (for example `/ui/analysis/12`), kept so history can link back. Used only for a new chat. */
  originPath?: string;
  /** Starts a new chat in YOLO mode. Ignored when `conversationId` is set: the server's state for that conversation decides. */
  yolo?: boolean;
}

/**
 * Switch YOLO mode for a conversation, or for a new chat's first run by its `requestId`. Leave `enabled` out to ask.
 * The server answers with `ai:yolo-state`.
 */
export interface AiYoloMessage {
  action: 'ai:yolo';
  conversationId?: number;
  requestId?: string;
  enabled?: boolean;
}

/** Cancel an in-progress AI response */
export interface AiChatCancelMessage {
  action: 'ai:cancel';
  conversationId: number | null;
  requestId?: string;
}

/**
 * How far an approval reaches. `once` covers the single call being asked about; `conversation` also covers later
 * calls to the same tool in the same conversation. A denial is always `once`.
 */
export type AiToolConfirmScope = 'once' | 'conversation';

/** User responds to a tool confirmation prompt */
export interface AiToolConfirmResponseMessage {
  action: 'ai:tool-confirm-response';
  toolUseId: string;
  allowed: boolean;
  /** Defaults to `once`. Any value other than `conversation` is treated as `once`. */
  scope?: AiToolConfirmScope;
}

// Server → Client

/** Streamed text token */
export interface AiTokenEvent {
  type: 'ai:token';
  conversationId: number;
  requestId?: string;
  text: string;
}

/** Agent started executing a tool */
export interface AiToolStartEvent {
  type: 'ai:tool-start';
  conversationId: number;
  requestId?: string;
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
  requestId?: string;
  toolUseId: string;
  result: string;
  durationMs: number;
}

/** AI response finished */
export interface AiDoneEvent {
  type: 'ai:done';
  conversationId: number;
  requestId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  /** True when the agent stopped because it ran out of tool-loop turns */
  turnLimitReached?: boolean;
}

/** AI response error */
export interface AiErrorEvent {
  type: 'ai:error';
  conversationId: number | null;
  error: string;
}

/** Context window usage update (emitted after each agent turn) */
export interface AiContextUsageEvent {
  type: 'ai:context-usage';
  conversationId: number | null;
  requestId?: string;
  percent: number;
}

/** A tool requires user confirmation before executing */
export interface AiToolConfirmEvent {
  type: 'ai:tool-confirm';
  conversationId: number | null;
  requestId?: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, any>;
}

/** Whether YOLO mode is on: for a conversation, or for a new chat's first run when `requestId` is set */
export interface AiYoloStateEvent {
  type: 'ai:yolo-state';
  conversationId: number | null;
  requestId?: string;
  enabled: boolean;
}

/** Union of all server → client AI events */
export type AiServerEvent =
  | AiTokenEvent
  | AiToolStartEvent
  | AiToolResultEvent
  | AiDoneEvent
  | AiErrorEvent
  | AiContextUsageEvent
  | AiToolConfirmEvent
  | AiYoloStateEvent;

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
  /** App path the chat was started from, or null for a chat saved before history existed. */
  originPath: string | null;
  /** The last reply did not finish: it was cancelled, it failed, or the connection dropped. */
  unfinished: boolean;
}

/** One row of the chat history list: a conversation without its messages. */
export type AiConversationSummary = Omit<AiConversation, 'messages'>;

/**
 * `GET /v1/ai/conversations?limit=&offset=&q=&pageContext=&contextId=`, newest activity first.
 * `limit` defaults to 30 (max 100). `q` matches the title and the message text. `pageContext` and
 * `contextId` narrow the list to one page context. Only the caller's own conversations are listed,
 * plus ones saved before history existed. Chats started by automated runs are left out.
 */
export interface AiConversationListResponse {
  conversations: AiConversationSummary[];
  hasMore: boolean;
}
