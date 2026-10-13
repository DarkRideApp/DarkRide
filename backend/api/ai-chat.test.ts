import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAiChatApiEndpoints } from './ai-chat';
import { createTestDb } from '../test-utils/create-test-db';

interface TestUser { userId: number; scopes: string[] }
const CHATTER: TestUser = { userId: 1, scopes: ['core.ai:chat'] };

/** `user` is the caller's identity; null sends the request with none, as if auth had not run. */
function createApp(db: BetterSQLite3Database<typeof schema>, user: TestUser | null = CHATTER) {
  clearEndpoints();
  registerAiChatApiEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) {
      req.authUser = { userId: user.userId, username: `u${user.userId}`, via: 'session', effectiveScopes: new Set(user.scopes) };
    }
    next();
  });
  app.use(getApiRouter());
  return app;
}

function insertConversation(
  db: BetterSQLite3Database<typeof schema>,
  pageContext: string,
  contextId: string,
  messages: any[],
  updatedAt: number,
  opts?: { inputTokens?: number; outputTokens?: number; userId?: number | null; title?: string; originPath?: string | null; unfinished?: boolean; automated?: boolean },
): number {
  return db.insert(schema.aiConversations)
    .values({
      pageContext,
      contextId,
      title: opts?.title ?? 'Test',
      userId: opts?.userId ?? null,
      originPath: opts?.originPath ?? null,
      unfinished: opts?.unfinished ?? false,
      automated: opts?.automated ?? false,
      messages: JSON.stringify(messages),
      inputTokens: opts?.inputTokens ?? null,
      outputTokens: opts?.outputTokens ?? null,
      createdAt: new Date(updatedAt),
      updatedAt: new Date(updatedAt),
    })
    .run().lastInsertRowid as number;
}

describe('GET /v1/ai/conversations/latest', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  it('returns null when no conversation exists', async () => {
    const res = await request(app).get('/v1/ai/conversations/latest?pageContext=dashboard&contextId=');
    expect(res.status).toBe(200);
    expect(res.body.data).toBe(null);
  });

  it('returns 400 when pageContext is missing', async () => {
    const res = await request(app).get('/v1/ai/conversations/latest');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pageContext/);
  });

  it('returns the latest conversation for matching context', async () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ];
    insertConversation(db, 'dashboard', '', messages, 1000000);

    const res = await request(app).get('/v1/ai/conversations/latest?pageContext=dashboard&contextId=');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toBe(null);
    expect(res.body.data.pageContext).toBe('dashboard');
    expect(res.body.data.messages).toEqual(messages);
  });

  it('returns the most recent conversation when multiple exist', async () => {
    const older = [{ role: 'user', content: 'Old' }];
    const newer = [{ role: 'user', content: 'New' }];
    insertConversation(db, 'traffic', '', older, 1000000);
    insertConversation(db, 'traffic', '', newer, 2000000);

    const res = await request(app).get('/v1/ai/conversations/latest?pageContext=traffic&contextId=');
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toEqual(newer);
  });

  it('filters by contextId', async () => {
    const msgs1 = [{ role: 'user', content: 'Session 1' }];
    const msgs2 = [{ role: 'user', content: 'Session 2' }];
    insertConversation(db, 'session-timeline', '1', msgs1, 1000000);
    insertConversation(db, 'session-timeline', '2', msgs2, 2000000);

    const res = await request(app).get('/v1/ai/conversations/latest?pageContext=session-timeline&contextId=1');
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toEqual(msgs1);
  });

  it('returns null for non-matching context', async () => {
    insertConversation(db, 'dashboard', '', [{ role: 'user', content: 'test' }], 1000000);

    const res = await request(app).get('/v1/ai/conversations/latest?pageContext=traffic&contextId=');
    expect(res.status).toBe(200);
    expect(res.body.data).toBe(null);
  });

  it('returns conversation id', async () => {
    insertConversation(db, 'dashboard', '', [{ role: 'user', content: 'hi' }], 1000000);

    const res = await request(app).get('/v1/ai/conversations/latest?pageContext=dashboard&contextId=');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.id).toBe('number');
  });
});

