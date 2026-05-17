import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerCloudEndpoints } from './cloud';
import type { FileStorageService, CloudStatus } from '../services/file-storage';
import type { CloudStorageService, ListResult } from '../services/cloud-storage';

function createMockFileSync(overrides: Partial<FileStorageService> = {}): FileStorageService {
  return {
    getStatus: vi.fn<() => CloudStatus>().mockReturnValue({
      configured: true,
      localCacheUsageMb: 120,
      localCacheBudgetMb: 5000,
      filesTracked: 42,
      filesCloudOnly: 10,
      pendingUploads: 3,
      errors: [],
    }),
    removeFile: vi.fn<(cloudKey: string) => Promise<void>>().mockResolvedValue(undefined),
    getDirectUrl: vi.fn<(cloudKey: string) => Promise<string | null>>().mockResolvedValue(
      'https://bucket.s3.amazonaws.com/apks/com.example/100_1.0.apk?signed=abc',
    ),
    retryUpload: vi.fn<(cloudKey: string) => void>(),
    ...overrides,
  } as unknown as FileStorageService;
}

function createMockCloudStorage(overrides: Partial<CloudStorageService> = {}): CloudStorageService {
  return {
    headBucket: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    listObjects: vi.fn<(prefix: string, delimiter: string) => Promise<ListResult>>().mockResolvedValue({
      prefixes: ['apks/', 'backups/'],
      files: [{ key: 'readme.txt', size: 1024, lastModified: new Date('2026-01-01') }],
    }),
    ...overrides,
  } as unknown as CloudStorageService;
}

function createApp(
  fileSync: FileStorageService,
  cloudStorage: CloudStorageService,
  onReconfigure?: () => void,
) {
  clearEndpoints();
  registerCloudEndpoints(fileSync, cloudStorage, onReconfigure);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Cloud API Endpoints', () => {
  let fileSync: FileStorageService;
  let cloudStorage: CloudStorageService;
  let app: express.Express;

  beforeEach(() => {
    fileSync = createMockFileSync();
    cloudStorage = createMockCloudStorage();
    app = createApp(fileSync, cloudStorage, vi.fn());
  });

  describe('GET /v1/cloud/status', () => {
    it('should return status from fileSync.getStatus()', async () => {
      const res = await request(app).get('/v1/cloud/status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.configured).toBe(true);
      expect(res.body.data.filesTracked).toBe(42);
      expect(res.body.data.pendingUploads).toBe(3);
      expect(fileSync.getStatus).toHaveBeenCalledOnce();
    });

    it('should return 500 when getStatus throws', async () => {
      (fileSync.getStatus as any).mockImplementation(() => {
        throw new Error('DB read failed');
      });

      const res = await request(app).get('/v1/cloud/status');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('DB read failed');
    });
  });

  describe('POST /v1/cloud/test', () => {
    it('should return success when headBucket resolves', async () => {
      const res = await request(app).post('/v1/cloud/test');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Connection successful');
      expect(cloudStorage.headBucket).toHaveBeenCalledOnce();
    });

    it('should return error when headBucket rejects', async () => {
      (cloudStorage.headBucket as any).mockRejectedValue(new Error('Access Denied'));

      const res = await request(app).post('/v1/cloud/test');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Access Denied');
    });
  });

  describe('GET /v1/cloud/browse', () => {
    it('should pass prefix and delimiter to listObjects', async () => {
      const res = await request(app)
        .get('/v1/cloud/browse')
        .query({ prefix: 'apks/', delimiter: '/' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.prefixes).toEqual(['apks/', 'backups/']);
      expect(res.body.data.files).toHaveLength(1);
      expect(cloudStorage.listObjects).toHaveBeenCalledWith('apks/', '/');
    });

    it('should use defaults when no query params provided', async () => {
      const res = await request(app).get('/v1/cloud/browse');

      expect(res.status).toBe(200);
      expect(cloudStorage.listObjects).toHaveBeenCalledWith('', '/');
    });

    it('should return 500 when listObjects throws', async () => {
      (cloudStorage.listObjects as any).mockRejectedValue(new Error('Network error'));

      const res = await request(app).get('/v1/cloud/browse');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Network error');
    });
  });

  describe('POST /v1/cloud/configure', () => {
    it('should call onReconfigure callback', async () => {
      const onReconfigure = vi.fn();
      app = createApp(fileSync, cloudStorage, onReconfigure);

      const res = await request(app).post('/v1/cloud/configure');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Cloud storage reconfigured');
      expect(onReconfigure).toHaveBeenCalledOnce();
    });

    it('should return 500 when onReconfigure throws', async () => {
      const onReconfigure = vi.fn().mockImplementation(() => {
        throw new Error('Config reload failed');
      });
      app = createApp(fileSync, cloudStorage, onReconfigure);

      const res = await request(app).post('/v1/cloud/configure');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Config reload failed');
    });

    it('should not register endpoint when onReconfigure is not provided', async () => {
      app = createApp(fileSync, cloudStorage);

      const res = await request(app).post('/v1/cloud/configure');

      // No matching route registered, Express returns 404
      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/cloud/delete/*', () => {
    it('should call fileSync.removeFile with the cloud key', async () => {
      const res = await request(app)
        .post('/v1/cloud/delete/apks/com.example/100_1.0.apk');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(fileSync.removeFile).toHaveBeenCalledWith('apks/com.example/100_1.0.apk');
    });

    it('should return 500 when removeFile throws', async () => {
      (fileSync.removeFile as any).mockRejectedValue(new Error('Delete failed'));

      const res = await request(app)
        .post('/v1/cloud/delete/apks/com.example/100_1.0.apk');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Delete failed');
    });
  });

  describe('POST /v1/cloud/retry/*', () => {
    it('should call fileSync.retryUpload with the cloud key', async () => {
      const res = await request(app)
        .post('/v1/cloud/retry/apks/com.example/100_1.0.apk');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(fileSync.retryUpload).toHaveBeenCalledWith('apks/com.example/100_1.0.apk');
    });

    it('should return 500 when retryUpload throws', async () => {
      (fileSync.retryUpload as any).mockImplementation(() => {
        throw new Error('DB error');
      });

      const res = await request(app)
        .post('/v1/cloud/retry/apks/com.example/100_1.0.apk');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('DB error');
    });
  });

  describe('GET /v1/cloud/download/*', () => {
    it('should return presigned download URL', async () => {
      const res = await request(app)
        .get('/v1/cloud/download/apks/com.example/100_1.0.apk');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toContain('https://bucket.s3.amazonaws.com');
      expect(fileSync.getDirectUrl).toHaveBeenCalledWith('apks/com.example/100_1.0.apk');
    });

    it('should return 404 when getDirectUrl returns null', async () => {
      (fileSync.getDirectUrl as any).mockResolvedValue(null);

      const res = await request(app)
        .get('/v1/cloud/download/apks/com.example/100_1.0.apk');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('File not available or cloud not configured');
    });

    it('should return 500 when getDirectUrl throws', async () => {
      (fileSync.getDirectUrl as any).mockRejectedValue(new Error('Presign error'));

      const res = await request(app)
        .get('/v1/cloud/download/apks/com.example/100_1.0.apk');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Presign error');
    });
  });
});
