import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import os from 'os';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerUtilsEndpoints } from './utils';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    statSync: vi.fn().mockReturnValue({ size: 1048576 }),
  };
});

import { statSync } from 'fs';
import { createTestDb } from '../test-utils/create-test-db';

function createApp(
  db: BetterSQLite3Database<typeof schema>,
  opts: { dbPath?: string; scopes?: string[] } = {},
) {
  clearEndpoints();
  registerUtilsEndpoints(opts.dbPath ?? '/tmp/test-darkride.db', db as any);
  const app = express();
  app.use(express.json());
  if (opts.scopes) {
    const scopes = opts.scopes;
    app.use((req, _res, next) => {
      (req as any).authUser = {
        userId: 1,
        effectiveScopes: new Set(scopes),
      };
      next();
    });
  }
  app.use(getApiRouter());
  return app;
}

describe('Utils API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db);
  });

  describe('GET /v1/utils/info', () => {
    it('should return db size when file exists', async () => {
      vi.mocked(statSync).mockReturnValue({ size: 1048576 } as any);

      const res = await request(app).get('/v1/utils/info');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.dbSizeBytes).toBe(1048576);
    });

    it('should return 0 when file does not exist', async () => {
      vi.mocked(statSync).mockImplementation(() => { throw new Error('ENOENT'); });

      const res = await request(app).get('/v1/utils/info');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.dbSizeBytes).toBe(0);
    });
  });

  describe('GET /v1/utils/table-sizes', () => {
    it('should return per-table size breakdown', async () => {
      const res = await request(app).get('/v1/utils/table-sizes');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // At minimum, db_size_snapshots table exists
      const names = res.body.data.map((t: any) => t.tableName);
      expect(names).toContain('db_size_snapshots');
    });

    it('should include sizeBytes, rowCount, and percentage for each table', async () => {
      // Insert some data so the table has rows
      db.insert(schema.dbSizeSnapshots).values({ sizeBytes: 1000, capturedAt: new Date() }).run();
      db.insert(schema.dbSizeSnapshots).values({ sizeBytes: 2000, capturedAt: new Date() }).run();

      const res = await request(app).get('/v1/utils/table-sizes');

      const snapshot = res.body.data.find((t: any) => t.tableName === 'db_size_snapshots');
      expect(snapshot).toBeDefined();
      expect(snapshot.sizeBytes).toBeGreaterThan(0);
      expect(snapshot.rowCount).toBe(2);
      expect(snapshot.percentage).toBeGreaterThan(0);
      expect(snapshot.name).toBe('Size Snapshots');
    });

    it('should return tables sorted by size descending', async () => {
      const res = await request(app).get('/v1/utils/table-sizes');

      const sizes = res.body.data.map((t: any) => t.sizeBytes);
      for (let i = 1; i < sizes.length; i++) {
        expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
      }
    });
  });

  describe('GET /v1/utils/backup', () => {
    let tmpDir: string;
    let dbFile: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'darkride-backup-test-'));
      dbFile = path.join(tmpDir, 'darkride.db');
      writeFileSync(dbFile, 'fake-sqlite-data');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns 403 when authenticated user lacks core.system:backup', async () => {
      const scopedApp = createApp(db, { dbPath: dbFile, scopes: ['core.settings:read'] });

      const res = await request(scopedApp).get('/v1/utils/backup');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.missing).toContain('core.system:backup');
    });

    it('streams the database file when user has core.system:backup', async () => {
      const scopedApp = createApp(db, { dbPath: dbFile, scopes: ['core.system:backup'] });

      const res = await request(scopedApp).get('/v1/utils/backup');

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('darkride.db');
      expect(res.body.toString()).toBe('fake-sqlite-data');
    });

    it('streams the database file when user has wildcard admin scope', async () => {
      const scopedApp = createApp(db, { dbPath: dbFile, scopes: ['core.admin:*'] });

      const res = await request(scopedApp).get('/v1/utils/backup');

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('darkride.db');
    });
  });

  describe('GET /v1/utils/db-size-history', () => {
    it('should return empty array when no snapshots exist', async () => {
      const res = await request(app).get('/v1/utils/db-size-history');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return snapshots within 60-day window ordered by capturedAt asc', async () => {
      const now = Date.now();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
      const twentyDaysAgo = new Date(now - 20 * 24 * 60 * 60 * 1000);

      db.insert(schema.dbSizeSnapshots).values({ sizeBytes: 2000000, capturedAt: twentyDaysAgo }).run();
      db.insert(schema.dbSizeSnapshots).values({ sizeBytes: 3000000, capturedAt: tenDaysAgo }).run();

      const res = await request(app).get('/v1/utils/db-size-history');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].sizeBytes).toBe(2000000);
      expect(res.body.data[1].sizeBytes).toBe(3000000);
    });

    it('should exclude snapshots older than 60 days', async () => {
      const now = Date.now();
      const recentDate = new Date(now - 5 * 24 * 60 * 60 * 1000);
      const oldDate = new Date(now - 90 * 24 * 60 * 60 * 1000);

      db.insert(schema.dbSizeSnapshots).values({ sizeBytes: 1000000, capturedAt: oldDate }).run();
      db.insert(schema.dbSizeSnapshots).values({ sizeBytes: 5000000, capturedAt: recentDate }).run();

      const res = await request(app).get('/v1/utils/db-size-history');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].sizeBytes).toBe(5000000);
    });
  });

  describe('GET /v1/utils/disk-usage', () => {
    it('returns null data when no snapshot exists', async () => {
      const res = await request(app).get('/v1/utils/disk-usage');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('returns the latest snapshot with computed used bytes and sorted dirs', async () => {
      const older = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const newer = new Date(Date.now() - 1 * 60 * 60 * 1000);
      db.insert(schema.diskUsageSnapshots).values({
        capturedAt: older,
        volumeTotalBytes: 100, volumeFreeBytes: 90, dirSizes: { apks: 1 },
      }).run();
      db.insert(schema.diskUsageSnapshots).values({
        capturedAt: newer,
        volumeTotalBytes: 1000, volumeFreeBytes: 400,
        dirSizes: { apks: 200, couchbase: 500, tools: 50 },
      }).run();

      const res = await request(app).get('/v1/utils/disk-usage');

      expect(res.status).toBe(200);
      expect(res.body.data.volumeTotalBytes).toBe(1000);
      expect(res.body.data.volumeFreeBytes).toBe(400);
      expect(res.body.data.volumeUsedBytes).toBe(600);
      expect(res.body.data.dirs).toEqual([
        { name: 'couchbase', sizeBytes: 500 },
        { name: 'apks', sizeBytes: 200 },
        { name: 'tools', sizeBytes: 50 },
      ]);
    });
  });

  describe('GET /v1/utils/disk-usage-history', () => {
    it('returns empty array when no snapshots exist', async () => {
      const res = await request(app).get('/v1/utils/disk-usage-history');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns usedBytes per snapshot within 60 days, ordered asc, excluding older', async () => {
      const now = Date.now();
      const recentOlder = new Date(now - 10 * 24 * 60 * 60 * 1000);
      const recentNewer = new Date(now - 5 * 24 * 60 * 60 * 1000);
      const old = new Date(now - 90 * 24 * 60 * 60 * 1000);
      // Out-of-window row: must be excluded.
      db.insert(schema.diskUsageSnapshots).values({
        capturedAt: old, volumeTotalBytes: 1000, volumeFreeBytes: 900, dirSizes: {},
      }).run();
      // Two in-window rows inserted newest-first so the test fails if the
      // endpoint doesn't explicitly order ascending by capturedAt.
      db.insert(schema.diskUsageSnapshots).values({
        capturedAt: recentNewer, volumeTotalBytes: 1000, volumeFreeBytes: 250, dirSizes: {},
      }).run();
      db.insert(schema.diskUsageSnapshots).values({
        capturedAt: recentOlder, volumeTotalBytes: 1000, volumeFreeBytes: 600, dirSizes: {},
      }).run();

      const res = await request(app).get('/v1/utils/disk-usage-history');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      // Ascending by capturedAt: the older in-window row (used 400) comes first.
      expect(res.body.data[0].usedBytes).toBe(400);
      expect(res.body.data[1].usedBytes).toBe(750);
      expect(new Date(res.body.data[0].capturedAt).getTime())
        .toBeLessThan(new Date(res.body.data[1].capturedAt).getTime());
      expect(typeof res.body.data[0].capturedAt).toBe('string');
    });
  });
});
