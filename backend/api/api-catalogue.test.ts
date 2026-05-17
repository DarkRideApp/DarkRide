import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerApiCatalogueEndpoints } from './api-catalogue';
import { createTestDb } from '../test-utils/create-test-db';

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerApiCatalogueEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function seedEndpoint(db: any, method: string, hostname: string, path: string, status = 200) {
  const now = Date.now();
  db.run(
    require('drizzle-orm').sql`INSERT OR IGNORE INTO api_endpoints (method, hostname, path_pattern, first_seen, last_seen, request_count, sample_response_status) VALUES (${method}, ${hostname}, ${path}, ${now}, ${now}, 1, ${status})`
  );
}

describe('API Catalogue Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('GET /v1/api-catalogue/endpoints', () => {
    it('should return empty list', async () => {
      const res = await request(app).get('/v1/api-catalogue/endpoints');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('should return endpoints with pagination', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/v1/users');
      seedEndpoint(db, 'POST', 'api.example.com', '/v1/users');

      const res = await request(app).get('/v1/api-catalogue/endpoints?limit=1');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.total).toBe(2);
    });

    it('should filter by method', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/a');
      seedEndpoint(db, 'POST', 'api.example.com', '/b');

      const res = await request(app).get('/v1/api-catalogue/endpoints?method=GET');
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].method).toBe('GET');
    });

    it('should filter by hostname', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/a');
      seedEndpoint(db, 'GET', 'other.com', '/b');

      const res = await request(app).get('/v1/api-catalogue/endpoints?hostname=example');
      expect(res.body.data.total).toBe(1);
    });
  });

  describe('GET /v1/api-catalogue/endpoints/:id', () => {
    it('should return endpoint detail', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/v1/users');

      const res = await request(app).get('/v1/api-catalogue/endpoints/1');
      expect(res.status).toBe(200);
      expect(res.body.data.method).toBe('GET');
      expect(res.body.data.hostname).toBe('api.example.com');
    });

    it('should return 404 for non-existent', async () => {
      const res = await request(app).get('/v1/api-catalogue/endpoints/999');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /v1/api-catalogue/endpoints/:id', () => {
    it('should delete an endpoint', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/v1/users');

      const res = await request(app).delete('/v1/api-catalogue/endpoints/1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const listRes = await request(app).get('/v1/api-catalogue/endpoints');
      expect(listRes.body.data.total).toBe(0);
    });
  });

  describe('DELETE /v1/api-catalogue/endpoints (clear all)', () => {
    it('should clear all endpoints', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/a');
      seedEndpoint(db, 'POST', 'api.example.com', '/b');

      const res = await request(app).delete('/v1/api-catalogue/endpoints');
      expect(res.status).toBe(200);

      const listRes = await request(app).get('/v1/api-catalogue/endpoints');
      expect(listRes.body.data.total).toBe(0);
    });
  });

  describe('PATCH /v1/api-catalogue/endpoints/:id', () => {
    it('should assign a group', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/v1/users');
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'TestGroup' });

      const res = await request(app).patch('/v1/api-catalogue/endpoints/1').send({ groupId: 1 });
      expect(res.status).toBe(200);

      const detail = await request(app).get('/v1/api-catalogue/endpoints/1');
      expect(detail.body.data.groupId).toBe(1);
      expect(detail.body.data.groupName).toBe('TestGroup');
    });
  });

  describe('Groups CRUD', () => {
    it('should create a group', async () => {
      const res = await request(app)
        .post('/v1/api-catalogue/groups')
        .send({ name: 'Auth API', description: 'Authentication' });
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Auth API');
    });

    it('should return 400 for missing name', async () => {
      const res = await request(app).post('/v1/api-catalogue/groups').send({});
      expect(res.status).toBe(400);
    });

    it('should return 409 for duplicate name', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });
      const res = await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });
      expect(res.status).toBe(409);
    });

    it('should list groups with endpoint counts', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'G1' });
      seedEndpoint(db, 'GET', 'api.example.com', '/a');
      await request(app).patch('/v1/api-catalogue/endpoints/1').send({ groupId: 1 });

      const res = await request(app).get('/v1/api-catalogue/groups');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].endpointCount).toBe(1);
    });

    it('should update a group', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Old' });

      const res = await request(app).put('/v1/api-catalogue/groups/1').send({ name: 'New' });
      expect(res.status).toBe(200);
    });

    it('should delete a group', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });

      const res = await request(app).delete('/v1/api-catalogue/groups/1');
      expect(res.status).toBe(200);

      const list = await request(app).get('/v1/api-catalogue/groups');
      expect(list.body.data).toHaveLength(0);
    });

    it('should bulk assign hostname', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Example' });
      seedEndpoint(db, 'GET', 'api.example.com', '/a');
      seedEndpoint(db, 'POST', 'api.example.com', '/b');
      seedEndpoint(db, 'GET', 'other.com', '/c');

      const res = await request(app)
        .post('/v1/api-catalogue/groups/1/assign-hostname')
        .send({ hostname: 'api.example.com' });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
    });
  });

  describe('GET /v1/api-catalogue/hostnames', () => {
    it('should return distinct hostnames', async () => {
      seedEndpoint(db, 'GET', 'api.example.com', '/a');
      seedEndpoint(db, 'GET', 'other.com', '/b');

      const res = await request(app).get('/v1/api-catalogue/hostnames');
      expect(res.status).toBe(200);
      expect(res.body.data).toContain('api.example.com');
      expect(res.body.data).toContain('other.com');
    });
  });

  describe('Pattern endpoints', () => {
    it('should add a pattern to a group', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });

      const res = await request(app)
        .post('/v1/api-catalogue/groups/1/patterns')
        .send({ pattern: '*.example.com', patternType: 'wildcard' });
      expect(res.status).toBe(201);
      expect(res.body.data.pattern).toBe('*.example.com');
      expect(res.body.data.patternType).toBe('wildcard');
    });

    it('should list patterns for a group', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });
      await request(app).post('/v1/api-catalogue/groups/1/patterns').send({ pattern: 'a.com' });
      await request(app).post('/v1/api-catalogue/groups/1/patterns').send({ pattern: 'b.com' });

      const res = await request(app).get('/v1/api-catalogue/groups/1/patterns');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('should delete a pattern', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });
      await request(app).post('/v1/api-catalogue/groups/1/patterns').send({ pattern: 'a.com' });

      const res = await request(app).delete('/v1/api-catalogue/groups/1/patterns/1');
      expect(res.status).toBe(200);

      const list = await request(app).get('/v1/api-catalogue/groups/1/patterns');
      expect(list.body.data).toHaveLength(0);
    });

    it('should return 400 for invalid regex', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });

      const res = await request(app)
        .post('/v1/api-catalogue/groups/1/patterns')
        .send({ pattern: '[invalid', patternType: 'regex' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid regex');
    });

    it('should return 409 for duplicate pattern', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });
      await request(app).post('/v1/api-catalogue/groups/1/patterns').send({ pattern: 'a.com' });

      const res = await request(app)
        .post('/v1/api-catalogue/groups/1/patterns')
        .send({ pattern: 'a.com' });
      expect(res.status).toBe(409);
    });

    it('should apply patterns to ungrouped endpoints', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });
      await request(app).post('/v1/api-catalogue/groups/1/patterns').send({ pattern: '*.example.com', patternType: 'wildcard' });

      seedEndpoint(db, 'GET', 'api.example.com', '/a');
      seedEndpoint(db, 'GET', 'other.com', '/b');

      const res = await request(app).post('/v1/api-catalogue/groups/1/apply-patterns');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });

    it('should include patterns in group list', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });
      await request(app).post('/v1/api-catalogue/groups/1/patterns').send({ pattern: 'a.com' });

      const res = await request(app).get('/v1/api-catalogue/groups');
      expect(res.body.data[0].patterns).toHaveLength(1);
      expect(res.body.data[0].patterns[0].pattern).toBe('a.com');
    });

    it('should return 400 for invalid patternType', async () => {
      await request(app).post('/v1/api-catalogue/groups').send({ name: 'Test' });

      const res = await request(app)
        .post('/v1/api-catalogue/groups/1/patterns')
        .send({ pattern: 'a.com', patternType: 'invalid' });
      expect(res.status).toBe(400);
    });
  });
});
