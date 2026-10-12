import type { WebSocket } from 'ws';
import { registerWebsocketEndpoint, getWebsocketHandler } from './handlers';
import type { HandleMessageParams } from '../services/ai-agent';
import type { AiToolRegistry } from '../services/ai-tools';
import type { AiAgentFactory, BoundAgent } from '../services/ai-agent-factory';
import { createLoggers } from '../logs';

const { log } = createLoggers('ai-chat');

// ── Types ────────────────────────────────────────────────────────────

export interface AiChatDeps {
  getRegistry: () => AiToolRegistry;
  aiFactory: AiAgentFactory;
}

// ── Active request tracking ──────────────────────────────────────────

/** Map<socket, Map<conversationId, AbortController>> */
const activeRequests = new Map<WebSocket, Map<string, AbortController>>();

// ── Tool confirmation tracking ──────────────────────────────────────

const CONFIRM_TIMEOUT_MS = 60_000;

interface PendingConfirmation {
  resolve: (allowed: boolean) => void;
  /** Called when the user allows the tool for the rest of the conversation. */
  remember: () => void;
}

/** Map<socket, Map<toolUseId, PendingConfirmation>> */
const pendingConfirmations = new Map<WebSocket, Map<string, PendingConfirmation>>();

// ── Approvals that last for a conversation ──────────────────────────

/** Conversations with remembered approvals; the least recently used is dropped first. */
export const MAX_REMEMBERED_CONVERSATIONS = 500;

/** Map<`${userId}:${conversationId}`, tool names>, oldest first. In memory only. */
const conversationApprovals = new Map<string, Set<string>>();

function approvalKey(userId: number, conversationId: number): string {
  return `${userId}:${conversationId}`;
}

function recallApprovals(userId: number, conversationId: number): Set<string> {
  return new Set(conversationApprovals.get(approvalKey(userId, conversationId)));
}

function rememberApprovals(userId: number, conversationId: number, tools: ReadonlySet<string>): void {
  if (tools.size === 0) return;
  const key = approvalKey(userId, conversationId);
  const merged = new Set(conversationApprovals.get(key));
  for (const tool of tools) merged.add(tool);
  conversationApprovals.delete(key);
  conversationApprovals.set(key, merged);
  evictOldest(conversationApprovals);
}

function evictOldest(store: Map<string, unknown> | Set<string>): void {
  while (store.size > MAX_REMEMBERED_CONVERSATIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// ── YOLO mode: every tool runs without asking ───────────────────────

/** Conversations in YOLO mode as `${userId}:${conversationId}`, oldest first. In memory only. */
const yoloConversations = new Set<string>();

function isYolo(userId: number, conversationId: number): boolean {
  return yoloConversations.has(approvalKey(userId, conversationId));
}

function setYolo(userId: number, conversationId: number, enabled: boolean): void {
  const key = approvalKey(userId, conversationId);
  yoloConversations.delete(key);
  if (enabled) {
    yoloConversations.add(key);
    evictOldest(yoloConversations);
  }
}

/** Map<socket, Map<requestId, run>>: the first run of a new chat, which has no conversation id to switch YOLO by. */
const newChatRuns = new Map<WebSocket, Map<string, { yolo: boolean }>>();

// ── Helpers ──────────────────────────────────────────────────────────

function sendJson(socket: WebSocket, data: Record<string, any>): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(data));
  } else {
    log(`Dropped ${data.type} event — socket readyState=${socket.readyState}`);
  }
}

function trackRequest(socket: WebSocket, requestId: string, controller: AbortController): void {
  let socketMap = activeRequests.get(socket);
  if (!socketMap) {
    socketMap = new Map();
    activeRequests.set(socket, socketMap);
  }
  socketMap.set(requestId, controller);
}

