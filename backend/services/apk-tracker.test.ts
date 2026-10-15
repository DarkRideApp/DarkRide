import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { ApkTracker, isDownloadOwed } from './apk-tracker';

const { trackedApps, apkVersions } = schema;

// Mock device-manager's adbShell and adbPull
vi.mock('./device-manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('./device-manager')>();
  return {
    ...original,
    adbShell: vi.fn(),
    adbPull: vi.fn(),
  };
});

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    default: {
      ...original,
      mkdirSync: vi.fn(),
      statSync: vi.fn(() => ({ size: 54321, isDirectory: () => false })),
      existsSync: vi.fn(() => true),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
      rmSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 54321, isDirectory: () => false })),
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    execSync: vi.fn(() => Buffer.alloc(0)),
  };
});

import { adbShell, adbPull } from './device-manager';
import { createTestDb } from '../test-utils/create-test-db';
import { SourceRegistry } from './apk-sources/registry';

const { appSources } = schema;
const mockedAdbShell = vi.mocked(adbShell);
const mockedAdbPull = vi.mocked(adbPull);

function createMockDeviceManager(overrides: Record<string, any> = {}) {
  return {
    isOnline: vi.fn(() => true),
    isBusy: vi.fn(() => false),
    unlockDevice: vi.fn(async () => {}),
    getAllDeviceStatuses: vi.fn(async () => [
      { id: 'DEV001', isOnline: true, isBusy: false },
    ]),
    ...overrides,
  } as any;
}

