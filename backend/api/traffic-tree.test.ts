import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerTrafficEndpoints, resetFilterRules } from './traffic';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../websocket/index', () => ({ broadcastToAll: vi.fn() }));

const { capturedTraffic } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerTrafficEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function seed(db: any, rows: Array<{ host: string; url: string; sessionId?: number }>) {
  for (const r of rows) {
    db.insert(capturedTraffic).values({
      requestMethod: 'GET', requestUrl: r.url, hostname: r.host,
      requestHeaders: '{}', requestBody: null, responseStatus: 200,
      responseHeaders: '{}', responseBody: '{}', type: 'http',
      sessionId: r.sessionId ?? null, capturedAt: new Date(),
    } as any).run();
  }
}

describe('GET /v1/traffic/tree', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;
  beforeEach(() => {
    db = createTestDb();
    resetFilterRules();
    app = createApp(db);
  });

  it('hosts mode returns distinct hostnames with counts, ordered desc', async () => {
    seed(db, [
      { host: 'api.foo.com', url: 'https://api.foo.com/a' },
      { host: 'api.foo.com', url: 'https://api.foo.com/b' },
      { host: 'cdn.bar.com', url: 'https://cdn.bar.com/x' },
    ]);
    const res = await request(app).get('/v1/traffic/tree');
    expect(res.status).toBe(200);
    expect(res.body.data.hosts).toEqual([
      { hostname: 'api.foo.com', count: 2 },
      { hostname: 'cdn.bar.com', count: 1 },
    ]);
  });

  it('buckets null/empty hostnames under (unknown)', async () => {
    seed(db, [{ host: '', url: 'not-a-url' }]);
    const res = await request(app).get('/v1/traffic/tree');
    expect(res.body.data.hosts[0].hostname).toBe('(unknown)');
  });

  it('paths mode returns per-path counts + a real latestId for one host', async () => {
    seed(db, [
      { host: 'api.foo.com', url: 'https://api.foo.com/users' },
      { host: 'api.foo.com', url: 'https://api.foo.com/users?q=1' },
      { host: 'api.foo.com', url: 'https://api.foo.com/orders' },
      { host: 'cdn.bar.com', url: 'https://cdn.bar.com/x' },
    ]);
    const res = await request(app).get('/v1/traffic/tree?hostname=api.foo.com');
    expect(res.status).toBe(200);
    const paths = res.body.data.paths as Array<{ path: string; count: number; latestId: number }>;
    const users = paths.find(p => p.path === '/users');
    expect(users?.count).toBe(2);
    expect(users?.latestId).toBeGreaterThan(0);
    expect(paths.some(p => p.path === '/orders')).toBe(true);
    // cdn.bar.com path must not appear
    expect(paths.some(p => p.path === '/x')).toBe(false);
  });

  it('narrows by sessionId', async () => {
    seed(db, [
      { host: 'api.foo.com', url: 'https://api.foo.com/a', sessionId: 1 },
      { host: 'api.foo.com', url: 'https://api.foo.com/b', sessionId: 2 },
    ]);
    const res = await request(app).get('/v1/traffic/tree?sessionId=1');
    expect(res.body.data.hosts).toEqual([{ hostname: 'api.foo.com', count: 1 }]);
  });
});
