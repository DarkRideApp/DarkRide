import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerEndpoint, getApiRouter, clearEndpoints } from './api-service';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('API Service', () => {
  beforeEach(() => {
    clearEndpoints();
  });

  describe('registerEndpoint', () => {
    it('should create a working GET route', async () => {
      registerEndpoint('GET', '/v1/test', (_req, res) => {
        res.json({ hello: 'world' });
      });

      const app = createTestApp();
      const response = await request(app).get('/v1/test');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hello: 'world' });
    });

    it('should create a working POST route', async () => {
      registerEndpoint('POST', '/v1/items', (req, res) => {
        res.status(201).json({ id: 1, name: req.body.name });
      });

      const app = createTestApp();
      const response = await request(app)
        .post('/v1/items')
        .send({ name: 'test item' });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: 1, name: 'test item' });
    });

    it('should create a working PUT route', async () => {
      registerEndpoint('PUT', '/v1/items/:id', (req, res) => {
        res.json({ id: req.params.id, name: req.body.name });
      });

      const app = createTestApp();
      const response = await request(app)
        .put('/v1/items/42')
        .send({ name: 'updated' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: '42', name: 'updated' });
    });

    it('should create a working DELETE route', async () => {
      registerEndpoint('DELETE', '/v1/items/:id', (req, res) => {
        res.json({ deleted: req.params.id });
      });

      const app = createTestApp();
      const response = await request(app).delete('/v1/items/99');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ deleted: '99' });
    });
  });

  describe('path params', () => {
    it('should parse single path param', async () => {
      registerEndpoint('GET', '/v1/proxy/view/:id', (req, res) => {
        res.json({ proxyId: req.params.id });
      });

      const app = createTestApp();
      const response = await request(app).get('/v1/proxy/view/5');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ proxyId: '5' });
    });

    it('should parse multiple path params', async () => {
      registerEndpoint('GET', '/v1/devices/:deviceId/sessions/:sessionId', (req, res) => {
        res.json({ deviceId: req.params.deviceId, sessionId: req.params.sessionId });
      });

      const app = createTestApp();
      const response = await request(app).get('/v1/devices/DEV001/sessions/42');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ deviceId: 'DEV001', sessionId: '42' });
    });
  });

  describe('response status codes', () => {
    it('should return custom status code', async () => {
      registerEndpoint('POST', '/v1/create', (_req, res) => {
        res.status(201).json({ created: true });
      });

      const app = createTestApp();
      const response = await request(app).post('/v1/create').send({});
      expect(response.status).toBe(201);
    });

    it('should return 500 on handler error', async () => {
      registerEndpoint('GET', '/v1/error', () => {
        throw new Error('test error');
      });

      const app = createTestApp();
      const response = await request(app).get('/v1/error');
      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('test error');
    });
  });

  describe('query params', () => {
    it('should parse query parameters', async () => {
      registerEndpoint('GET', '/v1/search', (req, res) => {
        res.json({ q: req.query.q, limit: req.query.limit });
      });

      const app = createTestApp();
      const response = await request(app).get('/v1/search?q=test&limit=10');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ q: 'test', limit: '10' });
    });
  });
});
