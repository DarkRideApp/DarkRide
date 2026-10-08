import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter, getRegisteredEndpoints } from './api-service';
import { registerAiUsageEndpoints } from './ai-usage';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

type Db = ReturnType<typeof createTestDb>;

function createApp(db: Db, scopes?: string[]) {
  clearEndpoints();
  registerAiUsageEndpoints(db as any);
  const app = express();
  app.use(express.json());
  if (scopes) {
    app.use((req, _res, next) => {
      (req as any).authUser = { userId: 1, effectiveScopes: new Set(scopes) };
      next();
    });
  }
  app.use(getApiRouter());
  return app;
}

describe('GET /v1/ai/usage', () => {
  let db: Db;
  let userId: number;

  function addRun(startedAt: Date): number {
    return (db as any).insert(schema.aiCallLog).values({
      startedAt,
      identityType: 'user',
      actorUserId: userId,
      effectiveScopes: [],
      inputTokens: 10,
      outputTokens: 5,
    }).returning({ id: schema.aiCallLog.id }).get().id;
  }

  beforeEach(() => {
    db = createTestDb([schema.users, schema.aiCallLog, schema.aiCallRequest]);
    const now = new Date();
    userId = (db as any).insert(schema.users).values({
      username: 'alice', providerId: 'core.password', scopes: [], createdAt: now, updatedAt: now,
    }).returning({ id: schema.users.id }).get().id;
  });

  it('returns the report wrapped in the success envelope with default days and limit', async () => {
    addRun(new Date(Date.now() - 60_000));
    const res = await request(createApp(db)).get('/v1/ai/usage');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.days).toBe(30);
    expect(res.body.data.totals.runs).toBe(1);
    expect(res.body.data.recentRuns).toHaveLength(1);
    expect(typeof res.body.data.generatedAt).toBe('string');
  });

  it('defaults the run list to 50 entries', async () => {
    for (let i = 0; i < 55; i++) addRun(new Date(Date.now() - (i + 1) * 1000));
    const res = await request(createApp(db)).get('/v1/ai/usage');
    expect(res.body.data.recentRuns).toHaveLength(50);
    expect(res.body.data.totals.runs).toBe(55);
  });

  it('applies the days and limit query parameters', async () => {
    addRun(new Date(Date.now() - 60_000));
    addRun(new Date(Date.now() - 120_000));
    addRun(new Date(Date.now() - 10 * 24 * 3600_000));
    const res = await request(createApp(db)).get('/v1/ai/usage?days=7&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toBe(7);
    expect(res.body.data.totals.runs).toBe(2);
    expect(res.body.data.recentRuns).toHaveLength(1);
  });

  it('accepts the bounds of each range', async () => {
    const app = createApp(db);
    expect((await request(app).get('/v1/ai/usage?days=1&limit=1')).status).toBe(200);
    expect((await request(app).get('/v1/ai/usage?days=90&limit=200')).status).toBe(200);
  });

  it.each([
    ['days=0', 'days must be an integer from 1 to 90'],
    ['days=91', 'days must be an integer from 1 to 90'],
    ['days=abc', 'days must be an integer from 1 to 90'],
    ['days=1.5', 'days must be an integer from 1 to 90'],
    ['days=', 'days must be an integer from 1 to 90'],
    ['days=7&days=8', 'days must be an integer from 1 to 90'],
    ['limit=0', 'limit must be an integer from 1 to 200'],
    ['limit=201', 'limit must be an integer from 1 to 200'],
    ['limit=-3', 'limit must be an integer from 1 to 200'],
  ])('rejects %s with 400', async (query, error) => {
    const res = await request(createApp(db)).get(`/v1/ai/usage?${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error });
  });

  it('requires the core.settings:read scope', async () => {
    createApp(db);
    const endpoint = getRegisteredEndpoints().find(e => e.method === 'GET' && e.path === '/v1/ai/usage');
    expect(endpoint?.opts?.requires).toEqual(['core.settings:read']);

    const denied = await request(createApp(db, ['core.devices:read'])).get('/v1/ai/usage');
    expect(denied.status).toBe(403);
    const allowed = await request(createApp(db, ['core.settings:read'])).get('/v1/ai/usage');
    expect(allowed.status).toBe(200);
  });
});
