import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// vi.hoisted runs before vi.mock factories (which are hoisted to the top).
// We define the mocks here so they are available inside the vi.mock factories.
// We also capture the real fs functions here, before any mocks replace them.
const { execFileMock, existsMock, mkdtempMock, rmSyncMock, realMkdtempSyncFn, realExistsSyncFn, realRmSyncFn } = vi.hoisted(() => {
  // Capture real fs functions before vi.mock('fs', ...) replaces them.
  const nodeFs = require('fs');
  const realMkdtempSyncFn = nodeFs.mkdtempSync.bind(nodeFs);
  const realExistsSyncFn = nodeFs.existsSync.bind(nodeFs);
  const realRmSyncFn = nodeFs.rmSync.bind(nodeFs);

  const execFileMock = vi.fn();
  const existsMock = vi.fn();
  const mkdtempMock = vi.fn();
  const rmSyncMock = vi.fn();
  return { execFileMock, existsMock, mkdtempMock, rmSyncMock, realMkdtempSyncFn, realExistsSyncFn, realRmSyncFn };
});

// Mock child_process at the top level so it is in place before the service is imported.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

// Mock fs so we control mkdtempSync and existsSync during git tests.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdtempSync: mkdtempMock,
    existsSync: existsMock,
    rmSync: rmSyncMock,
    readFileSync: actual.readFileSync,
  };
});

