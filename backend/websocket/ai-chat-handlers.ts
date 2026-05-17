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
const activeRequests = new Map<WebSocket, Map<number, AbortController>>();

// ── Tool confirmation tracking ──────────────────────────────────────

const CONFIRM_TIMEOUT_MS = 60_000;

/** Map<socket, Map<toolUseId, resolve>> */
const pendingConfirmations = new Map<WebSocket, Map<string, (allowed: boolean) => void>>();

// ── Helpers ──────────────────────────────────────────────────────────

function sendJson(socket: WebSocket, data: Record<string, any>): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(data));
  } else {
    log(`Dropped ${data.type} event — socket readyState=${socket.readyState}`);
  }
}

function trackRequest(socket: WebSocket, conversationId: number, controller: AbortController): void {
  let socketMap = activeRequests.get(socket);
  if (!socketMap) {
    socketMap = new Map();
    activeRequests.set(socket, socketMap);
  }
  socketMap.set(conversationId, controller);
}

function untrackRequest(socket: WebSocket, conversationId: number): void {
  const socketMap = activeRequests.get(socket);
  if (socketMap) {
    socketMap.delete(conversationId);
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
    for (const resolve of confirms.values()) {
      resolve(false);
    }
    pendingConfirmations.delete(socket);
  }
}

/** Valid page context name: lowercase alphanumeric with hyphens only. */
const VALID_CONTEXT_RE = /^[a-z0-9-]+$/;

/** Register `ai:message` and `ai:cancel` WebSocket handlers. */
export function registerAiChatEndpoints(deps: AiChatDeps): void {
  // ── ai:message ─────────────────────────────────────────────────
  registerWebsocketEndpoint('ai:message', async (message, socket) => {
    const { conversationId, message: userMessage, pageContext: rawPageContext, contextId: rawContextId } = message;

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
        error: 'No AI provider configured. Add a provider in Settings > Integrations.',
      });
      return;
    }

    const controller = new AbortController();
    // Use a temporary tracking key for new conversations (null -> -1)
    const trackingId = conversationId ?? -1;
    trackRequest(socket, trackingId, controller);

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
          sendJson(socket, { type: 'ai:token', conversationId: streamConversationId, text });
        },
        onToolStart: (toolUseId: string, toolName: string, input: unknown, toolUseCount: number, turnsRemaining: number) => {
          sendJson(socket, { type: 'ai:tool-start', conversationId: streamConversationId, toolUseId, toolName, input, toolUseCount, turnsRemaining });
        },
        onToolResult: (toolUseId: string, toolName: string, output: unknown, durationMs: number) => {
          sendJson(socket, { type: 'ai:tool-result', conversationId: streamConversationId, toolUseId, result: output, durationMs });
        },
        onContextUsage: (percent: number) => {
          sendJson(socket, { type: 'ai:context-usage', conversationId: streamConversationId, percent });
        },
        onToolConfirm: (toolUseId: string, toolName: string, input: unknown) => {
          return new Promise<boolean>((resolve) => {
            // Track the pending confirmation
            let socketConfirms = pendingConfirmations.get(socket);
            if (!socketConfirms) {
              socketConfirms = new Map();
              pendingConfirmations.set(socket, socketConfirms);
            }
            socketConfirms.set(toolUseId, resolve);

            // Send confirmation request to client
            sendJson(socket, {
              type: 'ai:tool-confirm',
              conversationId: streamConversationId,
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

      sendJson(socket, {
        type: 'ai:done',
        conversationId: result.conversationId,
        usage: result.usage,
        error: result.error,
        ...(result.turnLimitReached ? { turnLimitReached: true } : {}),
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        sendJson(socket, {
          type: 'ai:error',
          conversationId: conversationId ?? null,
          error: err.message || String(err),
        });
      }
    } finally {
      untrackRequest(socket, trackingId);
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
    const { toolUseId, allowed } = message;
    const confirms = pendingConfirmations.get(socket);
    if (confirms) {
      const resolve = confirms.get(toolUseId);
      if (resolve) {
        confirms.delete(toolUseId);
        if (confirms.size === 0) pendingConfirmations.delete(socket);
        resolve(!!allowed);
      }
    }
  }, { requires: ['core.ai:chat'] });

  // ── ai:cancel ──────────────────────────────────────────────────
  registerWebsocketEndpoint('ai:cancel', (message, socket) => {
    const { conversationId } = message;
    const socketMap = activeRequests.get(socket);
    if (socketMap) {
      // Try the exact conversationId first, then the temp key for new conversations
      const controller = socketMap.get(conversationId) ?? socketMap.get(-1);
      if (controller) {
        controller.abort();
      }
    }
  }, { requires: ['core.ai:chat'] });
}
