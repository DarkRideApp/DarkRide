import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerInterceptRuleEndpoints } from './intercept-rules';
import { createTestDb } from '../test-utils/create-test-db';

const mockBroadcast = vi.fn();

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerInterceptRuleEndpoints(db as any, mockBroadcast);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Intercept Rules API', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    mockBroadcast.mockClear();
    app = createApp(db);
  });

  describe('GET /v1/intercept/rules', () => {
    it('should return empty array when no rules exist', async () => {
      const res = await request(app).get('/v1/intercept/rules');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return rules ordered by priority ASC', async () => {
      const now = new Date();
      db.insert(schema.interceptRules).values({
        name: 'Low Priority',
        matchHostname: 'api.example.com',
        phase: 'response',
        actions: '[]',
        priority: 10,
        createdAt: now,
        updatedAt: now,
      }).run();
      db.insert(schema.interceptRules).values({
        name: 'High Priority',
        matchHostname: 'api.example.com',
        phase: 'request',
        actions: '[]',
        priority: 1,
        createdAt: now,
        updatedAt: now,
      }).run();

      const res = await request(app).get('/v1/intercept/rules');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].name).toBe('High Priority');
      expect(res.body.data[1].name).toBe('Low Priority');
    });
  });

  describe('POST /v1/intercept/rules', () => {
    it('should create a rule with all fields', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Force Admin Mode',
          matchHostname: '*.example.com',
          matchPath: '/v2/user/*',
          matchMethod: 'POST',
          phase: 'response',
          actions: [{ type: 'json-patch', path: '$.data.isAdmin', value: true }],
          deviceFilter: null,
          priority: 0,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Force Admin Mode');
      expect(res.body.data.matchHostname).toBe('*.example.com');
      expect(res.body.data.matchPath).toBe('/v2/user/*');
      expect(res.body.data.matchMethod).toBe('POST');
      expect(res.body.data.phase).toBe('response');
      expect(res.body.data.priority).toBe(0);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.createdAt).toBeDefined();
      expect(res.body.data.updatedAt).toBeDefined();
    });

    it('should accept actions as a JSON string', async () => {
      const actions = JSON.stringify([{ type: 'json-patch', path: '$.ok', value: true }]);
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Test',
          matchHostname: 'api.example.com',
          phase: 'request',
          actions,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.actions).toBe(actions);
    });

    it('should accept actions as an empty array', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Empty Actions',
          matchHostname: 'api.example.com',
          phase: 'request',
          actions: [],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.actions).toBe('[]');
    });

    it('should default enabled to true', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Test Rule',
          matchHostname: 'api.example.com',
          phase: 'request',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.enabled).toBe(true);
    });

    it('should broadcast intercept-rules-changed after creation', async () => {
      await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Test',
          matchHostname: 'api.example.com',
          phase: 'request',
        });

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'intercept-rules-changed' });
    });

    it('should return 400 if name is missing', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({ matchHostname: 'api.example.com', phase: 'request' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 if name is empty string', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({ name: '   ', matchHostname: 'api.example.com', phase: 'request' });

      expect(res.status).toBe(400);
    });

    it('should return 400 if matchHostname is missing', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({ name: 'Test', phase: 'request' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for invalid phase', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({ name: 'Test', matchHostname: 'api.example.com', phase: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for invalid actions JSON string', async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Test',
          matchHostname: 'api.example.com',
          phase: 'request',
          actions: 'not-json',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /v1/intercept/rules/:id', () => {
    let ruleId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Original Name',
          matchHostname: 'api.example.com',
          phase: 'request',
          actions: [],
          priority: 5,
        });
      ruleId = res.body.data.id;
      mockBroadcast.mockClear();
    });

    it('should update a rule', async () => {
      const res = await request(app)
        .put(`/v1/intercept/rules/${ruleId}`)
        .send({
          name: 'Updated Name',
          matchHostname: 'api.other.com',
          phase: 'response',
          priority: 10,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Updated Name');
      expect(res.body.data.matchHostname).toBe('api.other.com');
      expect(res.body.data.phase).toBe('response');
      expect(res.body.data.priority).toBe(10);
    });

    it('should update actions from array', async () => {
      const newActions = [{ type: 'json-patch', path: '$.x', value: 1 }];
      const res = await request(app)
        .put(`/v1/intercept/rules/${ruleId}`)
        .send({ actions: newActions });

      expect(res.status).toBe(200);
      expect(res.body.data.actions).toBe(JSON.stringify(newActions));
    });

    it('should broadcast intercept-rules-changed after update', async () => {
      await request(app)
        .put(`/v1/intercept/rules/${ruleId}`)
        .send({ name: 'New Name' });

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'intercept-rules-changed' });
    });

    it('should return 404 for non-existent rule', async () => {
      const res = await request(app)
        .put('/v1/intercept/rules/999')
        .send({ name: 'Nope' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app)
        .put('/v1/intercept/rules/abc')
        .send({ name: 'Nope' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid phase on update', async () => {
      const res = await request(app)
        .put(`/v1/intercept/rules/${ruleId}`)
        .send({ phase: 'invalid' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid actions on update', async () => {
      const res = await request(app)
        .put(`/v1/intercept/rules/${ruleId}`)
        .send({ actions: 'bad-json{' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /v1/intercept/rules/:id', () => {
    let ruleId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'To Delete',
          matchHostname: 'api.example.com',
          phase: 'request',
        });
      ruleId = res.body.data.id;
      mockBroadcast.mockClear();
    });

    it('should delete a rule', async () => {
      const res = await request(app).delete(`/v1/intercept/rules/${ruleId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const listRes = await request(app).get('/v1/intercept/rules');
      expect(listRes.body.data).toHaveLength(0);
    });

    it('should broadcast intercept-rules-changed after deletion', async () => {
      await request(app).delete(`/v1/intercept/rules/${ruleId}`);

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'intercept-rules-changed' });
    });

    it('should return 404 for non-existent rule', async () => {
      const res = await request(app).delete('/v1/intercept/rules/999');
      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).delete('/v1/intercept/rules/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /v1/intercept/rules/:id/toggle', () => {
    let ruleId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/v1/intercept/rules')
        .send({
          name: 'Toggleable',
          matchHostname: 'api.example.com',
          phase: 'request',
          enabled: true,
        });
      ruleId = res.body.data.id;
      mockBroadcast.mockClear();
    });

    it('should toggle enabled from true to false', async () => {
      const res = await request(app).patch(`/v1/intercept/rules/${ruleId}/toggle`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.enabled).toBe(false);
    });

    it('should toggle enabled from false to true', async () => {
      await request(app).patch(`/v1/intercept/rules/${ruleId}/toggle`);
      mockBroadcast.mockClear();

      const res = await request(app).patch(`/v1/intercept/rules/${ruleId}/toggle`);

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });

    it('should broadcast intercept-rules-changed after toggle', async () => {
      await request(app).patch(`/v1/intercept/rules/${ruleId}/toggle`);

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'intercept-rules-changed' });
    });

    it('should return 404 for non-existent rule', async () => {
      const res = await request(app).patch('/v1/intercept/rules/999/toggle');
      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).patch('/v1/intercept/rules/abc/toggle');
      expect(res.status).toBe(400);
    });
  });
});
