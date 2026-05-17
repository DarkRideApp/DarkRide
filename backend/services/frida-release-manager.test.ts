import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import * as schema from '../db/schema';
import { FridaReleaseManager } from './frida-release-manager';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    default: {
      ...original,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      rmSync: vi.fn(),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    rmSync: vi.fn(),
  };
});

describe('FridaReleaseManager', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let manager: FridaReleaseManager;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    manager = new FridaReleaseManager(db as any, '/tmp/test-frida');
  });

  afterEach(() => {
    manager.stop();
    vi.restoreAllMocks();
  });

  describe('syncReleases', () => {
    it('should parse GitHub releases and store in database', async () => {
      const mockReleases = [
        {
          tag_name: 'frida-16.7.19',
          published_at: '2026-01-15T00:00:00Z',
          assets: [
            { name: 'frida-server-16.7.19-android-arm64.xz', browser_download_url: 'https://github.com/download/frida-server-16.7.19-android-arm64.xz' },
            { name: 'frida-server-16.7.19-android-arm.xz', browser_download_url: 'https://other' },
          ],
        },
        {
          tag_name: 'frida-16.7.18',
          published_at: '2026-01-10T00:00:00Z',
          assets: [
            { name: 'frida-server-16.7.18-android-arm64.xz', browser_download_url: 'https://github.com/download/frida-server-16.7.18-android-arm64.xz' },
          ],
        },
      ];

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockReleases,
        headers: new Headers(),
      } as any);

      await manager.syncReleases();

      const releases = manager.getReleases();
      expect(releases).toHaveLength(2);
      // Ordered by desc id, so the second inserted (16.7.18) comes first in desc order
      expect(releases[0].version).toBe('16.7.18');
      expect(releases[1].version).toBe('16.7.19');
      expect(releases[1].downloadUrl).toBe('https://github.com/download/frida-server-16.7.19-android-arm64.xz');
    });

    it('should strip frida- prefix from tag_name to get version', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          tag_name: 'frida-16.7.19',
          published_at: '2026-01-15T00:00:00Z',
          assets: [{ name: 'frida-server-16.7.19-android-arm64.xz', browser_download_url: 'https://dl' }],
        }],
        headers: new Headers(),
      } as any);

      await manager.syncReleases();
      expect(manager.getReleases()[0].version).toBe('16.7.19');
    });

    it('should handle tag_name without frida- prefix', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          tag_name: '16.7.19',
          published_at: '2026-01-15T00:00:00Z',
          assets: [{ name: 'frida-server-16.7.19-android-arm64.xz', browser_download_url: 'https://dl' }],
        }],
        headers: new Headers(),
      } as any);

      await manager.syncReleases();
      expect(manager.getReleases()[0].version).toBe('16.7.19');
    });

    it('should skip releases without arm64 asset', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          tag_name: 'frida-16.7.19',
          published_at: '2026-01-15T00:00:00Z',
          assets: [
            { name: 'frida-server-16.7.19-linux-x86_64.tar.xz', browser_download_url: 'https://other' },
          ],
        }],
        headers: new Headers(),
      } as any);

      await manager.syncReleases();
      expect(manager.getReleases()).toHaveLength(0);
    });

    it('should skip releases with no assets', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          tag_name: 'frida-16.7.19',
          published_at: '2026-01-15T00:00:00Z',
          assets: [],
        }],
        headers: new Headers(),
      } as any);

      await manager.syncReleases();
      expect(manager.getReleases()).toHaveLength(0);
    });

    it('should not duplicate existing releases', async () => {
      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://existing',
      }).run();

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          tag_name: 'frida-16.7.19',
          published_at: '2026-01-15T00:00:00Z',
          assets: [{ name: 'frida-server-16.7.19-android-arm64.xz', browser_download_url: 'https://new' }],
        }],
        headers: new Headers(),
      } as any);

      await manager.syncReleases();
      expect(manager.getReleases()).toHaveLength(1);
      // Should keep the original URL
      expect(manager.getReleases()[0].downloadUrl).toBe('https://existing');
    });

    it('should update last sync timestamp', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      expect(manager.getLastSyncTime()).toBeNull();
      await manager.syncReleases();
      expect(manager.getLastSyncTime()).toBeTruthy();
    });

    it('should handle GitHub API errors gracefully', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
      } as any);

      // Should not throw
      await manager.syncReleases();
      expect(manager.getReleases()).toHaveLength(0);
    });

    it('should handle fetch network errors gracefully', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      await manager.syncReleases();
      expect(manager.getReleases()).toHaveLength(0);
    });

    it('should not sync concurrently', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
        // Simulate slow response
        await new Promise(r => setTimeout(r, 50));
        return { ok: true, json: async () => [], headers: new Headers() } as any;
      });

      // Start two syncs at once
      const p1 = manager.syncReleases();
      const p2 = manager.syncReleases();
      await Promise.all([p1, p2]);

      // Only one fetch should have been made because syncing flag blocks the second
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncIfStale', () => {
    it('should sync when no last sync time exists', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      await manager.syncIfStale();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should not sync if last sync was less than 24h ago', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      await manager.syncReleases(); // first sync sets timestamp
      fetchSpy.mockClear();

      await manager.syncIfStale(); // should skip
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    it('should sync if last sync was more than 24h ago', async () => {
      // Insert a stale timestamp
      db.insert(schema.settings).values({
        key: 'frida_last_sync',
        value: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }).run();

      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      await manager.syncIfStale();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('start / stop', () => {
    it('should start periodic sync timer', async () => {
      const spy = vi.spyOn(global, 'setInterval');
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      await manager.start();
      expect(spy).toHaveBeenCalled();
      manager.stop();
    });

    it('should clear timer on stop', async () => {
      const spy = vi.spyOn(global, 'clearInterval');
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      await manager.start();
      manager.stop();
      expect(spy).toHaveBeenCalled();
    });

    it('should be safe to call stop without start', () => {
      // Should not throw
      manager.stop();
    });
  });

  describe('getDefaultVersion', () => {
    it('should return "auto" when no setting exists', () => {
      expect(manager.getDefaultVersion()).toBe('auto');
    });

    it('should return stored setting value', () => {
      db.insert(schema.settings).values({ key: 'frida_default_version', value: '16.7.18' }).run();
      expect(manager.getDefaultVersion()).toBe('16.7.18');
    });
  });

  describe('resolveVersion', () => {
    it('should resolve "latest" to the newest version by id', () => {
      db.insert(schema.fridaReleases).values([
        { version: '16.7.18', downloadUrl: 'https://a', releaseDate: new Date('2026-01-10') },
        { version: '16.7.19', downloadUrl: 'https://b', releaseDate: new Date('2026-01-15') },
      ]).run();
      // Newest by id (desc) is the last inserted: 16.7.19
      expect(manager.resolveVersion('latest')).toBe('16.7.19');
    });

    it('should return the exact version if it exists', () => {
      db.insert(schema.fridaReleases).values({ version: '16.7.19', downloadUrl: 'https://a' }).run();
      expect(manager.resolveVersion('16.7.19')).toBe('16.7.19');
    });

    it('should return null for unknown version', () => {
      expect(manager.resolveVersion('99.99.99')).toBeNull();
    });

    it('should return null for "latest" when no releases exist', () => {
      expect(manager.resolveVersion('latest')).toBeNull();
    });
  });

  describe('getRelease', () => {
    it('should return a release by version', () => {
      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://dl',
        isDownloaded: false,
      }).run();

      const release = manager.getRelease('16.7.19');
      expect(release).toBeDefined();
      expect(release!.version).toBe('16.7.19');
      expect(release!.downloadUrl).toBe('https://dl');
    });

    it('should return undefined for unknown version', () => {
      expect(manager.getRelease('99.99.99')).toBeUndefined();
    });
  });

  describe('getReleases', () => {
    it('should return all releases ordered by desc id', () => {
      db.insert(schema.fridaReleases).values([
        { version: '16.7.17', downloadUrl: 'https://a' },
        { version: '16.7.18', downloadUrl: 'https://b' },
        { version: '16.7.19', downloadUrl: 'https://c' },
      ]).run();

      const releases = manager.getReleases();
      expect(releases).toHaveLength(3);
      expect(releases[0].version).toBe('16.7.19');
      expect(releases[1].version).toBe('16.7.18');
      expect(releases[2].version).toBe('16.7.17');
    });

    it('should return empty array when no releases', () => {
      expect(manager.getReleases()).toHaveLength(0);
    });
  });

  describe('isDownloaded', () => {
    it('should return false for unknown version', () => {
      expect(manager.isDownloaded('99.99.99')).toBe(false);
    });

    it('should return false for non-downloaded release', () => {
      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://a',
        isDownloaded: false,
      }).run();
      expect(manager.isDownloaded('16.7.19')).toBe(false);
    });

    it('should return true for downloaded release', () => {
      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://a',
        isDownloaded: true,
        fileSize: 50000000,
      }).run();
      expect(manager.isDownloaded('16.7.19')).toBe(true);
    });
  });

  describe('getBinaryPath', () => {
    it('should return the correct path for a version', () => {
      const binPath = manager.getBinaryPath('16.7.19');
      expect(binPath).toBe('/tmp/test-frida/16.7.19/frida-server-arm64');
    });
  });

  describe('deleteVersion', () => {
    it('should mark release as not downloaded and clear fileSize', () => {
      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://a',
        isDownloaded: true,
        fileSize: 12345,
      }).run();

      manager.deleteVersion('16.7.19');

      const release = manager.getRelease('16.7.19');
      expect(release?.isDownloaded).toBe(false);
      expect(release?.fileSize).toBeNull();
    });

    it('should attempt to remove the version directory', async () => {
      const fsModule = await import('fs');
      const fsMock = fsModule.default as any;
      fsMock.existsSync.mockReturnValueOnce(true);

      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://a',
        isDownloaded: true,
      }).run();

      manager.deleteVersion('16.7.19');

      expect(fsMock.rmSync).toHaveBeenCalledWith('/tmp/test-frida/16.7.19', { recursive: true });
    });

    it('should handle non-existent directory gracefully', async () => {
      const fsModule = await import('fs');
      const fsMock = fsModule.default as any;
      fsMock.existsSync.mockReturnValueOnce(false);

      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://a',
        isDownloaded: true,
      }).run();

      // Should not throw
      manager.deleteVersion('16.7.19');
    });
  });

  describe('downloadVersion', () => {
    it('should throw for unknown version', async () => {
      await expect(manager.downloadVersion('99.99.99')).rejects.toThrow('Unknown Frida version: 99.99.99');
    });

    it('should return existing binary path if already downloaded', async () => {
      db.insert(schema.fridaReleases).values({
        version: '16.7.19',
        downloadUrl: 'https://dl',
        isDownloaded: true,
        fileSize: 50000000,
      }).run();

      const result = await manager.downloadVersion('16.7.19');
      expect(result).toBe('/tmp/test-frida/16.7.19/frida-server-arm64');
    });
  });

  describe('getLastSyncTime', () => {
    it('should return null when no sync has happened', () => {
      expect(manager.getLastSyncTime()).toBeNull();
    });

    it('should return date after sync', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      await manager.syncReleases();
      const lastSync = manager.getLastSyncTime();
      expect(lastSync).toBeInstanceOf(Date);
      expect(lastSync!.getTime()).toBeGreaterThan(0);
    });

    it('should update timestamp on subsequent syncs', async () => {
      // First sync
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      await manager.syncReleases();
      const firstSync = manager.getLastSyncTime()!;

      // Wait a bit and sync again
      await new Promise(r => setTimeout(r, 10));

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      } as any);

      // Force syncing flag reset and sync again
      await manager.syncReleases();
      const secondSync = manager.getLastSyncTime()!;

      expect(secondSync.getTime()).toBeGreaterThanOrEqual(firstSync.getTime());
    });
  });

  describe('gadget binary management', () => {
    it('getGadgetPath returns correct path', () => {
      expect(manager.getGadgetPath('16.0.0')).toContain('16.0.0/frida-gadget-arm64.so');
    });

    it('isGadgetDownloaded returns false when file missing', () => {
      expect(manager.isGadgetDownloaded('16.0.0')).toBe(false);
    });

    it('isGadgetDownloaded returns true when file exists', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      expect(manager.isGadgetDownloaded('16.0.0')).toBe(true);
    });

    it('syncReleases stores gadget download URL', async () => {
      const mockReleases = [{
        tag_name: 'frida-16.0.0',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'frida-server-16.0.0-android-arm64.xz', browser_download_url: 'https://example.com/server.xz' },
          { name: 'frida-gadget-16.0.0-android-arm64.so.xz', browser_download_url: 'https://example.com/gadget.xz' },
        ],
      }];

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockReleases,
        headers: new Headers(),
      } as any);

      await manager.syncReleases();

      const release = manager.getRelease('16.0.0');
      expect(release?.gadgetDownloadUrl).toBe('https://example.com/gadget.xz');
    });

    it('syncReleases stores null gadgetDownloadUrl when no gadget asset', async () => {
      const mockReleases = [{
        tag_name: 'frida-16.0.0',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'frida-server-16.0.0-android-arm64.xz', browser_download_url: 'https://example.com/server.xz' },
        ],
      }];

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockReleases,
        headers: new Headers(),
      } as any);

      await manager.syncReleases();

      const release = manager.getRelease('16.0.0');
      expect(release?.gadgetDownloadUrl).toBeNull();
    });
  });
});
