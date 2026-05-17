import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerApkAvailabilityEndpoints } from './apk-availability';
import { ApkRestoreService, RestoreLostError } from '../services/apk-restore-service';
import { applyMigrations } from '../test-utils/create-test-db';
import * as schema from '../db/schema';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// ── Seed helpers ──────────────────────────────────────────────────────────────

function makeDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function seedVersion(
  db: BetterSQLite3Database<typeof schema>,
  packageName: string,
  versionCode: number,
  filename: string,
): number {
  const now = new Date();
  const app = db.insert(schema.trackedApps).values({
    packageName,
    appName: packageName,
    createdAt: now,
  } as any).returning({ id: schema.trackedApps.id }).get();
  const version = db.insert(schema.apkVersions).values({
    trackedAppId: app.id,
    versionCode,
    filename,
    source: 'upload',
    downloadedAt: now,
  } as any).returning({ id: schema.apkVersions.id }).get();
  return version.id;
}

function seedCloudFile(
  db: BetterSQLite3Database<typeof schema>,
  cloudKey: string,
  opts: { localPath: string | null; syncState: 'pending_upload' | 'synced' | 'cloud_only' },
) {
  const now = new Date();
  db.insert(schema.cloudFiles).values({
    namespace: 'apks',
    relativePath: cloudKey.slice('apks/'.length),
    cloudKey,
    localPath: opts.localPath ?? '',
    fileType: 'apk',
    fileSize: 1024,
    syncState: opts.syncState,
    retain: false,
    lastAccessed: now,
    createdAt: now,
  } as any).run();
}

// ── Test app factory ──────────────────────────────────────────────────────────

function createApp(
  db: BetterSQLite3Database<typeof schema>,
  restoreService: ApkRestoreService,
  scopes: string[] = ['core.apk:read', 'core.apk:manage'],
) {
  clearEndpoints();
  registerApkAvailabilityEndpoints(db as any, restoreService);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).authUser = {
      userId: 1,
      effectiveScopes: new Set(scopes),
    };
    next();
  });
  app.use(getApiRouter());
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('APK availability API', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let versionId: number;
  let fileSync: any;
  let apkAnalyzer: any;
  let restoreService: ApkRestoreService;
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();

    db = makeDb();
    versionId = seedVersion(db, 'com.foo', 100, '1.apk');

    fileSync = { acquireLocal: vi.fn().mockResolvedValue({ path: '/tmp/downloaded' }) };
    apkAnalyzer = { enqueue: vi.fn().mockResolvedValue(42) };
    restoreService = new ApkRestoreService({ db: db as any, fileSync, apkAnalyzer });

    app = createApp(db, restoreService);
  });

  // ── GET /availability ──────────────────────────────────────────────────────

  it('GET availability returns cloud state shape with correct fields', async () => {
    // All three artifacts are cloud_only → state should be "cloud"
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: null, syncState: 'cloud_only' });

    const res = await request(app).get(`/v1/apks/com.foo/${versionId}/availability`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'cloud',
      canRestoreFromCloud: true,
      canReanalyze: false,
      apk: { localPresent: false, cloudSynced: true },
      sourceDb: { localPresent: false, cloudSynced: true },
      metadata: { localPresent: false, cloudSynced: true },
    });
  });

  it('GET availability returns 404 for unknown versionId', async () => {
    const res = await request(app).get('/v1/apks/com.foo/99999/availability');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/version not found/i);
  });

  // ── POST /restore ──────────────────────────────────────────────────────────

  it('POST restore returns { kind: downloaded, artifacts: 3 } for cloud state', async () => {
    // Cloud state: all artifacts cloud_only
    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: null, syncState: 'cloud_only' });

    const res = await request(app).post(`/v1/apks/com.foo/${versionId}/restore`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'downloaded', artifacts: 3 });
    // fileSync.acquireLocal must have been called 3 times (one per artifact)
    expect(fileSync.acquireLocal).toHaveBeenCalledTimes(3);
    expect(fileSync.acquireLocal).toHaveBeenCalledWith(
      'apks/com.foo/1.apk',
      expect.any(String),
      expect.any(String),
    );
  });

  it('POST restore returns 409 for lost state (RestoreLostError)', async () => {
    // No cloud files seeded → lost state → service throws RestoreLostError
    const res = await request(app).post(`/v1/apks/com.foo/${versionId}/restore`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no cloud copy/i);
  });

  // ── Permission checks ──────────────────────────────────────────────────────

  it('GET availability returns 403 without core.apk:read scope', async () => {
    // Build an app that injects no scopes
    const restrictedApp = createApp(db, restoreService, []);

    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: null, syncState: 'cloud_only' });

    const res = await request(restrictedApp).get(`/v1/apks/com.foo/${versionId}/availability`);
    expect(res.status).toBe(403);
  });

  it('POST restore returns 403 without core.apk:manage scope', async () => {
    // App with only read scope, not manage
    const readOnlyApp = createApp(db, restoreService, ['core.apk:read']);

    seedCloudFile(db, 'apks/com.foo/1.apk', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/source.db', { localPath: null, syncState: 'cloud_only' });
    seedCloudFile(db, 'apks/com.foo/analysis/100/metadata.json', { localPath: null, syncState: 'cloud_only' });

    const res = await request(readOnlyApp).post(`/v1/apks/com.foo/${versionId}/restore`);
    expect(res.status).toBe(403);
  });
});
