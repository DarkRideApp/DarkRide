// fixtures: hand-written from https://platform.claude.com/docs/en/build-with-claude/streaming and
// https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback (wire shape only)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { AiAgent, type AgentIdentity, type TierConfig } from './ai-agent';
import { AiToolRegistry } from './ai-tools';
import { createProvider } from './ai/registry';
import { ModelRefusedError } from './ai/errors';
import { stubFetch, sseResponse, type FetchCall } from './ai/test-helpers';
import { createTestDb } from '../test-utils/create-test-db';
import type { AiMessage } from '../../shared/types/ai-chat';

const sse = (type: string, data: object = {}) => ({ event: type, data: JSON.stringify({ type, ...data }) });
const messageStart = (inputTokens = 25) => sse('message_start', {
  message: {
    id: 'msg_01XFDUDYJgAACzvnptvVoYEL', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 },
  },
});
const textBlock = (index: number, ...chunks: string[]) => [
  sse('content_block_start', { index, content_block: { type: 'text', text: '' } }),
  ...chunks.map((text) => sse('content_block_delta', { index, delta: { type: 'text_delta', text } })),
  sse('content_block_stop', { index }),
];
const toolBlock = (index: number, id: string, name: string, json: string[], finished = true) => [
  sse('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } }),
  ...json.map((partial_json) => sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } })),
  ...(finished ? [sse('content_block_stop', { index })] : []),
];
const end = (stopReason: string, outputTokens: number, stopDetails?: object) => [
  sse('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: outputTokens } }),
  sse('message_stop'),
];
const refusal = (category: string | null = 'cyber') => end('refusal', 7, { type: 'refusal', category, explanation: null });
const stream = (...parts: Array<ReturnType<typeof sse> | ReturnType<typeof sse>[]>) => sseResponse(parts.flat());

const REFUSAL_MESSAGE = 'Claude declined this request (category: cyber). If this is legitimate security work, see Anthropic\'s Cyber Verification Program.';
const PARTIAL_TEXT = 'Sure, I will start by reading the notes.';

const person = (id: number): AgentIdentity => ({ identityType: 'user', actorUserId: id, effectiveScopes: [] });

describe('an Anthropic stream that ends in a refusal after output', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let executed: Array<{ name: string; input: unknown }>;

  beforeEach(() => {
    db = createTestDb();
    executed = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  function makeRegistry(names: string[] = ['read_notes', 'write_notes']): AiToolRegistry {
    const registry = new AiToolRegistry();
    for (const name of names) {
      registry.register({
        name, description: `The ${name} tool`, inputSchema: { type: 'object', properties: {} }, context: ['devices'],
        execute: async (input: unknown) => { executed.push({ name, input }); return `${name} done`; },
      });
    }
    return registry;
  }

  const anthropic = (model = 'claude-sonnet-5-5') => createProvider('anthropic', { apiKey: 'sk-test-placeholder', model });

  function run(agent: AiAgent, extra: Record<string, unknown> = {}) {
    const events: string[] = [];
    const onToken = vi.fn((t: string) => { events.push(`token:${t}`); });
    const onToolStart = vi.fn((_id: string, name: string) => { events.push(`tool:${name}`); });
    const result = agent.handleMessageWithIdentity(person(5), {
      conversationId: null, message: 'look at my notes', pageContext: 'devices', contextId: '',
      onToken, onToolStart, onToolResult: vi.fn(), mode: 'streaming', ...extra,
    } as any);
    return { result, onToken, onToolStart, events };
  }

  const stored = (): AiMessage[] => JSON.parse(db.select().from(schema.aiConversations).get()!.messages);
  const shown = (onToken: { mock: { calls: unknown[][] } }): string => onToken.mock.calls.map((c) => c[0]).join('');

  describe('standard execution', () => {
    it('stores and shows only the refusal message when text had already streamed', async () => {
      stubFetch(() => stream(messageStart(), textBlock(0, 'Sure, ', 'I will start by reading the notes.'), refusal()));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result, onToken } = run(agent);
      const outcome = await result;

      expect(outcome.error).toBeUndefined();
      expect(stored()).toEqual([
        { role: 'user', content: 'look at my notes' },
        { role: 'assistant', content: [{ type: 'text', text: REFUSAL_MESSAGE }] },
      ]);
      expect(shown(onToken)).toBe(REFUSAL_MESSAGE);
    });

    it('never runs, stores or shows a tool call that completed before the refusal, nor the text before it', async () => {
      const fetchStub = stubFetch(() => stream(
        messageStart(), textBlock(0, PARTIAL_TEXT), toolBlock(1, 'toolu_01A', 'write_notes', ['{"text":', '"draft"}']), refusal(),
      ));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result, onToken, onToolStart } = run(agent);
      await result;

      expect(executed).toEqual([]);
      expect(onToolStart).not.toHaveBeenCalled();
      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: REFUSAL_MESSAGE }] });
      expect(shown(onToken)).toBe(REFUSAL_MESSAGE);
      expect(fetchStub.calls).toHaveLength(1);
    });

    it('drops every tool call of the turn when the refusal follows several of them', async () => {
      stubFetch(() => stream(
        messageStart(),
        toolBlock(0, 'toolu_01A', 'read_notes', ['{}']), toolBlock(1, 'toolu_01B', 'write_notes', ['{"text":"x"}']),
        refusal(),
      ));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result } = run(agent);
      await result;

      expect(executed).toEqual([]);
      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: REFUSAL_MESSAGE }] });
    });

    it('drops the text and tool call that came before a tool_use block cut off by the refusal', async () => {
      stubFetch(() => stream(
        messageStart(), textBlock(0, PARTIAL_TEXT), toolBlock(1, 'toolu_01A', 'write_notes', ['{"text":"dra'], false), refusal(),
      ));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result, onToken } = run(agent);
      await result;

      expect(executed).toEqual([]);
      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: REFUSAL_MESSAGE }] });
      expect(shown(onToken)).toBe(REFUSAL_MESSAGE);
    });

    it('counts the tokens of the refused turn as used', async () => {
      stubFetch(() => stream(messageStart(100), textBlock(0, PARTIAL_TEXT), refusal()));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const outcome = await run(agent).result;
      expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 7 });
    });

    it('a refusal before any output is still an error that ends the run, as before', async () => {
      stubFetch(() => stream(messageStart(), refusal()));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      await expect(run(agent).result).rejects.toBeInstanceOf(ModelRefusedError);
      expect(executed).toEqual([]);
    });

    it('a refusal after only a cut-off tool_use block (no text, no finished call) is still an error that ends the run', async () => {
      stubFetch(() => stream(messageStart(), toolBlock(0, 'toolu_01A', 'write_notes', ['{"text":"dra'], false), refusal()));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      await expect(run(agent).result).rejects.toBeInstanceOf(ModelRefusedError);
      expect(executed).toEqual([]);
    });

    it('a normal text turn is stored and shown whole', async () => {
      stubFetch(() => stream(messageStart(), textBlock(0, 'All ', 'good.'), end('end_turn', 4)));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result, onToken } = run(agent);
      await result;

      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'All good.' }] });
      expect(shown(onToken)).toBe('All good.');
    });

    it('a normal tool turn shows its text, then runs the tool, then continues', async () => {
      const fetchStub = stubFetch((_call, n) => n === 0
        ? stream(messageStart(), textBlock(0, 'Reading now.'), toolBlock(1, 'toolu_01A', 'read_notes', ['{"id":', '3}']), end('tool_use', 9))
        : stream(messageStart(), textBlock(0, 'Here they are.'), end('end_turn', 5)));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result, events } = run(agent);
      await result;

      expect(executed).toEqual([{ name: 'read_notes', input: { id: 3 } }]);
      expect(events).toEqual(['token:Reading now.', 'tool:read_notes', 'token:Here they are.']);
      expect(stored().map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
      expect(stored()[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading now.' }, { type: 'tool_use', id: 'toolu_01A', name: 'read_notes', input: { id: 3 } }],
      });
      expect(fetchStub.calls).toHaveLength(2);
    });

    it('keeps earlier turns of the run and replaces only the refused turn', async () => {
      stubFetch((_call, n) => n === 0
        ? stream(messageStart(), textBlock(0, 'Reading now.'), toolBlock(1, 'toolu_01A', 'read_notes', ['{}']), end('tool_use', 9))
        : stream(messageStart(), textBlock(0, PARTIAL_TEXT), toolBlock(1, 'toolu_01B', 'write_notes', ['{}']), refusal()));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result, events } = run(agent);
      await result;

      expect(executed).toEqual([{ name: 'read_notes', input: {} }]);
      expect(events).toEqual(['token:Reading now.', 'tool:read_notes', `token:${REFUSAL_MESSAGE}`]);
      expect(stored().map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
      expect(stored()[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: REFUSAL_MESSAGE }] });
    });

    it('does not replay the discarded text or tool calls on the next user turn', async () => {
      const fetchStub = stubFetch((_call, n) => n === 0
        ? stream(messageStart(), textBlock(0, PARTIAL_TEXT), toolBlock(1, 'toolu_01A', 'write_notes', ['{"text":"draft"}']), refusal())
        : stream(messageStart(), textBlock(0, 'Understood.'), end('end_turn', 2)));
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const first = await run(agent).result;
      await run(agent, { conversationId: first.conversationId, message: 'ok, something else' }).result;

      const replayed: any[] = fetchStub.calls[1].body.messages;
      expect(replayed).toEqual([
        { role: 'user', content: 'look at my notes' },
        { role: 'assistant', content: [{ type: 'text', text: REFUSAL_MESSAGE }] },
        { role: 'user', content: 'ok, something else' },
      ]);
      const wire = JSON.stringify(fetchStub.calls[1].body);
      expect(wire).not.toContain('start by reading');
      expect(wire).not.toContain('toolu_01A');
      expect(wire).not.toContain('draft');
    });
  });

  describe('tiered execution', () => {
    const WRITE_MODEL = 'claude-opus-5-5';
    const RESEARCH_MODEL = 'claude-haiku-5-5';
    const tierConfig = (): TierConfig => ({
      researchProvider: anthropic(RESEARCH_MODEL), writeProvider: anthropic(WRITE_MODEL), writeToolNames: ['write_notes'],
    });
    const modelOf = (call: FetchCall): string => call.body.model;

    it('a research turn that is refused after it asked for a write tool does not escalate and runs nothing', async () => {
      const fetchStub = stubFetch(() => stream(
        messageStart(), textBlock(0, PARTIAL_TEXT), toolBlock(1, 'toolu_01A', 'write_notes', ['{"text":"draft"}']), refusal(),
      ));
      const agent = new AiAgent(db, makeRegistry(), anthropic(RESEARCH_MODEL));
      const { result, onToken } = run(agent, { tierConfig: tierConfig() });
      await result;

      expect(fetchStub.calls.map(modelOf)).toEqual([RESEARCH_MODEL]);
      expect(executed).toEqual([]);
      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: REFUSAL_MESSAGE }] });
      expect(shown(onToken)).toBe(REFUSAL_MESSAGE);
    });

    it('a write model refused after it started writing counts as declining: the research response is used', async () => {
      const fetchStub = stubFetch((call, n) => {
        if (modelOf(call) === RESEARCH_MODEL && n === 0) {
          return stream(messageStart(), toolBlock(0, 'toolu_01R', 'write_notes', ['{"text":"from research"}']), end('tool_use', 6));
        }
        if (modelOf(call) === WRITE_MODEL) {
          return stream(messageStart(), textBlock(0, PARTIAL_TEXT), toolBlock(1, 'toolu_01W', 'write_notes', ['{"text":"from write"}']), refusal());
        }
        return stream(messageStart(), textBlock(0, 'Written.'), end('end_turn', 2));
      });
      const agent = new AiAgent(db, makeRegistry(), anthropic(RESEARCH_MODEL));
      const { result } = run(agent, { tierConfig: tierConfig() });
      await result;

      expect(fetchStub.calls.map(modelOf)).toEqual([RESEARCH_MODEL, WRITE_MODEL, RESEARCH_MODEL]);
      expect(executed).toEqual([{ name: 'write_notes', input: { text: 'from research' } }]);
      expect(JSON.stringify(stored())).not.toContain('from write');
    });
  });

  describe('context compaction', () => {
    it('keeps the full history when the summary request is refused after it started writing', async () => {
      const fetchStub = stubFetch((call, n) => {
        const last: any = call.body.messages[call.body.messages.length - 1];
        if (typeof last.content === 'string' && last.content.startsWith('CONTEXT COMPACTION REQUIRED')) {
          return stream(messageStart(), textBlock(0, 'Summary so far: the notes say'), refusal());
        }
        return n === 0
          ? stream(messageStart(600_000), toolBlock(0, 'toolu_01A', 'read_notes', ['{}']), end('tool_use', 9))   // over 55% of the model's 1M window
          : stream(messageStart(), textBlock(0, 'Done.'), end('end_turn', 2));
      });
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result } = run(agent);
      await result;

      expect(fetchStub.calls).toHaveLength(3);
      const nextTurn: any[] = fetchStub.calls[2].body.messages;
      expect(nextTurn.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(JSON.stringify(nextTurn)).toContain('look at my notes');
      expect(JSON.stringify(nextTurn)).not.toContain('Conversation compacted');
      expect(JSON.stringify(nextTurn)).not.toContain('Summary so far');
    });

    it('sends the run\'s tools and system prompt with the summary request, which Anthropic needs for a history that holds tool calls', async () => {
      const fetchStub = stubFetch((call, n) => {
        const last: any = call.body.messages[call.body.messages.length - 1];
        if (typeof last.content === 'string' && last.content.startsWith('CONTEXT COMPACTION REQUIRED')) {
          return stream(messageStart(), textBlock(0, 'Summary so far: the notes say'), end('end_turn', 7));
        }
        return n === 0
          ? stream(messageStart(600_000), toolBlock(0, 'toolu_01A', 'read_notes', ['{}']), end('tool_use', 9))
          : stream(messageStart(), textBlock(0, 'Done.'), end('end_turn', 2));
      });
      const agent = new AiAgent(db, makeRegistry(), anthropic());
      const { result } = run(agent);
      await result;

      expect(fetchStub.calls).toHaveLength(3);
      const [turn, summary, afterSummary] = fetchStub.calls.map((c) => c.body);
      expect(summary.tools?.length).toBeGreaterThan(0);
      expect(summary.tools).toEqual(turn.tools);
      expect(summary.system).toEqual(turn.system);
      expect(JSON.stringify(afterSummary.messages)).toContain('Conversation compacted');
      expect(JSON.stringify(afterSummary.messages)).toContain('Summary so far');
    });
  });
});
