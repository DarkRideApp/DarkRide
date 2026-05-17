import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAppEndpoints, clearAppListCache } from './apps';

const { trackedApps, apkVersions, analysisJobs } = schema;

// Mock device-manager's adbShell, adbCommand, and adbPull
vi.mock('../services/device-manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/device-manager')>();
  return {
    ...original,
    adbShell: vi.fn(),
    adbCommand: vi.fn(),
    adbPull: vi.fn(),
  };
});

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// Mock fs for pull-apk tests (keep real mkdtempSync/writeFileSync/unlinkSync/rmdirSync for batch script)
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  const mockStatSync = vi.fn(() => ({ size: 12345, isDirectory: () => false }));
  const mockCreateReadStream = vi.fn(() => {
    const { Readable } = require('stream');
    const s = new Readable();
    s.push('APK_DATA');
    s.push(null);
    return s;
  });
  return {
    ...original,
    default: {
      ...original,
      mkdirSync: vi.fn(),
      statSync: mockStatSync,
      existsSync: vi.fn(() => true),
      createReadStream: mockCreateReadStream,
    },
    mkdirSync: vi.fn(),
    statSync: mockStatSync,
    existsSync: vi.fn(() => true),
    createReadStream: mockCreateReadStream,
  };
});

import { adbShell, adbCommand, adbPull } from '../services/device-manager';
import { createTestDb } from '../test-utils/create-test-db';

const mockedAdbShell = vi.mocked(adbShell);
const mockedAdbCommand = vi.mocked(adbCommand);
const mockedAdbPull = vi.mocked(adbPull);

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  const mockDeviceManager = {
    isOnline: vi.fn(() => true),
    isBusy: vi.fn(() => false),
    getAllDeviceStatuses: vi.fn(async () => []),
  } as any;
  const mockApkTracker = {
    checkForUpdates: vi.fn(async () => {}),
  } as any;
  const mockAnalyzer = {
    enqueue: vi.fn().mockResolvedValue(1),
    getJobStatusForVersion: vi.fn().mockReturnValue(null),
    getJobStatus: vi.fn().mockReturnValue(null),
    isAiAgentRunning: vi.fn().mockReturnValue(false),
  };
  registerAppEndpoints(mockDeviceManager, db as any, mockApkTracker, mockAnalyzer as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return { app, mockDeviceManager, mockApkTracker, mockAnalyzer };
}

