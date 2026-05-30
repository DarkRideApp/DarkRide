import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliProvider } from './claude-cli-provider';
import { ClaudeCliAgent } from './claude-cli-agent';
import { createTestDb } from '../test-utils/create-test-db';
import type { AgentIdentity, HandleMessageParams } from './ai-agent';
import type { ClaudeCliCallbacks } from './claude-cli-provider';

const identity: AgentIdentity = { identityType: 'user', actorUserId: 1, effectiveScopes: [] };

function baseParams(): HandleMessageParams {
  return {
    conversationId: null,
    message: 'Analyze APK version 190 using the tools.',
    pageContext: 'apk-analysis',
    contextId: '190',
    maxTurns: 50,
    onToken: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
  } as HandleMessageParams;
}

/** Build a fake ClaudeCliProvider whose sendMessage drives the given script. */
function fakeProvider(script: (cb: ClaudeCliCallbacks) => { numTurns: number }): ClaudeCliProvider {
  return {
    async sendMessage(_prompt: string, callbacks: ClaudeCliCallbacks) {
      const { numTurns } = script(callbacks);
      return { sessionId: 's1', usage: { inputTokens: 2, outputTokens: 173 }, costUsd: 0.006, numTurns };
    },
  } as unknown as ClaudeCliProvider;
}

describe('ClaudeCliAgent — text-based tool-call leak detection', () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => { db = createTestDb(); });

  it('throws when the model emits tool calls as text and runs zero tools', async () => {
    const provider = fakeProvider((cb) => {
      cb.onText('I\'ll start.\n<invoke name="get_apk_overview">\n<parameter name="contextId">190</parameter>\n</invoke>\n{ "appLabel": "Fake" }');
      return { numTurns: 1 };
    });
    const agent = new ClaudeCliAgent(db, provider, 'opus');

    await expect(agent.handleMessageWithIdentity(identity, baseParams()))
      .rejects.toThrow(/emitted tool calls as text/i);
  });

  it('does NOT throw when real tool calls were executed (even if text mentions invoke)', async () => {
    const provider = fakeProvider((cb) => {
      cb.onToolStart('t1', 'mcp__darkride__get_apk_overview', { contextId: '190' });
      cb.onToolResult('t1', 'mcp__darkride__get_apk_overview', '{"appLabel":"Real"}');
      cb.onText('Done. (the user asked about <invoke> syntax)');
      return { numTurns: 2 };
    });
    const agent = new ClaudeCliAgent(db, provider, 'opus');

    const result = await agent.handleMessageWithIdentity(identity, baseParams());
    expect(result.error).toBeUndefined();
  });

  it('does NOT throw on a normal text-only answer with no tool-call markup', async () => {
    const provider = fakeProvider((cb) => {
      cb.onText('The app talks to api.example.com and uses Mapbox tiles.');
      return { numTurns: 1 };
    });
    const agent = new ClaudeCliAgent(db, provider, 'opus');

    const result = await agent.handleMessageWithIdentity(identity, baseParams());
    expect(result.error).toBeUndefined();
  });
});
