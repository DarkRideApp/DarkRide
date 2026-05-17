import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerProxyEndpoints } from './proxies';
import { createTestDb } from '../test-utils/create-test-db';

const { proxies } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerProxyEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Proxy API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('POST /v1/proxy/add', () => {
    it('should add a new proxy', async () => {
      const res = await request(app)
        .post('/v1/proxy/add')
        .send({ url: 'http://proxy.example.com:8080', username: 'user', password: 'pass' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe('http://proxy.example.com:8080');
      expect(res.body.data.username).toBe('user');
      expect(res.body.data.password).toBe('pass');
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.failureCount).toBe(0);
    });

    it('should add a proxy without credentials', async () => {
      const res = await request(app)
        .post('/v1/proxy/add')
        .send({ url: 'http://proxy.example.com:8080' });

      expect(res.status).toBe(201);
      expect(res.body.data.username).toBeNull();
      expect(res.body.data.password).toBeNull();
    });

    it('should return 400 if url is missing', async () => {
      const res = await request(app)
        .post('/v1/proxy/add')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/proxy/list', () => {
    it('should return empty array when no proxies exist', async () => {
      const res = await request(app).get('/v1/proxy/list');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return all proxies', async () => {
      db.insert(proxies).values({ url: 'http://p1.com:8080', createdAt: new Date() }).run();
      db.insert(proxies).values({ url: 'http://p2.com:8080', createdAt: new Date() }).run();

      const res = await request(app).get('/v1/proxy/list');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('GET /v1/proxy/view/:id', () => {
    it('should return proxy details', async () => {
      db.insert(proxies).values({ url: 'http://proxy.com:8080', username: 'u', createdAt: new Date() }).run();

      const res = await request(app).get('/v1/proxy/view/1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe('http://proxy.com:8080');
      expect(res.body.data.username).toBe('u');
    });

    it('should return 404 for non-existent proxy', async () => {
      const res = await request(app).get('/v1/proxy/view/999');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).get('/v1/proxy/view/abc');

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /v1/proxy/update/:id', () => {
    it('should update proxy url', async () => {
      db.insert(proxies).values({ url: 'http://old.com:8080', createdAt: new Date() }).run();

      const res = await request(app)
        .put('/v1/proxy/update/1')
        .send({ url: 'http://new.com:8080' });

      expect(res.status).toBe(200);
      expect(res.body.data.url).toBe('http://new.com:8080');
    });

    it('should update proxy credentials', async () => {
      db.insert(proxies).values({ url: 'http://proxy.com:8080', createdAt: new Date() }).run();

      const res = await request(app)
        .put('/v1/proxy/update/1')
        .send({ username: 'newuser', password: 'newpass' });

      expect(res.status).toBe(200);
      expect(res.body.data.username).toBe('newuser');
      expect(res.body.data.password).toBe('newpass');
    });

    it('should return 404 for non-existent proxy', async () => {
      const res = await request(app)
        .put('/v1/proxy/update/999')
        .send({ url: 'http://new.com:8080' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /v1/proxy/delete/:id', () => {
    it('should delete a proxy', async () => {
      db.insert(proxies).values({ url: 'http://proxy.com:8080', createdAt: new Date() }).run();

      const res = await request(app).delete('/v1/proxy/delete/1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const remaining = db.select().from(proxies).all();
      expect(remaining).toHaveLength(0);
    });

    it('should return 404 for non-existent proxy', async () => {
      const res = await request(app).delete('/v1/proxy/delete/999');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/proxy/enable/:id', () => {
    it('should enable a disabled proxy', async () => {
      db.insert(proxies).values({ url: 'http://proxy.com:8080', enabled: false, createdAt: new Date() }).run();

      const res = await request(app).post('/v1/proxy/enable/1');

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });

    it('should return 404 for non-existent proxy', async () => {
      const res = await request(app).post('/v1/proxy/enable/999');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/proxy/disable/:id', () => {
    it('should disable an enabled proxy', async () => {
      db.insert(proxies).values({ url: 'http://proxy.com:8080', createdAt: new Date() }).run();

      const res = await request(app).post('/v1/proxy/disable/1');

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
    });

    it('should return 404 for non-existent proxy', async () => {
      const res = await request(app).post('/v1/proxy/disable/999');
      expect(res.status).toBe(404);
    });
  });
});
