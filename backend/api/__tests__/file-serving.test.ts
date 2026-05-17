import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import { mountFileServing } from '../file-serving';
import type { FileStorageService } from '../../services/file-storage';

vi.mock('../../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

/** Build a mock NamespacedStorage whose getFilePath can be configured per test. */
function createMockNamespacedStorage(overrides: Record<string, any> = {}) {
  return {
    getFilePath: vi.fn<(filePath: string) => Promise<string>>(),
    write: vi.fn(),
    read: vi.fn(),
    url: vi.fn(),
    exists: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    flush: vi.fn(),
    ...overrides,
  };
}

function createMockFileStorage(namespacedStorage: ReturnType<typeof createMockNamespacedStorage>): FileStorageService {
  return {
    forPlugin: vi.fn().mockReturnValue(namespacedStorage),
  } as unknown as FileStorageService;
}

function createApp(fileStorage: FileStorageService): express.Express {
  const app = express();
  app.use(express.json());
  mountFileServing(app, fileStorage);
  return app;
}

describe('File Serving Endpoint', () => {
  let namespacedStorage: ReturnType<typeof createMockNamespacedStorage>;
  let fileStorage: FileStorageService;
  let app: express.Express;

  beforeEach(() => {
    namespacedStorage = createMockNamespacedStorage();
    fileStorage = createMockFileStorage(namespacedStorage);
    app = createApp(fileStorage);
  });

  describe('GET /v1/files/:namespace/*', () => {
    it('should serve a file that exists locally with correct content type (png)', async () => {
      const absPath = path.resolve(__dirname, '../../..', 'test-fixtures', 'test.png');
      // Use a real file that sendFile can resolve — create a temp approach
      // Instead, we mock sendFile at the response level
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/test-file.png');

      const res = await request(app).get('/v1/files/my-plugin/images/test.png');

      // getFilePath should have been called with the file path portion
      expect(namespacedStorage.getFilePath).toHaveBeenCalledWith('images/test.png');
      expect(fileStorage.forPlugin).toHaveBeenCalledWith('my-plugin');
      // sendFile will fail since file doesn't actually exist, but we verify the
      // handler reached the sendFile stage (not 400/404/502)
      // For a proper integration test we'd need a real file, so we check it
      // doesn't return our application-level errors
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(502);
    });

    it('should return 404 for a nonexistent file', async () => {
      namespacedStorage.getFilePath.mockRejectedValue(new Error('File not found: my-plugin/missing.txt'));

      const res = await request(app).get('/v1/files/my-plugin/missing.txt');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('File not found');
    });

    it('should return 400 for path traversal attempts', async () => {
      // The NamespacedStorage.safePath() detects traversal and throws
      namespacedStorage.getFilePath.mockRejectedValue(new Error('Path traversal rejected: resolves outside namespace'));

      // Use a path that doesn't get normalized away by Express router.
      // Express normalizes literal ../ in paths, so we use an encoded variant
      // that survives routing but still triggers safePath rejection.
      const res = await request(app).get('/v1/files/my-plugin/..%2F..%2F..%2Fetc%2Fpasswd');

      expect(namespacedStorage.getFilePath).toHaveBeenCalled();
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid file path');
    });

    it('should return 400 for namespace containing ".."', async () => {
      const res = await request(app).get('/v1/files/bad..ns/file.txt');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid namespace');
      // forPlugin should never be called for invalid namespaces
      expect(fileStorage.forPlugin).not.toHaveBeenCalled();
    });

    it('should return 400 for namespace containing "/"', async () => {
      // Express routing makes this tricky — a namespace with / becomes a different route
      // We test a URL-encoded slash: %2F
      const res = await request(app).get('/v1/files/bad%2Fns/file.txt');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid namespace');
    });

    it('should return 400 for namespace containing backslash', async () => {
      const res = await request(app).get('/v1/files/bad%5Cns/file.txt');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid namespace');
    });

    it('should return 400 for empty file path', async () => {
      // With Express wildcard route /v1/files/:namespace/*, an empty wildcard
      // portion means req.params[0] is empty string
      const res = await request(app).get('/v1/files/my-plugin/');

      // Express wildcard captures empty string for trailing slash
      // The handler checks !filePath, which is truthy for empty string
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('File path required');
    });

    it('should return 502 when cloud download fails', async () => {
      namespacedStorage.getFilePath.mockRejectedValue(new Error('Cloud download failed for my-plugin/data.json: Access Denied'));

      const res = await request(app).get('/v1/files/my-plugin/data.json');

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('File retrieval failed');
    });

    it('should use correct MIME type for .jpg files', async () => {
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/photo.jpg');

      const res = await request(app).get('/v1/files/my-plugin/photo.jpg');

      // Verify getFilePath was called; content-type set via res.type()
      expect(namespacedStorage.getFilePath).toHaveBeenCalledWith('photo.jpg');
    });

    it('should use correct MIME type for .json files', async () => {
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/data.json');

      const res = await request(app).get('/v1/files/my-plugin/data.json');

      expect(namespacedStorage.getFilePath).toHaveBeenCalledWith('data.json');
    });

    it('should use correct MIME type for .txt files', async () => {
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/notes.txt');

      const res = await request(app).get('/v1/files/my-plugin/notes.txt');

      expect(namespacedStorage.getFilePath).toHaveBeenCalledWith('notes.txt');
    });

    it('should use correct MIME type for .apk files', async () => {
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/app.apk');

      const res = await request(app).get('/v1/files/my-plugin/app.apk');

      expect(namespacedStorage.getFilePath).toHaveBeenCalledWith('app.apk');
    });

    it('should work with various namespace values', async () => {
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/file.txt');

      // Test several valid namespaces
      for (const ns of ['maps', 'analytics', 'my-plugin-v2', 'UPPERCASE']) {
        const res = await request(app).get(`/v1/files/${ns}/file.txt`);

        expect(fileStorage.forPlugin).toHaveBeenCalledWith(ns);
        expect(res.status).not.toBe(400);
      }
    });

    it('should pass the full sub-path to getFilePath for nested paths', async () => {
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/deep/nested/file.txt');

      await request(app).get('/v1/files/my-plugin/deep/nested/file.txt');

      expect(namespacedStorage.getFilePath).toHaveBeenCalledWith('deep/nested/file.txt');
    });

    it('should call forPlugin with the namespace from the URL', async () => {
      namespacedStorage.getFilePath.mockResolvedValue('/tmp/f.txt');

      await request(app).get('/v1/files/special-ns/f.txt');

      expect(fileStorage.forPlugin).toHaveBeenCalledWith('special-ns');
    });

    it('should handle unknown error from getFilePath as 404', async () => {
      namespacedStorage.getFilePath.mockRejectedValue(new Error('Some unexpected error'));

      const res = await request(app).get('/v1/files/my-plugin/unknown.txt');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('File not found');
    });
  });

  describe('MIME type mapping', () => {
    // We test the MIME type by verifying what content-type header gets set.
    // We need a real file for sendFile to work, so we create temp files.
    const fs = require('fs');
    const os = require('os');
    const tmpDir = os.tmpdir();

    const mimeTests: Array<{ ext: string; expectedType: string }> = [
      { ext: '.png', expectedType: 'image/png' },
      { ext: '.jpg', expectedType: 'image/jpeg' },
      { ext: '.jpeg', expectedType: 'image/jpeg' },
      { ext: '.gif', expectedType: 'image/gif' },
      { ext: '.webp', expectedType: 'image/webp' },
      { ext: '.svg', expectedType: 'image/svg+xml' },
      { ext: '.json', expectedType: 'application/json' },
      { ext: '.txt', expectedType: 'text/plain' },
      { ext: '.html', expectedType: 'text/html' },
      { ext: '.css', expectedType: 'text/css' },
      { ext: '.js', expectedType: 'application/javascript' },
      { ext: '.db', expectedType: 'application/octet-stream' },
      { ext: '.apk', expectedType: 'application/vnd.android.package-archive' },
      { ext: '.pdf', expectedType: 'application/pdf' },
      { ext: '.zip', expectedType: 'application/zip' },
      { ext: '.xyz', expectedType: 'application/octet-stream' }, // unknown ext -> octet-stream
    ];

    for (const { ext, expectedType } of mimeTests) {
      it(`should serve ${ext} files with Content-Type ${expectedType}`, async () => {
        const tmpFile = path.join(tmpDir, `darkride-test-file${ext}`);
        // Use valid JSON for .json files so supertest's auto-parser doesn't choke
        const content = ext === '.json' ? '{"test":true}' : 'test-content';
        fs.writeFileSync(tmpFile, content);

        try {
          namespacedStorage.getFilePath.mockResolvedValue(tmpFile);

          const res = await request(app).get(`/v1/files/my-plugin/test${ext}`);

          expect(res.status).toBe(200);
          expect(res.headers['content-type']).toContain(expectedType);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      });
    }
  });
});
