import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAiChatEndpoints, cleanupSocket, type AiChatDeps } from './ai-chat-handlers';
import { getWebsocketHandler, clearWebsocketHandlers } from './handlers';
import type { AiToolRegistry } from '../services/ai-tools';

function createMockSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as any;
}

function createMockRegistry(): AiToolRegistry {
  return {
    getToolDefinitions: vi.fn().mockReturnValue([]),
    getToolDefinitionsForContexts: vi.fn().mockReturnValue([]),
    executeTool: vi.fn(),
    register: vi.fn(),
    listContexts: vi.fn().mockReturnValue([]),
  } as any;
}

function createMockFactory(mockAgent: any = null): any {
  return {
    forUser: vi.fn().mockReturnValue(mockAgent),
  };
}

function setupAgentAndProvider(deps: AiChatDeps, mockAgent: any) {
  (deps.aiFactory.forUser as any).mockReturnValue(mockAgent);
}

/** Create a socket with an authenticated user (needed for the factory path). */
function createAuthenticatedSocket(userId = 1) {
  const socket = {
    readyState: 1,
    send: vi.fn(),
  } as any;
  socket.authUser = { userId, effectiveScopes: new Set(['core.ai:chat']) };
  return socket;
}

describe('AI Chat Handlers', () => {
  let deps: AiChatDeps;

  beforeEach(() => {
    clearWebsocketHandlers();
    deps = {
      getRegistry: vi.fn().mockReturnValue(createMockRegistry()),
      aiFactory: createMockFactory(null),
    };
    registerAiChatEndpoints(deps);
  });

  describe('ai:message', () => {
    it('should send ai:error when no agent is configured', async () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 1, message: 'hello', pageContext: 'dashboard', contextId: '' }, socket);

      expect(socket.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent).toEqual({
        type: 'ai:error',
        conversationId: 1,
        error: 'No AI provider configured. Add a provider in Settings > Integrations.',
      });
    });

    it('should send ai:error when no agent is available', async () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 2, message: 'hello', pageContext: 'devices', contextId: '' }, socket);

      expect(socket.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent).toEqual({
        type: 'ai:error',
        conversationId: 2,
        error: 'No AI provider configured. Add a provider in Settings > Integrations.',
      });
    });

    it('should send ai:error with null conversationId for new conversations when no provider', async () => {
      const socket = createMockSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ message: 'hello', pageContext: 'dashboard', contextId: '' }, socket);

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.conversationId).toBeNull();
      expect(sent.type).toBe('ai:error');
    });

    it('should call agent.handleMessage and send ai:done on success', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          conversationId: 42,
          usage: { inputTokens: 10, outputTokens: 20 },
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: null, message: 'test', pageContext: 'devices', contextId: 'dev1' }, socket);

      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);
      const params = mockAgent.handleMessage.mock.calls[0][0];
      expect(params.conversationId).toBeNull();
      expect(params.message).toBe('test');
      expect(params.pageContext).toBe('devices');
      expect(params.contextId).toBe('dev1');
      expect(params.signal).toBeInstanceOf(AbortSignal);
      expect(typeof params.onToken).toBe('function');
      expect(typeof params.onToolStart).toBe('function');
      expect(typeof params.onToolResult).toBe('function');
      expect(typeof params.onContextUsage).toBe('function');

      // Check ai:done message
      expect(socket.send).toHaveBeenCalledTimes(1);
      const done = JSON.parse(socket.send.mock.calls[0][0]);
      expect(done).toEqual({
        type: 'ai:done',
        conversationId: 42,
        usage: { inputTokens: 10, outputTokens: 20 },
      });
    });

    it('should send ai:error when handleMessage throws', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockRejectedValue(new Error('Provider failed')),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 5, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent).toEqual({
        type: 'ai:error',
        conversationId: 5,
        error: 'Provider failed',
      });
    });

    it('sends a terminal cancellation error for AbortError', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      const mockAgent = {
        handleMessage: vi.fn().mockRejectedValue(abortError),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 3, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
        type: 'ai:error',
        conversationId: 3,
        error: 'Request was cancelled',
      });
    });

    it('should not send if socket is not open', async () => {
      const socket = createMockSocket();
      socket.readyState = 3; // CLOSED
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 1, message: 'hello', pageContext: 'dashboard', contextId: '' }, socket);

      expect(socket.send).not.toHaveBeenCalled();
    });

    it('should invoke streaming callbacks correctly', async () => {
      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          params.onToken('Hello ');
          params.onToken('world');
          params.onToolStart('tu-1', 'list_devices', { filter: 'online' }, 1, 24);
          params.onToolResult('tu-1', 'list_devices', '[{"id":"dev1"}]', 150);
          return { conversationId: 7, usage: { inputTokens: 5, outputTokens: 15 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 7, message: 'list devices', pageContext: 'devices', contextId: '' }, socket);

      // 2 tokens + 1 tool-start + 1 tool-result + 1 done = 5 messages
      expect(socket.send).toHaveBeenCalledTimes(5);

      const messages = socket.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      expect(messages[0]).toEqual({ type: 'ai:token', conversationId: 7, text: 'Hello ' });
      expect(messages[1]).toEqual({ type: 'ai:token', conversationId: 7, text: 'world' });
      expect(messages[2]).toEqual({ type: 'ai:tool-start', conversationId: 7, toolUseId: 'tu-1', toolName: 'list_devices', input: { filter: 'online' }, toolUseCount: 1, turnsRemaining: 24 });
      expect(messages[3]).toEqual({ type: 'ai:tool-result', conversationId: 7, toolUseId: 'tu-1', result: '[{"id":"dev1"}]', durationMs: 150 });
      expect(messages[4]).toEqual({ type: 'ai:done', conversationId: 7, usage: { inputTokens: 5, outputTokens: 15 } });
    });

    // ── New error scenario tests ──────────────────────────────────────

    it('should send ai:error when agent throws', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockRejectedValue(new Error('Internal agent crash')),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 99, message: 'crash me', pageContext: 'dashboard', contextId: '' }, socket);

      expect(socket.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent).toEqual({
        type: 'ai:error',
        conversationId: 99,
        error: 'Internal agent crash',
      });
    });

    it('should not send on closed socket (readyState !== 1)', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          conversationId: 50,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      socket.readyState = 3; // CLOSED
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 50, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      // Agent was called, but send() should never fire because socket is closed
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);
      expect(socket.send).not.toHaveBeenCalled();
    });

    it('should handle socket.send() throwing', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          conversationId: 60,
          usage: { inputTokens: 2, outputTokens: 3 },
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      socket.send.mockImplementation(() => {
        throw new Error('WebSocket write failed');
      });
      const handler = getWebsocketHandler('ai:message')!.handler;

      // sendJson does not catch send() errors, so the error propagates through
      // the catch block (which also tries to sendJson and throws again).
      // The handler rejects, but the process does not crash -- the caller
      // (the WebSocket dispatch layer) is responsible for catching this.
      await expect(
        handler({ conversationId: 60, message: 'test', pageContext: 'dashboard', contextId: '' }, socket),
      ).rejects.toThrow('WebSocket write failed');
    });

    // ── New streaming callback tests ──────────────────────────────────

    it('should send ai:token events during streaming', async () => {
      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          params.onToken('one');
          params.onToken('two');
          params.onToken('three');
          return { conversationId: 70, usage: { inputTokens: 3, outputTokens: 9 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 70, message: 'stream test', pageContext: 'dashboard', contextId: '' }, socket);

      // 3 tokens + 1 done = 4 messages
      expect(socket.send).toHaveBeenCalledTimes(4);

      const messages = socket.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const tokenMessages = messages.filter((m: any) => m.type === 'ai:token');
      expect(tokenMessages).toHaveLength(3);
      expect(tokenMessages[0]).toEqual({ type: 'ai:token', conversationId: 70, text: 'one' });
      expect(tokenMessages[1]).toEqual({ type: 'ai:token', conversationId: 70, text: 'two' });
      expect(tokenMessages[2]).toEqual({ type: 'ai:token', conversationId: 70, text: 'three' });
    });

    it('should send ai:tool-start and ai:tool-result events', async () => {
      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          params.onToolStart('tu-a', 'get_device', { id: 'abc123' }, 1, 24);
          params.onToolResult('tu-a', 'get_device', '{"status":"online"}', 250);
          params.onToolStart('tu-b', 'reboot_device', { id: 'abc123' }, 2, 24);
          params.onToolResult('tu-b', 'reboot_device', 'ok', 500);
          return { conversationId: 71, usage: { inputTokens: 8, outputTokens: 16 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 71, message: 'reboot device', pageContext: 'devices', contextId: 'abc123' }, socket);

      // 2 tool-start + 2 tool-result + 1 done = 5 messages
      expect(socket.send).toHaveBeenCalledTimes(5);

      const messages = socket.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      expect(messages[0]).toEqual({ type: 'ai:tool-start', conversationId: 71, toolUseId: 'tu-a', toolName: 'get_device', input: { id: 'abc123' }, toolUseCount: 1, turnsRemaining: 24 });
      expect(messages[1]).toEqual({ type: 'ai:tool-result', conversationId: 71, toolUseId: 'tu-a', result: '{"status":"online"}', durationMs: 250 });
      expect(messages[2]).toEqual({ type: 'ai:tool-start', conversationId: 71, toolUseId: 'tu-b', toolName: 'reboot_device', input: { id: 'abc123' }, toolUseCount: 2, turnsRemaining: 24 });
      expect(messages[3]).toEqual({ type: 'ai:tool-result', conversationId: 71, toolUseId: 'tu-b', result: 'ok', durationMs: 500 });
      expect(messages[4]).toEqual({
        type: 'ai:done',
        conversationId: 71,
        usage: { inputTokens: 8, outputTokens: 16 },
      });
    });

    it('should send ai:context-usage event when onContextUsage is called', async () => {
      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          params.onContextUsage(72);
          return { conversationId: 80, usage: { inputTokens: 10, outputTokens: 5 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 80, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      // 1 context-usage + 1 done = 2 messages
      expect(socket.send).toHaveBeenCalledTimes(2);
      const messages = socket.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      expect(messages[0]).toEqual({ type: 'ai:context-usage', conversationId: 80, percent: 72 });
      expect(messages[1].type).toBe('ai:done');
    });

    it('should send ai:done with conversationId and usage', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          conversationId: 123,
          usage: { inputTokens: 100, outputTokens: 200 },
          error: 'partial failure',
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      await handler({ conversationId: 123, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      expect(socket.send).toHaveBeenCalledTimes(1);
      const done = JSON.parse(socket.send.mock.calls[0][0]);
      expect(done.type).toBe('ai:done');
      expect(done.conversationId).toBe(123);
      expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
      expect(done.error).toBe('partial failure');
    });

    // ── Concurrent requests ───────────────────────────────────────────

    it('should handle multiple simultaneous requests on same socket', async () => {
      let resolveFirst!: (value: any) => void;
      let resolveSecond!: (value: any) => void;

      const callCount = { value: 0 };
      const mockAgent = {
        handleMessage: vi.fn(async (_params: any) => {
          callCount.value++;
          if (callCount.value === 1) {
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          } else {
            return new Promise((resolve) => {
              resolveSecond = resolve;
            });
          }
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      // Start two requests on the same socket concurrently
      const promise1 = handler({ conversationId: 100, message: 'first', pageContext: 'dashboard', contextId: '' }, socket);
      const promise2 = handler({ conversationId: 200, message: 'second', pageContext: 'dashboard', contextId: '' }, socket);

      // Let both handlers register
      await new Promise((r) => setTimeout(r, 10));

      // Both should have been called
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(2);

      // Resolve them in reverse order
      resolveSecond({ conversationId: 200, usage: { inputTokens: 2, outputTokens: 4 } });
      resolveFirst({ conversationId: 100, usage: { inputTokens: 1, outputTokens: 2 } });

      await Promise.all([promise1, promise2]);

      // Both ai:done messages should have been sent
      expect(socket.send).toHaveBeenCalledTimes(2);
      const messages = socket.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const doneMessages = messages.filter((m: any) => m.type === 'ai:done');
      expect(doneMessages).toHaveLength(2);

      const conversationIds = doneMessages.map((m: any) => m.conversationId).sort();
      expect(conversationIds).toEqual([100, 200]);
    });

    // ── Cleanup after completion ──────────────────────────────────────

    it('should cleanup active requests on completion', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          conversationId: 80,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;
      const cancelHandler = getWebsocketHandler('ai:cancel')!.handler;

      // Run a request to completion
      await handler({ conversationId: 80, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      expect(socket.send).toHaveBeenCalledTimes(1);
      const done = JSON.parse(socket.send.mock.calls[0][0]);
      expect(done.type).toBe('ai:done');

      // Now try to cancel the completed request - should be a no-op
      // (verifies the request was removed from the tracking map)
      // We verify indirectly: no abort should happen, no error should be thrown
      expect(() => cancelHandler({ conversationId: 80 }, socket)).not.toThrow();
    });
  });

  describe('ai:cancel', () => {
    it('should abort an active new conversation by its temporary tracking key', async () => {
      let capturedSignal: AbortSignal | undefined;
      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          capturedSignal = params.signal;
          // Simulate a long-running request
          await new Promise<void>((resolve) => {
            params.signal.addEventListener('abort', () => resolve());
            // Also set a timeout so the test doesn't hang
            setTimeout(resolve, 100);
          });
          return { conversationId: 10, usage: { inputTokens: 0, outputTokens: 0 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const messageHandler = getWebsocketHandler('ai:message')!.handler;
      const cancelHandler = getWebsocketHandler('ai:cancel')!.handler;

      // Start the message (don't await)
      const messagePromise = messageHandler({ conversationId: null, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      // Small delay to let the handler set up
      await new Promise((r) => setTimeout(r, 10));

      // Cancel it
      cancelHandler({ conversationId: null }, socket);

      await messagePromise;

      expect(capturedSignal!.aborted).toBe(true);
    });

    it('should track and cancel requests via ai:cancel', async () => {
      let capturedSignal: AbortSignal | undefined;
      const abortSpy = vi.fn();

      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          capturedSignal = params.signal;
          params.signal.addEventListener('abort', abortSpy);
          // Wait until aborted or timeout
          await new Promise<void>((resolve) => {
            params.signal.addEventListener('abort', () => resolve());
            setTimeout(resolve, 200);
          });
          return { conversationId: 30, usage: { inputTokens: 0, outputTokens: 0 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const messageHandler = getWebsocketHandler('ai:message')!.handler;
      const cancelHandler = getWebsocketHandler('ai:cancel')!.handler;

      const messagePromise = messageHandler({ conversationId: 30, message: 'long task', pageContext: 'dashboard', contextId: '' }, socket);

      await new Promise((r) => setTimeout(r, 10));

      // The request should be in-flight, signal not yet aborted
      expect(capturedSignal!.aborted).toBe(false);

      // Cancel it
      cancelHandler({ conversationId: 30 }, socket);

      await messagePromise;

      // Verify abort was called
      expect(capturedSignal!.aborted).toBe(true);
      expect(abortSpy).toHaveBeenCalled();
    });

    it('should handle cancel for unknown conversationId', () => {
      const socket = createMockSocket();
      const cancelHandler = getWebsocketHandler('ai:cancel')!.handler;

      // Send cancel with a conversationId that has no active request - should not throw
      expect(() => cancelHandler({ conversationId: 999999 }, socket)).not.toThrow();
    });

    it('should handle cancel for socket with no active requests', () => {
      const socket = createMockSocket();
      const cancelHandler = getWebsocketHandler('ai:cancel')!.handler;

      // A completely unknown socket - should not throw
      expect(() => cancelHandler({ conversationId: 1 }, socket)).not.toThrow();
    });
  });

  describe('cleanupSocket', () => {
    it('should abort all active requests for a socket', async () => {
      let capturedSignal: AbortSignal | undefined;
      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          capturedSignal = params.signal;
          await new Promise<void>((resolve) => {
            params.signal.addEventListener('abort', () => resolve());
            setTimeout(resolve, 100);
          });
          return { conversationId: 20, usage: { inputTokens: 0, outputTokens: 0 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      const messagePromise = handler({ conversationId: 20, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      await new Promise((r) => setTimeout(r, 10));

      cleanupSocket(socket);

      await messagePromise;

      expect(capturedSignal!.aborted).toBe(true);
    });

    it('should abort all active requests for a socket with multiple requests', async () => {
      const capturedSignals: AbortSignal[] = [];

      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          capturedSignals.push(params.signal);
          await new Promise<void>((resolve) => {
            params.signal.addEventListener('abort', () => resolve());
            setTimeout(resolve, 200);
          });
          // Return a result based on which call this is
          const convId = capturedSignals.length === 1 ? 301 : 302;
          return { conversationId: convId, usage: { inputTokens: 0, outputTokens: 0 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      // Start two simultaneous requests on the same socket
      const promise1 = handler({ conversationId: 301, message: 'first', pageContext: 'dashboard', contextId: '' }, socket);
      const promise2 = handler({ conversationId: 302, message: 'second', pageContext: 'dashboard', contextId: '' }, socket);

      // Wait for both to register
      await new Promise((r) => setTimeout(r, 20));

      expect(capturedSignals).toHaveLength(2);
      expect(capturedSignals[0].aborted).toBe(false);
      expect(capturedSignals[1].aborted).toBe(false);

      // Cleanup the socket - should abort both
      cleanupSocket(socket);

      await Promise.all([promise1, promise2]);

      expect(capturedSignals[0].aborted).toBe(true);
      expect(capturedSignals[1].aborted).toBe(true);
    });

    it('should handle cleanupSocket on socket with no requests', () => {
      const socket = createMockSocket();

      // Socket was never used for any AI requests - should not throw
      expect(() => cleanupSocket(socket)).not.toThrow();
    });

    it('should handle cleanupSocket called twice', async () => {
      const capturedSignals: AbortSignal[] = [];

      const mockAgent = {
        handleMessage: vi.fn(async (params: any) => {
          capturedSignals.push(params.signal);
          await new Promise<void>((resolve) => {
            params.signal.addEventListener('abort', () => resolve());
            setTimeout(resolve, 200);
          });
          return { conversationId: 400, usage: { inputTokens: 0, outputTokens: 0 } };
        }),
      };
      setupAgentAndProvider(deps, mockAgent);

      const socket = createAuthenticatedSocket();
      const handler = getWebsocketHandler('ai:message')!.handler;

      const messagePromise = handler({ conversationId: 400, message: 'test', pageContext: 'dashboard', contextId: '' }, socket);

      await new Promise((r) => setTimeout(r, 10));

      // First cleanup aborts
      cleanupSocket(socket);

      await messagePromise;

      expect(capturedSignals[0].aborted).toBe(true);

      // Second cleanup - should be a no-op, no error
      expect(() => cleanupSocket(socket)).not.toThrow();
    });
  });

  describe('aiFactory.forUser', () => {
    it('calls aiFactory.forUser with the authenticated user id and omits userId from params', async () => {
      clearWebsocketHandlers();

      const handleMessage = vi.fn().mockResolvedValue({
        conversationId: 1,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const forUser = vi.fn().mockReturnValue({
        identity: { identityType: 'user', actorUserId: 42, effectiveScopes: ['mcp'] },
        handleMessage,
      });
      const factoryDeps: AiChatDeps = {
        getRegistry: vi.fn().mockReturnValue(createMockRegistry()),
        aiFactory: { forUser } as any,
      };
      registerAiChatEndpoints(factoryDeps);

      const socket = createMockSocket();
      // Attach a mock authUser (simulating authenticated WebSocket connection)
      (socket as any).authUser = { userId: 42, effectiveScopes: new Set(['mcp']) };

      const handler = getWebsocketHandler('ai:message')!.handler;
      await handler({ conversationId: null, message: 'hello', pageContext: 'chat', contextId: '' }, socket);

      expect(forUser).toHaveBeenCalledWith(42);
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const callParams = handleMessage.mock.calls[0][0];
      expect(callParams).toMatchObject({ mode: 'streaming', pageContext: 'chat' });
      // userId must NOT be present on the params (identity is in the factory-bound agent)
      expect(callParams.userId).toBeUndefined();
      expect(callParams.userScopes).toBeUndefined();
    });
  });
});
