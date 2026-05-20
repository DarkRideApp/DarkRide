import { describe, it, expect, vi } from 'vitest';
import { replayMissingInstalls } from '../replay-missing-installs';
import type { PluginInstallRecord } from '../plugin-installs-repo';

function makeRow(overrides: Partial<PluginInstallRecord> = {}): PluginInstallRecord {
  return {
    name: 'demo-plugin',
    npmPackage: '@darkride/plugin-demo',
    sourceUrl: 'git+https://gitea.private/org/demo.git',
    resolvedRef: 'abc123',
    sourceId: null,
    authToken: null,
    installedAt: 1700000000,
    ...overrides,
  };
}

describe('replayMissingInstalls', () => {
  it('no-op when nothing is missing', async () => {
    const installer = { installManaged: vi.fn() };
    const installsRepo = { getMissingDirs: vi.fn().mockReturnValue([]) };
    const log = vi.fn();
    const logError = vi.fn();

    await replayMissingInstalls({
      installsRepo: installsRepo as any,
      installer: installer as any,
      sourceManager: null,
      managedNodeModules: '/fake/node_modules',
      log,
      logError,
    });

    expect(installer.installManaged).not.toHaveBeenCalled();
    // No "Replaying N..." log when N=0
    expect(log).not.toHaveBeenCalled();
  });

  it('replays each missing install with the persisted authToken', async () => {
    const installer = {
      installManaged: vi.fn().mockResolvedValue({ success: true, pkgName: '@darkride/plugin-demo' }),
    };
    const installsRepo = {
      getMissingDirs: vi.fn().mockReturnValue([
        makeRow({ name: 'a', authToken: 'persisted-a' }),
        makeRow({ name: 'b', authToken: 'persisted-b', npmPackage: '@darkride/plugin-b' }),
      ]),
    };

    await replayMissingInstalls({
      installsRepo: installsRepo as any,
      installer: installer as any,
      sourceManager: null,
      managedNodeModules: '/fake/node_modules',
      log: vi.fn(),
      logError: vi.fn(),
    });

    expect(installer.installManaged).toHaveBeenCalledTimes(2);
    expect(installer.installManaged).toHaveBeenNthCalledWith(1, 'git+https://gitea.private/org/demo.git#abc123', 'persisted-a');
    expect(installer.installManaged).toHaveBeenNthCalledWith(2, 'git+https://gitea.private/org/demo.git#abc123', 'persisted-b');
  });

  it('falls back to sourceManager auth when the row has no persisted token (pre-0090 rows)', async () => {
    const installer = {
      installManaged: vi.fn().mockResolvedValue({ success: true, pkgName: '@darkride/plugin-demo' }),
    };
    const installsRepo = {
      getMissingDirs: vi.fn().mockReturnValue([
        makeRow({ authToken: null, sourceId: 7 }),
      ]),
    };
    const sourceManager = {
      getAll: vi.fn().mockReturnValue([
        { id: 7, authToken: 'source-fallback-token' },
      ]),
    };

    await replayMissingInstalls({
      installsRepo: installsRepo as any,
      installer: installer as any,
      sourceManager,
      managedNodeModules: '/fake/node_modules',
      log: vi.fn(),
      logError: vi.fn(),
    });

    expect(installer.installManaged).toHaveBeenCalledWith(expect.any(String), 'source-fallback-token');
  });

  it('continues past a failed install and logs each failure (does NOT throw)', async () => {
    // The bug this guards against: pre-extraction, a thrown promise from
    // installManaged would crash the boot. Now each install is independent
    // and the loop completes regardless of any single failure.
    const installer = {
      installManaged: vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'npm ERR! 404' })
        .mockResolvedValueOnce({ success: true, pkgName: '@darkride/plugin-good' }),
    };
    const installsRepo = {
      getMissingDirs: vi.fn().mockReturnValue([
        makeRow({ name: 'broken', authToken: 'tok-a' }),
        makeRow({ name: 'good', authToken: 'tok-b' }),
      ]),
    };
    const logError = vi.fn();

    await replayMissingInstalls({
      installsRepo: installsRepo as any,
      installer: installer as any,
      sourceManager: null,
      managedNodeModules: '/fake/node_modules',
      log: vi.fn(),
      logError,
    });

    expect(installer.installManaged).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('broken'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('404'));
  });

  it('appends the "is this a private repo?" hint only for no-auth git+ URLs', async () => {
    const installer = {
      installManaged: vi.fn().mockResolvedValue({ success: false, error: 'npm ERR! auth required' }),
    };
    const installsRepo = {
      getMissingDirs: vi.fn().mockReturnValue([
        makeRow({ name: 'git-no-auth', sourceUrl: 'git+https://private.example/x.git', authToken: null, sourceId: null }),
        makeRow({ name: 'pkg-no-auth', sourceUrl: '@scope/plugin-foo', authToken: null, sourceId: null, resolvedRef: null }),
      ]),
    };
    const logError = vi.fn();

    await replayMissingInstalls({
      installsRepo: installsRepo as any,
      installer: installer as any,
      sourceManager: null,
      managedNodeModules: '/fake/node_modules',
      log: vi.fn(),
      logError,
    });

    // First call: git URL, no auth → hint included.
    expect(logError.mock.calls[0][0]).toMatch(/private repo/i);
    // Second call: bare pkg name, no auth → no hint (auth was never needed).
    expect(logError.mock.calls[1][0]).not.toMatch(/private repo/i);
  });
});
