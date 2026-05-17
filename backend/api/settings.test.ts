import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerSettingsEndpoints } from './settings';
import { createTestDb } from '../test-utils/create-test-db';

const { settings } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerSettingsEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Settings API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('PUT /v1/settings/:key', () => {
    it('should upsert a setting', async () => {
      const res = await request(app)
        .put('/v1/settings/nordvpn_username')
        .send({ value: 'myuser' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.key).toBe('nordvpn_username');
      expect(res.body.data.value).toBe('myuser');
    });

    it('should update existing setting', async () => {
      db.insert(settings).values({ key: 'nordvpn_username', value: 'old' }).run();

      const res = await request(app)
        .put('/v1/settings/nordvpn_username')
        .send({ value: 'new' });

      expect(res.status).toBe(200);
      expect(res.body.data.value).toBe('new');

      // Verify in DB
      const row = db.select().from(settings).all()[0];
      expect(row.value).toBe('new');
    });

    it('should reject unknown key', async () => {
      const res = await request(app)
        .put('/v1/settings/unknown_key')
        .send({ value: 'foo' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unknown setting key');
    });

    it('should reject missing value', async () => {
      const res = await request(app)
        .put('/v1/settings/nordvpn_username')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('value is required');
    });

    it('should accept analysis_excluded_paths key', async () => {
      const value = JSON.stringify(['com.alibaba', 'com.amazonaws', 'org.apache']);
      const res = await request(app)
        .put('/v1/settings/analysis_excluded_paths')
        .send({ value });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.key).toBe('analysis_excluded_paths');
      expect(res.body.data.value).toBe(value);
    });

    it('should mask password value in response', async () => {
      const res = await request(app)
        .put('/v1/settings/nordvpn_password')
        .send({ value: 'supersecret' });

      expect(res.status).toBe(200);
      expect(res.body.data.value).toBe('********');

      // But stored in DB as plaintext
      const row = db.select().from(settings).all()[0];
      expect(row.value).toBe('supersecret');
    });

    it('should clamp apk_local_retention_count below floor to 2 with a warning', async () => {
      const res = await request(app)
        .put('/v1/settings/apk_local_retention_count')
        .send({ value: '1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.value).toBe('2');
      expect(res.body.warning).toMatch(/clamped.*2/i);

      // Verify stored in DB as clamped value
      const row = db.select().from(settings).where(eq(settings.key, 'apk_local_retention_count')).all()[0];
      expect(row.value).toBe('2');
    });

    it('should clamp apk_local_retention_count NaN to floor with a warning', async () => {
      const res = await request(app)
        .put('/v1/settings/apk_local_retention_count')
        .send({ value: 'abc' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.value).toBe('2');
      expect(res.body.warning).toMatch(/clamped/i);

      const row = db.select().from(settings).where(eq(settings.key, 'apk_local_retention_count')).all()[0];
      expect(row.value).toBe('2');
    });

    it('should clamp negative apk_local_retention_count to floor with a warning', async () => {
      const res = await request(app)
        .put('/v1/settings/apk_local_retention_count')
        .send({ value: '-5' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.value).toBe('2');
      expect(res.body.warning).toMatch(/clamped/i);
    });

    it('should accept apk_local_retention_count >= 2 unchanged', async () => {
      const res = await request(app)
        .put('/v1/settings/apk_local_retention_count')
        .send({ value: '5' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.value).toBe('5');
      expect(res.body.warning).toBeUndefined();

      const row = db.select().from(settings).where(eq(settings.key, 'apk_local_retention_count')).all()[0];
      expect(row.value).toBe('5');
    });

    it('should accept apk_local_retention_count = 2 as floor boundary', async () => {
      const res = await request(app)
        .put('/v1/settings/apk_local_retention_count')
        .send({ value: '2' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.value).toBe('2');
      expect(res.body.warning).toBeUndefined();
    });

    it('should accept large apk_local_retention_count without clamping', async () => {
      const res = await request(app)
        .put('/v1/settings/apk_local_retention_count')
        .send({ value: '100' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.value).toBe('100');
      expect(res.body.warning).toBeUndefined();
    });
  });

  describe('GET /v1/settings/list', () => {
    it('should return empty array when no settings', async () => {
      const res = await request(app).get('/v1/settings/list');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return all settings with passwords masked', async () => {
      db.insert(settings).values({ key: 'nordvpn_username', value: 'myuser' }).run();
      db.insert(settings).values({ key: 'nordvpn_password', value: 'secret' }).run();

      const res = await request(app).get('/v1/settings/list');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);

      const userSetting = res.body.data.find((s: any) => s.key === 'nordvpn_username');
      const passSetting = res.body.data.find((s: any) => s.key === 'nordvpn_password');

      expect(userSetting.value).toBe('myuser');
      expect(passSetting.value).toBe('********');
    });
  });

  describe('GET /v1/settings/:key', () => {
    it('should return a setting by key', async () => {
      db.insert(settings).values({ key: 'nordvpn_username', value: 'testuser' }).run();

      const res = await request(app).get('/v1/settings/nordvpn_username');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.key).toBe('nordvpn_username');
      expect(res.body.data.value).toBe('testuser');
    });

    it('should return 404 for missing key', async () => {
      const res = await request(app).get('/v1/settings/nordvpn_username');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should mask password value', async () => {
      db.insert(settings).values({ key: 'nordvpn_password', value: 'topsecret' }).run();

      const res = await request(app).get('/v1/settings/nordvpn_password');

      expect(res.status).toBe(200);
      expect(res.body.data.value).toBe('********');
    });
  });

});
