// fixtures: hand-written from https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures (wire shape only)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { AiAgent, type AgentIdentity, type TierConfig } from './ai-agent';
import { AiToolRegistry } from './ai-tools';
import { createProvider } from './ai/registry';
import { stubFetch, sseResponse } from './ai/test-helpers';
import { createTestDb } from '../test-utils/create-test-db';
import type { AiMessage, AiProviderData, AiStreamEvent } from '../../shared/types/ai-chat';
import type { AiStreamingProvider } from './ai/dialect';

const MODEL = 'gemini-3-pro-preview';
const written = (sig: string, model = MODEL): AiProviderData => ({ dialect: 'gemini-generate', model, data: { thoughtSignature: sig } });

const chunk = (parts: object[], finishReason?: string, promptTokens = 10) => ({
  data: JSON.stringify({
    candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
    ...(finishReason ? { usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 4 } } : {}),
  }),
});
const reply = (...chunks: Array<ReturnType<typeof chunk>>) => sseResponse(chunks);

const person = (id: number): AgentIdentity => ({ identityType: 'user', actorUserId: id, effectiveScopes: [] });

describe('provider data on the blocks of a stored conversation', () => {
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

  const gemini = () => createProvider('gemini', { apiKey: 'sk-test-placeholder', model: MODEL });

  /** A provider that streams the given events on every request. */
  const fake = (events: AiStreamEvent[] | ((n: number) => AiStreamEvent[])): AiStreamingProvider & { requests: number } => {
    const provider = {
      name: 'fake',
      requests: 0,
      async *createStreamingRequest() {
        const list = typeof events === 'function' ? events(provider.requests) : events;
        provider.requests++;
        yield* list;
      },
    };
    return provider;
  };

  function run(agent: AiAgent, extra: Record<string, unknown> = {}) {
    const onToken = vi.fn();
    const result = agent.handleMessageWithIdentity(person(5), {
      conversationId: null, message: 'look at my notes', pageContext: 'devices', contextId: '',
      onToken, onToolStart: vi.fn(), onToolResult: vi.fn(), mode: 'streaming', ...extra,
    } as any);
    return { result, onToken };
  }

  const stored = (): AiMessage[] => JSON.parse(db.select().from(schema.aiConversations).get()!.messages);
  const partsOf = (call: { body: any }, index: number): any[] => call.body.contents[index].parts;

  describe('a Gemini run end to end', () => {
    const SKIP = 'skip_thought_signature_validator';
    const twoSteps = (n: number) => n === 0
      ? reply(chunk([
        { text: 'Reading now.' },
        { functionCall: { id: 'fc1', name: 'read_notes', args: { id: 3 } }, thoughtSignature: 'SIG-A' },
      ], 'STOP'))
      : reply(chunk([{ text: 'Here they are.', thoughtSignature: 'SIG-T' }], 'STOP'));

    it('stores the signatures with the blocks they arrived on', async () => {
      stubFetch((_call, n) => twoSteps(n));
      await run(new AiAgent(db, makeRegistry(), gemini())).result;

      expect(stored()).toEqual([
        { role: 'user', content: 'look at my notes' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading now.' },
            { type: 'tool_use', id: 'fc1', name: 'read_notes', input: { id: 3 }, providerData: written('SIG-A') },
          ],
        },
        { role: 'tool_result', toolUseId: 'fc1', content: 'read_notes done' },
        { role: 'assistant', content: [{ type: 'text', text: 'Here they are.', providerData: written('SIG-T') }] },
      ]);
    });

    it('sends the real signature back on the next step of the same run, not the stand-in', async () => {
      const fetchStub = stubFetch((_call, n) => twoSteps(n));
      await run(new AiAgent(db, makeRegistry(), gemini())).result;

      const call = partsOf(fetchStub.calls[1], 1).find((p) => p.functionCall);
      expect(call.thoughtSignature).toBe('SIG-A');
      expect(JSON.stringify(fetchStub.calls[1].body)).not.toContain(SKIP);
    });

    it('sends both signatures back on the next user turn, read again from the store', async () => {
      const fetchStub = stubFetch((_call, n) => n < 2 ? twoSteps(n) : reply(chunk([{ text: 'Sure.' }], 'STOP')));
      const agent = new AiAgent(db, makeRegistry(), gemini());
      const first = await run(agent).result;
      await run(agent, { conversationId: first.conversationId, message: 'and the rest?' }).result;

      const contents: any[] = fetchStub.calls[2].body.contents;
      expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
      expect(contents[1].parts.find((p: any) => p.functionCall).thoughtSignature).toBe('SIG-A');
      expect(contents[3].parts).toEqual([{ text: 'Here they are.', thoughtSignature: 'SIG-T' }]);
    });

    it('keeps a signature that streams on an empty text part, and does not show an empty token', async () => {
      stubFetch(() => reply(chunk([{ text: 'Hello' }]), chunk([{ text: '', thoughtSignature: 'SIG-T' }], 'STOP')));
      const { result, onToken } = run(new AiAgent(db, makeRegistry(), gemini()));
      await result;

      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hello', providerData: written('SIG-T') }] });
      expect(onToken.mock.calls.map((c) => c[0])).toEqual(['Hello']);
    });

    it('leaves no signature behind when the context is compacted: the summary messages carry none', async () => {
      const fetchStub = stubFetch((call, n) => {
        const last = call.body.contents[call.body.contents.length - 1];
        if (String(last.parts[0].text ?? '').startsWith('CONTEXT COMPACTION REQUIRED')) {
          return reply(chunk([{ text: 'Summary: read the notes.' }], 'STOP'));
        }
        return n === 0
          ? reply(chunk([{ functionCall: { id: 'fc1', name: 'read_notes', args: {} }, thoughtSignature: 'SIG-A' }], 'STOP', 150_000))
          : reply(chunk([{ text: 'Done.' }], 'STOP'));
      });
      await run(new AiAgent(db, makeRegistry(), gemini())).result;

      expect(fetchStub.calls).toHaveLength(3);
      expect(JSON.stringify(fetchStub.calls[1].body)).toContain('SIG-A');   // the summary request still sees the real history
      const afterCompaction = JSON.stringify(fetchStub.calls[2].body);
      expect(afterCompaction).toContain('Conversation compacted');
      expect(afterCompaction).not.toContain('SIG-A');
      expect(afterCompaction).not.toContain(SKIP);
      expect(JSON.stringify(stored())).not.toContain('SIG-A');
    });

    it('a run on a conversation stored before signatures were kept still gets the stand-in', async () => {
      const fetchStub = stubFetch(() => reply(chunk([{ text: 'Sure.' }], 'STOP')));
      const agent = new AiAgent(db, makeRegistry(), gemini());
      const first = await run(agent).result;
      const row = db.select().from(schema.aiConversations).get()!;
      const legacy: AiMessage[] = [
        { role: 'user', content: 'look at my notes' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'fc1', name: 'read_notes', input: {} }] },
        { role: 'tool_result', toolUseId: 'fc1', content: 'read_notes done' },
        { role: 'assistant', content: [{ type: 'text', text: 'Here they are.' }] },
      ];
      db.update(schema.aiConversations).set({ messages: JSON.stringify(legacy) }).run();
      await run(agent, { conversationId: row.id, message: 'again' }).result;

      expect(first.conversationId).toBe(row.id);
      const call = partsOf(fetchStub.calls[1], 1).find((p) => p.functionCall);
      expect(call.thoughtSignature).toBe(SKIP);
    });
  });

  describe('standard execution with any provider', () => {
    const text = (t: string, providerData?: AiProviderData): AiStreamEvent => ({ type: 'text', text: t, ...(providerData ? { providerData } : {}) });
    const tool = (id: string, name: string, providerData?: AiProviderData): AiStreamEvent => ({ type: 'tool_use', id, name, input: {}, ...(providerData ? { providerData } : {}) });

    it('joins the text events into one block and keeps the last data they carried', async () => {
      const agent = new AiAgent(db, makeRegistry(), fake([text('a ', written('FIRST')), text('b '), text('c', written('LAST'))]));
      await run(agent).result;
      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'a b c', providerData: written('LAST') }] });
    });

    it('stores a block without data when none was sent, with no providerData key', async () => {
      const agent = new AiAgent(db, makeRegistry(), fake([text('plain')]));
      await run(agent).result;
      expect('providerData' in (stored()[1] as any).content[0]).toBe(false);
    });

    it('keeps the data of each tool call on its own block', async () => {
      const agent = new AiAgent(db, makeRegistry(), fake((n) => n === 0
        ? [tool('t1', 'read_notes', written('SIG-1')), tool('t2', 'write_notes')]
        : [text('done')]));
      await run(agent).result;
      const blocks = (stored()[1] as any).content;
      expect(blocks[0].providerData).toEqual(written('SIG-1'));
      expect('providerData' in blocks[1]).toBe(false);
    });

    it('does not keep the data of text that a refusal replaced', async () => {
      const agent = new AiAgent(db, makeRegistry(), fake([
        text('partial', written('SIG-T')), tool('t1', 'write_notes', written('SIG-1')), { type: 'refusal', message: 'Declined.' },
      ]));
      await run(agent).result;
      expect(stored()[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Declined.' }] });
      expect(executed).toEqual([]);
    });
  });

  describe('tiered execution', () => {
    const text = (t: string, providerData?: AiProviderData): AiStreamEvent => ({ type: 'text', text: t, ...(providerData ? { providerData } : {}) });
    const tool = (id: string, name: string, providerData?: AiProviderData): AiStreamEvent => ({ type: 'tool_use', id, name, input: {}, ...(providerData ? { providerData } : {}) });
    const tiers = (research: AiStreamingProvider, write: AiStreamingProvider): TierConfig =>
      ({ researchProvider: research, writeProvider: write, writeToolNames: ['write_notes'] });
    const end = [text('done')];

    it('keeps the data of the research response when it needs no write tool', async () => {
      const research = fake((n) => n === 0 ? [text('Reading.', written('SIG-T')), tool('r1', 'read_notes', written('SIG-R'))] : end);
      const write = fake([]);
      await run(new AiAgent(db, makeRegistry(), research), { tierConfig: tiers(research, write) }).result;

      expect(write.requests).toBe(0);
      expect(stored()[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.', providerData: written('SIG-T') },
          { type: 'tool_use', id: 'r1', name: 'read_notes', input: {}, providerData: written('SIG-R') },
        ],
      });
    });

    it('keeps the data of the write response after an escalation, not the research one', async () => {
      const research = fake((n) => n === 0 ? [text('Drafting.', written('RESEARCH-T')), tool('r1', 'write_notes', written('RESEARCH-1'))] : end);
      const write = fake([text('Writing.', written('WRITE-T')), tool('w1', 'write_notes', written('WRITE-1'))]);
      await run(new AiAgent(db, makeRegistry(), research), { tierConfig: tiers(research, write) }).result;

      expect(stored()[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Writing.', providerData: written('WRITE-T') },
          { type: 'tool_use', id: 'w1', name: 'write_notes', input: {}, providerData: written('WRITE-1') },
        ],
      });
    });

    it('falls back to the research response, with its data, when the write model does not write', async () => {
      const research = fake((n) => n === 0 ? [text('Drafting.', written('RESEARCH-T')), tool('r1', 'write_notes', written('RESEARCH-1'))] : end);
      const write = fake([text('No need.', written('WRITE-T'))]);
      await run(new AiAgent(db, makeRegistry(), research), { tierConfig: tiers(research, write) }).result;

      const blocks = (stored()[1] as any).content;
      expect(blocks[0]).toEqual({ type: 'text', text: 'Drafting.', providerData: written('RESEARCH-T') });
      expect(blocks[1].providerData).toEqual(written('RESEARCH-1'));
    });
  });
});
