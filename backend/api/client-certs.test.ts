import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerClientCertEndpoints } from './client-certs';
import { createTestDb } from '../test-utils/create-test-db';

const mockBroadcast = vi.fn();

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerClientCertEndpoints(db as any, mockBroadcast);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

const VALID_CERT = '-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ==\n-----END CERTIFICATE-----';
const VALID_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAAOCAQ==\n-----END PRIVATE KEY-----';

describe('Client Certs API', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    mockBroadcast.mockClear();
    app = createApp(db);
  });

  describe('GET /v1/certs', () => {
    it('should return empty array when no certs exist', async () => {
      const res = await request(app).get('/v1/certs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return certs with hostnames parsed as array', async () => {
      db.insert(schema.clientCerts).values({
        name: 'Test Cert',
        hostnames: JSON.stringify(['api.example.com', 'cms.example.com']),
        certPem: VALID_CERT,
        keyPem: VALID_KEY,
        createdAt: new Date(),
      }).run();

      const res = await request(app).get('/v1/certs');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Test Cert');
      expect(res.body.data[0].hostnames).toEqual(['api.example.com', 'cms.example.com']);
    });
  });

  describe('POST /v1/certs', () => {
    it('should create a cert with hostnames as array', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'PortAventura',
          hostnames: ['cms-v2.adventurelabs.xyz', 'api-v2.adventurelabs.xyz'],
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('PortAventura');
      expect(res.body.data.hostnames).toEqual(['cms-v2.adventurelabs.xyz', 'api-v2.adventurelabs.xyz']);
      expect(res.body.data.certPem).toBe(VALID_CERT);
      expect(res.body.data.keyPem).toBe(VALID_KEY);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.createdAt).toBeDefined();
    });

    it('should create a cert with hostnames as comma-separated string', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'My Cert',
          hostnames: 'api.example.com, cms.example.com',
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.hostnames).toEqual(['api.example.com', 'cms.example.com']);
    });

    it('should create a cert with hostnames as JSON array string', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'My Cert',
          hostnames: '["api.example.com","cms.example.com"]',
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.hostnames).toEqual(['api.example.com', 'cms.example.com']);
    });

    it('should default enabled to true', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'My Cert',
          hostnames: ['api.example.com'],
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.enabled).toBe(true);
    });

    it('should create a cert with enabled set to false', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'My Cert',
          hostnames: ['api.example.com'],
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
          enabled: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.enabled).toBe(false);
    });

    it('should broadcast client-certs-changed after creation', async () => {
      await request(app)
        .post('/v1/certs')
        .send({
          name: 'My Cert',
          hostnames: ['api.example.com'],
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
        });

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'client-certs-changed' });
    });

    it('should return 400 if name is missing', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({ hostnames: ['api.example.com'], certPem: VALID_CERT, keyPem: VALID_KEY });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 if name is empty string', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({ name: '   ', hostnames: ['api.example.com'], certPem: VALID_CERT, keyPem: VALID_KEY });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 if hostnames is missing', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({ name: 'My Cert', certPem: VALID_CERT, keyPem: VALID_KEY });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 if certPem is missing', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({ name: 'My Cert', hostnames: ['api.example.com'], keyPem: VALID_KEY });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 if certPem is empty', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({ name: 'My Cert', hostnames: ['api.example.com'], certPem: '   ', keyPem: VALID_KEY });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 if keyPem is missing', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({ name: 'My Cert', hostnames: ['api.example.com'], certPem: VALID_CERT });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 if keyPem is empty', async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({ name: 'My Cert', hostnames: ['api.example.com'], certPem: VALID_CERT, keyPem: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('PUT /v1/certs/:id', () => {
    let certId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'Original Name',
          hostnames: ['api.example.com'],
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
        });
      certId = res.body.data.id;
      mockBroadcast.mockClear();
    });

    it('should update name', async () => {
      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Updated Name');
    });

    it('should update hostnames from array', async () => {
      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ hostnames: ['new.example.com', 'other.example.com'] });

      expect(res.status).toBe(200);
      expect(res.body.data.hostnames).toEqual(['new.example.com', 'other.example.com']);
    });

    it('should update hostnames from comma-separated string', async () => {
      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ hostnames: 'new.example.com, other.example.com' });

      expect(res.status).toBe(200);
      expect(res.body.data.hostnames).toEqual(['new.example.com', 'other.example.com']);
    });

    it('should update certPem and keyPem', async () => {
      const newCert = '-----BEGIN CERTIFICATE-----\nnew\n-----END CERTIFICATE-----';
      const newKey = '-----BEGIN PRIVATE KEY-----\nnew\n-----END PRIVATE KEY-----';

      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ certPem: newCert, keyPem: newKey });

      expect(res.status).toBe(200);
      expect(res.body.data.certPem).toBe(newCert);
      expect(res.body.data.keyPem).toBe(newKey);
    });

    it('should update enabled field', async () => {
      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
    });

    it('should broadcast client-certs-changed after update', async () => {
      await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ name: 'New Name' });

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'client-certs-changed' });
    });

    it('should return 404 for non-existent cert', async () => {
      const res = await request(app)
        .put('/v1/certs/999')
        .send({ name: 'Nope' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app)
        .put('/v1/certs/abc')
        .send({ name: 'Nope' });

      expect(res.status).toBe(400);
    });

    it('should return 400 if name is empty on update', async () => {
      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ name: '  ' });

      expect(res.status).toBe(400);
    });

    it('should return 400 if certPem is empty on update', async () => {
      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ certPem: '' });

      expect(res.status).toBe(400);
    });

    it('should return 400 if keyPem is empty on update', async () => {
      const res = await request(app)
        .put(`/v1/certs/${certId}`)
        .send({ keyPem: '   ' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /v1/certs/:id', () => {
    let certId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'To Delete',
          hostnames: ['api.example.com'],
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
        });
      certId = res.body.data.id;
      mockBroadcast.mockClear();
    });

    it('should delete a cert', async () => {
      const res = await request(app).delete(`/v1/certs/${certId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const listRes = await request(app).get('/v1/certs');
      expect(listRes.body.data).toHaveLength(0);
    });

    it('should broadcast client-certs-changed after deletion', async () => {
      await request(app).delete(`/v1/certs/${certId}`);

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'client-certs-changed' });
    });

    it('should return 404 for non-existent cert', async () => {
      const res = await request(app).delete('/v1/certs/999');
      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).delete('/v1/certs/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /v1/certs/:id/toggle', () => {
    let certId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/v1/certs')
        .send({
          name: 'Toggleable',
          hostnames: ['api.example.com'],
          certPem: VALID_CERT,
          keyPem: VALID_KEY,
          enabled: true,
        });
      certId = res.body.data.id;
      mockBroadcast.mockClear();
    });

    it('should toggle enabled from true to false', async () => {
      const res = await request(app).patch(`/v1/certs/${certId}/toggle`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.enabled).toBe(false);
    });

    it('should toggle enabled from false to true', async () => {
      await request(app).patch(`/v1/certs/${certId}/toggle`);
      mockBroadcast.mockClear();

      const res = await request(app).patch(`/v1/certs/${certId}/toggle`);

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });

    it('should broadcast client-certs-changed after toggle', async () => {
      await request(app).patch(`/v1/certs/${certId}/toggle`);

      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith({ type: 'client-certs-changed' });
    });

    it('should return 404 for non-existent cert', async () => {
      const res = await request(app).patch('/v1/certs/999/toggle');
      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).patch('/v1/certs/abc/toggle');
      expect(res.status).toBe(400);
    });
  });
});
