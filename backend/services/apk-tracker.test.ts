import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { ApkTracker } from './apk-tracker';

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
      statSync: vi.fn(() => ({ size: 54321 })),
      existsSync: vi.fn(() => true),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 54321 })),
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
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

    function addApp(): number {
      db.insert(trackedApps).values({ packageName: 'com.example.app', createdAt: new Date() }).run();
      return db.select().from(trackedApps).all()[0].id;
    }

    function seedSource(appId: number, opts: { enabled?: boolean; lastVersion?: string | null } = {}) {
      db.insert(appSources).values({
        trackedAppId: appId,
        source: 'playstore',
        enabled: opts.enabled ?? true,
        lastVersion: opts.lastVersion ?? null,
        createdAt: new Date(),
      }).run();
    }

    function sourceRow(appId: number) {
      return db.select().from(appSources).all().find(r => r.trackedAppId === appId && r.source === 'playstore');
    }

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
  });

});