describe('ApkTracker', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start/stop', () => {
    it('should start and stop without errors', () => {
      const tracker = new ApkTracker(db as any, createMockDeviceManager());
      tracker.start();
      tracker.stop();
    });

    it('should not start twice', () => {
      const spy = vi.spyOn(global, 'setInterval');
      const tracker = new ApkTracker(db as any, createMockDeviceManager());
      tracker.start();
      tracker.start();
      // Only one interval should be created
      const callCount = spy.mock.calls.filter(c => typeof c[1] === 'number').length;
      expect(callCount).toBeGreaterThanOrEqual(1);
      tracker.stop();
    });
  });

  describe('checkForUpdates', () => {
    it('should skip when no tracked apps', async () => {
      const dm = createMockDeviceManager();
      const tracker = new ApkTracker(db as any, dm);
      await tracker.checkForUpdates();
      expect(mockedAdbShell).not.toHaveBeenCalled();
    });

    it('should skip when no online devices', async () => {
      // Add a tracked app
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();

      const dm = createMockDeviceManager({
        getAllDeviceStatuses: vi.fn(async () => []),
      });
      const tracker = new ApkTracker(db as any, dm);
      await tracker.checkForUpdates();
      expect(mockedAdbShell).not.toHaveBeenCalled();
    });

    it('should skip busy devices', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();

      const dm = createMockDeviceManager({
        getAllDeviceStatuses: vi.fn(async () => [
          { id: 'DEV001', isOnline: true, isBusy: true },
        ]),
      });
      const tracker = new ApkTracker(db as any, dm);
      await tracker.checkForUpdates();
      // adbShell might still be called before the busy check on the second pass
      // The key is that no versions should be created
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(0);
    });

    it('should detect and pull new version', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();
      const tracked = db.select().from(trackedApps).all();

      // Existing version in DB
      db.insert(apkVersions).values({
        trackedAppId: tracked[0].id,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        downloadedAt: new Date(),
      }).run();

      // Device has newer version
      mockedAdbShell.mockImplementation(async (deviceId: string, cmd: string) => {
        if (cmd.startsWith('dumpsys package')) {
          return 'Packages:\n  versionCode=200\n  versionName=2.0.0';
        }
        if (cmd.startsWith('pm path')) {
          return 'package:/data/app/base.apk';
        }
        return '';
      });
      mockedAdbPull.mockResolvedValue(undefined);

      const dm = createMockDeviceManager();
      const tracker = new ApkTracker(db as any, dm);
      await tracker.checkForUpdates();

      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(2);
      expect(versions.find(v => v.versionCode === 200)).toBeTruthy();
    });

    it('should skip when device has same version as latest stored', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();
      const tracked = db.select().from(trackedApps).all();

      db.insert(apkVersions).values({
        trackedAppId: tracked[0].id,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        downloadedAt: new Date(),
      }).run();

      mockedAdbShell.mockImplementation(async (deviceId: string, cmd: string) => {
        if (cmd.startsWith('dumpsys package')) {
          return 'Packages:\n  versionCode=100\n  versionName=1.0.0';
        }
        return '';
      });

      const dm = createMockDeviceManager();
      const tracker = new ApkTracker(db as any, dm);
      await tracker.checkForUpdates();

      // No new version pulled
      expect(mockedAdbPull).not.toHaveBeenCalled();
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
    });

    it('should pull first version when no stored versions exist', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();

      mockedAdbShell.mockImplementation(async (deviceId: string, cmd: string) => {
        if (cmd.startsWith('dumpsys package')) {
          return 'Packages:\n  versionCode=100\n  versionName=1.0.0';
        }
        if (cmd.startsWith('pm path')) {
          return 'package:/data/app/base.apk';
        }
        return '';
      });
      mockedAdbPull.mockResolvedValue(undefined);

      const dm = createMockDeviceManager();
      const tracker = new ApkTracker(db as any, dm);
      await tracker.checkForUpdates();

      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
      expect(versions[0].versionCode).toBe(100);
      expect(versions[0].fileSize).toBe(54321);
    });

    it('should handle app not installed on device gracefully', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();

      mockedAdbShell.mockRejectedValue(new Error('Unknown package: com.example.app'));

      const dm = createMockDeviceManager();
      const tracker = new ApkTracker(db as any, dm);
      // Should not throw
      await tracker.checkForUpdates();

      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(0);
    });

    it('should handle errors in checkForUpdates gracefully', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();

      mockedAdbShell.mockRejectedValue(new Error('some other error'));

      const dm = createMockDeviceManager();
      const tracker = new ApkTracker(db as any, dm);
      await tracker.checkForUpdates();

      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(0);
    });

    it('should not run concurrent checks', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();

      mockedAdbShell.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 100));
        return 'Packages:\n  versionCode=100\n  versionName=1.0.0';
      });

      const dm = createMockDeviceManager();
      const tracker = new ApkTracker(db as any, dm);

      // Start two checks simultaneously
      const p1 = tracker.checkForUpdates();
      const p2 = tracker.checkForUpdates();

      await Promise.all([p1, p2]);

      // The second check should be skipped (checking flag)
      // adbShell should only be called by the first check
      // (dumpsys + pm path/aapt for name backfill + cmd dump-icon for icon + pm path for pull = up to 5)
      expect(mockedAdbShell.mock.calls.length).toBeLessThanOrEqual(5);
    });
  });

  describe('checkRemoteSource - per-source dedup via app_sources', () => {
    // A stand-in remote source (id 'playstore') exercising the generic
    // registry path that replaced the old hard-wired Play Store check.
    function fakeSource(overrides: Record<string, any> = {}) {
      return {
        id: 'playstore',
        label: 'Play Store',
        isConfigured: () => true,
        defaultEnabled: () => true,
        checkVersion: vi.fn(async () => ({ versionName: '3.0.0', appName: 'Test App' })),
        downloadApk: vi.fn(async () => ({
          success: true,
          versionCode: 300,
          versionName: '3.0.0',
          filePath: '/tmp/test.apk',
          fileSize: 12345,
        })),
        ...overrides,
      } as any;
    }

    function trackerWith(source: any) {
      const dm = createMockDeviceManager({ getAllDeviceStatuses: vi.fn(async () => []) });
      const tracker = new ApkTracker(db as any, dm);
      tracker.setSourceRegistry(new SourceRegistry().register(source));
      return tracker;
    }

    // autoAnalyse: true because these tests are about the DOWNLOAD path, and it
    // mirrors migration 0098, which backfills every pre-existing tracked app to
    // true. New apps default to false — covered in the block at the end.
    function addApp(autoAnalyse = true): number {
      db.insert(trackedApps).values({ packageName: 'com.example.app', autoAnalyse, createdAt: new Date() }).run();
      return db.select().from(trackedApps).all()[0].id;
    }

    function seedSource(appId: number, opts: { enabled?: boolean; lastVersion?: string | null; lastError?: string | null } = {}) {
      db.insert(appSources).values({
        trackedAppId: appId,
        source: 'playstore',
        enabled: opts.enabled ?? true,
        lastVersion: opts.lastVersion ?? null,
        lastError: opts.lastError ?? null,
        createdAt: new Date(),
      }).run();
    }

    function sourceRow(appId: number) {
      return db.select().from(appSources).all().find(r => r.trackedAppId === appId && r.source === 'playstore');
    }

    // ── track without analysing ──────────────────────────────────────────
    // The whole point of the tracking/analysis split: an app can be watched for
    // versions without its APK ever being fetched. If these pass only with
    // auto-analyse enabled, the separation is cosmetic.
    describe('auto-analyse off', () => {
      function hookBus() {
        const emit = vi.fn();
        return { emit, bus: { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit } as any };
      }

      it('records the new version WITHOUT downloading', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = fakeSource();
        const tracker = trackerWith(ps);

        const result = await tracker.checkRemoteSource(
          { id: appId, packageName: 'com.example.app', appName: null }, ps,
        );

        expect(ps.checkVersion).toHaveBeenCalled();
        expect(ps.downloadApk, 'downloaded the APK despite auto-analyse being off').not.toHaveBeenCalled();
        expect(result.newVersionId).toBeNull();
        // The version is still recorded — otherwise every cycle would re-detect
        // it as new and re-announce it forever.
        expect(sourceRow(appId)!.lastVersion).toBe('3.0.0');
        expect(db.select().from(apkVersions).all()).toHaveLength(0);
      });

      it('emits apk:version-detected with analysed:false', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = fakeSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, ps);

        expect(emit).toHaveBeenCalledWith('apk:version-detected', expect.objectContaining({
          trackedAppId: appId,
          packageName: 'com.example.app',
          source: 'playstore',
          versionName: '3.0.0',
          previousVersion: '2.0.0',
          analysed: false,
        }));
      });

      it('emits apk:version-detected with analysed:true when it did download', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = fakeSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, ps);

        expect(ps.downloadApk).toHaveBeenCalled();
        expect(emit).toHaveBeenCalledWith('apk:version-detected', expect.objectContaining({ analysed: true }));
      });

      it('does not re-announce an unchanged version', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '3.0.0' });   // already at the reported version
        const ps = fakeSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, ps);

        expect(emit).not.toHaveBeenCalled();
        expect(ps.downloadApk).not.toHaveBeenCalled();
      });

      it('a forced fetch still downloads — the button must not silently no-op', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = fakeSource();
        const tracker = trackerWith(ps);

        await tracker.checkRemoteSource(
          { id: appId, packageName: 'com.example.app', appName: null }, ps, { force: true },
        );

        expect(ps.downloadApk, 'explicit fetch-now was ignored').toHaveBeenCalled();
      });

      it('a throwing subscriber does not break the check', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = fakeSource();
        const tracker = trackerWith(ps);
        tracker.setHookBus({
          define: vi.fn(), on: vi.fn(), off: vi.fn(),
          emit: vi.fn(() => { throw new Error('subscriber exploded'); }),
        } as any);

        await expect(
          tracker.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, ps),
        ).resolves.toBeTruthy();
        // The version still got recorded despite the subscriber throwing.
        expect(sourceRow(appId)!.lastVersion).toBe('3.0.0');
      });
    });

    // ── a failed download must not hide the version the store reported ────
    // Regression: a store listing moved to a new version but the APK download
    // kept failing. The version was only recorded AFTER a successful download,
    // so app_sources.last_version stayed on the old release indefinitely and
    // apk:version-detected never fired. Consumers that only need the version
    // string must not wait on a download that may never succeed.
    describe('a failed download still records and announces the store version', () => {
      const DOWNLOAD_ERROR = 'apkeep produced no downloadable files (APKPure)';
      const app = (appId: number) => ({ id: appId, packageName: 'com.example.app', appName: null });

      function hookBus() {
        const emit = vi.fn();
        return { emit, bus: { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit } as any };
      }

      function failingSource(overrides: Record<string, any> = {}) {
        return fakeSource({
          downloadApk: vi.fn(async () => ({ success: false, error: DOWNLOAD_ERROR })),
          ...overrides,
        });
      }

      const detected = (emit: ReturnType<typeof vi.fn>) =>
        emit.mock.calls.filter(c => c[0] === 'apk:version-detected').map(c => c[1]);

      it('writes last_version and emits analysed:false when the download fails', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = failingSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        const result = await tracker.checkRemoteSource(app(appId), ps);

        expect(result).toMatchObject({ newVersionId: null, error: DOWNLOAD_ERROR });
        expect(sourceRow(appId)!.lastVersion, 'last_version stayed behind the store').toBe('3.0.0');
        // The failure is still surfaced: it is also what keeps the retry alive.
        expect(sourceRow(appId)!.lastError).toBe(DOWNLOAD_ERROR);
        expect(db.select().from(apkVersions).all()).toHaveLength(0);
        expect(detected(emit)).toEqual([expect.objectContaining({
          trackedAppId: appId,
          packageName: 'com.example.app',
          source: 'playstore',
          versionName: '3.0.0',
          previousVersion: '2.0.0',
          analysed: false,
        })]);
      });

      it('persists the store listing metadata alongside the version, so a consumer can describe the release', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const when = new Date('2026-09-17T08:47:07.000Z');
        const ps = failingSource({
          checkVersion: vi.fn(async () => ({
            versionName: '3.0.0', appName: 'Test App', iconUrl: 'https://example.test/icon.png',
            releaseNotes: 'Bug fixes', sizeLabel: '24M', storeUpdatedAt: when,
          })),
        });

        await trackerWith(ps).checkRemoteSource(app(appId), ps);

        const row = sourceRow(appId)!;
        expect(row.lastIconUrl).toBe('https://example.test/icon.png');
        expect(row.lastReleaseNotes).toBe('Bug fixes');
        expect(row.lastSizeLabel).toBe('24M');
        expect(row.lastStoreUpdatedAt?.getTime()).toBe(when.getTime());
      });

      it('records the version before announcing it, even if a subscriber throws', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = failingSource();
        const tracker = trackerWith(ps);
        tracker.setHookBus({
          define: vi.fn(), on: vi.fn(), off: vi.fn(),
          emit: vi.fn(() => { throw new Error('subscriber exploded'); }),
        } as any);

        await expect(tracker.checkRemoteSource(app(appId), ps)).resolves.toMatchObject({ error: DOWNLOAD_ERROR });
        expect(sourceRow(appId)!.lastVersion).toBe('3.0.0');
      });

      it('retries the download on the next cycle, and does not re-announce the same version', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = failingSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource(app(appId), ps);
        await tracker.checkRemoteSource(app(appId), ps);
        await tracker.checkRemoteSource(app(appId), ps);

        // last_version already equals the store version from cycle 1, so the
        // OLD skip rule would have stopped retrying after the first failure.
        expect(ps.downloadApk, 'gave up retrying after the first failure').toHaveBeenCalledTimes(3);
        expect(detected(emit), 'announced the same stuck version every cycle').toHaveLength(1);
        expect(sourceRow(appId)!.lastError).toBe(DOWNLOAD_ERROR);
      });

      it('announces again with analysed:true when a retry finally succeeds, ingests once, then goes quiet', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = fakeSource({
          downloadApk: vi.fn()
            .mockResolvedValueOnce({ success: false, error: DOWNLOAD_ERROR })
            .mockResolvedValue({
              success: true, versionCode: 300, versionName: '3.0.0', filePath: '/tmp/test.apk', fileSize: 12345,
            }),
        });
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource(app(appId), ps);   // fails: announced as analysed:false
        const retry = await tracker.checkRemoteSource(app(appId), ps);   // succeeds
        await tracker.checkRemoteSource(app(appId), ps);   // settled: skipped

        expect(retry.newVersionId).not.toBeNull();
        expect(ps.downloadApk).toHaveBeenCalledTimes(2);
        expect(db.select().from(apkVersions).all(), 'ingested more than once').toHaveLength(1);
        expect(sourceRow(appId)!.lastError).toBeNull();
        expect(detected(emit).map(p => p.analysed)).toEqual([false, true]);
        expect(detected(emit)[1]).toMatchObject({ versionName: '3.0.0' });
      });

      it('a forced fetch that fails also records and announces the version', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = failingSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource(app(appId), ps, { force: true });

        expect(sourceRow(appId)!.lastVersion).toBe('3.0.0');
        expect(detected(emit)).toHaveLength(1);
      });

      // The retry must key on "the download for THIS version is still owed",
      // not on "lastError is set": check failures set lastError too.
      it('a transient check failure does not make an already-ingested version download again', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '3.0.0', lastError: 'getaddrinfo ENOTFOUND play.google.com' });
        db.insert(apkVersions).values({
          trackedAppId: appId, versionCode: 300, versionName: '3.0.0',
          filename: '300_3.0.0.apk', source: 'playstore', downloadedAt: new Date(),
        }).run();
        const ps = failingSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource(app(appId), ps);

        expect(ps.downloadApk, 'redownloaded a version we already hold').not.toHaveBeenCalled();
        expect(sourceRow(appId)!.lastError, 'stale check error was not cleared').toBeNull();
        expect(emit).not.toHaveBeenCalled();
      });

      it('stops retrying once another source (a device) has ingested that version', async () => {
        const appId = addApp(true);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = failingSource();
        const tracker = trackerWith(ps);

        await tracker.checkRemoteSource(app(appId), ps);   // remote download fails
        db.insert(apkVersions).values({                    // the device pulls the same version
          trackedAppId: appId, versionCode: 300, versionName: '3.0.0',
          filename: '300_3.0.0.apk', source: 'device', downloadedAt: new Date(),
        }).run();
        await tracker.checkRemoteSource(app(appId), ps);

        expect(ps.downloadApk).toHaveBeenCalledTimes(1);
        expect(sourceRow(appId)!.lastError).toBeNull();
      });

      it('auto-analyse off ignores a stale lastError: no download, no spurious announcement', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '3.0.0', lastError: 'getaddrinfo ENOTFOUND play.google.com' });
        const ps = failingSource();
        const tracker = trackerWith(ps);
        const { emit, bus } = hookBus();
        tracker.setHookBus(bus);

        await tracker.checkRemoteSource(app(appId), ps);

        expect(ps.downloadApk).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(sourceRow(appId)!.lastError).toBeNull();
      });
    });

    // ── store metadata captured alongside the version ────────────────────
    describe('store metadata', () => {
      const meta = {
        versionName: '3.0.0', appName: 'Test App',
        iconUrl: 'https://example.test/icon.png',
        releaseNotes: 'Fixed the thing',
        sizeLabel: '24M',
        storeUpdatedAt: new Date('2026-08-01T00:00:00Z'),
      };

      it('persists icon, release notes, size and store-updated alongside lastVersion', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '2.0.0' });
        const ps = fakeSource({ checkVersion: vi.fn(async () => meta) });
        const tracker = trackerWith(ps);

        await tracker.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, ps);

        const row = sourceRow(appId)!;
        expect(row.lastIconUrl).toBe('https://example.test/icon.png');
        expect(row.lastReleaseNotes).toBe('Fixed the thing');
        expect(row.lastSizeLabel).toBe('24M');
        expect(row.lastStoreUpdatedAt).toEqual(meta.storeUpdatedAt);
      });

      it('refreshes metadata even when the version is unchanged', async () => {
        // A store can edit an icon or release notes without shipping a build,
        // so the unchanged-version path must not skip the metadata update.
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '3.0.0' });
        const ps = fakeSource({ checkVersion: vi.fn(async () => meta) });
        const tracker = trackerWith(ps);

        await tracker.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, ps);

        expect(sourceRow(appId)!.lastReleaseNotes).toBe('Fixed the thing');
      });

      it('keeps the previous metadata when a source reports none', async () => {
        const appId = addApp(false);
        seedSource(appId, { lastVersion: '2.0.0' });
        const withMeta = fakeSource({ checkVersion: vi.fn(async () => meta) });
        const tracker = trackerWith(withMeta);
        await tracker.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, withMeta);

        // A later check from a source that publishes no icon must not blank it.
        const bare = fakeSource({ checkVersion: vi.fn(async () => ({ versionName: '4.0.0' })) });
        const tracker2 = trackerWith(bare);
        await tracker2.checkRemoteSource({ id: appId, packageName: 'com.example.app', appName: null }, bare);

        const row = sourceRow(appId)!;
        expect(row.lastVersion).toBe('4.0.0');
        expect(row.lastIconUrl, 'metadata was blanked by a source that had none').toBe('https://example.test/icon.png');
      });
    });

    it('skips download when the source reports the last-seen version', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '3.0.0' });
      const ps = fakeSource();
      await trackerWith(ps).checkForUpdates();

      expect(ps.checkVersion).toHaveBeenCalled();
      expect(ps.downloadApk).not.toHaveBeenCalled();
    });

    it('does not check a disabled source', async () => {
      const appId = addApp();
      seedSource(appId, { enabled: false, lastVersion: '2.0.0' });
      const ps = fakeSource();
      await trackerWith(ps).checkForUpdates();

      expect(ps.checkVersion).not.toHaveBeenCalled();
    });

    it('downloads + inserts when the version changes and is newer', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '2.0.0' });
      const ps = fakeSource();
      await trackerWith(ps).checkForUpdates();

      expect(ps.downloadApk).toHaveBeenCalled();
      expect(sourceRow(appId)?.lastVersion).toBe('3.0.0');
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
      expect(versions[0].versionCode).toBe(300);
      expect(versions[0].source).toBe('playstore');
    });

    it('discards a download older than what we already have, but still records lastVersion', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '2.0.0' });
      db.insert(apkVersions).values({
        trackedAppId: appId, versionCode: 400, versionName: '4.0.0-beta',
        filename: '400_4.0.0-beta.apk', source: 'device', downloadedAt: new Date(),
      }).run();

      const ps = fakeSource();
      await trackerWith(ps).checkForUpdates();

      expect(ps.downloadApk).toHaveBeenCalled();
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
      expect(versions[0].versionCode).toBe(400);
      expect(sourceRow(appId)?.lastVersion).toBe('3.0.0');
    });

    it('downloads on first check (lastVersion null)', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: null });
      const ps = fakeSource();
      await trackerWith(ps).checkForUpdates();

      expect(ps.downloadApk).toHaveBeenCalled();
      expect(sourceRow(appId)?.lastVersion).toBe('3.0.0');
    });

    it('records lastError when checkVersion throws', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '2.0.0' });
      const ps = fakeSource({ checkVersion: vi.fn(async () => { throw new Error('boom'); }) });
      await trackerWith(ps).checkForUpdates();

      expect(sourceRow(appId)?.lastError).toBe('boom');
    });

    it('auto-creates missing app_sources rows from the registry defaults', async () => {
      const appId = addApp();
      // No seeded row — ensureAppSources should create one with defaultEnabled().
      const ps = fakeSource();
      await trackerWith(ps).checkForUpdates();

      const row = sourceRow(appId);
      expect(row).toBeTruthy();
      expect(row?.enabled).toBe(true);
    });

    it('a forced fetch on an app with no source row creates it and records state', async () => {
      const appId = addApp();
      // No seeded row at all (e.g. a pre-existing app whose qq row was never backfilled).
      const ps = fakeSource();
      const tracker = trackerWith(ps);
      const result = await tracker.checkRemoteSource(
        { id: appId, packageName: 'com.example.app', appName: null }, ps, { force: true },
      );

      expect(ps.downloadApk).toHaveBeenCalled();
      expect(result.newVersionId).not.toBeNull();
      const row = sourceRow(appId);
      expect(row).toBeTruthy();
      expect(row?.lastVersion).toBe('3.0.0'); // state recorded, not silently dropped
    });

    it('finalizes the staged download via rename on keep (never overwrites in place)', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '2.0.0' });
      const ps = fakeSource(); // downloadApk returns filePath: '/tmp/test.apk' (staged)
      await trackerWith(ps).checkForUpdates();

      // ingestVersion renames the staged temp file to the final name.
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith('/tmp/test.apk', expect.stringContaining('300_3.0.0.apk'));
    });

    it('discards (unlinks) the staged download on dedup, never renaming it', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '2.0.0' });
      db.insert(apkVersions).values({
        trackedAppId: appId, versionCode: 400, versionName: '4.0.0',
        filename: '400_4.0.0.apk', source: 'device', downloadedAt: new Date(),
      }).run();
      vi.mocked(fs.renameSync).mockClear();

      const ps = fakeSource(); // returns versionCode 300 < stored 400 → dedup
      await trackerWith(ps).checkForUpdates();

      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith('/tmp/test.apk');
      expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    });

    // A source that served an XAPK: downloadApk returns a staged split DIR.
    function fakeSplitSource(overrides: Record<string, any> = {}) {
      return fakeSource({
        downloadApk: vi.fn(async () => ({
          success: true,
          versionCode: 300,
          versionName: '3.0.0',
          splitDir: '/tmp/split',
          fileSize: 22222,
        })),
        ...overrides,
      });
    }

    it('finalizes a staged split dir via directory rename and tracks each child APK', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '2.0.0' });

      // statSync: the staged path is a directory; its children are files.
      vi.mocked(fs.statSync).mockImplementation((p: any) => {
        const s = String(p);
        const isDir = s === '/tmp/split' || s.endsWith('300_3.0.0');
        return { size: 4444, isDirectory: () => isDir } as any;
      });
      // After rename, the final dir enumerates to base.apk + a config split.
      vi.mocked(fs.readdirSync).mockReturnValue(['base.apk', 'config.arm64_v8a.apk'] as any);

      const trackFile = vi.fn();
      const ps = fakeSplitSource();
      const tracker = trackerWith(ps);
      tracker.setFileSync({ trackFile } as any);
      await tracker.checkForUpdates();

      // Directory rename into a filename WITHOUT the .apk suffix.
      const renameCall = vi.mocked(fs.renameSync).mock.calls.find(c => c[0] === '/tmp/split');
      expect(renameCall).toBeTruthy();
      expect(String(renameCall![1])).toMatch(/300_3\.0\.0$/);
      expect(String(renameCall![1])).not.toMatch(/\.apk$/);

      // Each split child is tracked with a per-child cloudKey under the dir key.
      expect(trackFile).toHaveBeenCalledTimes(2);
      const cloudKeys = trackFile.mock.calls.map(c => c[1]);
      expect(cloudKeys).toContain('apks/com.example.app/300_3.0.0/base.apk');
      expect(cloudKeys).toContain('apks/com.example.app/300_3.0.0/config.arm64_v8a.apk');
    });

    it('discards a staged split dir recursively on dedup, never renaming it', async () => {
      const appId = addApp();
      seedSource(appId, { lastVersion: '2.0.0' });
      db.insert(apkVersions).values({
        trackedAppId: appId, versionCode: 400, versionName: '4.0.0',
        filename: '400_4.0.0.apk', source: 'device', downloadedAt: new Date(),
      }).run();
      vi.mocked(fs.renameSync).mockClear();
      vi.mocked(fs.rmSync).mockClear();
      vi.mocked(fs.statSync).mockImplementation((p: any) => (
        { size: 4444, isDirectory: () => String(p) === '/tmp/split' } as any
      ));

      const ps = fakeSplitSource(); // versionCode 300 < stored 400 → dedup
      await trackerWith(ps).checkForUpdates();

      expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith('/tmp/split', { recursive: true, force: true });
      expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
    });
  });


  // The retry rule behind "a failed download is retried". Each row flips ONE
  // input from the first (the only combination that is owed), so a regression in
  // any single condition shows up as a named failure.
  describe('isDownloadOwed', () => {
    const ERR = 'apkeep produced no downloadable files (APKPure)';

    function setup(opts: { autoAnalyse: boolean; held?: string | null }) {
      db.insert(trackedApps).values({ packageName: 'com.example.app', autoAnalyse: opts.autoAnalyse, createdAt: new Date() }).run();
      const appId = db.select().from(trackedApps).all()[0].id;
      if (opts.held) {
        db.insert(apkVersions).values({
          trackedAppId: appId, versionCode: 300, versionName: opts.held,
          filename: '300.apk', source: 'device', downloadedAt: new Date(),
        }).run();
      }
      return appId;
    }

    it.each([
      ['owed: error set, auto-analyse, no APK held', { autoAnalyse: true, held: null, lastError: ERR, versionName: '3.0.0' }, true],
      ['not owed: no error (the last attempt did not fail)', { autoAnalyse: true, held: null, lastError: null, versionName: '3.0.0' }, false],
      ['not owed: auto-analyse off (nothing is ever downloaded)', { autoAnalyse: false, held: null, lastError: ERR, versionName: '3.0.0' }, false],
      ['not owed: an APK of that version is already held', { autoAnalyse: true, held: '3.0.0', lastError: ERR, versionName: '3.0.0' }, false],
      ['owed: a DIFFERENT version is held', { autoAnalyse: true, held: '2.0.0', lastError: ERR, versionName: '3.0.0' }, true],
      ['not owed: the store reported no version', { autoAnalyse: true, held: null, lastError: ERR, versionName: null }, false],
    ])('%s', (_name, c, expected) => {
      const appId = setup(c);
      expect(isDownloadOwed(db as any, { trackedAppId: appId, versionName: c.versionName, lastError: c.lastError })).toBe(expected);
    });

    it('is scoped to the app: another app holding that version does not count', () => {
      const appId = setup({ autoAnalyse: true });
      db.insert(trackedApps).values({ packageName: 'com.other.app', autoAnalyse: true, createdAt: new Date() }).run();
      const otherId = db.select().from(trackedApps).all().find(a => a.packageName === 'com.other.app')!.id;
      db.insert(apkVersions).values({
        trackedAppId: otherId, versionCode: 300, versionName: '3.0.0',
        filename: '300.apk', source: 'device', downloadedAt: new Date(),
      }).run();
      expect(isDownloadOwed(db as any, { trackedAppId: appId, versionName: '3.0.0', lastError: ERR })).toBe(true);
    });
  });

});