import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { PluginSourceManager } from './plugin-source-manager';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE plugin_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      auth_token TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO plugin_sources (name, type, url, enabled, is_default, priority)
    VALUES ('Default', 'registry', 'https://darkride.app/plugins.json', 1, 1, 0);
  `);
  return drizzle(sqlite, { schema });
}

describe('PluginSourceManager', () => {
  let db: ReturnType<typeof createTestDb>;
  let manager: PluginSourceManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PluginSourceManager(db);
    execFileMock.mockReset();
    rmSyncMock.mockReset();
    // Default: mkdtempSync creates a real temp dir.
    mkdtempMock.mockImplementation((prefix: string) => realMkdtempSyncFn(prefix));
    // Default: existsSync delegates to real fs.
    existsMock.mockImplementation((p: string) => realExistsSyncFn(p));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- CRUD tests ----

  it('getAll returns all sources including default', () => {
    const sources = manager.getAll();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      name: 'Default',
      type: 'registry',
      url: 'https://darkride.app/plugins.json',
      isDefault: true,
      enabled: true,
    });
  });

  it('add creates a new registry source', () => {
    const id = manager.add({
      name: 'My Registry',
      type: 'registry',
      url: 'https://example.com/plugins.json',
    });

    expect(id).toBeGreaterThan(0);
    const sources = manager.getAll();
    expect(sources).toHaveLength(2);
    expect(sources.find(s => s.id === id)).toMatchObject({
      name: 'My Registry',
      type: 'registry',
      url: 'https://example.com/plugins.json',
      isDefault: false,
      enabled: true,
    });
  });

  it('add creates a new git source', () => {
    const id = manager.add({
      name: 'My Git Plugin',
      type: 'git',
      url: 'https://github.com/user/darkride-plugin-foo',
      authToken: 'ghp_token123',
    });

    expect(id).toBeGreaterThan(0);
    const added = manager.getAll().find(s => s.id === id);
    expect(added).toMatchObject({
      name: 'My Git Plugin',
      type: 'git',
      url: 'https://github.com/user/darkride-plugin-foo',
      authToken: 'ghp_token123',
      isDefault: false,
    });
  });

  it('add rejects duplicate URLs', () => {
    manager.add({
      name: 'Other Registry',
      type: 'registry',
      url: 'https://example.com/plugins.json',
    });

    expect(() =>
      manager.add({
        name: 'Duplicate Registry',
        type: 'registry',
        url: 'https://example.com/plugins.json',
      })
    ).toThrow('A source with this URL already exists');
  });

  it('update modifies a source name and URL', () => {
    const id = manager.add({
      name: 'My Registry',
      type: 'registry',
      url: 'https://example.com/plugins.json',
    });

    manager.update(id, { name: 'Renamed Registry', url: 'https://example.com/v2/plugins.json' });

    expect(manager.getAll().find(s => s.id === id)).toMatchObject({
      name: 'Renamed Registry',
      url: 'https://example.com/v2/plugins.json',
    });
  });

  it('update allows changing fields on default source (protection is in API layer)', () => {
    const defaultSource = manager.getAll().find(s => s.isDefault)!;
    // The source manager no longer guards default source fields — the API layer
    // handles comprehensive protection. The manager should accept any valid update.
    manager.update(defaultSource.id, { authToken: 'new-token' });
    expect(manager.getAll().find(s => s.id === defaultSource.id)!.authToken).toBe('new-token');
  });

  it('remove deletes a non-default source', () => {
    const id = manager.add({
      name: 'Removable',
      type: 'registry',
      url: 'https://example.com/removable.json',
    });

    expect(manager.getAll()).toHaveLength(2);
    manager.remove(id);
    expect(manager.getAll()).toHaveLength(1);
    expect(manager.getAll().find(s => s.id === id)).toBeUndefined();
  });

  it('remove rejects deleting the default source', () => {
    const defaultSource = manager.getAll().find(s => s.isDefault)!;
    expect(() => manager.remove(defaultSource.id)).toThrow('Cannot remove the default source');
    expect(manager.getAll()).toHaveLength(1);
  });

  // ---- fetchRegistry tests ----

  it('fetchRegistry fetches and parses plugins JSON', async () => {
    const mockPlugins = [
      {
        name: 'foo',
        displayName: 'Foo Plugin',
        description: 'A test plugin',
        author: 'Tester',
        repo: 'https://github.com/user/foo',
        latestVersion: '1.0.0',
        category: 'community',
        license: 'MIT',
        npmPackage: '@darkride/plugin-foo',
      },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: mockPlugins }),
    }));

    const result = await manager.fetchRegistry({
      url: 'https://example.com/plugins.json',
      authToken: null,
      name: 'Test Registry',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'foo',
      displayName: 'Foo Plugin',
      source: 'Test Registry',
    });
  });

  it('fetchRegistry passes auth token as Bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await manager.fetchRegistry({
      url: 'https://private.example.com/plugins.json',
      authToken: 'secret-token',
      name: 'Private Registry',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://private.example.com/plugins.json',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-token' },
      })
    );
  });

  // ---- fetchGitRepo tests ----

  it('fetchGitRepo clones repo and reads package.json', async () => {
    // Create a real temp dir and populate it with plugin files.
    const tempDir = realMkdtempSyncFn(join(tmpdir(), 'test-darkride-plugin-'));
    try {
      writeFileSync(join(tempDir, 'darkride-plugin.ts'), 'export default {};');
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: '@user/darkride-plugin-bar',
        version: '2.1.0',
        description: 'Bar plugin',
        author: 'Alice',
        license: 'MIT',
        keywords: ['darkride-plugin'],
      }));

      // mkdtempSync will return our pre-populated tempDir.
      mkdtempMock.mockReturnValue(tempDir);
      // existsSync delegates to real fs so our written files are found.
      existsMock.mockImplementation((p: string) => realExistsSyncFn(p));
      // execFile mock: simulate successful clone (tempDir already populated).
      execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '', '');
      });

      const result = await manager.fetchGitRepo({
        url: 'https://github.com/user/darkride-plugin-bar',
        authToken: null,
        name: 'Bar Repo',
      });

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        name: 'bar',
        displayName: '@user/darkride-plugin-bar',
        description: 'Bar plugin',
        author: 'Alice',
        latestVersion: '2.1.0',
        source: 'Bar Repo',
        installUrl: 'git+https://github.com/user/darkride-plugin-bar',
      });
    } finally {
      try { realRmSyncFn(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('fetchGitRepo injects auth token into clone URL', async () => {
    const cloneArgs: string[][] = [];

    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: object, cb: Function) => {
      cloneArgs.push([...args]);
      cb(null, '', '');
    });

    // existsSync returns false — no darkride-plugin entry, so fetchGitRepo returns null quickly.
    existsMock.mockReturnValue(false);

    await manager.fetchGitRepo({
      url: 'https://github.com/user/private-plugin',
      authToken: 'mytoken',
      name: 'Private Git',
    });

    expect(cloneArgs.length).toBeGreaterThan(0);
    expect(cloneArgs[0]).toContain('https://token:mytoken@github.com/user/private-plugin');
  });

  it('fetchGitRepo returns null for repo without darkride-plugin entry', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: Function) => {
      cb(null, '', '');
    });

    // Neither darkride-plugin.ts nor darkride-plugin.js exists.
    existsMock.mockReturnValue(false);

    const result = await manager.fetchGitRepo({
      url: 'https://github.com/user/not-a-darkride-plugin',
      authToken: null,
      name: 'Not A Plugin',
    });

    expect(result).toBeNull();
  });

  // ---- cache tests ----

  it('getCacheFetchedAt returns null when no cache', () => {
    expect(manager.getCacheFetchedAt()).toBeNull();
  });

  it('getCacheFetchedAt returns timestamp after fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: [] }),
    }));

    const before = Date.now();
    await manager.fetchAll();
    const after = Date.now();

    const fetchedAt = manager.getCacheFetchedAt();
    expect(fetchedAt).not.toBeNull();
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
    expect(fetchedAt).toBeLessThanOrEqual(after);
  });

  it('fetchAll returns cached results within TTL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ plugins: [{ name: 'alpha' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ plugins: [{ name: 'beta' }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const first = await manager.fetchAll();
    const second = await manager.fetchAll();

    // fetch should only have been called once — second call served from cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('fetchAll busts cache when requested', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ plugins: [{ name: 'alpha' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ plugins: [{ name: 'beta' }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await manager.fetchAll();
    const second = await manager.fetchAll(true);

    // fetch should have been called twice — cache was busted
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second result should contain the fresh data
    const allPlugins = second.flatMap(r => r.plugins);
    expect(allPlugins[0].name).toBe('beta');
  });

  // ---- getCachedPlugins tests ----

  describe('getCachedPlugins', () => {
    it('returns empty array when cache is empty', () => {
      const mgr = new PluginSourceManager(db);
      expect(mgr.getCachedPlugins()).toEqual([]);
    });

    it('returns flat list of plugins from all cached source results', () => {
      const mgr = new PluginSourceManager(db);
      (mgr as any).cache = {
        fetchedAt: Date.now(),
        results: [
          { sourceName: 's1', sourceType: 'registry', plugins: [{ name: 'a', npmPackage: '@x/a', latestVersion: '1.0.0' } as any] },
          { sourceName: 's2', sourceType: 'registry', plugins: [{ name: 'b', npmPackage: '@x/b', latestVersion: '2.0.0' } as any] },
        ],
      };
      const cached = mgr.getCachedPlugins();
      expect(cached).toHaveLength(2);
      expect(cached.map(p => p.name).sort()).toEqual(['a', 'b']);
    });
  });

  // ---- fetchAll test ----

  it('fetchAll aggregates from all enabled sources', async () => {
    manager.add({
      name: 'Extra Registry',
      type: 'registry',
      url: 'https://extra.example.com/plugins.json',
    });

    const defaultPlugins = [
      { name: 'alpha', displayName: 'Alpha', description: '', author: 'A', repo: '', latestVersion: '1.0.0', category: 'official', license: 'MIT', npmPackage: 'alpha' },
    ];
    const extraPlugins = [
      { name: 'beta', displayName: 'Beta', description: '', author: 'B', repo: '', latestVersion: '2.0.0', category: 'community', license: 'MIT', npmPackage: 'beta' },
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('darkride.app')) {
        return { ok: true, json: async () => ({ plugins: defaultPlugins }) };
      }
      return { ok: true, json: async () => ({ plugins: extraPlugins }) };
    }));

    const results = await manager.fetchAll();

    expect(results).toHaveLength(2);
    const defaultResult = results.find(r => r.sourceName === 'Default');
    const extraResult = results.find(r => r.sourceName === 'Extra Registry');

    expect(defaultResult?.plugins).toHaveLength(1);
    expect(defaultResult?.plugins[0].name).toBe('alpha');
    expect(extraResult?.plugins).toHaveLength(1);
    expect(extraResult?.plugins[0].name).toBe('beta');
  });
});
