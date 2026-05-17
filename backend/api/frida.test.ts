import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerFridaEndpoints } from './frida';
import { createTestDb } from '../test-utils/create-test-db';

function createApp(db: BetterSQLite3Database<typeof schema>, releaseManager?: any) {
  clearEndpoints();
  const mockBridgeManager = {} as any;
  registerFridaEndpoints(db as any, releaseManager ?? (null as any), mockBridgeManager);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Frida API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('Script CRUD', () => {
    describe('POST /v1/frida/scripts', () => {
      it('should create a script with name and code', async () => {
        const res = await request(app)
          .post('/v1/frida/scripts')
          .send({ name: 'SSL Bypass', code: 'Java.perform(function() {})' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('SSL Bypass');
        expect(res.body.data.code).toBe('Java.perform(function() {})');
        expect(res.body.data.id).toBeDefined();
      });

      it('should create a script with all fields', async () => {
        const res = await request(app)
          .post('/v1/frida/scripts')
          .send({
            name: 'Root Detection Bypass',
            code: 'Java.perform(...)',
            targetApp: 'com.example.app',
            description: 'Bypasses root detection checks',
          });

        expect(res.status).toBe(200);
        expect(res.body.data.targetApp).toBe('com.example.app');
        expect(res.body.data.description).toBe('Bypasses root detection checks');
      });

      it('should return 400 when name is missing', async () => {
        const res = await request(app)
          .post('/v1/frida/scripts')
          .send({ code: 'some code' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('name and code are required');
      });

      it('should return 400 when code is missing', async () => {
        const res = await request(app)
          .post('/v1/frida/scripts')
          .send({ name: 'test' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('name and code are required');
      });
    });

    describe('GET /v1/frida/scripts', () => {
      it('should return empty array when no scripts exist', async () => {
        const res = await request(app).get('/v1/frida/scripts');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual([]);
      });

      it('should list all scripts', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values([
          { name: 'script-a', code: 'code-a', targetApp: 'com.a', createdAt: now, updatedAt: now },
          { name: 'script-b', code: 'code-b', targetApp: 'com.b', createdAt: now, updatedAt: now },
        ]).run();

        const res = await request(app).get('/v1/frida/scripts');

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
      });

      it('should filter by targetApp query param', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values([
          { name: 'a', code: 'c', targetApp: 'com.target', createdAt: now, updatedAt: now },
          { name: 'b', code: 'c', targetApp: 'com.other', createdAt: now, updatedAt: now },
        ]).run();

        const res = await request(app).get('/v1/frida/scripts?targetApp=com.target');

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].name).toBe('a');
      });
    });

    describe('GET /v1/frida/scripts/:id', () => {
      it('should return a script by id', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values({ name: 'test', code: 'code', createdAt: now, updatedAt: now }).run();
        const script = db.select().from(schema.fridaScripts).all()[0];

        const res = await request(app).get(`/v1/frida/scripts/${script.id}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('test');
      });

      it('should return 404 for non-existent script', async () => {
        const res = await request(app).get('/v1/frida/scripts/999');

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('Script not found');
      });
    });

    describe('PUT /v1/frida/scripts/:id', () => {
      it('should update a script', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values({ name: 'old', code: 'old code', createdAt: now, updatedAt: now }).run();
        const script = db.select().from(schema.fridaScripts).all()[0];

        const res = await request(app)
          .put(`/v1/frida/scripts/${script.id}`)
          .send({ name: 'new', code: 'new code' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('new');
        expect(res.body.data.code).toBe('new code');
      });

      it('should partially update a script', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values({ name: 'original', code: 'original code', createdAt: now, updatedAt: now }).run();
        const script = db.select().from(schema.fridaScripts).all()[0];

        const res = await request(app)
          .put(`/v1/frida/scripts/${script.id}`)
          .send({ name: 'updated name' });

        expect(res.status).toBe(200);
        expect(res.body.data.name).toBe('updated name');
        expect(res.body.data.code).toBe('original code');
      });

      it('should return 404 for non-existent script', async () => {
        const res = await request(app)
          .put('/v1/frida/scripts/999')
          .send({ name: 'nope' });

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
      });
    });

    describe('DELETE /v1/frida/scripts/:id', () => {
      it('should delete a script', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values({ name: 'temp', code: 'code', createdAt: now, updatedAt: now }).run();
        const script = db.select().from(schema.fridaScripts).all()[0];

        const res = await request(app).delete(`/v1/frida/scripts/${script.id}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.select().from(schema.fridaScripts).all()).toHaveLength(0);
      });

      it('should succeed even if script does not exist', async () => {
        const res = await request(app).delete('/v1/frida/scripts/999');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('should return 400 when deleting a builtin script', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values({
          name: 'Builtin Script',
          code: 'code',
          isBuiltin: true,
          category: 'utility',
          createdAt: now,
          updatedAt: now,
        }).run();
        const script = db.select().from(schema.fridaScripts).all()[0];

        const res = await request(app).delete(`/v1/frida/scripts/${script.id}`);

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('builtin');
      });
    });

    describe('POST /v1/frida/scripts (with category)', () => {
      it('should accept category field', async () => {
        const res = await request(app)
          .post('/v1/frida/scripts')
          .send({ name: 'Test', code: 'code', category: 'utility' });

        expect(res.status).toBe(200);
        expect(res.body.data.category).toBe('utility');
      });
    });

    describe('GET /v1/frida/scripts/categories', () => {
      it('should return empty object when no builtin scripts exist', async () => {
        const res = await request(app).get('/v1/frida/scripts/categories');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual({});
      });

      it('should return category counts for builtin scripts', async () => {
        const now = new Date();
        db.insert(schema.fridaScripts).values([
          { name: 'a', code: 'c', category: 'utility', isBuiltin: true, createdAt: now, updatedAt: now },
          { name: 'b', code: 'c', category: 'utility', isBuiltin: true, createdAt: now, updatedAt: now },
          { name: 'c', code: 'c', category: 'cert-pinning', isBuiltin: true, createdAt: now, updatedAt: now },
          { name: 'd', code: 'c', category: 'utility', isBuiltin: false, createdAt: now, updatedAt: now },
        ]).run();

        const res = await request(app).get('/v1/frida/scripts/categories');

        expect(res.body.data['utility'].count).toBe(2);
        expect(res.body.data['utility'].label).toBe('Utility');
        expect(res.body.data['cert-pinning'].count).toBe(1);
        expect(res.body.data['cert-pinning'].label).toBe('Certificate Pinning');
        // Non-builtin should not be counted
        expect(Object.values(res.body.data).reduce((a: number, b: any) => a + b.count, 0)).toBe(3);
      });
    });

    describe('POST /v1/frida/scripts/reseed', () => {
      it('should seed library scripts and return all scripts', async () => {
        const res = await request(app).post('/v1/frida/scripts/reseed');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.length).toBeGreaterThanOrEqual(25);
      });
    });
  });

  describe('Releases', () => {
    describe('GET /v1/frida/releases', () => {
      it('should return empty array when no releases exist', async () => {
        const res = await request(app).get('/v1/frida/releases');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual([]);
      });

      it('should list all releases', async () => {
        db.insert(schema.fridaReleases).values({ version: '16.7.19', downloadUrl: 'https://github.com/frida/frida/releases/download/16.7.19/frida-server-16.7.19-android-arm64.xz', isDownloaded: false }).run();
        db.insert(schema.fridaReleases).values({ version: '16.7.18', downloadUrl: 'https://github.com/frida/frida/releases/download/16.7.18/frida-server-16.7.18-android-arm64.xz', isDownloaded: true }).run();

        const res = await request(app).get('/v1/frida/releases');

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0].version).toBe('16.7.18');
        expect(res.body.data[1].version).toBe('16.7.19');
      });
    });

    describe('POST /v1/frida/releases/sync', () => {
      it('should call releaseManager.syncReleases and return releases', async () => {
        const mockReleaseManager = {
          syncReleases: async () => {
            db.insert(schema.fridaReleases).values({ version: '16.8.0', downloadUrl: 'https://example.com/frida.xz', isDownloaded: false }).run();
          },
        };
        const appWithManager = createApp(db, mockReleaseManager);

        const res = await request(appWithManager).post('/v1/frida/releases/sync');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].version).toBe('16.8.0');
      });
    });

    describe('POST /v1/frida/releases/:version/download', () => {
      it('should call releaseManager.downloadVersion and return path', async () => {
        const mockReleaseManager = {
          downloadVersion: async (version: string) => `/data/frida-server/${version}/frida-server-arm64`,
        };
        const appWithManager = createApp(db, mockReleaseManager);

        const res = await request(appWithManager).post('/v1/frida/releases/16.7.19/download');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.version).toBe('16.7.19');
        expect(res.body.data.path).toBe('/data/frida-server/16.7.19/frida-server-arm64');
      });

      it('should return 400 when download fails', async () => {
        const mockReleaseManager = {
          downloadVersion: async () => { throw new Error('Unknown Frida version: 99.99.99'); },
        };
        const appWithManager = createApp(db, mockReleaseManager);

        const res = await request(appWithManager).post('/v1/frida/releases/99.99.99/download');

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Unknown Frida version');
      });
    });

    describe('DELETE /v1/frida/releases/:version', () => {
      it('should call releaseManager.deleteVersion', async () => {
        let deletedVersion: string | null = null;
        const mockReleaseManager = {
          deleteVersion: (version: string) => { deletedVersion = version; },
        };
        const appWithManager = createApp(db, mockReleaseManager);

        const res = await request(appWithManager).delete('/v1/frida/releases/16.7.19');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(deletedVersion).toBe('16.7.19');
      });
    });
  });
});
