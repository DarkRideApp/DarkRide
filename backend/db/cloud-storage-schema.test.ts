import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { createTestDb } from '../test-utils/create-test-db';

const { cloudFiles } = schema;

describe('Cloud Storage Schema', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb(undefined, { foreignKeys: true });
  });

  describe('cloudFiles', () => {
    it('should insert and query a cloud file', () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'screenshots/2026/02/shot-001.png',
        relativePath: '/data/screenshots/shot-001.png',
        fileType: 'screenshot',
        fileSize: 524288,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      const result = db.select().from(cloudFiles).all();
      expect(result).toHaveLength(1);
      expect(result[0].cloudKey).toBe('screenshots/2026/02/shot-001.png');
      expect(result[0].relativePath).toBe('/data/screenshots/shot-001.png');
      expect(result[0].fileType).toBe('screenshot');
      expect(result[0].fileSize).toBe(524288);
      expect(result[0].syncState).toBe('synced');
      expect(result[0].syncError).toBeNull();
      expect(result[0].id).toBe(1);
    });

    it('should enforce cloud_key unique constraint', () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'apks/v1/app.apk',
        relativePath: '/data/apks/app.apk',
        fileType: 'apk',
        fileSize: 1048576,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      expect(() => {
        db.insert(cloudFiles).values({
          cloudKey: 'apks/v1/app.apk',
          relativePath: '/data/apks/app-copy.apk',
          fileType: 'apk',
          fileSize: 1048576,
          syncState: 'pending',
          lastAccessed: now,
          createdAt: now,
        }).run();
      }).toThrow();
    });

    it('should allow sync_error to be null', () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/file.bin',
        relativePath: '/data/test/file.bin',
        fileType: 'binary',
        fileSize: 256,
        syncState: 'synced',
        lastAccessed: now,
        createdAt: now,
      }).run();

      const result = db.select().from(cloudFiles).where(eq(cloudFiles.id, 1)).all();
      expect(result[0].syncError).toBeNull();
    });

    it('should allow sync_error to store text', () => {
      const now = new Date();
      db.insert(cloudFiles).values({
        cloudKey: 'test/failed.bin',
        relativePath: '/data/test/failed.bin',
        fileType: 'binary',
        fileSize: 512,
        syncState: 'error',
        syncError: 'S3 upload failed: AccessDenied',
        lastAccessed: now,
        createdAt: now,
      }).run();

      const result = db.select().from(cloudFiles).where(eq(cloudFiles.id, 1)).all();
      expect(result[0].syncError).toBe('S3 upload failed: AccessDenied');
      expect(result[0].syncState).toBe('error');
    });
  });

});