describe('GET /v1/ai/usage', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  it('returns zero totals when no conversations exist', async () => {
    const res = await request(app).get('/v1/ai/usage');
    expect(res.status).toBe(200);
    expect(res.body.data.totalInputTokens).toBe(0);
    expect(res.body.data.totalOutputTokens).toBe(0);
    expect(res.body.data.conversationCount).toBe(0);
    expect(res.body.data.byContext).toEqual([]);
    expect(res.body.data.conversations).toEqual([]);
  });

  it('returns aggregate token usage across all conversations', async () => {
    insertConversation(db, 'apk-analysis', '1', [], 1000000, { inputTokens: 5000, outputTokens: 1000 });
    insertConversation(db, 'apk-analysis', '2', [], 2000000, { inputTokens: 3000, outputTokens: 800 });
    insertConversation(db, 'apk-diff', '1', [], 3000000, { inputTokens: 2000, outputTokens: 500 });

    const res = await request(app).get('/v1/ai/usage');
    expect(res.status).toBe(200);
    expect(res.body.data.totalInputTokens).toBe(10000);
    expect(res.body.data.totalOutputTokens).toBe(2300);
    expect(res.body.data.conversationCount).toBe(3);
  });

  it('returns per-context breakdown', async () => {
    insertConversation(db, 'apk-analysis', '1', [], 1000000, { inputTokens: 5000, outputTokens: 1000 });
    insertConversation(db, 'apk-diff', '1', [], 2000000, { inputTokens: 2000, outputTokens: 500 });

    const res = await request(app).get('/v1/ai/usage');
    expect(res.status).toBe(200);
    const byContext = res.body.data.byContext as Array<{ pageContext: string; inputTokens: number; outputTokens: number; count: number }>;
    expect(byContext).toHaveLength(2);

    const analysis = byContext.find(c => c.pageContext === 'apk-analysis');
    expect(analysis).toBeDefined();
    expect(analysis!.inputTokens).toBe(5000);
    expect(analysis!.outputTokens).toBe(1000);
    expect(analysis!.count).toBe(1);

    const diff = byContext.find(c => c.pageContext === 'apk-diff');
    expect(diff).toBeDefined();
    expect(diff!.inputTokens).toBe(2000);
    expect(diff!.outputTokens).toBe(500);
  });

  it('filters by pageContext', async () => {
    insertConversation(db, 'apk-analysis', '1', [], 1000000, { inputTokens: 5000, outputTokens: 1000 });
    insertConversation(db, 'apk-diff', '1', [], 2000000, { inputTokens: 2000, outputTokens: 500 });

    const res = await request(app).get('/v1/ai/usage?pageContext=apk-analysis');
    expect(res.status).toBe(200);
    expect(res.body.data.totalInputTokens).toBe(5000);
    expect(res.body.data.totalOutputTokens).toBe(1000);
    expect(res.body.data.conversationCount).toBe(1);
  });

  it('filters by date range', async () => {
    // Timestamps in ms: 1000000 = 1000s after epoch, 3000000 = 3000s
    insertConversation(db, 'apk-analysis', '1', [], 1000000, { inputTokens: 5000, outputTokens: 1000 });
    insertConversation(db, 'apk-analysis', '2', [], 3000000, { inputTokens: 3000, outputTokens: 800 });

    // Filter to only include the first conversation (from=0, to=2000000)
    const res = await request(app).get('/v1/ai/usage?from=0&to=2000000');
    expect(res.status).toBe(200);
    expect(res.body.data.totalInputTokens).toBe(5000);
    expect(res.body.data.conversationCount).toBe(1);
  });

  it('returns conversations sorted by most expensive', async () => {
    insertConversation(db, 'apk-analysis', '1', [], 1000000, { inputTokens: 1000, outputTokens: 200 });
    insertConversation(db, 'apk-analysis', '2', [], 2000000, { inputTokens: 9000, outputTokens: 3000 });
    insertConversation(db, 'apk-diff', '1', [], 3000000, { inputTokens: 5000, outputTokens: 1000 });

    const res = await request(app).get('/v1/ai/usage');
    expect(res.status).toBe(200);
    const convos = res.body.data.conversations;
    expect(convos).toHaveLength(3);
    // Most expensive first: 9000+3000=12000, then 5000+1000=6000, then 1000+200=1200
    expect(convos[0].inputTokens).toBe(9000);
    expect(convos[1].inputTokens).toBe(5000);
    expect(convos[2].inputTokens).toBe(1000);
  });

  it('handles conversations with null token usage', async () => {
    insertConversation(db, 'chat', '', [], 1000000);
    insertConversation(db, 'apk-analysis', '1', [], 2000000, { inputTokens: 5000, outputTokens: 1000 });

    const res = await request(app).get('/v1/ai/usage');
    expect(res.status).toBe(200);
    // Null tokens are treated as 0 in sum
    expect(res.body.data.totalInputTokens).toBe(5000);
    expect(res.body.data.totalOutputTokens).toBe(1000);
    expect(res.body.data.conversationCount).toBe(2);
  });
});

