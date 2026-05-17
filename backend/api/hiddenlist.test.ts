import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerHiddenlistEndpoints } from './hiddenlist';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../services/hiddenlist-writer', () => ({
  syncHiddenlistFile: vi.fn(),
}));

const { hiddenDomains } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerHiddenlistEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Hiddenlist API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('POST /v1/hiddenlist/add', () => {
    it('should add a new hidden domain', async () => {
      const res = await request(app)
        .post('/v1/hiddenlist/add')
        .send({ domain: 'example.com' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.domain).toBe('example.com');
    });

    it('should normalize domain to lowercase', async () => {
      const res = await request(app)
        .post('/v1/hiddenlist/add')
        .send({ domain: 'EXAMPLE.COM' });

      expect(res.status).toBe(201);
      expect(res.body.data.domain).toBe('example.com');
    });

    it('should strip wildcard prefix', async () => {
      const res = await request(app)
        .post('/v1/hiddenlist/add')
        .send({ domain: '*.example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data.domain).toBe('example.com');
    });

    it('should return existing entry for duplicate (idempotent)', async () => {
      await request(app).post('/v1/hiddenlist/add').send({ domain: 'example.com' });
      const res = await request(app).post('/v1/hiddenlist/add').send({ domain: 'example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data.domain).toBe('example.com');

      // Should still only have one entry
      const listRes = await request(app).get('/v1/hiddenlist/list');
      expect(listRes.body.data).toHaveLength(1);
    });

    it('should return 400 if domain is missing', async () => {
      const res = await request(app)
        .post('/v1/hiddenlist/add')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/hiddenlist/list', () => {
    it('should return empty array when no domains exist', async () => {
      const res = await request(app).get('/v1/hiddenlist/list');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return all hidden domains', async () => {
      db.insert(hiddenDomains).values({ domain: 'a.com', createdAt: new Date() }).run();
      db.insert(hiddenDomains).values({ domain: 'b.com', createdAt: new Date() }).run();

      const res = await request(app).get('/v1/hiddenlist/list');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('DELETE /v1/hiddenlist/remove/:id', () => {
    it('should remove a hidden domain', async () => {
      db.insert(hiddenDomains).values({ domain: 'example.com', createdAt: new Date() }).run();

      const res = await request(app).delete('/v1/hiddenlist/remove/1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const remaining = db.select().from(hiddenDomains).all();
      expect(remaining).toHaveLength(0);
    });

    it('should return 404 for non-existent domain', async () => {
      const res = await request(app).delete('/v1/hiddenlist/remove/999');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).delete('/v1/hiddenlist/remove/abc');

      expect(res.status).toBe(400);
    });
  });
});
