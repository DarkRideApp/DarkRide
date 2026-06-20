import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAppEndpoints } from './apps';
import { SourceRegistry } from '../services/apk-sources/registry';
import type { RemoteApkSource } from '../services/apk-sources/types';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../services/device-manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/device-manager')>();
  return { ...original, adbShell: vi.fn(), adbCommand: vi.fn(), adbPull: vi.fn() };
});
vi.mock('../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));

const { appSources } = schema;

function fakeSource(id: string, defaultEnabled: boolean): RemoteApkSource {
  return {
    id, label: id,
    isConfigured: () => true,
    defaultEnabled: () => defaultEnabled,
    checkVersion: vi.fn(async () => ({ versionName: '1.0.0' })),
    downloadApk: vi.fn(async () => ({ success: false })),
  };
}

function buildHarness() {
  clearEndpoints();
  const db = createTestDb() as unknown as BetterSQLite3Database<typeof schema>;
  const registry = new SourceRegistry()
    .register(fakeSource('playstore', true))
    .register(fakeSource('qq', false));
  const apkTracker = { checkRemoteSource: vi.fn(async () => ({ newVersionId: 42 })) } as any;
  const deviceManager = { getAllDeviceStatuses: vi.fn(async () => []) } as any;

  registerAppEndpoints(deviceManager, db as any, apkTracker, undefined, undefined, undefined, registry);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return { app, db, apkTracker };
}

describe('Apps source-config API', () => {
  let h: ReturnType<typeof buildHarness>;
  beforeEach(() => { h = buildHarness(); });

  async function trackApp(packageName = 'com.example.app') {
    const res = await request(h.app).post('/v1/apps/track').send({ packageName });
    return res.body.data.id as number;
  }

  it('seeds app_sources rows with registry defaults on track', async () => {
    const id = await trackApp();
    const rows = h.db.select().from(appSources).all().filter(r => r.trackedAppId === id);
    expect(rows.map(r => [r.source, !!r.enabled]).sort()).toEqual([['playstore', true], ['qq', false]]);
  });

  it('lists sources with labels in registry order', async () => {
    const id = await trackApp();
    const res = await request(h.app).get(`/v1/apps/track/${id}/sources`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: any) => s.source)).toEqual(['playstore', 'qq']);
    expect(res.body.data[1]).toMatchObject({ source: 'qq', enabled: false, lastVersion: null });
  });

  it('toggles a source enabled flag', async () => {
    const id = await trackApp();
    const res = await request(h.app).patch(`/v1/apps/track/${id}/sources/qq`).send({ enabled: true });
    expect(res.status).toBe(200);
    const row = h.db.select().from(appSources).all().find(r => r.trackedAppId === id && r.source === 'qq');
    expect(row?.enabled).toBe(true);
  });

  it('rejects an unknown source', async () => {
    const id = await trackApp();
    const res = await request(h.app).patch(`/v1/apps/track/${id}/sources/nope`).send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it('back-compat: PATCH autoFetchPlayStore routes to the playstore source row', async () => {
    const id = await trackApp();
    await request(h.app).patch(`/v1/apps/track/${id}`).send({ autoFetchPlayStore: false });
    const row = h.db.select().from(appSources).all().find(r => r.trackedAppId === id && r.source === 'playstore');
    expect(row?.enabled).toBe(false);
  });

  it('fetch-now drives the tracker with force=true and returns the new versionId', async () => {
    const id = await trackApp();
    const res = await request(h.app).post(`/v1/apps/track/${id}/sources/qq/fetch`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.newVersionId).toBe(42);
    expect(h.apkTracker.checkRemoteSource).toHaveBeenCalledWith(
      expect.objectContaining({ id, packageName: 'com.example.app' }),
      expect.objectContaining({ id: 'qq' }),
      { force: true },
    );
  });

  it('fetch-now 404s for an unknown app', async () => {
    const res = await request(h.app).post('/v1/apps/track/9999/sources/qq/fetch').send({});
    expect(res.status).toBe(404);
  });

  it('GET and PATCH /sources 404 for an unknown app (no orphan rows)', async () => {
    const get = await request(h.app).get('/v1/apps/track/9999/sources');
    expect(get.status).toBe(404);
    const patch = await request(h.app).patch('/v1/apps/track/9999/sources/qq').send({ enabled: true });
    expect(patch.status).toBe(404);
    expect(h.db.select().from(appSources).all().filter(r => r.trackedAppId === 9999)).toHaveLength(0);
  });

  it('rejects an invalid packageName on track', async () => {
    const res = await request(h.app).post('/v1/apps/track').send({ packageName: '../../etc/passwd' });
    expect(res.status).toBe(400);
  });

  it('fetch-now returns 502 (not success) when the download fails', async () => {
    const id = await trackApp();
    h.apkTracker.checkRemoteSource.mockResolvedValueOnce({ newVersionId: null, error: 'sha256 mismatch' });
    const res = await request(h.app).post(`/v1/apps/track/${id}/sources/qq/fetch`).send({});
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/sha256/);
  });

  it('fetch-now reports outcome "not-found" when the app is not on the store', async () => {
    const id = await trackApp();
    h.apkTracker.checkRemoteSource.mockResolvedValueOnce({ newVersionId: null, notFound: true });
    const res = await request(h.app).post(`/v1/apps/track/${id}/sources/qq/fetch`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('not-found');
  });

  it('coalesces concurrent fetch-now triggers into a single download', async () => {
    const id = await trackApp();
    let resolveFn: (v: any) => void = () => {};
    h.apkTracker.checkRemoteSource.mockReturnValue(new Promise(r => { resolveFn = r; }));
    // .then() forces supertest to dispatch the request eagerly (it's otherwise
    // lazy), so both handlers reach the in-flight guard before we resolve.
    const p1 = request(h.app).post(`/v1/apps/track/${id}/sources/qq/fetch`).send({}).then(r => r);
    const p2 = request(h.app).post(`/v1/apps/track/${id}/sources/qq/fetch`).send({}).then(r => r);
    await new Promise(r => setTimeout(r, 40)); // let both reach the handler + park on the shared promise
    resolveFn({ newVersionId: 7 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(h.apkTracker.checkRemoteSource).toHaveBeenCalledTimes(1);
  });
});
