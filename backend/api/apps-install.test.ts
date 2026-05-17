import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAppEndpoints } from './apps';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  const mockStatSync = vi.fn(() => ({ size: 12345, isDirectory: () => false }));
  return {
    ...original,
    default: { ...original, existsSync: vi.fn(() => true), statSync: mockStatSync },
    existsSync: vi.fn(() => true),
    statSync: mockStatSync,
  };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    promisify: (fn: any) => vi.fn().mockResolvedValue({ stdout: 'Success', stderr: '' }),
  };
});

function createMockDeviceManager(): any {
  return {
    isOnline: vi.fn().mockReturnValue(true),
    getDevice: vi.fn(),
    markBusy: vi.fn(),
    markIdle: vi.fn(),
  };
}

describe('APK Install Endpoint', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    clearEndpoints();
    const dm = createMockDeviceManager();
    registerAppEndpoints(dm, db as any);
    app = express();
    app.use(express.json());
    app.use(getApiRouter());
  });

  it('POST /v1/apps/install/:deviceId requires apkVersionId', async () => {
    const res = await request(app)
      .post('/v1/apps/install/device123')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('apkVersionId');
  });

  it('POST /v1/apps/install/:deviceId returns 404 for unknown version', async () => {
    const res = await request(app)
      .post('/v1/apps/install/device123')
      .send({ apkVersionId: 999 });

    expect(res.status).toBe(404);
  });

  it('POST /v1/apps/install/:deviceId returns success for valid version', async () => {
    // Insert tracked app + version
    db.insert(schema.trackedApps).values({
      packageName: 'com.test.app',
      appName: 'Test App',
      createdAt: new Date(),
    }).run();
    const tracked = db.select().from(schema.trackedApps).all()[0];
    db.insert(schema.apkVersions).values({
      trackedAppId: tracked.id,
      versionCode: 100,
      versionName: '1.0.0',
      filename: '100_1.0.0.apk',
      downloadedAt: new Date(),
    }).run();
    const version = db.select().from(schema.apkVersions).all()[0];

    const res = await request(app)
      .post('/v1/apps/install/device123')
      .send({ apkVersionId: version.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.packageName).toBe('com.test.app');
    expect(res.body.data.versionCode).toBe(100);
  });
});
