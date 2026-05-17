import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CloudStorageService, type CloudStorageConfig } from './cloud-storage';

// vi.hoisted runs before vi.mock hoisting, so these are available in the factories
const { mockSend, mockDestroy, MockS3Client, mockGetSignedUrl, mockMkdirSync, mockCreateReadStream, mockCreateWriteStream, mockPipeline, mockStatSync, mockReadFileSync, mockExistsSync, mockWriteFileSync } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockDestroy = vi.fn();
  const MockS3Client = vi.fn().mockImplementation(() => ({
    send: mockSend,
    destroy: mockDestroy,
  }));
  const mockGetSignedUrl = vi.fn().mockResolvedValue('https://example.com/signed-url');
  const mockMkdirSync = vi.fn();
  const mockCreateReadStream = vi.fn().mockReturnValue('mock-read-stream');
  const mockCreateWriteStream = vi.fn().mockReturnValue('mock-write-stream');
  const mockPipeline = vi.fn().mockResolvedValue(undefined);
  const mockStatSync = vi.fn().mockReturnValue({ isDirectory: () => false, size: 1000 });
  const mockReadFileSync = vi.fn().mockReturnValue(Buffer.from('mock-file-content'));
  const mockExistsSync = vi.fn().mockReturnValue(false);
  const mockWriteFileSync = vi.fn();
  return { mockSend, mockDestroy, MockS3Client, mockGetSignedUrl, mockMkdirSync, mockCreateReadStream, mockCreateWriteStream, mockPipeline, mockStatSync, mockReadFileSync, mockExistsSync, mockWriteFileSync };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: MockS3Client,
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
  HeadBucketCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock('fs', () => ({
  default: {
    createReadStream: mockCreateReadStream,
    createWriteStream: mockCreateWriteStream,
    mkdirSync: mockMkdirSync,
    statSync: mockStatSync,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    writeFileSync: mockWriteFileSync,
  },
}));

vi.mock('stream/promises', () => ({
  pipeline: mockPipeline,
}));

// Import the mocked command constructors for assertion
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

function makeConfig(overrides: Partial<CloudStorageConfig> = {}): CloudStorageConfig {
  return {
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKey: 'AKIATEST',
    secretKey: 'secret123',
    provider: 's3',
    ...overrides,
  };
}

