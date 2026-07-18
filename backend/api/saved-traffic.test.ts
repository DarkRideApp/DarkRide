import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerSavedTrafficEndpoints } from './saved-traffic';
import { SavedTrafficStore } from '../services/saved-traffic-store';
import { createTestDb } from '../test-utils/create-test-db';

const { capturedTraffic } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerSavedTrafficEndpoints(new SavedTrafficStore(db as any), db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('POST /v1/traffic/saved', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;
  beforeEach(() => { db = createTestDb(); app = createApp(db); });

  function seedCaptured(): number {
    const row = db.insert(capturedTraffic).values({
      requestMethod: 'GET', requestUrl: 'https://api.test/x', requestHeaders: '{}',
      requestBody: null, responseStatus: 200, responseHeaders: '{}', responseBody: '{"ok":true}',
      type: 'http', capturedAt: new Date(),
    } as any).returning({ id: capturedTraffic.id }).all()[0];
    return row.id;
  }

  it('persists a captured row into saved traffic', async () => {
    const id = seedCaptured();
    const res = await request(app).post('/v1/traffic/saved').send({ id });
    expect(res.status).toBe(200);
    expect(res.body.data.saved).toBe(true);
    const saved = await request(app).get('/v1/traffic/saved');
    expect(saved.body.data.some((s: any) => s.url === 'https://api.test/x')).toBe(true);
  });

  it('404s for an unknown captured id', async () => {
    const res = await request(app).post('/v1/traffic/saved').send({ id: 99999 });
    expect(res.status).toBe(404);
  });

  it('400s when id is missing', async () => {
    const res = await request(app).post('/v1/traffic/saved').send({});
    expect(res.status).toBe(400);
  });
});