describe('GET /v1/ai/conversations/latest, owner and history fields', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => { db = createTestDb(); });

  it('returns originPath and unfinished', async () => {
    insertConversation(db, 'apk-analysis', '12', [], 1000, { originPath: '/ui/analysis/12', unfinished: true });
    const res = await request(createApp(db)).get('/v1/ai/conversations/latest?pageContext=apk-analysis&contextId=12');
    expect(res.body.data.originPath).toBe('/ui/analysis/12');
    expect(res.body.data.unfinished).toBe(true);
  });

  it('does not return another user\'s conversation, even when it is the most recent', async () => {
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'mine' }], 1000, { userId: 1 });
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'theirs' }], 2000, { userId: 2 });
    const res = await request(createApp(db)).get('/v1/ai/conversations/latest?pageContext=devices&contextId=');
    expect(res.body.data.messages).toEqual([{ role: 'user', content: 'mine' }]);
  });

  it('returns a conversation saved before ownership existed', async () => {
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'old' }], 1000, { userId: null });
    const res = await request(createApp(db, { userId: 7, scopes: ['core.ai:chat'] })).get('/v1/ai/conversations/latest?pageContext=devices&contextId=');
    expect(res.body.data.messages).toEqual([{ role: 'user', content: 'old' }]);
  });

  it('answers 401 when the request has no identity', async () => {
    const res = await request(createApp(db, null)).get('/v1/ai/conversations/latest?pageContext=devices&contextId=');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/ai/conversations (history list)', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => { db = createTestDb(); });
  const list = (qs = '', user: TestUser | null = CHATTER) => request(createApp(db, user)).get(`/v1/ai/conversations${qs}`);
  const titles = (res: request.Response) => res.body.data.conversations.map((c: any) => c.title);

  it('lists summaries newest activity first, without messages', async () => {
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'a' }], 1000, { userId: 1, title: 'older', originPath: '/ui/devices' });
    insertConversation(db, 'automations', '5', [{ role: 'user', content: 'b' }], 3000, { userId: 1, title: 'newest', unfinished: true });
    insertConversation(db, 'proxies', '', [{ role: 'user', content: 'c' }], 2000, { userId: 1, title: 'middle' });

    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data.hasMore).toBe(false);
    expect(titles(res)).toEqual(['newest', 'middle', 'older']);
    expect(res.body.data.conversations[0]).toEqual({
      id: expect.any(Number), title: 'newest', pageContext: 'automations', contextId: '5',
      originPath: null, unfinished: true, createdAt: 3000, updatedAt: 3000,
    });
    expect(res.body.data.conversations[2].originPath).toBe('/ui/devices');
  });

  it('lists only the caller\'s conversations plus ones saved before ownership existed', async () => {
    insertConversation(db, 'devices', '', [], 1000, { userId: 1, title: 'mine' });
    insertConversation(db, 'devices', '', [], 2000, { userId: 2, title: 'theirs' });
    insertConversation(db, 'devices', '', [], 3000, { userId: null, title: 'legacy' });
    expect(titles(await list())).toEqual(['legacy', 'mine']);
  });

  it('leaves out conversations started by automated runs', async () => {
    insertConversation(db, 'apk-diff', '3', [], 2000, { title: 'diff run', automated: true });
    insertConversation(db, 'devices', '', [], 1000, { userId: 1, title: 'chat' });
    expect(titles(await list())).toEqual(['chat']);
  });

  it('pages with limit and offset and reports hasMore', async () => {
    for (let i = 1; i <= 5; i++) insertConversation(db, 'devices', '', [], i * 1000, { userId: 1, title: `c${i}` });
    const p1 = await list('?limit=2&offset=0');
    expect(titles(p1)).toEqual(['c5', 'c4']);
    expect(p1.body.data.hasMore).toBe(true);
    const p3 = await list('?limit=2&offset=4');
    expect(titles(p3)).toEqual(['c1']);
    expect(p3.body.data.hasMore).toBe(false);
  });

  it('defaults to 30, caps at 100, and ignores junk limit and offset', async () => {
    for (let i = 0; i < 105; i++) insertConversation(db, 'devices', '', [], i + 1, { userId: 1 });
    expect((await list()).body.data.conversations).toHaveLength(30);
    expect((await list('?limit=1000')).body.data.conversations).toHaveLength(100);
    expect((await list('?limit=abc&offset=-5')).body.data.conversations).toHaveLength(30);
    expect((await list('?limit=0')).body.data.conversations).toHaveLength(30);
  });

  it('searches the title and the message text, ignoring case', async () => {
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'nothing here' }], 1000, { userId: 1, title: 'Pixel Frida hook' });
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'why does the Cronet bypass fail' }], 2000, { userId: 1, title: 'other' });
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'unrelated' }], 3000, { userId: 1, title: 'third' });
    expect(titles(await list('?q=frida'))).toEqual(['Pixel Frida hook']);
    expect(titles(await list('?q=CRONET'))).toEqual(['other']);
    expect(titles(await list('?q=zzz'))).toEqual([]);
  });

  it('treats % and _ in the search text as plain characters', async () => {
    insertConversation(db, 'devices', '', [], 1000, { userId: 1, title: '100% done' });
    insertConversation(db, 'devices', '', [], 2000, { userId: 1, title: 'plain' });
    expect(titles(await list('?q=%25'))).toEqual(['100% done']);
    expect(titles(await list('?q=_'))).toEqual([]);
  });

  it('never searches another user\'s messages', async () => {
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'secret-token' }], 1000, { userId: 2, title: 'theirs' });
    expect(titles(await list('?q=secret-token'))).toEqual([]);
  });

  it('narrows to one page context and context id', async () => {
    insertConversation(db, 'apk-analysis', '1', [], 1000, { userId: 1, title: 'a1' });
    insertConversation(db, 'apk-analysis', '2', [], 2000, { userId: 1, title: 'a2' });
    insertConversation(db, 'devices', '', [], 3000, { userId: 1, title: 'd' });
    expect(titles(await list('?pageContext=apk-analysis'))).toEqual(['a2', 'a1']);
    expect(titles(await list('?pageContext=apk-analysis&contextId=1'))).toEqual(['a1']);
    expect(titles(await list('?pageContext=devices&contextId='))).toEqual(['d']);
  });

  it('answers 403 without the chat scope and 401 without an identity', async () => {
    insertConversation(db, 'devices', '', [], 1000, { userId: 1 });
    expect((await list('', { userId: 1, scopes: ['core.apk:read'] })).status).toBe(403);
    expect((await list('', null)).status).toBe(401);
  });
});