describe('Apps API', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;
  let mockDeviceManager: any;
  let mockApkTracker: any;
  let mockAnalyzer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear app list cache so tests don't bleed into each other
    clearAppListCache('DEV001');
    clearAppListCache('DEV002');
    clearAppListCache('DEV003');
    db = createTestDb();
    const setup = createApp(db);
    app = setup.app;
    mockDeviceManager = setup.mockDeviceManager;
    mockApkTracker = setup.mockApkTracker;
    mockAnalyzer = setup.mockAnalyzer;
  });

  describe('POST /v1/apps/track', () => {
    it('should create a tracked app', async () => {
      const res = await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app', appName: 'Example App' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.packageName).toBe('com.example.app');
      expect(res.body.data.appName).toBe('Example App');
    });

    it('should return existing tracked app on duplicate', async () => {
      await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app' });

      const res = await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should require packageName', async () => {
      const res = await request(app)
        .post('/v1/apps/track')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /v1/apps/track/:id', () => {
    it('should delete a tracked app and its versions', async () => {
      // Create tracked app
      const createRes = await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app' });

      const id = createRes.body.data.id;

      // Add a version manually
      db.insert(apkVersions).values({
        trackedAppId: id,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        fileSize: 1000,
        downloadedAt: new Date(),
      }).run();

      const delRes = await request(app).delete(`/v1/apps/track/${id}`);

      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      // Verify versions are also deleted
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(0);
    });

    it('should return 404 for unknown id', async () => {
      const res = await request(app).delete('/v1/apps/track/999');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/apps/tracked', () => {
    it('should list tracked apps with version info', async () => {
      // Create tracked app
      await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app', appName: 'Example' });

      const tracked = db.select().from(trackedApps).all();
      const appId = tracked[0].id;

      // Add versions
      db.insert(apkVersions).values({
        trackedAppId: appId,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        fileSize: 1000,
        downloadedAt: new Date(),
      }).run();
      db.insert(apkVersions).values({
        trackedAppId: appId,
        versionCode: 101,
        versionName: '1.0.1',
        filename: '101_1.0.1.apk',
        fileSize: 2000,
        downloadedAt: new Date(),
      }).run();

      const res = await request(app).get('/v1/apps/tracked');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].packageName).toBe('com.example.app');
      expect(res.body.data[0].versionCount).toBe(2);
      expect(res.body.data[0].latestVersion.versionCode).toBe(101);
    });

    it('should return empty list when no apps tracked', async () => {
      const res = await request(app).get('/v1/apps/tracked');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('GET /v1/apps/versions/:trackedAppId', () => {
    it('should list versions sorted by versionCode desc', async () => {
      await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app' });

      const tracked = db.select().from(trackedApps).all();
      const appId = tracked[0].id;

      db.insert(apkVersions).values({
        trackedAppId: appId,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        downloadedAt: new Date(),
      }).run();
      db.insert(apkVersions).values({
        trackedAppId: appId,
        versionCode: 200,
        versionName: '2.0.0',
        filename: '200_2.0.0.apk',
        downloadedAt: new Date(),
      }).run();

      const res = await request(app).get(`/v1/apps/versions/${appId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].versionCode).toBe(200); // highest first
      expect(res.body.data[1].versionCode).toBe(100);
    });

    it('should return 404 for unknown trackedAppId', async () => {
      const res = await request(app).get('/v1/apps/versions/999');
      expect(res.status).toBe(404);
    });

    it('includes availability state on each version row', async () => {
      await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app' });

      const tracked = db.select().from(trackedApps).all();
      const appId = tracked[0].id;

      db.insert(apkVersions).values({
        trackedAppId: appId,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        downloadedAt: new Date(),
      }).run();

      const res = await request(app).get(`/v1/apps/versions/${appId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      // No cloud_files rows, but the module-level fs mock in this file makes
      // existsSync return true unconditionally — so the filesystem fallback
      // in computeVersionAvailability sees all artefacts as locally present.
      // This guards the contract "availability field is present with a
      // valid state value", which was the original intent of this test.
      expect(res.body.data[0].availability).toBe('local');
    });
  });

  describe('GET /v1/apps/download/:versionId', () => {
    it('should stream APK file', async () => {
      // Setup tracked app + version
      await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app' });

      const tracked = db.select().from(trackedApps).all();
      db.insert(apkVersions).values({
        trackedAppId: tracked[0].id,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        downloadedAt: new Date(),
      }).run();

      const versions = db.select().from(apkVersions).all();
      const res = await request(app).get(`/v1/apps/download/${versions[0].id}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('android.package-archive');
    });

    it('should return 404 for unknown versionId', async () => {
      const res = await request(app).get('/v1/apps/download/999');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/device/apps/:deviceId', () => {
    it('should list installed apps with tracked status', async () => {
      // Mock the batch script execution
      mockedAdbShell.mockImplementation(async (deviceId: string, cmd: string) => {
        if (cmd.startsWith('sh /data/local/tmp/darkride_list_apps.sh')) {
          return 'APP\tcom.example.app\t100\t1.0.0\tExample App\nAPP\tcom.other.app\t50\t2.0.0\t';
        }
        return '';
      });
      mockedAdbCommand.mockResolvedValue('');

      // Track one app
      await request(app)
        .post('/v1/apps/track')
        .send({ packageName: 'com.example.app', appName: 'Example' });

      const res = await request(app).get('/v1/device/apps/DEV001');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);

      const example = res.body.data.find((a: any) => a.packageName === 'com.example.app');
      expect(example.isTracked).toBe(true);
      expect(example.versionCode).toBe(100);
      expect(example.appName).toBe('Example App');

      const other = res.body.data.find((a: any) => a.packageName === 'com.other.app');
      expect(other.isTracked).toBe(false);
      expect(other.versionCode).toBe(50);
    });

    it('should handle apps with no metadata', async () => {
      mockedAdbShell.mockImplementation(async (deviceId: string, cmd: string) => {
        if (cmd.startsWith('sh /data/local/tmp/darkride_list_apps.sh')) {
          return 'APP\tcom.bare.app\t\t\t';
        }
        return '';
      });
      mockedAdbCommand.mockResolvedValue('');

      const res = await request(app).get('/v1/device/apps/DEV001');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].packageName).toBe('com.bare.app');
      expect(res.body.data[0].versionCode).toBeNull();
      expect(res.body.data[0].appName).toBeNull();
    });

    it('should return error if device offline', async () => {
      mockDeviceManager.isOnline.mockReturnValue(false);
      const res = await request(app).get('/v1/device/apps/DEV001');
      expect(res.status).toBe(400);
    });

    it('should return cached data on second request without force', async () => {
      clearAppListCache('DEV001');
      mockedAdbShell.mockImplementation(async (_deviceId: string, cmd: string) => {
        if (cmd.startsWith('sh /data/local/tmp/darkride_list_apps.sh')) {
          return 'APP\tcom.example.app\t100\t1.0.0\tExample App';
        }
        return '';
      });
      mockedAdbCommand.mockResolvedValue('');

      // First request — hits device
      await request(app).get('/v1/device/apps/DEV001');
      const callCountAfterFirst = mockedAdbCommand.mock.calls.length;

      // Second request — should use cache (no new adb calls)
      const res = await request(app).get('/v1/device/apps/DEV001');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(mockedAdbCommand.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('should bypass cache when force=true', async () => {
      clearAppListCache('DEV002');
      mockedAdbShell.mockImplementation(async (_deviceId: string, cmd: string) => {
        if (cmd.startsWith('sh /data/local/tmp/darkride_list_apps.sh')) {
          return 'APP\tcom.example.app\t100\t1.0.0\tExample App';
        }
        return '';
      });
      mockedAdbCommand.mockResolvedValue('');

      // First request — fills cache
      await request(app).get('/v1/device/apps/DEV002');
      const callCountAfterFirst = mockedAdbCommand.mock.calls.length;

      // Force request — should hit device again
      const res = await request(app).get('/v1/device/apps/DEV002?force=true');
      expect(res.status).toBe(200);
      expect(mockedAdbCommand.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
    });

    it('clearAppListCache should remove cache entry for device', async () => {
      clearAppListCache('DEV003');
      mockedAdbShell.mockImplementation(async (_deviceId: string, cmd: string) => {
        if (cmd.startsWith('sh /data/local/tmp/darkride_list_apps.sh')) {
          return 'APP\tcom.example.app\t100\t1.0.0\tExample App';
        }
        return '';
      });
      mockedAdbCommand.mockResolvedValue('');

      // Fill cache
      await request(app).get('/v1/device/apps/DEV003');
      const callCountAfterFirst = mockedAdbCommand.mock.calls.length;

      // Clear cache
      clearAppListCache('DEV003');

      // Next request should hit device again
      await request(app).get('/v1/device/apps/DEV003');
      expect(mockedAdbCommand.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
    });
  });

  describe('GET /v1/device/app-icon/:deviceId/:packageName', () => {
    it('should return null icon when device offline', async () => {
      mockDeviceManager.isOnline.mockReturnValue(false);
      const res = await request(app).get('/v1/device/app-icon/DEV001/com.example.app');
      expect(res.status).toBe(200);
      expect(res.body.data.icon).toBeNull();
    });
  });

  describe('POST /v1/device/pull-apk/:deviceId', () => {
    it('should require packageName', async () => {
      const res = await request(app)
        .post('/v1/device/pull-apk/DEV001')
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return error if device offline', async () => {
      mockDeviceManager.isOnline.mockReturnValue(false);
      const res = await request(app)
        .post('/v1/device/pull-apk/DEV001')
        .send({ packageName: 'com.example.app' });
      expect(res.status).toBe(400);
    });

    it('should pull APK and create version record', async () => {
      mockedAdbShell.mockImplementation(async (deviceId: string, cmd: string) => {
        if (cmd.startsWith('pm path')) {
          return 'package:/data/app/com.example-abc/base.apk';
        }
        if (cmd.startsWith('dumpsys package')) {
          return 'Packages:\n  versionCode=100\n  versionName=1.0.0';
        }
        if (cmd.includes('aapt')) {
          return "application-label:'Example App'";
        }
        return '';
      });
      mockedAdbPull.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/v1/device/pull-apk/DEV001')
        .send({ packageName: 'com.example.app' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.versionCode).toBe(100);

      // Should have created tracked app entry
      const tracked = db.select().from(trackedApps).all();
      expect(tracked).toHaveLength(1);
      expect(tracked[0].packageName).toBe('com.example.app');
    });

    it('should return existing version if already pulled', async () => {
      mockedAdbShell.mockImplementation(async (deviceId: string, cmd: string) => {
        if (cmd.startsWith('pm path')) return 'package:/data/app/base.apk';
        if (cmd.startsWith('dumpsys package')) return 'Packages:\n  versionCode=100\n  versionName=1.0.0';
        if (cmd.includes('aapt')) return '';
        return '';
      });
      mockedAdbPull.mockResolvedValue(undefined);

      // First pull
      await request(app)
        .post('/v1/device/pull-apk/DEV001')
        .send({ packageName: 'com.example.app' });

      // Second pull of same version
      const res = await request(app)
        .post('/v1/device/pull-apk/DEV001')
        .send({ packageName: 'com.example.app' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Should still only have one version record
      const versions = db.select().from(apkVersions).all();
      expect(versions).toHaveLength(1);
    });
  });

  describe('POST /v1/apps/trigger-scan', () => {
    it('should trigger APK scan and return immediately', async () => {
      const res = await request(app).post('/v1/apps/trigger-scan');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('APK scan started');
      expect(mockApkTracker.checkForUpdates).toHaveBeenCalledOnce();
    });
  });

  describe('POST /v1/apps/analyze/:versionId', () => {
    it('should enqueue analysis job', async () => {
      db.insert(trackedApps).values({ packageName: 'com.test', createdAt: new Date() }).run();
      db.insert(apkVersions).values({
        trackedAppId: 1, versionCode: 1, versionName: '1.0', filename: '1_1.0.apk',
        fileSize: 100, downloadedAt: new Date(),
      }).run();

      const res = await request(app).post('/v1/apps/analyze/1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.jobId).toBe(1);
      expect(mockAnalyzer.enqueue).toHaveBeenCalledWith(1);
    });

    it('should return 404 for nonexistent version', async () => {
      const res = await request(app).post('/v1/apps/analyze/999');
      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid id', async () => {
      const res = await request(app).post('/v1/apps/analyze/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/apps/analysis-status/:versionId', () => {
    it('should return null when no job exists', async () => {
      const res = await request(app).get('/v1/apps/analysis-status/1');
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('should return job status', async () => {
      mockAnalyzer.getJobStatusForVersion.mockReturnValueOnce({
        id: 1, apkVersionId: 1, status: 'completed', error: null,
        createdAt: new Date(), startedAt: new Date(), completedAt: new Date(),
      });
      const res = await request(app).get('/v1/apps/analysis-status/1');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
      expect(res.body.data.aiRunning).toBe(false);
    });

    it('should include aiRunning=true while AI review is in flight', async () => {
      mockAnalyzer.getJobStatusForVersion.mockReturnValueOnce({
        id: 1, apkVersionId: 1, status: 'completed', error: null,
        createdAt: new Date(), startedAt: new Date(), completedAt: new Date(),
      });
      mockAnalyzer.isAiAgentRunning.mockReturnValueOnce(true);
      const res = await request(app).get('/v1/apps/analysis-status/1');
      expect(res.status).toBe(200);
      expect(res.body.data.aiRunning).toBe(true);
    });
  });

  describe('GET /v1/device/package-version/:deviceId/:packageName', () => {
    it('should return installed version info', async () => {
      mockedAdbShell.mockResolvedValueOnce(
        'Packages:\n  versionCode=200\n  versionName=2.0.0',
      );
      const res = await request(app).get(
        '/v1/device/package-version/device1/com.example.app',
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        installed: true,
        versionCode: 200,
        versionName: '2.0.0',
      });
    });

    it('should return not installed when device is offline', async () => {
      mockDeviceManager.isOnline.mockReturnValueOnce(false);
      const res = await request(app).get(
        '/v1/device/package-version/device1/com.example.app',
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        installed: false,
        versionCode: null,
        versionName: null,
      });
    });

    it('should return not installed when package not found', async () => {
      mockedAdbShell.mockResolvedValueOnce('');
      const res = await request(app).get(
        '/v1/device/package-version/device1/com.nonexistent',
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        installed: false,
        versionCode: null,
        versionName: null,
      });
    });
  });

  describe('GET /v1/apps/analysis-jobs/recent', () => {
    it('should return empty array when no jobs exist', async () => {
      const res = await request(app).get('/v1/apps/analysis-jobs/recent');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return jobs with app/version info ordered by id desc', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Create tracked app
      db.insert(trackedApps).values({
        id: 1, packageName: 'com.test.app', appName: 'Test App', createdAt: new Date(now * 1000),
      }).run();
      // Create version
      db.insert(apkVersions).values({
        id: 1, trackedAppId: 1, versionCode: 100, versionName: '1.0.0',
        filename: '100.apk', fileSize: 5000, downloadedAt: new Date(now * 1000),
      }).run();
      // Create two jobs
      db.insert(analysisJobs).values({
        id: 1, apkVersionId: 1, status: 'completed', stage: 'done',
        createdAt: new Date((now - 60) * 1000), startedAt: new Date((now - 50) * 1000),
        completedAt: new Date((now - 10) * 1000),
      }).run();
      db.insert(analysisJobs).values({
        id: 2, apkVersionId: 1, status: 'pending',
        createdAt: new Date(now * 1000),
      }).run();

      const res = await request(app).get('/v1/apps/analysis-jobs/recent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      // Ordered by id desc — id 2 first
      expect(res.body.data[0].id).toBe(2);
      expect(res.body.data[0].status).toBe('pending');
      expect(res.body.data[0].trackedAppId).toBe(1);
      expect(res.body.data[0].packageName).toBe('com.test.app');
      expect(res.body.data[0].appName).toBe('Test App');
      expect(res.body.data[0].versionCode).toBe(100);
      expect(res.body.data[0].versionName).toBe('1.0.0');
      expect(res.body.data[1].id).toBe(1);
      expect(res.body.data[1].status).toBe('completed');
    });

    it('should include failed jobs with error field', async () => {
      const now = Math.floor(Date.now() / 1000);
      db.insert(trackedApps).values({
        id: 1, packageName: 'com.fail.app', appName: null, createdAt: new Date(now * 1000),
      }).run();
      db.insert(apkVersions).values({
        id: 1, trackedAppId: 1, versionCode: 50, versionName: '0.5',
        filename: '50.apk', downloadedAt: new Date(now * 1000),
      }).run();
      db.insert(analysisJobs).values({
        id: 1, apkVersionId: 1, status: 'failed', error: 'Decompile error',
        createdAt: new Date(now * 1000),
      }).run();

      const res = await request(app).get('/v1/apps/analysis-jobs/recent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('failed');
      expect(res.body.data[0].error).toBe('Decompile error');
      expect(res.body.data[0].packageName).toBe('com.fail.app');
      expect(res.body.data[0].appName).toBeNull();
    });
  });

});
