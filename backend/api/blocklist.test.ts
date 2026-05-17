import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerBlocklistEndpoints } from './blocklist';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../services/blocklist-writer', () => ({
  syncBlocklistFile: vi.fn(),
}));

const { blockedDomains } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerBlocklistEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Blocklist API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('POST /v1/blocklist/add', () => {
    it('should add a new blocked domain', async () => {
      const res = await request(app)
        .post('/v1/blocklist/add')
        .send({ domain: 'example.com' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.domain).toBe('example.com');
    });

    it('should normalize domain to lowercase', async () => {
      const res = await request(app)
        .post('/v1/blocklist/add')
        .send({ domain: 'EXAMPLE.COM' });

      expect(res.status).toBe(201);
      expect(res.body.data.domain).toBe('example.com');
    });

    it('should strip wildcard prefix', async () => {
      const res = await request(app)
        .post('/v1/blocklist/add')
        .send({ domain: '*.example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data.domain).toBe('example.com');
    });

    it('should return existing entry for duplicate (idempotent)', async () => {
      await request(app).post('/v1/blocklist/add').send({ domain: 'example.com' });
      const res = await request(app).post('/v1/blocklist/add').send({ domain: 'example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data.domain).toBe('example.com');

      // Should still only have one entry
      const listRes = await request(app).get('/v1/blocklist/list');
      expect(listRes.body.data).toHaveLength(1);
    });

    it('should return 400 if domain is missing', async () => {
      const res = await request(app)
        .post('/v1/blocklist/add')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/blocklist/list', () => {
    it('should return empty array when no domains exist', async () => {
      const res = await request(app).get('/v1/blocklist/list');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return all blocked domains', async () => {
      db.insert(blockedDomains).values({ domain: 'a.com', createdAt: new Date() }).run();
      db.insert(blockedDomains).values({ domain: 'b.com', createdAt: new Date() }).run();

      const res = await request(app).get('/v1/blocklist/list');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('DELETE /v1/blocklist/remove/:id', () => {
    it('should remove a blocked domain', async () => {
      db.insert(blockedDomains).values({ domain: 'example.com', createdAt: new Date() }).run();

      const res = await request(app).delete('/v1/blocklist/remove/1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const remaining = db.select().from(blockedDomains).all();
      expect(remaining).toHaveLength(0);
    });

    it('should return 404 for non-existent domain', async () => {
      const res = await request(app).delete('/v1/blocklist/remove/999');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).delete('/v1/blocklist/remove/abc');

      expect(res.status).toBe(400);
    });
  });
});
