import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
const { trackedApps } = schema;
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAppEndpoints } from './apps';
import { SourceRegistry } from '../services/apk-sources/registry';
import type { RemoteApkSource } from '../services/apk-sources/types';
import { ApkTracker } from '../services/apk-tracker';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../services/device-manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/device-manager')>();
  return { ...original, adbShell: vi.fn(), adbCommand: vi.fn(), adbPull: vi.fn() };
});
vi.mock('../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));

const { appSources, apkVersions } = schema;

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
  const apkTracker = {
    checkRemoteSource: vi.fn(async () => ({ newVersionId: 42 })),
    emitVersionDetected: vi.fn(),
  } as any;
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

  // ── PATCH /v1/apps/track/:id — auto-analyse ─────────────────────────────
  // The switch that decides whether a detected version is downloaded at all.
  // Until this endpoint existed it could only be changed in the database.
  it('a newly tracked app does NOT auto-analyse', async () => {
    const id = await trackApp();
    const row = h.db.select().from(trackedApps).all().find(a => a.id === id)!;
    expect(row.autoAnalyse, 'tracking a new app should be cheap by default').toBe(false);
  });

  it('PATCH toggles auto-analyse and returns the updated app', async () => {
    const id = await trackApp();
    const on = await request(h.app).patch(`/v1/apps/track/${id}`).send({ autoAnalyse: true });
    expect(on.status).toBe(200);
    expect(on.body.data.autoAnalyse).toBe(true);
    expect(h.db.select().from(trackedApps).all().find(a => a.id === id)!.autoAnalyse).toBe(true);

    const off = await request(h.app).patch(`/v1/apps/track/${id}`).send({ autoAnalyse: false });
    expect(off.status).toBe(200);
    expect(h.db.select().from(trackedApps).all().find(a => a.id === id)!.autoAnalyse).toBe(false);
  });

  it('PATCH rejects a non-boolean and 404s an unknown app', async () => {
    const id = await trackApp();
    const bad = await request(h.app).patch(`/v1/apps/track/${id}`).send({ autoAnalyse: 'yes' });
    expect(bad.status).toBe(400);
    // Unchanged — a rejected request must not half-apply.
    expect(h.db.select().from(trackedApps).all().find(a => a.id === id)!.autoAnalyse).toBe(false);

    const missing = await request(h.app).patch('/v1/apps/track/9999').send({ autoAnalyse: true });
    expect(missing.status).toBe(404);
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

  // ── sources/check announces what it stores ──────────────────────────────
  // Regression: this endpoint writes `last_version` straight from the store
  // probe. It emitted nothing, so a subscriber only learned of the new version
  // when its own periodic reconcile next ran.
  describe('sources/check announces a version it stores', () => {
    const OWED_ERROR = 'apkeep produced no downloadable files (APKPure)';
    const setRow = (id: number, source: string, patch: Partial<typeof appSources.$inferInsert>) =>
      h.db.update(appSources).set(patch)
        .where(and(eq(appSources.trackedAppId, id), eq(appSources.source, source))).run();
    const rowOf = (id: number, source: string) =>
      h.db.select().from(appSources).all().find(r => r.trackedAppId === id && r.source === source)!;
    const check = (id: number) => request(h.app).post(`/v1/apps/track/${id}/sources/check`).send({});

    it('emits apk:version-detected (analysed:false) for a version it newly stores, ENABLED sources only', async () => {
      const id = await trackApp();
      await check(id);

      // qq is probed and recorded (so the UI can show availability) but is
      // disabled: announcing a store the user has not enabled would fire
      // triggers for a source they chose not to follow.
      expect(h.apkTracker.emitVersionDetected).toHaveBeenCalledTimes(1);
      expect(h.apkTracker.emitVersionDetected).toHaveBeenCalledWith({
        trackedAppId: id, packageName: 'com.example.app', appName: null,
        source: 'playstore', versionName: '1.0.0', previousVersion: null, analysed: false,
      });
      expect(rowOf(id, 'qq').lastVersion).toBe('1.0.0');
    });

    it('passes the previous version when it replaces one', async () => {
      const id = await trackApp();
      setRow(id, 'playstore', { lastVersion: '0.9.0' });
      await check(id);

      expect(h.apkTracker.emitVersionDetected).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'playstore', versionName: '1.0.0', previousVersion: '0.9.0' }),
      );
    });

    it('does not announce an unchanged version', async () => {
      const id = await trackApp();
      setRow(id, 'playstore', { lastVersion: '1.0.0' });
      await check(id);

      expect(h.apkTracker.emitVersionDetected).not.toHaveBeenCalled();
    });

    it('does not announce when the store no longer lists the app', async () => {
      const id = await trackApp();
      setRow(id, 'playstore', { lastVersion: '1.0.0' });
      (h.registry.get('playstore')!.checkVersion as any).mockResolvedValueOnce(null);
      await check(id);

      expect(h.apkTracker.emitVersionDetected).not.toHaveBeenCalled();
      expect(rowOf(id, 'playstore').lastVersion).toBeNull();
    });

    it('does not announce when the probe throws', async () => {
      const id = await trackApp();
      (h.registry.get('playstore')!.checkVersion as any).mockRejectedValueOnce(new Error('network boom'));
      await check(id);

      expect(h.apkTracker.emitVersionDetected).not.toHaveBeenCalled();
    });

    it('still stores the result when there is no tracker to announce through', async () => {
      clearEndpoints();
      const db = createTestDb() as unknown as BetterSQLite3Database<typeof schema>;
      const registry = new SourceRegistry().register(fakeSource('playstore', true));
      registerAppEndpoints({ getAllDeviceStatuses: vi.fn(async () => []) } as any, db as any, undefined, undefined, undefined, undefined, registry);
      const app = express();
      app.use(express.json());
      app.use(getApiRouter());
      const tracked = await request(app).post('/v1/apps/track').send({ packageName: 'com.example.app' });

      const res = await request(app).post(`/v1/apps/track/${tracked.body.data.id}/sources/check`).send({});

      expect(res.status).toBe(200);
      const row = db.select().from(appSources).all().find(r => r.source === 'playstore');
      expect(row?.lastVersion).toBe('1.0.0');
    });

    // The probe is a read, not a download. Clearing lastError here would drop
    // the retry that is waiting on a download that never succeeded.
    it('does not clear an error while a download for that version is still owed', async () => {
      const id = await trackApp();
      h.db.update(trackedApps).set({ autoAnalyse: true }).where(eq(trackedApps.id, id)).run();
      setRow(id, 'playstore', { lastVersion: '1.0.0', lastError: OWED_ERROR });
      await check(id);

      expect(rowOf(id, 'playstore').lastError, 'the probe laundered away a download that is still owed').toBe(OWED_ERROR);
    });

    it('still clears a stale error when no download is owed', async () => {
      const id = await trackApp();   // new apps do not auto-analyse, so nothing is ever owed
      setRow(id, 'playstore', { lastVersion: '1.0.0', lastError: 'getaddrinfo ENOTFOUND play.google.com' });
      await check(id);

      expect(rowOf(id, 'playstore').lastError).toBeNull();
    });

    // A subscriber that reads the row when the event fires (the usual way to
    // describe a release) must find the NEW version's listing, not the old one.
    // checkRemoteSource saves the listing metadata before it emits; this
    // endpoint has to as well.
    describe('listing metadata is saved before the announcement', () => {
      const when = new Date('2026-09-17T08:47:07.000Z');
      const newListing = {
        versionName: '1.0.0', iconUrl: 'https://example.test/new.png',
        releaseNotes: 'New notes', sizeLabel: '24M', storeUpdatedAt: when,
      };
      const oldListing = {
        lastVersion: '0.9.0', lastIconUrl: 'https://example.test/old.png',
        lastReleaseNotes: 'Old notes', lastSizeLabel: '10M', lastStoreUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
      };

      it('the row already holds the new listing when the event fires', async () => {
        const id = await trackApp();
        setRow(id, 'playstore', oldListing);
        (h.registry.get('playstore')!.checkVersion as any).mockResolvedValueOnce(newListing);
        let atEmit: ReturnType<typeof rowOf> | undefined;
        h.apkTracker.emitVersionDetected.mockImplementation(() => { atEmit = { ...rowOf(id, 'playstore') }; });

        await check(id);

        expect(h.apkTracker.emitVersionDetected).toHaveBeenCalledTimes(1);
        expect(atEmit, 'the event fired with the previous release notes and size still on the row').toMatchObject({
          lastVersion: '1.0.0',
          lastIconUrl: 'https://example.test/new.png',
          lastReleaseNotes: 'New notes',
          lastSizeLabel: '24M',
        });
        expect(atEmit!.lastStoreUpdatedAt?.getTime()).toBe(when.getTime());
      });

      it('keeps the stored listing when the probe carries none (never blanks it)', async () => {
        const id = await trackApp();
        setRow(id, 'playstore', oldListing);   // default probe reply is just { versionName: '1.0.0' }
        await check(id);

        expect(rowOf(id, 'playstore')).toMatchObject({
          lastVersion: '1.0.0', lastIconUrl: 'https://example.test/old.png',
          lastReleaseNotes: 'Old notes', lastSizeLabel: '10M',
        });
      });

      it('saves the listing of a disabled source too (it is probed, just not announced)', async () => {
        const id = await trackApp();
        (h.registry.get('qq')!.checkVersion as any).mockResolvedValueOnce(newListing);
        await check(id);

        expect(rowOf(id, 'qq')).toMatchObject({ lastVersion: '1.0.0', lastReleaseNotes: 'New notes', lastSizeLabel: '24M' });
      });
    });

    // The probe moves last_version onto a new release without downloading it.
    // For an auto-analyse source, the scheduled cycle compares the store's
    // version with last_version and would call the APK "already seen", so it
    // would never be fetched and the announcement would never be followed by
    // analysed:true. The probe has to leave that download owed.
    describe('a new version on an auto-analyse source is left owed for the next cycle', () => {
      const autoAnalyse = (id: number) =>
        h.db.update(trackedApps).set({ autoAnalyse: true }).where(eq(trackedApps.id, id)).run();
      const realTracker = () => {
        const tracker = new ApkTracker(h.db as any, { getAllDeviceStatuses: vi.fn(async () => []) } as any);
        tracker.setSourceRegistry(h.registry);
        return tracker;
      };

      it('the endpoint, then a scheduled cycle, downloads the APK', async () => {
        const id = await trackApp();
        autoAnalyse(id);
        setRow(id, 'playstore', { lastVersion: '0.9.0' });
        const ps = h.registry.get('playstore')!;

        await check(id);
        expect(ps.downloadApk, 'the probe itself must not download').not.toHaveBeenCalled();
        await realTracker().checkRemoteSource({ id, packageName: 'com.example.app', appName: null }, ps);

        expect(ps.downloadApk, 'the cycle called the version "already seen" and never fetched the APK').toHaveBeenCalledTimes(1);
      });

      it('and once the cycle has fetched it, the next cycle leaves it alone', async () => {
        const id = await trackApp();
        autoAnalyse(id);
        setRow(id, 'playstore', { lastVersion: '0.9.0' });
        const ps = h.registry.get('playstore')!;
        (ps.downloadApk as any).mockResolvedValue({ success: false, error: 'nope' });
        const tracker = realTracker();
        const app = { id, packageName: 'com.example.app', appName: null };

        await check(id);
        await tracker.checkRemoteSource(app, ps);   // fails: still owed, real error recorded
        await tracker.checkRemoteSource(app, ps);   // retried, not skipped

        expect(ps.downloadApk).toHaveBeenCalledTimes(2);
        expect(rowOf(id, 'playstore').lastError).toBe('nope');
        // ...and the failed cycle did not announce the same version a second time.
        expect(h.apkTracker.emitVersionDetected).toHaveBeenCalledTimes(1);
      });

      it('does not mark an app that does not auto-analyse', async () => {
        const id = await trackApp();
        await check(id);
        expect(rowOf(id, 'playstore').lastError).toBeNull();
      });

      it('does not mark a version whose APK is already held (from any source)', async () => {
        const id = await trackApp();
        autoAnalyse(id);
        h.db.insert(apkVersions).values({
          trackedAppId: id, versionCode: 100, versionName: '1.0.0',
          filename: '100_1.0.0.apk', source: 'device', downloadedAt: new Date(),
        }).run();
        await check(id);
        expect(rowOf(id, 'playstore').lastError).toBeNull();
      });

      it('does not mark a disabled source (the cycle never checks it)', async () => {
        const id = await trackApp();
        autoAnalyse(id);
        await check(id);
        expect(rowOf(id, 'qq').lastError).toBeNull();
      });

      it('does not mark a version that did not change', async () => {
        const id = await trackApp();
        autoAnalyse(id);
        setRow(id, 'playstore', { lastVersion: '1.0.0' });
        await check(id);
        expect(rowOf(id, 'playstore').lastError).toBeNull();
      });
    });
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
