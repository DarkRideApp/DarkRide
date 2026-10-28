import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import type { AiMessage } from '../../shared/types/ai-chat';
import type { AgentIdentity } from './ai-agent';
import {
  loadForRun,
  saveRunStart,
  saveRunEnd,
  appendUserMessage,
  ownerOf,
  INTERRUPTED_NOTE,
  INTERRUPTED_TOOL_RESULT,
} from './ai-conversation-store';

type Db = ReturnType<typeof createTestDb>;

function seed(db: Db, over: Partial<typeof schema.aiConversations.$inferInsert> = {}): number {
  return Number(db.insert(schema.aiConversations).values({
    pageContext: 'devices',
    contextId: '',
    title: 'seeded',
    messages: JSON.stringify([{ role: 'user', content: 'hi' }]),
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
    ...over,
  }).run().lastInsertRowid);
}
const rowOf = (db: Db, id: number) => db.select().from(schema.aiConversations).where(eq(schema.aiConversations.id, id)).get();

const user = (id: number): AgentIdentity => ({ identityType: 'user', actorUserId: id, effectiveScopes: [] });

describe('ownerOf', () => {
  it('is the user for a person chatting', () => {
    expect(ownerOf(user(4), false)).toBe(4);
  });
  it('is the person a plugin acts for', () => {
    expect(ownerOf({ identityType: 'plugin-acting-for-user', actorUserId: 9, actingForUserId: 4, effectiveScopes: [] }, false)).toBe(4);
  });
  it('is nobody for a service, a plain plugin, or any automated run', () => {
    expect(ownerOf({ identityType: 'core-service', actorUserId: 2, effectiveScopes: [] }, false)).toBeNull();
    expect(ownerOf({ identityType: 'plugin', actorUserId: 3, effectiveScopes: [] }, false)).toBeNull();
    expect(ownerOf(user(4), true)).toBeNull();
  });
});

describe('loadForRun', () => {
  let db: Db;
  beforeEach(() => { db = createTestDb(); });

  it('finds nothing for a new chat or a missing id', () => {
    expect(loadForRun(db, null, 1)).toBeUndefined();
    expect(loadForRun(db, 999, 1)).toBeUndefined();
  });
  it('returns the caller\'s conversation and one saved before ownership existed', () => {
    const mine = seed(db, { userId: 1 });
    const legacy = seed(db, { userId: null });
    expect(loadForRun(db, mine, 1)?.id).toBe(mine);
    expect(loadForRun(db, legacy, 1)?.id).toBe(legacy);
  });
  it('does not return another user\'s conversation', () => {
    expect(loadForRun(db, seed(db, { userId: 2 }), 1)).toBeUndefined();
  });
  it('applies no owner check when the run has no owner (automated runs and services)', () => {
    expect(loadForRun(db, seed(db, { userId: 2 }), null)?.userId).toBe(2);
  });
});

describe('saveRunStart', () => {
  let db: Db;
  beforeEach(() => { db = createTestDb(); });
  const base = { ownerId: 1, automated: false, pageContext: 'apk-analysis', contextId: '12', originPath: '/ui/analysis/12', title: 'T' };
  const msgs: AiMessage[] = [{ role: 'user', content: 'first' }];

  it('inserts a new conversation that is unfinished, owned, and remembers where it started', () => {
    const id = saveRunStart(db, { ...base, conversationId: null, messages: msgs });
    const row = rowOf(db, id)!;
    expect(row).toMatchObject({
      userId: 1, pageContext: 'apk-analysis', contextId: '12', originPath: '/ui/analysis/12',
      title: 'T', unfinished: true, automated: false,
    });
    expect(JSON.parse(row.messages)).toEqual(msgs);
    expect(row.createdAt.getTime()).toBeGreaterThan(0);
  });

  it('flags automated runs and gives them no owner', () => {
    const id = saveRunStart(db, { ...base, ownerId: null, automated: true, originPath: undefined, conversationId: null, messages: msgs });
    expect(rowOf(db, id)).toMatchObject({ userId: null, automated: true, originPath: null });
  });

  it('updates an existing conversation and keeps its owner, title and origin', () => {
    const id = seed(db, { userId: 1, title: 'kept', originPath: '/ui/devices', unfinished: false });
    const out = saveRunStart(db, { ...base, originPath: '/ui/elsewhere', title: 'ignored', conversationId: id, messages: [...msgs, { role: 'user', content: 'second' }] });
    expect(out).toBe(id);
    const row = rowOf(db, id)!;
    expect(row).toMatchObject({ userId: 1, title: 'kept', originPath: '/ui/devices', unfinished: true });
    expect(JSON.parse(row.messages)).toHaveLength(2);
    expect(row.updatedAt.getTime()).toBeGreaterThan(1000);
  });

  it('inserts a fresh conversation when the id was deleted in the meantime', () => {
    const id = saveRunStart(db, { ...base, conversationId: 999, messages: msgs });
    expect(id).not.toBe(999);
    expect(rowOf(db, id)).toMatchObject({ userId: 1, unfinished: true });
  });
});

