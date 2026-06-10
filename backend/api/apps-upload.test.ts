import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { trackedApps, apkVersions } from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { createTestDb } from '../test-utils/create-test-db';
import { registerAppsUploadEndpoint } from './apps-upload';

vi.mock('../websocket/index', () => ({ broadcastToAll: vi.fn() }));
import { broadcastToAll } from '../websocket/index';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function makeApp(db: BetterSQLite3Database<typeof schema>, opts: {
  meta?: { packageName: string; versionCode: number; versionName: string | null };
  metaError?: string;
  enqueue?: ReturnType<typeof vi.fn>;
  apkDir?: string;
  /** When set, an upstream middleware attaches req.authUser with these scopes. */
  authScopes?: string[];
} = {}) {
  clearEndpoints();
  const extractor = opts.metaError
    ? vi.fn().mockRejectedValue(new Error(opts.metaError))
    : vi.fn().mockResolvedValue(opts.meta ?? { packageName: 'com.up.app', versionCode: 7, versionName: '7.0' });
  const analyzer = { enqueue: opts.enqueue ?? vi.fn().mockResolvedValue(1) };
  const apkDir = opts.apkDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'apk-upload-test-'));
  registerAppsUploadEndpoint(db as any, analyzer as any, { extractor, apkDir });
  const app = express();
  app.use(express.json());
  if (opts.authScopes) {
    app.use((req, _res, next) => { (req as any).authUser = { effectiveScopes: opts.authScopes }; next(); });
  }
  app.use(getApiRouter());
  return { app, extractor, analyzer, apkDir };
}

const APK_BYTES = Buffer.from('PK\x03\x04fakeapk');

describe('POST /v1/apps/upload', () => {
  let db: BetterSQLite3Database<typeof schema>;
  beforeEach(() => { db = createTestDb(); vi.mocked(broadcastToAll).mockClear(); });

  it('uploads, creates tracked app + version, stores file, enqueues analysis', async () => {
    const { app, analyzer, apkDir } = makeApp(db);
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'my-app.apk');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.packageName).toBe('com.up.app');
    const apps = db.select().from(trackedApps).all();
    expect(apps).toHaveLength(1);
    const versions = db.select().from(apkVersions).all();
    expect(versions).toHaveLength(1);
    expect(versions[0].source).toBe('upload');
    expect(versions[0].versionCode).toBe(7);
    expect(versions[0].filename).toBe('7_7.0.apk');
    expect(fs.existsSync(path.join(apkDir, 'com.up.app', '7_7.0.apk'))).toBe(true);
    expect(analyzer.enqueue).toHaveBeenCalledWith(versions[0].id);
    expect(vi.mocked(broadcastToAll)).toHaveBeenCalledWith(expect.objectContaining({
      type: 'apk:version-pulled', packageName: 'com.up.app', versionCode: 7, source: 'upload',
    }));
  });

  it('reuses an existing tracked app', async () => {
    db.insert(trackedApps).values({ packageName: 'com.up.app', appName: 'Existing', createdAt: new Date() }).run();
    const { app } = makeApp(db);
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'x.apk');
    expect(res.status).toBe(200);
    expect(db.select().from(trackedApps).all()).toHaveLength(1);
  });

  it('409s on duplicate package+versionCode', async () => {
    const { app } = makeApp(db);
    await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'x.apk');
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'x.apk');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
    expect(db.select().from(apkVersions).all()).toHaveLength(1);
  });

  it('400s when metadata extraction fails', async () => {
    const { app } = makeApp(db, { metaError: 'Could not read APK: Not an APK' });
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'x.apk');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Not an APK/);
    expect(db.select().from(apkVersions).all()).toHaveLength(0);
  });

  it('400s when no file is attached', async () => {
    const { app } = makeApp(db);
    const res = await request(app).post('/v1/apps/upload').send();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file/i);
  });

  it('400s on non-.apk filename', async () => {
    const { app } = makeApp(db);
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'archive.zip');
    expect(res.status).toBe(400);
  });

  it('allows an authenticated user with core.apk:manage', async () => {
    const { app } = makeApp(db, { authScopes: ['core.apk:manage'] });
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'x.apk');
    expect(res.status).toBe(200);
  });

  it('403s and cleans up the temp file when the user lacks core.apk:manage', async () => {
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink');
    const { app, extractor } = makeApp(db, { authScopes: ['core.apk:read'] });
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'x.apk');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
    // No work performed past the gate…
    expect(extractor).not.toHaveBeenCalled();
    expect(db.select().from(apkVersions).all()).toHaveLength(0);
    // …and multer's temp file was removed.
    expect(unlinkSpy).toHaveBeenCalled();
    unlinkSpy.mockRestore();
  });

  it('removes the copied APK from disk if the DB insert fails', async () => {
    const apkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-upload-orphan-'));
    // Pre-create the tracked app so the handler skips the trackedApps insert and
    // the FIRST (mocked) db.insert is the apkVersions insert — which runs AFTER
    // the file copy, so we genuinely exercise the orphan-cleanup path.
    db.insert(trackedApps).values({ packageName: 'com.up.app', appName: null, createdAt: new Date() }).run();
    const { app } = makeApp(db, { apkDir });
    const copySpy = vi.spyOn(fs.promises, 'copyFile');
    const insertSpy = vi.spyOn(db, 'insert').mockImplementationOnce(() => { throw new Error('disk full'); });
    const res = await request(app).post('/v1/apps/upload').attach('apk', APK_BYTES, 'x.apk');
    expect(res.status).toBe(500);
    // The file was actually copied (so we reached the insert) …
    expect(copySpy).toHaveBeenCalled();
    // … and then cleaned up — no orphan left in the package directory.
    const pkgDir = path.join(apkDir, 'com.up.app');
    const leftover = fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir) : [];
    expect(leftover).toHaveLength(0);
    insertSpy.mockRestore();
    copySpy.mockRestore();
  });
});
