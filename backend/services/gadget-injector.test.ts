import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as schema from '../db/schema';
import { GadgetInjector } from './gadget-injector';
import type { AppDatabase } from '../db/index';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

describe('GadgetInjector', () => {
  let db: AppDatabase;
  let injector: GadgetInjector;
  let mockBridgeManager: any;
  let mockReleaseManager: any;

  beforeEach(() => {
    db = createTestDb();

    mockBridgeManager = {
      getBridge: vi.fn().mockResolvedValue({ port: 9999, isRunning: () => true }),
    };

    mockReleaseManager = {
      ensureGadget: vi.fn().mockResolvedValue('/data/frida-server/16.0.0/frida-gadget-arm64.so'),
      resolveVersion: vi.fn().mockReturnValue('16.0.0'),
      getDefaultVersion: vi.fn().mockReturnValue('latest'),
    };

    injector = new GadgetInjector(db, mockBridgeManager, mockReleaseManager);
  });

  describe('getCachedInjection', () => {
    it('returns null when no cache exists', () => {
      expect(injector.getCachedInjection('com.example.app', 100, '16.0.0')).toBeNull();
    });

    it('returns cached entry when it exists', () => {
      db.insert(schema.injectedApks).values({
        packageName: 'com.example.app',
        versionCode: 100,
        fridaVersion: '16.0.0',
        filename: 'com.example.app/100_1.0_frida-16.0.0.apk',
        createdAt: new Date(),
      }).run();

      const result = injector.getCachedInjection('com.example.app', 100, '16.0.0');
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('com.example.app');
    });
  });

  describe('listInjected', () => {
    it('returns all injected APKs', () => {
      db.insert(schema.injectedApks).values({
        packageName: 'com.example.app',
        versionCode: 100,
        fridaVersion: '16.0.0',
        filename: 'test.apk',
        createdAt: new Date(),
      }).run();

      expect(injector.listInjected()).toHaveLength(1);
    });
  });

  describe('deleteInjected', () => {
    it('removes DB row', () => {
      db.insert(schema.injectedApks).values({
        packageName: 'com.example.app',
        versionCode: 100,
        fridaVersion: '16.0.0',
        filename: 'test.apk',
        createdAt: new Date(),
      }).run();

      const rows = db.select().from(schema.injectedApks).all();
      injector.deleteInjected(rows[0].id);
      expect(db.select().from(schema.injectedApks).all()).toHaveLength(0);
    });
  });

  describe('pruneExpired', () => {
    it('deletes entries older than TTL', () => {
      const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
      const fresh = new Date();

      db.insert(schema.injectedApks).values({
        packageName: 'old.app', versionCode: 1, fridaVersion: '16.0.0',
        filename: 'old.apk', createdAt: old,
      }).run();
      db.insert(schema.injectedApks).values({
        packageName: 'new.app', versionCode: 1, fridaVersion: '16.0.0',
        filename: 'new.apk', createdAt: fresh,
      }).run();

      const deleted = injector.pruneExpired();
      expect(deleted).toBe(1);
      expect(db.select().from(schema.injectedApks).all()).toHaveLength(1);
    });
  });
});