describe('CloudStorageService', () => {
  let service: CloudStorageService;

  beforeEach(() => {
    // Clear call history without wiping mockImplementation
    mockSend.mockClear();
    mockDestroy.mockClear();
    mockGetSignedUrl.mockClear().mockResolvedValue('https://example.com/signed-url');
    MockS3Client.mockClear();
    vi.mocked(PutObjectCommand).mockClear();
    vi.mocked(GetObjectCommand).mockClear();
    vi.mocked(DeleteObjectCommand).mockClear();
    vi.mocked(HeadObjectCommand).mockClear();
    vi.mocked(HeadBucketCommand).mockClear();
    vi.mocked(ListObjectsV2Command).mockClear();
    service = new CloudStorageService();
  });

  describe('isConfigured', () => {
    it('returns false initially', () => {
      expect(service.isConfigured()).toBe(false);
    });

    it('returns true after configure with valid settings', () => {
      service.configure(makeConfig());
      expect(service.isConfigured()).toBe(true);
    });

    it('returns false if missing required fields', () => {
      service.configure(makeConfig({ accessKey: '' }));
      expect(service.isConfigured()).toBe(false);
    });

    it('returns false if endpoint is empty', () => {
      service.configure(makeConfig({ endpoint: '' }));
      expect(service.isConfigured()).toBe(false);
    });

    it('returns false if bucket is empty', () => {
      service.configure(makeConfig({ bucket: '' }));
      expect(service.isConfigured()).toBe(false);
    });
  });

  describe('configure', () => {
    it('destroys previous client on reconfigure', () => {
      service.configure(makeConfig());
      expect(mockDestroy).not.toHaveBeenCalled();

      service.configure(makeConfig({ bucket: 'new-bucket' }));
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('clears presign cache on reconfigure', async () => {
      service.configure(makeConfig());
      mockSend.mockResolvedValue({});

      await service.presignUrl('test-key');
      expect(service.getPresignCacheSize()).toBe(1);

      service.configure(makeConfig());
      expect(service.getPresignCacheSize()).toBe(0);
    });

    it('uses forcePathStyle for B2 provider', () => {
      service.configure(makeConfig({ provider: 'b2' }));
      expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({
        forcePathStyle: true,
      }));
    });

    it('uses forcePathStyle for custom provider', () => {
      service.configure(makeConfig({ provider: 'custom' }));
      expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({
        forcePathStyle: true,
      }));
    });

    it('does not use forcePathStyle for s3 provider', () => {
      service.configure(makeConfig({ provider: 's3' }));
      expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({
        forcePathStyle: false,
      }));
    });

    it('prepends https:// if endpoint does not start with http', () => {
      service.configure(makeConfig({ endpoint: 's3.us-east-1.amazonaws.com' }));
      expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({
        endpoint: 'https://s3.us-east-1.amazonaws.com',
      }));
    });

    it('keeps endpoint as-is if it starts with http', () => {
      service.configure(makeConfig({ endpoint: 'http://localhost:9000' }));
      expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({
        endpoint: 'http://localhost:9000',
      }));
    });
  });

  describe('unconfigured operations', () => {
    it('upload is a no-op', async () => {
      await service.upload('key', '/tmp/file');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('download returns error', async () => {
      const result = await service.download('key', '/tmp/file');
      expect(result).toEqual({ error: 'Cloud storage not configured' });
    });

    it('delete is a no-op', async () => {
      await service.delete('key');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('exists returns false', async () => {
      const result = await service.exists('key');
      expect(result).toBe(false);
    });

    it('presignUrl returns null', async () => {
      const result = await service.presignUrl('key');
      expect(result).toBeNull();
    });

    it('headBucket throws', async () => {
      await expect(service.headBucket()).rejects.toThrow('Cloud storage not configured');
    });

    it('listObjects returns empty', async () => {
      const result = await service.listObjects('prefix/');
      expect(result).toEqual({ prefixes: [], files: [] });
    });
  });

  describe('configured operations', () => {
    beforeEach(() => {
      service.configure(makeConfig());
    });

    it('upload calls S3Client.send with PutObjectCommand', async () => {
      mockSend.mockResolvedValue({});

      await service.upload('backups/test.db', '/tmp/test.db');
      expect(mockSend).toHaveBeenCalled();
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'backups/test.db',
        Body: 'mock-read-stream',
      });
    });

    it('upload throws after exhausting retries', async () => {
      mockSend.mockRejectedValue(new Error('network error'));

      await expect(service.upload('key', '/tmp/file')).rejects.toThrow(/network error/);
    });

    it('upload skips identical files on second upload', async () => {
      mockSend.mockResolvedValue({});

      await service.upload('backups/test.db', '/tmp/test.db');
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Same file content (mockReadFileSync returns same buffer) → should skip
      mockSend.mockClear();
      await service.upload('backups/test.db', '/tmp/test.db');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('upload re-uploads when file content changes', async () => {
      mockSend.mockResolvedValue({});

      await service.upload('backups/test.db', '/tmp/test.db');
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Different content → should upload again
      mockSend.mockClear();
      mockReadFileSync.mockReturnValueOnce(Buffer.from('different-content'));
      await service.upload('backups/test.db', '/tmp/test.db');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('upload skips directories without crashing', async () => {
      mockStatSync.mockReturnValueOnce({ isDirectory: () => true, size: 0 });

      await service.upload('apks/split-dir', '/tmp/split-dir');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('download calls S3Client.send with GetObjectCommand', async () => {
      const mockBody = { pipe: vi.fn() };
      mockSend.mockResolvedValue({ Body: mockBody });

      const result = await service.download('backups/test.db', '/tmp/test.db');
      expect(mockSend).toHaveBeenCalled();
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'backups/test.db',
      });
      expect(result).toEqual({});
    });

    it('download creates parent directory', async () => {
      const mockBody = { pipe: vi.fn() };
      mockSend.mockResolvedValue({ Body: mockBody });

      await service.download('key', '/tmp/nested/dir/file.db');
      expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/nested/dir', { recursive: true });
    });

    it('download returns error on failure', async () => {
      mockSend.mockRejectedValue(new Error('access denied'));

      const result = await service.download('key', '/tmp/file');
      expect(result).toEqual({ error: 'access denied' });
    });

    it('delete calls S3Client.send with DeleteObjectCommand', async () => {
      mockSend.mockResolvedValue({});

      await service.delete('backups/old.db');
      expect(mockSend).toHaveBeenCalled();
      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'backups/old.db',
      });
    });

    it('exists returns true when object exists', async () => {
      mockSend.mockResolvedValue({});

      const result = await service.exists('backups/test.db');
      expect(result).toBe(true);
    });

    it('exists returns false on 404', async () => {
      const err = new Error('Not Found');
      (err as any).name = 'NotFound';
      mockSend.mockRejectedValue(err);

      const result = await service.exists('missing-key');
      expect(result).toBe(false);
    });

    it('headBucket calls S3Client.send with HeadBucketCommand', async () => {
      mockSend.mockResolvedValue({});

      await service.headBucket();
      expect(mockSend).toHaveBeenCalled();
      expect(HeadBucketCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
      });
    });

    it('listObjects maps CommonPrefixes and Contents', async () => {
      mockSend.mockResolvedValue({
        CommonPrefixes: [
          { Prefix: 'backups/device1/' },
          { Prefix: 'backups/device2/' },
        ],
        Contents: [
          { Key: 'backups/', Size: 0, LastModified: new Date('2026-01-01') },
          { Key: 'backups/file1.db', Size: 1024, LastModified: new Date('2026-01-15') },
          { Key: 'backups/file2.db', Size: 2048, LastModified: undefined },
        ],
      });

      const result = await service.listObjects('backups/');
      expect(result.prefixes).toEqual(['backups/device1/', 'backups/device2/']);
      // The prefix key itself (backups/) is excluded
      expect(result.files).toEqual([
        { key: 'backups/file1.db', size: 1024, lastModified: new Date('2026-01-15') },
        { key: 'backups/file2.db', size: 2048, lastModified: null },
      ]);
    });

    it('listObjects handles empty response', async () => {
      mockSend.mockResolvedValue({});

      const result = await service.listObjects('empty/');
      expect(result).toEqual({ prefixes: [], files: [] });
    });
  });

  describe('presign URL caching', () => {
    beforeEach(() => {
      service.configure(makeConfig());
      mockSend.mockResolvedValue({});
    });

    it('caches presigned URLs', async () => {
      const url1 = await service.presignUrl('test-key');
      const url2 = await service.presignUrl('test-key');

      expect(url1).toBe('https://example.com/signed-url');
      expect(url2).toBe('https://example.com/signed-url');
      // getSignedUrl should only be called once due to caching
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('returns different URLs for different keys', async () => {
      await service.presignUrl('key1');
      await service.presignUrl('key2');

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
      expect(service.getPresignCacheSize()).toBe(2);
    });

    it('regenerates URL when cache entry is near expiry', async () => {
      // First call — caches the URL with 10 min expiry
      await service.presignUrl('test-key', 600);

      // Advance time so there is less than 10 min until expiry
      const originalNow = Date.now;
      Date.now = () => originalNow() + 5 * 60 * 1000; // 5 min later, only 5 min left

      await service.presignUrl('test-key', 600);

      Date.now = originalNow;

      // Should have been called twice since cache entry was near expiry
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    });
  });
});