describe('saveRunEnd', () => {
  let db: Db;
  beforeEach(() => { db = createTestDb(); });
  const done: AiMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }];

  it('stores the messages and usage and clears the unfinished flag', () => {
    const id = seed(db, { userId: 1, unfinished: true });
    saveRunEnd(db, id, { messages: done, inputTokens: 10, outputTokens: 5, unfinished: false });
    const row = rowOf(db, id)!;
    expect(JSON.parse(row.messages)).toEqual(done);
    expect(row).toMatchObject({ inputTokens: 10, outputTokens: 5, unfinished: false, userId: 1, title: 'seeded' });
    expect(row.updatedAt.getTime()).toBeGreaterThan(1000);
  });

  it('keeps the unfinished flag when the run did not finish cleanly', () => {
    const id = seed(db, { unfinished: true });
    saveRunEnd(db, id, { messages: done, inputTokens: 1, outputTokens: 1, unfinished: true });
    expect(rowOf(db, id)!.unfinished).toBe(true);
  });

  it('stores the CLI session id only when given', () => {
    const id = seed(db, { claudeSessionId: 'old' });
    saveRunEnd(db, id, { messages: done, inputTokens: 1, outputTokens: 1, unfinished: false });
    expect(rowOf(db, id)!.claudeSessionId).toBe('old');
    saveRunEnd(db, id, { messages: done, inputTokens: 1, outputTokens: 1, unfinished: false, claudeSessionId: 'new' });
    expect(rowOf(db, id)!.claudeSessionId).toBe('new');
  });

  it('does nothing, and does not bring the chat back, when it was deleted during the run', () => {
    saveRunEnd(db, 999, { messages: done, inputTokens: 1, outputTokens: 1, unfinished: false });
    expect(db.select().from(schema.aiConversations).all()).toHaveLength(0);
  });
});

describe('appendUserMessage', () => {
  it('appends the message to an empty or finished conversation', () => {
    expect(appendUserMessage([], 'hi')).toEqual([{ role: 'user', content: 'hi' }]);
    const finished: AiMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }];
    expect(appendUserMessage(finished, 'next')).toEqual([...finished, { role: 'user', content: 'next' }]);
  });

  it('puts a note between two user messages when the earlier run never replied', () => {
    const out = appendUserMessage([{ role: 'user', content: 'q' }], 'continue');
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: INTERRUPTED_NOTE }] },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('does not change the list it was given', () => {
    const before: AiMessage[] = [{ role: 'user', content: 'q' }];
    appendUserMessage(before, 'x');
    expect(before).toHaveLength(1);
  });

  const use = (id: string) => ({ type: 'tool_use' as const, id, name: 'ping', input: {} });
  const note: AiMessage = { role: 'assistant', content: [{ type: 'text', text: INTERRUPTED_NOTE }] };

  it('answers a tool call that never got a result, so the provider accepts the next request', () => {
    const out = appendUserMessage([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [use('t1')] },
    ], 'continue');
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [use('t1')] },
      { role: 'tool_result', toolUseId: 't1', content: INTERRUPTED_TOOL_RESULT },
      note,
      { role: 'user', content: 'continue' },
    ]);
  });

  it('answers only the calls that have no result, in order', () => {
    const out = appendUserMessage([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [use('t1'), use('t2')] },
      { role: 'tool_result', toolUseId: 't1', content: 'done' },
    ], 'continue');
    expect(out.slice(1)).toEqual([
      { role: 'assistant', content: [use('t1'), use('t2')] },
      { role: 'tool_result', toolUseId: 't1', content: 'done' },
      { role: 'tool_result', toolUseId: 't2', content: INTERRUPTED_TOOL_RESULT },
      note,
      { role: 'user', content: 'continue' },
    ]);
  });

  it('closes a call in the middle of the history too', () => {
    const out = appendUserMessage([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [use('t1')] },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ], 'more');
    expect(out[2]).toEqual({ role: 'tool_result', toolUseId: 't1', content: INTERRUPTED_TOOL_RESULT });
    expect(out.at(-1)).toEqual({ role: 'user', content: 'more' });
    expect(out.some((m) => m === note)).toBe(false);
  });

  it('adds the note when the last run stopped after its tool results', () => {
    const out = appendUserMessage([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [use('t1')] },
      { role: 'tool_result', toolUseId: 't1', content: 'done' },
    ], 'continue');
    expect(out.slice(-2)).toEqual([note, { role: 'user', content: 'continue' }]);
  });

  it('leaves a finished conversation with answered calls untouched', () => {
    const finished: AiMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [use('t1')] },
      { role: 'tool_result', toolUseId: 't1', content: 'done' },
      { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
    ];
    expect(appendUserMessage(finished, 'next')).toEqual([...finished, { role: 'user', content: 'next' }]);
  });
});