describe('GET /v1/ai/conversations/:id', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => { db = createTestDb(); });
  const get = (id: string | number, user: TestUser | null = CHATTER) => request(createApp(db, user)).get(`/v1/ai/conversations/${id}`);

  it('returns the conversation with its messages', async () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    const id = insertConversation(db, 'devices', '', msgs, 1000, { userId: 1, title: 'T', originPath: '/ui/devices', unfinished: true });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, title: 'T', pageContext: 'devices', contextId: '', messages: msgs, originPath: '/ui/devices', unfinished: true });
  });

  it('returns a conversation saved before ownership existed', async () => {
    const id = insertConversation(db, 'devices', '', [], 1000, { userId: null });
    expect((await get(id, { userId: 9, scopes: ['core.ai:chat'] })).status).toBe(200);
  });

  it('answers 404 for another user\'s conversation and for a missing one', async () => {
    const id = insertConversation(db, 'devices', '', [], 1000, { userId: 2 });
    expect((await get(id)).status).toBe(404);
    expect((await get(9999)).status).toBe(404);
  });

  it('answers 400 for a non-numeric id and does not shadow /latest', async () => {
    expect((await get('abc')).status).toBe(400);
    insertConversation(db, 'devices', '', [{ role: 'user', content: 'x' }], 1000, { userId: 1 });
    const latest = await request(createApp(db)).get('/v1/ai/conversations/latest?pageContext=devices&contextId=');
    expect(latest.status).toBe(200);
    expect(latest.body.data.pageContext).toBe('devices');
  });

  it('answers 403 without the chat scope and 401 without an identity', async () => {
    const id = insertConversation(db, 'devices', '', [], 1000, { userId: 1 });
    expect((await get(id, { userId: 1, scopes: [] })).status).toBe(403);
    expect((await get(id, null)).status).toBe(401);
  });
});

describe('DELETE /v1/ai/conversations/:id', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => { db = createTestDb(); });
  const del = (id: string | number, user: TestUser | null = CHATTER) => request(createApp(db, user)).delete(`/v1/ai/conversations/${id}`);
  const count = () => db.select().from(schema.aiConversations).all().length;

  it('deletes the caller\'s own conversation', async () => {
    const id = insertConversation(db, 'devices', '', [], 1000, { userId: 1 });
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(count()).toBe(0);
  });

  it('deletes a conversation saved before ownership existed', async () => {
    const id = insertConversation(db, 'devices', '', [], 1000, { userId: null });
    expect((await del(id)).status).toBe(200);
    expect(count()).toBe(0);
  });

  it('answers 404 and keeps another user\'s conversation', async () => {
    const id = insertConversation(db, 'devices', '', [], 1000, { userId: 2 });
    expect((await del(id)).status).toBe(404);
    expect(count()).toBe(1);
  });

  it('answers 404 for a missing id and 400 for a bad one', async () => {
    expect((await del(9999)).status).toBe(404);
    expect((await del('abc')).status).toBe(400);
  });

  it('answers 403 without the chat scope and 401 without an identity, deleting nothing', async () => {
    const id = insertConversation(db, 'devices', '', [], 1000, { userId: 1 });
    expect((await del(id, { userId: 1, scopes: [] })).status).toBe(403);
    expect((await del(id, null)).status).toBe(401);
    expect(count()).toBe(1);
  });
});
