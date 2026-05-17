import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerCredentialsEndpoints } from './credentials';
import { createTestDb } from '../test-utils/create-test-db';

const { credentials } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerCredentialsEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Credentials API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('POST /v1/credentials/add', () => {
    it('should create a credential', async () => {
      const res = await request(app)
        .post('/v1/credentials/add')
        .send({ appId: 'com.example.app', username: 'user1', password: 'pass1' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.appId).toBe('com.example.app');
      expect(res.body.data.username).toBe('user1');
      expect(res.body.data.password).toBe('pass1');
      expect(res.body.data.customFields).toBeNull();
    });

    it('should return 400 if appId is missing', async () => {
      const res = await request(app)
        .post('/v1/credentials/add')
        .send({ username: 'user1', password: 'pass1' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('appId is required');
    });

    it('should return 400 if username is missing', async () => {
      const res = await request(app)
        .post('/v1/credentials/add')
        .send({ appId: 'com.example.app', password: 'pass1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('username is required');
    });

    it('should return 400 if password is missing', async () => {
      const res = await request(app)
        .post('/v1/credentials/add')
        .send({ appId: 'com.example.app', username: 'user1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('password is required');
    });

    it('should create a credential with customFields', async () => {
      const res = await request(app)
        .post('/v1/credentials/add')
        .send({
          appId: 'com.example.app',
          username: 'user1',
          password: 'pass1',
          customFields: { apiKey: 'abc123', region: 'us-east' },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.customFields).toEqual({ apiKey: 'abc123', region: 'us-east' });
    });
  });

  describe('GET /v1/credentials/list', () => {
    it('should return empty array when no credentials', async () => {
      const res = await request(app).get('/v1/credentials/list');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return all credentials', async () => {
      const now = new Date();
      db.insert(credentials).values({ appId: 'com.a', username: 'u1', password: 'p1', createdAt: now, updatedAt: now }).run();
      db.insert(credentials).values({ appId: 'com.b', username: 'u2', password: 'p2', createdAt: now, updatedAt: now }).run();

      const res = await request(app).get('/v1/credentials/list');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('should filter by appId', async () => {
      const now = new Date();
      db.insert(credentials).values({ appId: 'com.a', username: 'u1', password: 'p1', createdAt: now, updatedAt: now }).run();
      db.insert(credentials).values({ appId: 'com.b', username: 'u2', password: 'p2', createdAt: now, updatedAt: now }).run();

      const res = await request(app).get('/v1/credentials/list?appId=com.a');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].appId).toBe('com.a');
    });
  });

  describe('PUT /v1/credentials/update/:id', () => {
    it('should update a credential', async () => {
      const now = new Date();
      db.insert(credentials).values({ appId: 'com.a', username: 'old', password: 'old', createdAt: now, updatedAt: now }).run();

      const res = await request(app)
        .put('/v1/credentials/update/1')
        .send({ username: 'new-user', password: 'new-pass' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.username).toBe('new-user');
      expect(res.body.data.password).toBe('new-pass');
    });

    it('should partial update (only username)', async () => {
      const now = new Date();
      db.insert(credentials).values({ appId: 'com.a', username: 'old', password: 'keep', createdAt: now, updatedAt: now }).run();

      const res = await request(app)
        .put('/v1/credentials/update/1')
        .send({ username: 'new-user' });

      expect(res.status).toBe(200);
      expect(res.body.data.username).toBe('new-user');
      expect(res.body.data.password).toBe('keep');
    });

    it('should return 404 if credential not found', async () => {
      const res = await request(app)
        .put('/v1/credentials/update/999')
        .send({ username: 'x' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('DELETE /v1/credentials/delete/:id', () => {
    it('should delete a credential', async () => {
      const now = new Date();
      db.insert(credentials).values({ appId: 'com.a', username: 'u', password: 'p', createdAt: now, updatedAt: now }).run();

      const res = await request(app).delete('/v1/credentials/delete/1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const remaining = db.select().from(credentials).all();
      expect(remaining).toHaveLength(0);
    });

    it('should return 404 if credential not found', async () => {
      const res = await request(app).delete('/v1/credentials/delete/999');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
