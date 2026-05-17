import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountAiTiersRoutesOnRouter } from '../ai-tiers';
import { AiTierStore } from '../../services/ai-tier-store';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';

const SETUP_SQL = `
CREATE TABLE ai_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  is_hardcoded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE ai_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_id INTEGER,
  model TEXT,
  enabled INTEGER DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  cooldown_minutes INTEGER DEFAULT 10,
  tier_id INTEGER REFERENCES ai_tiers(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO ai_tiers (name, sort_order, is_hardcoded, created_at, updated_at) VALUES ('High', 0, 1, 1, 1);
INSERT INTO ai_tiers (name, sort_order, is_hardcoded, created_at, updated_at) VALUES ('Low', 1, 1, 1, 1);
`;

function makeApp(store: AiTierStore, db: any) {
  const app = express();
  app.use(express.json());
  const r = express.Router();
  mountAiTiersRoutesOnRouter(r, { tierStore: store, db });
  app.use(r);
  return app;
}

describe('AI tiers routes', () => {
  let sqlite: Database.Database;
  let store: AiTierStore;
  let db: any;
  let app: express.Express;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(SETUP_SQL);
    db = drizzle(sqlite, { schema });
    store = new AiTierStore(db);
    app = makeApp(store, db);
  });

  it('GET /v1/ai/tiers returns seeded tiers', async () => {
    const res = await request(app).get('/v1/ai/tiers');
    expect(res.status).toBe(200);
    expect(res.body.map((t: any) => t.name)).toEqual(['High', 'Low']);
  });

  it('POST /v1/ai/tiers creates a new tier', async () => {
    const res = await request(app).post('/v1/ai/tiers').send({ name: 'Medium' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Medium');
    expect(res.body.sortOrder).toBe(2);
  });

  it('POST rejects duplicate name with 400', async () => {
    const res = await request(app).post('/v1/ai/tiers').send({ name: 'High' });
    expect(res.status).toBe(400);
  });

  it('PATCH renames a user-added tier', async () => {
    const created = (await request(app).post('/v1/ai/tiers').send({ name: 'Medium' })).body;
    const res = await request(app).patch(`/v1/ai/tiers/${created.id}`).send({ name: 'Mid' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Mid');
  });

  it('PATCH rejects rename on hardcoded tier with 409', async () => {
    const highId = store.getByName('High')!.id;
    const res = await request(app).patch(`/v1/ai/tiers/${highId}`).send({ name: 'Top' });
    expect(res.status).toBe(409);
  });

  it('PUT /v1/ai/tiers/reorder reorders tiers', async () => {
    const created = (await request(app).post('/v1/ai/tiers').send({ name: 'Medium' })).body;
    const highId = store.getByName('High')!.id;
    const lowId = store.getByName('Low')!.id;
    const res = await request(app).put('/v1/ai/tiers/reorder').send({ ids: [created.id, highId, lowId] });
    expect(res.status).toBe(204);
    const list = (await request(app).get('/v1/ai/tiers')).body;
    expect(list.map((t: any) => t.name)).toEqual(['Medium', 'High', 'Low']);
  });

  it('DELETE removes an empty user-added tier', async () => {
    const created = (await request(app).post('/v1/ai/tiers').send({ name: 'Medium' })).body;
    const res = await request(app).delete(`/v1/ai/tiers/${created.id}`);
    expect(res.status).toBe(204);
    const list = (await request(app).get('/v1/ai/tiers')).body;
    expect(list.map((t: any) => t.name)).toEqual(['High', 'Low']);
  });

  it('DELETE rejects hardcoded tier with 409', async () => {
    const highId = store.getByName('High')!.id;
    const res = await request(app).delete(`/v1/ai/tiers/${highId}`);
    expect(res.status).toBe(409);
  });

  it('DELETE rejects tier with models with 409', async () => {
    const created = (await request(app).post('/v1/ai/tiers').send({ name: 'Medium' })).body;
    sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, created_at, updated_at) VALUES ('x','p',?,1,1)`).run(created.id);
    const res = await request(app).delete(`/v1/ai/tiers/${created.id}`);
    expect(res.status).toBe(409);
  });

  it('POST /v1/ai/models/:id/move-tier updates the model tier', async () => {
    const created = (await request(app).post('/v1/ai/tiers').send({ name: 'Medium' })).body;
    const highId = store.getByName('High')!.id;
    sqlite.prepare(`INSERT INTO ai_models (id, name, provider, tier_id, created_at, updated_at) VALUES (1,'x','p',?,1,1)`).run(highId);
    const res = await request(app).post('/v1/ai/models/1/move-tier').send({ tierId: created.id });
    expect(res.status).toBe(200);
    const model = sqlite.prepare(`SELECT tier_id FROM ai_models WHERE id = 1`).get() as any;
    expect(model.tier_id).toBe(created.id);
  });
});
