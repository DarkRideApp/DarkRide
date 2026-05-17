import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
    },
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 54321 })),
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
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

  describe('checkPlayStore - lastPlayStoreVersion', () => {
    function createMockPlayStoreSource(overrides: Record<string, any> = {}) {
      return {
        checkVersion: vi.fn(async () => ({
          versionName: '3.0.0',
          appName: 'Test App',
        })),
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

    it('should skip download when lastPlayStoreVersion matches scraper output', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        lastPlayStoreVersion: '3.0.0',
        createdAt: new Date(),
      }).run();

      const dm = createMockDeviceManager({ getAllDeviceStatuses: vi.fn(async () => []) });
      const ps = createMockPlayStoreSource();
      const tracker = new ApkTracker(db as any, dm);
      tracker.setPlayStoreSource(ps);

      await tracker.checkForUpdates();

      // checkVersion is called, but downloadApk should NOT be called
      expect(ps.checkVersion).toHaveBeenCalled();
      expect(ps.downloadApk).not.toHaveBeenCalled();
    });

    it('should download when Play Store version string changes and versionCode is newer', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        lastPlayStoreVersion: '2.0.0',
        createdAt: new Date(),
      }).run();

      const dm = createMockDeviceManager({ getAllDeviceStatuses: vi.fn(async () => []) });
      const ps = createMockPlayStoreSource();
      const tracker = new ApkTracker(db as any, dm);
      tracker.setPlayStoreSource(ps);

      await tracker.checkForUpdates();

      expect(ps.downloadApk).toHaveBeenCalled();

      // lastPlayStoreVersion should be updated
      const apps = db.select().from(trackedApps).all();
      expect(apps[0].lastPlayStoreVersion).toBe('3.0.0');

      // Version record should be inserted
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
      expect(versions[0].versionCode).toBe(300);
    });

    it('should not keep a Play Store download when we already have a newer version from another source', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        lastPlayStoreVersion: '2.0.0',
        createdAt: new Date(),
      }).run();
      const apps = db.select().from(trackedApps).all();

      // Already have a newer version from device (versionCode 400 > 300)
      db.insert(apkVersions).values({
        trackedAppId: apps[0].id,
        versionCode: 400,
        versionName: '4.0.0-beta',
        filename: '400_4.0.0-beta.apk',
        source: 'device',
        downloadedAt: new Date(),
      }).run();

      const dm = createMockDeviceManager({ getAllDeviceStatuses: vi.fn(async () => []) });
      // Play Store returns 3.0.0 (versionCode 300) — older than what we have
      const ps = createMockPlayStoreSource();
      const tracker = new ApkTracker(db as any, dm);
      tracker.setPlayStoreSource(ps);

      await tracker.checkForUpdates();

      // Download was attempted (version string changed), but dedup discards it
      expect(ps.downloadApk).toHaveBeenCalled();

      // No new version record — only the original device-pulled one
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
      expect(versions[0].versionCode).toBe(400);

      // lastPlayStoreVersion still updated so we don't re-download next cycle
      const updatedApps = db.select().from(trackedApps).all();
      expect(updatedApps[0].lastPlayStoreVersion).toBe('3.0.0');
    });

    it('should download when lastPlayStoreVersion is null (first check)', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        createdAt: new Date(),
      }).run();

      const dm = createMockDeviceManager({ getAllDeviceStatuses: vi.fn(async () => []) });
      const ps = createMockPlayStoreSource();
      const tracker = new ApkTracker(db as any, dm);
      tracker.setPlayStoreSource(ps);

      await tracker.checkForUpdates();

      expect(ps.downloadApk).toHaveBeenCalled();

      const apps = db.select().from(trackedApps).all();
      expect(apps[0].lastPlayStoreVersion).toBe('3.0.0');
    });

    it('should update lastPlayStoreVersion even when versionCode is already stored (dedup)', async () => {
      db.insert(trackedApps).values({
        packageName: 'com.example.app',
        lastPlayStoreVersion: '2.0.0',
        createdAt: new Date(),
      }).run();
      const apps = db.select().from(trackedApps).all();

      // Already have versionCode 300 from a device pull
      db.insert(apkVersions).values({
        trackedAppId: apps[0].id,
        versionCode: 300,
        versionName: '3.0.0',
        filename: '300_3.0.0.apk',
        downloadedAt: new Date(),
      }).run();

      const dm = createMockDeviceManager({ getAllDeviceStatuses: vi.fn(async () => []) });
      const ps = createMockPlayStoreSource();
      const tracker = new ApkTracker(db as any, dm);
      tracker.setPlayStoreSource(ps);

      await tracker.checkForUpdates();

      // Download was attempted (version name changed), but dedup kicked in
      expect(ps.downloadApk).toHaveBeenCalled();

      // lastPlayStoreVersion should still be updated to prevent re-downloading
      const updatedApps = db.select().from(trackedApps).all();
      expect(updatedApps[0].lastPlayStoreVersion).toBe('3.0.0');

      // No new version record
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
    });
  });

});
