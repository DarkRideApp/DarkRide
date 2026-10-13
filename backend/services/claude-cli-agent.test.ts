import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliProvider } from './claude-cli-provider';
import { ClaudeCliAgent } from './claude-cli-agent';
import { createTestDb } from '../test-utils/create-test-db';
import * as schema from '../db/schema';
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

describe('ClaudeCliAgent conversation history persistence', () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => { db = createTestDb(); });
  const all = () => db.select().from(schema.aiConversations).all();
  const params = (extra: Record<string, unknown> = {}) => ({ ...baseParams(), originPath: '/ui/analysis/190', mode: 'streaming', ...extra }) as HandleMessageParams;
  const textProvider = () => fakeProvider((cb) => { cb.onText('done'); return { numTurns: 1 }; });

  it('saves a new chat with its owner and where it started, and clears the unfinished flag', async () => {
    const agent = new ClaudeCliAgent(db, textProvider(), 'opus');
    const result = await agent.handleMessageWithIdentity(identity, params());
    expect(all()[0]).toMatchObject({ id: result.conversationId, userId: 1, originPath: '/ui/analysis/190', unfinished: false, automated: false, claudeSessionId: 's1' });
  });

  it('saves an automated run with no owner, flagged automated', async () => {
    const agent = new ClaudeCliAgent(db, textProvider(), 'opus');
    await agent.handleMessageWithIdentity(identity, params({ mode: 'silent' }));
    expect(all()[0]).toMatchObject({ userId: null, automated: true, unfinished: false });
  });

  it('has the user message stored before the CLI is called', async () => {
    let seen: typeof schema.aiConversations.$inferSelect | undefined;
    const provider = fakeProvider((cb) => { seen = all()[0]; cb.onText('x'); return { numTurns: 1 }; });
    await new ClaudeCliAgent(db, provider, 'opus').handleMessageWithIdentity(identity, params());
    expect(seen?.unfinished).toBe(true);
    expect(JSON.parse(seen!.messages)).toEqual([{ role: 'user', content: 'Analyze APK version 190 using the tools.' }]);
  });

  it('leaves the chat unfinished when the run throws', async () => {
    const provider = fakeProvider((cb) => { cb.onText('<invoke name="x">'); return { numTurns: 1 }; });
    await expect(new ClaudeCliAgent(db, provider, 'opus').handleMessageWithIdentity(identity, params())).rejects.toThrow();
    expect(all()[0].unfinished).toBe(true);
  });

  it('leaves the chat unfinished when the CLI reports an error', async () => {
    const provider = { async sendMessage() { return { sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1 }, numTurns: 1, error: 'cancelled' }; } } as unknown as ClaudeCliProvider;
    await new ClaudeCliAgent(db, provider, 'opus').handleMessageWithIdentity(identity, params());
    expect(all()[0].unfinished).toBe(true);
  });

  it('starts a new chat, with no CLI session to resume, instead of continuing another user\'s conversation', async () => {
    const theirs = Number(db.insert(schema.aiConversations).values({
      pageContext: 'apk-analysis', contextId: '190', title: 't', messages: '[]', userId: 9, claudeSessionId: 'theirs',
      createdAt: new Date(1000), updatedAt: new Date(1000),
    }).run().lastInsertRowid);
    let resumed: string | undefined = 'unset';
    const provider = { async sendMessage(_p: string, _cb: unknown, opts: { sessionId?: string }) { resumed = opts.sessionId; return { sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1 }, numTurns: 1 }; } } as unknown as ClaudeCliProvider;
    const result = await new ClaudeCliAgent(db, provider, 'opus').handleMessageWithIdentity(identity, params({ conversationId: theirs }));
    expect(resumed).toBeUndefined();
    expect(result.conversationId).not.toBe(theirs);
    expect(all()).toHaveLength(2);
  });
});
