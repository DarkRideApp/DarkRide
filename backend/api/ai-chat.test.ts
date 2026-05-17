import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAiChatApiEndpoints } from './ai-chat';
import { createTestDb } from '../test-utils/create-test-db';

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerAiChatApiEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function insertConversation(
  db: BetterSQLite3Database<typeof schema>,
  pageContext: string,
  contextId: string,
  messages: any[],
  updatedAt: number,
  opts?: { inputTokens?: number; outputTokens?: number },
) {
  db.insert(schema.aiConversations)
    .values({
      pageContext,
      contextId,
      title: 'Test',
      messages: JSON.stringify(messages),
      inputTokens: opts?.inputTokens ?? null,
      outputTokens: opts?.outputTokens ?? null,
      createdAt: new Date(updatedAt),
      updatedAt: new Date(updatedAt),
    })
    .run();
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
