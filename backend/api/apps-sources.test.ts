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
    storeUrl: (pkg: string) => `https://example.test/${id}/${pkg}`,
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
  return { app, db, apkTracker, registry };
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

  it('GET /sources includes a storeUrl deep-link per source', async () => {
    const id = await trackApp();
    const res = await request(h.app).get(`/v1/apps/track/${id}/sources`);
    expect(res.status).toBe(200);
    const qq = res.body.data.find((s: any) => s.source === 'qq');
    expect(qq.storeUrl).toBe('https://example.test/qq/com.example.app');
  });

  it('sources/check probes each source and persists availability (available + not-on-store)', async () => {
    const id = await trackApp();
    // playstore stays available (default mock); qq reports not-on-store (null).
    (h.registry.get('qq')!.checkVersion as any).mockResolvedValueOnce(null);
    const res = await request(h.app).post(`/v1/apps/track/${id}/sources/check`).send({});
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((r: any) => [r.source, r]));
    expect(byId.playstore).toMatchObject({ available: true, version: '1.0.0', error: null });
    expect(byId.qq).toMatchObject({ available: false, version: null, error: null });
    // Persisted: lastCheckedAt set for both; lastVersion only for the available one.
    const rows = h.db.select().from(appSources).all().filter(r => r.trackedAppId === id);
    const ps = rows.find(r => r.source === 'playstore');
    const qq = rows.find(r => r.source === 'qq');
    expect(ps?.lastVersion).toBe('1.0.0');
    expect(ps?.lastCheckedAt).toBeTruthy();
    expect(qq?.lastVersion).toBeNull();
    expect(qq?.lastCheckedAt).toBeTruthy();
  });

  it('sources/check records the error and reports available:null when a probe throws', async () => {
    const id = await trackApp();
    (h.registry.get('qq')!.checkVersion as any).mockRejectedValueOnce(new Error('network boom'));
    const res = await request(h.app).post(`/v1/apps/track/${id}/sources/check`).send({});
    const qq = res.body.data.find((r: any) => r.source === 'qq');
    expect(qq).toMatchObject({ available: null, error: 'network boom' });
    const row = h.db.select().from(appSources).all().find(r => r.trackedAppId === id && r.source === 'qq');
    expect(row?.lastError).toBe('network boom');
    expect(row?.lastCheckedAt).toBeTruthy();
  });

  it('sources/check 404s for an unknown app', async () => {
    const res = await request(h.app).post('/v1/apps/track/9999/sources/check').send({});
    expect(res.status).toBe(404);
  });

  it('GET /v1/apps/sources lists the registry stores with labels + defaults', async () => {
    const res = await request(h.app).get('/v1/apps/sources');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { source: 'playstore', label: 'playstore', defaultEnabled: true },
      { source: 'qq', label: 'qq', defaultEnabled: false },
    ]);
  });

  it('track applies an explicit store selection, overriding registry defaults', async () => {
    const res = await request(h.app).post('/v1/apps/track')
      .send({ packageName: 'com.example.app', sources: { playstore: false, qq: true } });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    const rows = h.db.select().from(appSources).all().filter(r => r.trackedAppId === id);
    expect(rows.map(r => [r.source, !!r.enabled]).sort()).toEqual([['playstore', false], ['qq', true]]);
  });

  it('track ignores unknown source ids in the selection (no orphan rows)', async () => {
    const res = await request(h.app).post('/v1/apps/track')
      .send({ packageName: 'com.example.app', sources: { qq: true, bogus: true } });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    const rows = h.db.select().from(appSources).all().filter(r => r.trackedAppId === id);
    expect(rows.map(r => r.source).sort()).toEqual(['playstore', 'qq']);
  });

  it('track with fetch:true force-fetches each ENABLED store and nothing else', async () => {
    await request(h.app).post('/v1/apps/track')
      .send({ packageName: 'com.example.app', sources: { playstore: false, qq: true }, fetch: true });
    expect(h.apkTracker.checkRemoteSource).toHaveBeenCalledTimes(1);
    expect(h.apkTracker.checkRemoteSource).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'com.example.app' }),
      expect.objectContaining({ id: 'qq' }),
      { force: true },
    );
  });

  it('track without fetch does NOT trigger any download', async () => {
    await request(h.app).post('/v1/apps/track')
      .send({ packageName: 'com.example.app', sources: { qq: true } });
    expect(h.apkTracker.checkRemoteSource).not.toHaveBeenCalled();
  });

  it('re-adding an existing app applies the new selection + fetch (not just first track)', async () => {
    const first = await request(h.app).post('/v1/apps/track').send({ packageName: 'com.example.app' });
    const id = first.body.data.id;
    expect(h.apkTracker.checkRemoteSource).not.toHaveBeenCalled(); // default track, no fetch
    const again = await request(h.app).post('/v1/apps/track')
      .send({ packageName: 'com.example.app', sources: { qq: true }, fetch: true });
    expect(again.body.data.id).toBe(id); // same app
    const row = h.db.select().from(appSources).all().find(r => r.trackedAppId === id && r.source === 'qq');
    expect(row?.enabled).toBe(true);
    expect(h.apkTracker.checkRemoteSource).toHaveBeenCalledWith(
      expect.objectContaining({ id }), expect.objectContaining({ id: 'qq' }), { force: true },
    );
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
