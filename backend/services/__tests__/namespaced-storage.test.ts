import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { NamespacedStorageImpl } from '../namespaced-storage';

// --- Test helpers ---

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE cloud_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      cloud_key TEXT NOT NULL UNIQUE,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sync_state TEXT NOT NULL,
      sync_error TEXT,
      retain INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

function createMockCloudStorage(files: Map<string, Buffer> = new Map()) {
  return {
    isConfigured: () => true,
    upload: vi.fn(async (key: string, localPath: string) => {
      files.set(key, fs.readFileSync(localPath));
      return true;
    }),
    download: vi.fn(async (key: string, localPath: string) => {
      const data = files.get(key);
      if (!data) return { error: 'Not found' };
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(localPath, data);
      return {};
    }),
    exists: vi.fn(async (key: string) => files.has(key)),
    delete: vi.fn(async (key: string) => { files.delete(key); }),
    presignUrl: vi.fn(async () => null),
  };
}

function createUnconfiguredCloudStorage() {
  return {
    isConfigured: () => false,
    upload: vi.fn(),
    download: vi.fn(),
    exists: vi.fn(async () => false),
    delete: vi.fn(),
    presignUrl: vi.fn(async () => null),
  };
}

// --- Tests ---

describe('NamespacedStorageImpl', () => {
  let tmpDir: string;
  let originalDataRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-storage-'));
    originalDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = originalDataRoot;
    }
  });

  // ── Basic file operations (no DB, no cloud) ──

  describe('basic operations (no DB, no cloud)', () => {
    it('writes and reads a file', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('subdir/file.txt', Buffer.from('hello world'));
      const result = await storage.read('subdir/file.txt');
      expect(result.toString()).toBe('hello world');
    });

    it('creates nested directories on write', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('a/b/c/d/deep.txt', Buffer.from('deep'));
      expect(fs.existsSync(path.join(tmpDir, 'a', 'b', 'c', 'd', 'deep.txt'))).toBe(true);
    });

    it('overwrites existing file', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('file.txt', Buffer.from('v1'));
      await storage.write('file.txt', Buffer.from('v2'));
      const result = await storage.read('file.txt');
      expect(result.toString()).toBe('v2');
    });

    it('returns correct local path via getFilePath', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('data/test.bin', Buffer.from('x'));
      const filePath = await storage.getFilePath('data/test.bin');
      expect(filePath).toBe(path.join(tmpDir, 'data', 'test.bin'));
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('returns correct URL', () => {
      const storage = new NamespacedStorageImpl('maps', tmpDir, null as any, null as any);
      expect(storage.url('configs/1/tiles/14/0/0.png')).toBe('/v1/files/maps/configs/1/tiles/14/0/0.png');
    });

    it('checks existence on disk', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      expect(await storage.exists('nope.txt')).toBe(false);
      await storage.write('yes.txt', Buffer.from('here'));
      expect(await storage.exists('yes.txt')).toBe(true);
    });

    it('deletes a file from disk', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('delete-me.txt', Buffer.from('bye'));
      await storage.delete('delete-me.txt');
      expect(fs.existsSync(path.join(tmpDir, 'delete-me.txt'))).toBe(false);
    });

    it('lists files under a prefix', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('tiles/14/0/0.png', Buffer.from('a'));
      await storage.write('tiles/14/0/1.png', Buffer.from('b'));
      await storage.write('tiles/15/0/0.png', Buffer.from('c'));
      await storage.write('other/file.txt', Buffer.from('d'));
      const files = await storage.list('tiles/14/');
      expect(files.sort()).toEqual(['tiles/14/0/0.png', 'tiles/14/0/1.png']);
    });

    it('lists all files with empty prefix', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('a.txt', Buffer.from('1'));
      await storage.write('sub/b.txt', Buffer.from('2'));
      const files = await storage.list('');
      expect(files.sort()).toEqual(['a.txt', 'sub/b.txt']);
    });

    it('returns empty list for nonexistent prefix', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      const files = await storage.list('nothing/');
      expect(files).toEqual([]);
    });

    it('throws on read of nonexistent file', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await expect(storage.read('missing.txt')).rejects.toThrow('File not found: test/missing.txt');
    });

    it('throws on getFilePath of nonexistent file', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await expect(storage.getFilePath('missing.txt')).rejects.toThrow('File not found: test/missing.txt');
    });

    it('handles empty buffer write', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await storage.write('empty.bin', Buffer.alloc(0));
      const result = await storage.read('empty.bin');
      expect(result.length).toBe(0);
    });

    it('handles binary data', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
      await storage.write('binary.bin', binary);
      const result = await storage.read('binary.bin');
      expect(result).toEqual(binary);
    });

    it('delete is idempotent for nonexistent file', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await expect(storage.delete('nonexistent.txt')).resolves.not.toThrow();
    });
  });

  // ── Security: path traversal ──

  describe('path traversal protection', () => {
    it('rejects paths with ../', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      // Write a file outside the namespace root
      await expect(storage.write('../../../etc/passwd', Buffer.from('hacked'))).rejects.toThrow();
    });

    it('rejects paths with encoded traversal', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await expect(storage.read('..%2F..%2Fetc%2Fpasswd')).rejects.toThrow();
    });

    it('rejects absolute paths', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      await expect(storage.write('/etc/passwd', Buffer.from('hacked'))).rejects.toThrow();
    });

    it('allows paths that contain .. in directory names', async () => {
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, null as any);
      // "a..b" is a valid directory name, not a traversal
      await storage.write('a..b/file.txt', Buffer.from('ok'));
      expect(await storage.exists('a..b/file.txt')).toBe(true);
    });
  });

  // ── DB tracking ──

  describe('with DB tracking', () => {
    it('tracks written files in cloudFiles table', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('maps', tmpDir, db as any, null as any);

      await storage.write('tiles/0/0/0.png', Buffer.from('tile data'));

      const rows = db.select().from(schema.cloudFiles).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].namespace).toBe('maps');
      expect(rows[0].relativePath).toBe('tiles/0/0/0.png');
      expect(rows[0].cloudKey).toBe('plugins/maps/tiles/0/0/0.png');
      expect(rows[0].syncState).toBe('pending_upload');
      expect(rows[0].fileSize).toBe(9); // 'tile data'.length
      expect(rows[0].retain).toBe(false);
    });

    it('uses custom cloud key prefix when provided', async () => {
      const { db } = createTestDb();
      // forNamespace('apks') would pass cloudKeyPrefix='apks/'
      const storage = new NamespacedStorageImpl('apks', tmpDir, db as any, null as any, 'apks/');

      await storage.write('com.example/v1.apk', Buffer.from('apk data'));

      const rows = db.select().from(schema.cloudFiles).all();
      expect(rows[0].cloudKey).toBe('apks/com.example/v1.apk');
    });

    it('defaults to plugins/{namespace}/ prefix without custom prefix', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('my-plugin', tmpDir, db as any, null as any);

      await storage.write('data.json', Buffer.from('{}'));

      const rows = db.select().from(schema.cloudFiles).all();
      expect(rows[0].cloudKey).toBe('plugins/my-plugin/data.json');
    });

    it('sets retain flag when requested', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, null as any);

      await storage.write('important.db', Buffer.from('keep me'), { retain: true });

      const rows = db.select().from(schema.cloudFiles).all();
      expect(rows[0].retain).toBe(true);
    });

    it('preserves existing retain flag on overwrite without explicit option', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, null as any);

      await storage.write('file.txt', Buffer.from('v1'), { retain: true });
      await storage.write('file.txt', Buffer.from('v2')); // no retain option

      const rows = db.select().from(schema.cloudFiles).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].retain).toBe(true); // preserved
      expect(rows[0].fileSize).toBe(2); // updated
    });

    it('updates existing row on overwrite', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, null as any);

      await storage.write('file.txt', Buffer.from('v1'));
      await storage.write('file.txt', Buffer.from('v2-longer'));

      const rows = db.select().from(schema.cloudFiles).all();
      expect(rows).toHaveLength(1); // upsert, not duplicate
      expect(rows[0].fileSize).toBe(9);
      expect(rows[0].syncState).toBe('pending_upload');
    });

    it('removes DB tracking on delete', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, null as any);

      await storage.write('file.txt', Buffer.from('data'));
      expect(db.select().from(schema.cloudFiles).all()).toHaveLength(1);

      await storage.delete('file.txt');
      expect(db.select().from(schema.cloudFiles).all()).toHaveLength(0);
    });

    it('bumps lastAccessed on read', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, null as any);

      await storage.write('file.txt', Buffer.from('data'));
      const beforeRead = db.select().from(schema.cloudFiles).all()[0].lastAccessed;

      // Small delay to ensure timestamp changes
      await new Promise(r => setTimeout(r, 10));
      await storage.read('file.txt');

      const afterRead = db.select().from(schema.cloudFiles).all()[0].lastAccessed;
      expect(Number(afterRead)).toBeGreaterThanOrEqual(Number(beforeRead));
    });

    it('bumps lastAccessed on getFilePath', async () => {
      const { db } = createTestDb();
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, null as any);

      await storage.write('file.txt', Buffer.from('data'));
      await new Promise(r => setTimeout(r, 10));
      await storage.getFilePath('file.txt');

      const row = db.select().from(schema.cloudFiles).all()[0];
      expect(row.lastAccessed).toBeTruthy();
    });
  });

  // ── Cloud storage integration ──

  describe('with cloud storage (mock)', () => {
    it('falls back to cloud on read when file evicted from disk', async () => {
      const cloudFiles = new Map<string, Buffer>();
      const cloud = createMockCloudStorage(cloudFiles);
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);

      // Simulate a file that exists only in cloud
      cloudFiles.set('plugins/test/evicted.txt', Buffer.from('from cloud'));

      const result = await storage.read('evicted.txt');
      expect(result.toString()).toBe('from cloud');
      expect(cloud.download).toHaveBeenCalledWith(
        'plugins/test/evicted.txt',
        expect.stringContaining('evicted.txt'),
      );
    });

    it('falls back to cloud on getFilePath when file evicted', async () => {
      const cloudFiles = new Map<string, Buffer>();
      const cloud = createMockCloudStorage(cloudFiles);
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);

      cloudFiles.set('plugins/test/remote.bin', Buffer.from('remote data'));

      const localPath = await storage.getFilePath('remote.bin');
      expect(fs.existsSync(localPath)).toBe(true);
      expect(fs.readFileSync(localPath).toString()).toBe('remote data');
    });

    it('checks cloud existence when not on disk', async () => {
      const cloudFiles = new Map<string, Buffer>();
      cloudFiles.set('plugins/test/cloud-only.txt', Buffer.from('x'));
      const cloud = createMockCloudStorage(cloudFiles);
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);

      expect(await storage.exists('cloud-only.txt')).toBe(true);
      expect(await storage.exists('nowhere.txt')).toBe(false);
    });

    it('deletes from both disk and cloud', async () => {
      const cloudFiles = new Map<string, Buffer>();
      const cloud = createMockCloudStorage(cloudFiles);
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);

      await storage.write('both.txt', Buffer.from('data'));
      cloudFiles.set('plugins/test/both.txt', Buffer.from('data'));

      await storage.delete('both.txt');
      expect(fs.existsSync(path.join(tmpDir, 'both.txt'))).toBe(false);
      expect(cloud.delete).toHaveBeenCalledWith('plugins/test/both.txt');
    });

    it('prefers local over cloud on read', async () => {
      const cloud = createMockCloudStorage();
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);

      await storage.write('local.txt', Buffer.from('local version'));

      const result = await storage.read('local.txt');
      expect(result.toString()).toBe('local version');
      expect(cloud.download).not.toHaveBeenCalled(); // didn't touch cloud
    });

    it('throws with cloud error when download fails', async () => {
      const cloud = createMockCloudStorage();
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);

      await expect(storage.read('nowhere.txt')).rejects.toThrow('Cloud download failed');
    });
  });

  // ── Cloud storage not configured ──

  describe('without cloud storage', () => {
    it('works fully locally when cloud not configured', async () => {
      const cloud = createUnconfiguredCloudStorage();
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);

      await storage.write('local.txt', Buffer.from('data'));
      const result = await storage.read('local.txt');
      expect(result.toString()).toBe('data');

      expect(await storage.exists('local.txt')).toBe(true);
      expect(cloud.upload).not.toHaveBeenCalled();
    });

    it('throws on read of missing file when cloud not configured', async () => {
      const cloud = createUnconfiguredCloudStorage();
      const storage = new NamespacedStorageImpl('test', tmpDir, null as any, cloud as any);
      await expect(storage.read('missing.txt')).rejects.toThrow('File not found');
    });

    it('flush is a no-op when cloud not configured', async () => {
      const { db } = createTestDb();
      const cloud = createUnconfiguredCloudStorage();
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, cloud as any);

      await storage.write('file.txt', Buffer.from('data'));
      await storage.flush(); // should not throw

      const rows = (db as any).select().from(schema.cloudFiles).all();
      expect(rows[0].syncState).toBe('pending_upload'); // unchanged
    });
  });

  // ── Flush ──

  describe('flush', () => {
    it('uploads pending files to cloud', async () => {
      const { db } = createTestDb();
      const cloudFiles = new Map<string, Buffer>();
      const cloud = createMockCloudStorage(cloudFiles);
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, cloud as any);

      await storage.write('a.txt', Buffer.from('aaa'));
      await storage.write('b.txt', Buffer.from('bbb'));

      await storage.flush();

      expect(cloud.upload).toHaveBeenCalledTimes(2);
      expect(cloudFiles.has('plugins/test/a.txt')).toBe(true);
      expect(cloudFiles.has('plugins/test/b.txt')).toBe(true);

      // DB should be updated to synced
      const rows = (db as any).select().from(schema.cloudFiles).all();
      expect(rows.every((r: any) => r.syncState === 'synced')).toBe(true);
    });

    it('records sync error on upload failure', async () => {
      const { db } = createTestDb();
      const cloud = createMockCloudStorage();
      cloud.upload = vi.fn(async () => { throw new Error('network error'); });
      const storage = new NamespacedStorageImpl('test', tmpDir, db as any, cloud as any);

      await storage.write('fail.txt', Buffer.from('data'));
      await storage.flush();

      const rows = (db as any).select().from(schema.cloudFiles).all();
      expect(rows[0].syncState).toBe('pending_upload'); // not changed to synced
      expect(rows[0].syncError).toBe('network error');
    });

    it('only flushes files in own namespace', async () => {
      const { db } = createTestDb();
      const cloud = createMockCloudStorage();
      const storageA = new NamespacedStorageImpl('alpha', tmpDir + '/alpha', db as any, cloud as any);
      const storageB = new NamespacedStorageImpl('beta', tmpDir + '/beta', db as any, cloud as any);

      fs.mkdirSync(tmpDir + '/alpha', { recursive: true });
      fs.mkdirSync(tmpDir + '/beta', { recursive: true });

      await storageA.write('a.txt', Buffer.from('a'));
      await storageB.write('b.txt', Buffer.from('b'));

      await storageA.flush(); // only flush alpha

      expect(cloud.upload).toHaveBeenCalledTimes(1);
      expect(cloud.upload).toHaveBeenCalledWith('plugins/alpha/a.txt', expect.any(String));
    });
  });
});