function untrackRequest(socket: WebSocket, requestId: string): void {
  const socketMap = activeRequests.get(socket);
  if (socketMap) {
    socketMap.delete(requestId);
    if (socketMap.size === 0) {
      activeRequests.delete(socket);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/** Abort all active AI requests and deny pending confirmations for a disconnected socket. */
export function cleanupSocket(socket: WebSocket): void {
  const socketMap = activeRequests.get(socket);
  if (socketMap) {
    for (const controller of socketMap.values()) {
      controller.abort();
    }
    activeRequests.delete(socket);
  }
  // Deny all pending tool confirmations
  const confirms = pendingConfirmations.get(socket);
  if (confirms) {
    for (const pending of confirms.values()) {
      pending.resolve(false);
    }
    pendingConfirmations.delete(socket);
  }
  newChatRuns.delete(socket);
}

/** Valid page context name: lowercase alphanumeric with hyphens only. */
const VALID_CONTEXT_RE = /^[a-z0-9-]+$/;

/** Register the AI chat WebSocket handlers. */
export function registerAiChatEndpoints(deps: AiChatDeps): void {
  // ── ai:message ─────────────────────────────────────────────────
  registerWebsocketEndpoint('ai:message', async (message, socket) => {
    const { conversationId, message: userMessage, pageContext: rawPageContext, contextId: rawContextId, requestId: rawRequestId } = message;
    const requestId = typeof rawRequestId === 'string' && rawRequestId.length <= 128
      ? rawRequestId
      : undefined;

    // Validate pageContext format — reject anything that isn't alphanumeric+hyphens
    const pageContext = (typeof rawPageContext === 'string' && VALID_CONTEXT_RE.test(rawPageContext))
      ? rawPageContext
      : 'dashboard';

    // Validate contextId — must be a safe identifier (alphanumeric, dots, hyphens)
    const contextId = typeof rawContextId === 'string'
      ? rawContextId.replace(/[^\w.-]/g, '').slice(0, 64)
      : '';

    // Extract user identity from the authenticated WebSocket connection
    const authUser = (socket as any).authUser;
    const userId: number | undefined = authUser?.userId;

    // Resolve agent via factory — requires an authenticated userId.
    let agent: BoundAgent | null = null;
    if (userId != null) {
      try {
        agent = deps.aiFactory.forUser(userId);
      } catch {
        // forUser can throw if user not found — fall through to error below
      }
    }

    if (!agent) {
      sendJson(socket, {
        type: 'ai:error',
        conversationId: conversationId ?? null,
        ...(requestId ? { requestId } : {}),
        error: 'No AI provider configured. Add a provider in Settings > AI.',
      });
      return;
    }

    const controller = new AbortController();
    // Use a temporary tracking key for new conversations (null -> -1)
    const trackingId = requestId ?? String(conversationId ?? -1);
    trackRequest(socket, trackingId, controller);

    // A new conversation has no id until its run ends, so approvals given during it are stored in the finally below.
    const incomingConversationId: number | null = Number.isInteger(conversationId) ? conversationId : null;
    const allowedTools: Set<string> = userId != null && incomingConversationId != null
      ? recallApprovals(userId, incomingConversationId)
      : new Set();
    let finalConversationId: number | null = incomingConversationId;
    // The flag only starts a new chat in YOLO; an existing conversation follows the server's state.
    const run = { yolo: message.yolo === true && incomingConversationId == null };
    if (requestId && incomingConversationId == null) {
      let runs = newChatRuns.get(socket);
      if (!runs) {
        runs = new Map();
        newChatRuns.set(socket, runs);
      }
      runs.set(requestId, run);
    }

    try {
      // During streaming, conversationId may be null for new conversations.
      // The ai:done event carries the final (assigned) conversationId.
      const streamConversationId = conversationId ?? null;

      const handleParams: HandleMessageParams = {
        conversationId: streamConversationId,
        message: userMessage,
        pageContext,
        contextId,
        mode: 'streaming',
        signal: controller.signal,
        onToken: (text: string) => {
          sendJson(socket, { type: 'ai:token', conversationId: streamConversationId, ...(requestId ? { requestId } : {}), text });
        },
        onToolStart: (toolUseId: string, toolName: string, input: unknown, toolUseCount: number, turnsRemaining: number) => {
          sendJson(socket, { type: 'ai:tool-start', conversationId: streamConversationId, ...(requestId ? { requestId } : {}), toolUseId, toolName, input, toolUseCount, turnsRemaining });
        },
        onToolResult: (toolUseId: string, toolName: string, output: unknown, durationMs: number) => {
          sendJson(socket, { type: 'ai:tool-result', conversationId: streamConversationId, ...(requestId ? { requestId } : {}), toolUseId, result: output, durationMs });
        },
        onContextUsage: (percent: number) => {
          sendJson(socket, { type: 'ai:context-usage', conversationId: streamConversationId, ...(requestId ? { requestId } : {}), percent });
        },
        onToolConfirm: (toolUseId: string, toolName: string, input: unknown) => {
          if (run.yolo || (userId != null && incomingConversationId != null && isYolo(userId, incomingConversationId))) {
            log(`Tool ${toolName} runs without a prompt: YOLO mode, user ${userId}, conversation ${incomingConversationId ?? 'new'}`);
            return Promise.resolve(true);
          }
          if (allowedTools.has(toolName)) {
            log(`Tool ${toolName} runs without a prompt: user ${userId} allowed it for conversation ${incomingConversationId ?? 'new'}`);
            return Promise.resolve(true);
          }
          return new Promise<boolean>((resolve) => {
            // Track the pending confirmation
            let socketConfirms = pendingConfirmations.get(socket);
            if (!socketConfirms) {
              socketConfirms = new Map();
              pendingConfirmations.set(socket, socketConfirms);
            }
            socketConfirms.set(toolUseId, {
              resolve,
              remember: () => {
                allowedTools.add(toolName);
                log(`Tool ${toolName} allowed for the rest of conversation ${incomingConversationId ?? 'new'} by user ${userId}`);
              },
            });

            // Send confirmation request to client
            sendJson(socket, {
              type: 'ai:tool-confirm',
              conversationId: streamConversationId,
              ...(requestId ? { requestId } : {}),
              toolUseId,
              toolName,
              input,
            });

            // Auto-deny after timeout
            setTimeout(() => {
              const confirms = pendingConfirmations.get(socket);
              if (confirms?.has(toolUseId)) {
                confirms.delete(toolUseId);
                if (confirms.size === 0) pendingConfirmations.delete(socket);
                resolve(false);
              }
            }, CONFIRM_TIMEOUT_MS);
          });
        },
      };
      const result = await agent.handleMessage(handleParams);
      finalConversationId = Number.isInteger(result.conversationId) ? result.conversationId : finalConversationId;

      sendJson(socket, {
        type: 'ai:done',
        conversationId: result.conversationId,
        ...(requestId ? { requestId } : {}),
        usage: result.usage,
        error: result.error,
        ...(result.turnLimitReached ? { turnLimitReached: true } : {}),
      });
    } catch (err: any) {
      sendJson(socket, {
        type: 'ai:error',
        conversationId: conversationId ?? null,
        ...(requestId ? { requestId } : {}),
        error: err.name === 'AbortError'
          ? 'Request was cancelled'
          : err.message || String(err),
      });
    } finally {
      untrackRequest(socket, trackingId);
      if (requestId) {
        const runs = newChatRuns.get(socket);
        runs?.delete(requestId);
        if (runs?.size === 0) newChatRuns.delete(socket);
      }
      if (userId != null && finalConversationId != null) {
        rememberApprovals(userId, finalConversationId, allowedTools);
      }
    }
  }, { requires: ['core.ai:chat'] });

  // ── ai:claude-message (Claude CLI path) ────────────────────────
  // Now that getAgent() returns ClaudeCliAgent when the top model is claude-cli,
  // this handler simply delegates to ai:message which handles both agent types.
  // getClaudeCliProvider and getDb are no longer needed here.
  registerWebsocketEndpoint('ai:claude-message', async (message, socket) => {
    const entry = getWebsocketHandler('ai:message');
    if (entry) {
      await entry.handler(message, socket);
    } else {
      sendJson(socket, {
        type: 'ai:error',
        conversationId: message.conversationId ?? null,
        error: 'AI handler not available',
      });
    }
  }, { requires: ['core.ai:chat'] });

  // ── ai:tool-confirm-response ────────────────────────────────────
  registerWebsocketEndpoint('ai:tool-confirm-response', (message, socket) => {
    const { toolUseId, allowed, scope } = message;
    const confirms = pendingConfirmations.get(socket);
    if (confirms) {
      const pending = confirms.get(toolUseId);
      if (pending) {
        confirms.delete(toolUseId);
        if (confirms.size === 0) pendingConfirmations.delete(socket);
        // A denial is never remembered, and any scope but 'conversation' covers this one call.
        if (allowed && scope === 'conversation') pending.remember();
        pending.resolve(!!allowed);
      }
    }
  }, { requires: ['core.ai:chat'] });

  // ── ai:yolo ────────────────────────────────────────────────────
  // Switch YOLO mode for a conversation, or for a new chat's first run by its requestId. Leave `enabled` out to ask.
  registerWebsocketEndpoint('ai:yolo', (message, socket) => {
    const { conversationId, requestId, enabled } = message;
    const userId: number | undefined = (socket as any).authUser?.userId;
    const change = typeof enabled === 'boolean' ? enabled : undefined;

    if (typeof requestId === 'string') {
      const run = newChatRuns.get(socket)?.get(requestId);
      if (run && change !== undefined) run.yolo = change;
      sendJson(socket, { type: 'ai:yolo-state', conversationId: null, requestId, enabled: run?.yolo ?? false });
      return;
    }
    if (userId == null || !Number.isInteger(conversationId)) {
      sendJson(socket, { type: 'ai:yolo-state', conversationId: null, enabled: false });
      return;
    }
    if (change !== undefined) {
      setYolo(userId, conversationId, change);
      log(`YOLO mode ${change ? 'on' : 'off'} for conversation ${conversationId} by user ${userId}`);
    }
    sendJson(socket, { type: 'ai:yolo-state', conversationId, enabled: isYolo(userId, conversationId) });
  }, { requires: ['core.ai:chat'] });

  // ── ai:cancel ──────────────────────────────────────────────────
  registerWebsocketEndpoint('ai:cancel', (message, socket) => {
    const { conversationId, requestId } = message;
    const socketMap = activeRequests.get(socket);
    if (socketMap) {
      // Try the exact conversationId first, then the temp key for new conversations
      const controller = socketMap.get(requestId) ?? socketMap.get(String(conversationId ?? -1));
      if (controller) {
        controller.abort();
      }
    }
    // A confirmation blocks the agent outside the provider stream. Deny it
    // immediately so cancellation does not wait for the confirmation timeout.
    const confirms = pendingConfirmations.get(socket);
    if (confirms) {
      for (const pending of confirms.values()) pending.resolve(false);
      pendingConfirmations.delete(socket);
    }
  }, { requires: ['core.ai:chat'] });
}
