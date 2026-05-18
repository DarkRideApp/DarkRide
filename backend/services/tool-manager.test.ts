import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

// Mock fs
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: {
      ...original,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      chmodSync: vi.fn(),
      unlinkSync: vi.fn(),
      rmSync: vi.fn(),
      createWriteStream: vi.fn(),
      readdirSync: vi.fn(() => []),
      renameSync: vi.fn(),
    },
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
    readdirSync: vi.fn(() => []),
    renameSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    rm: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
  },
  mkdir: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

// We need to mock AdmZip for jadx extraction
const { mockExtractAllTo } = vi.hoisted(() => {
  const mockExtractAllTo = vi.fn();
  return { mockExtractAllTo };
});

vi.mock('adm-zip', async () => {
  class FakeAdmZip {
    constructor(_input?: any) {}
    extractAllTo = mockExtractAllTo;
  }
  return { default: FakeAdmZip };
});

import { ToolManager } from './tool-manager';
import { execSync, execFileSync } from 'child_process';
import fs from 'node:fs';

const fsMock = fs as any;
const execSyncMock = execSync as any;
const execFileSyncMock = execFileSync as any;

describe('ToolManager', () => {
  let manager: ToolManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ToolManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('hasJava()', () => {
    it('returns true when java is available', () => {
      execFileSyncMock.mockReturnValueOnce(Buffer.from('openjdk version "17.0.10"'));
      expect(manager.hasJava()).toBe(true);
    });

    it('returns false when java is not available', () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error('Command not found: java');
      });
      expect(manager.hasJava()).toBe(false);
    });

    it('caches java availability after first check', () => {
      execFileSyncMock.mockReturnValueOnce(Buffer.from('openjdk version "17.0.10"'));
      manager.hasJava(); // first call discovers java
      execSyncMock.mockClear();

      expect(manager.hasJava()).toBe(true);
      expect(execSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('getToolPath()', () => {
    it('returns null for missing jadx', () => {
      fsMock.existsSync.mockReturnValue(false);
      expect(manager.getToolPath('jadx')).toBeNull();
    });

    it('returns path for installed jadx', () => {
      fsMock.existsSync.mockReturnValue(true);
      const p = manager.getToolPath('jadx');
      expect(p).not.toBeNull();
      expect(p).toContain('jadx');
      expect(p).toContain('bin');
    });

    it('returns null for missing apktool', () => {
      fsMock.existsSync.mockReturnValue(false);
      expect(manager.getToolPath('apktool')).toBeNull();
    });

    it('returns path for installed apktool', () => {
      fsMock.existsSync.mockReturnValue(true);
      const p = manager.getToolPath('apktool');
      expect(p).not.toBeNull();
      expect(p).toContain('apktool.jar');
    });

    it('returns null for missing mobsfscan', () => {
      fsMock.existsSync.mockReturnValue(false);
      expect(manager.getToolPath('mobsfscan')).toBeNull();
    });

    it('returns path for installed mobsfscan', () => {
      fsMock.existsSync.mockReturnValue(true);
      const p = manager.getToolPath('mobsfscan');
      expect(p).not.toBeNull();
      expect(p).toContain('mobsfscan');
    });
  });

  describe('getStatus()', () => {
    it('returns not-installed for missing tools', async () => {
      fsMock.existsSync.mockReturnValue(false);
      execFileSyncMock.mockImplementation(() => { throw new Error('no java'); });

      const status = await manager.getStatus();
      expect(status.java).toBe(false);
      for (const tool of status.tools) {
        expect(tool.installed).toBe(false);
        expect(tool.version).toBeNull();
      }
    });

    it('returns installed with version for present tools', async () => {
      fsMock.existsSync.mockReturnValue(true);
      execFileSyncMock.mockReturnValue(Buffer.from('openjdk version "17.0.10"'));

      const status = await manager.getStatus();
      expect(status.java).toBe(true);
      for (const tool of status.tools) {
        expect(tool.installed).toBe(true);
        expect(tool.path).not.toBeNull();
      }
    });

    it('detects java availability', async () => {
      fsMock.existsSync.mockReturnValue(false);
      execFileSyncMock.mockReturnValue(Buffer.from('openjdk version "17.0.10"'));
      const status = await manager.getStatus();
      expect(status.java).toBe(true);
    });

    it('reports correct tool names', async () => {
      fsMock.existsSync.mockReturnValue(false);
      execFileSyncMock.mockImplementation(() => { throw new Error('no java'); });

      const status = await manager.getStatus();
      const names = status.tools.map(t => t.name);
      expect(names).toEqual(['jadx', 'apktool', 'mobsfscan', 'blutter']);
    });
  });

  describe('getToolPaths()', () => {
    it('returns absolute paths to all installed tool binaries', () => {
      fsMock.existsSync.mockReturnValue(true);
      execFileSyncMock.mockReturnValue(Buffer.from('openjdk version "17.0.10"'));

      const paths = manager.getToolPaths();
      expect(paths.jadx).not.toBeNull();
      expect(paths.apktool).not.toBeNull();
      expect(paths.mobsfscan).not.toBeNull();
      expect(paths.java).toBe('java');

      // All paths should be absolute
      for (const [key, p] of Object.entries(paths)) {
        if (p && key !== 'java') {
          expect(path.isAbsolute(p)).toBe(true);
        }
      }
    });

    it('returns null for missing tools', () => {
      fsMock.existsSync.mockReturnValue(false);
      execFileSyncMock.mockImplementation(() => { throw new Error('no java'); });

      const paths = manager.getToolPaths();
      expect(paths.jadx).toBeNull();
      expect(paths.apktool).toBeNull();
      expect(paths.mobsfscan).toBeNull();
      expect(paths.java).toBeNull();
    });
  });

  describe('downloadTool()', () => {
    it('downloads jadx zip from GitHub releases and extracts', async () => {
      const mockZipBuffer = Buffer.from('fake-zip-data');
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v1.5.1',
            assets: [
              { name: 'jadx-1.5.1.zip', browser_download_url: 'https://github.com/jadx/jadx-1.5.1.zip' },
            ],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockZipBuffer.buffer,
        } as any);

      fsMock.mkdirSync.mockReturnValue(undefined);
      fsMock.existsSync.mockReturnValue(false);

      await manager.downloadTool('jadx');

      // Should have fetched GitHub API then download URL
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('downloads apktool jar from GitHub releases', async () => {
      const mockJarBuffer = Buffer.from('fake-jar-data');
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v2.10.0',
            assets: [
              { name: 'apktool_2.10.0.jar', browser_download_url: 'https://github.com/apktool_2.10.0.jar' },
            ],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockJarBuffer.buffer,
        } as any);

      fsMock.mkdirSync.mockReturnValue(undefined);
      fsMock.existsSync.mockReturnValue(false);

      await manager.downloadTool('apktool');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(fsMock.writeFileSync).toHaveBeenCalled();
    });

    it('installs mobsfscan via pip into venv', async () => {
      fsMock.existsSync.mockReturnValue(false);
      execFileSyncMock.mockReturnValue('');

      await manager.downloadTool('mobsfscan');

      expect(execFileSyncMock).toHaveBeenCalled();
      const call = execFileSyncMock.mock.calls[0];
      expect(call[0]).toContain('python');
      expect(call[1]).toEqual(expect.arrayContaining(['-m', 'pip', 'install', 'mobsfscan']));
    });

    it('handles GitHub API rate limiting gracefully', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'rate limit exceeded',
      } as any);

      await expect(manager.downloadTool('jadx')).rejects.toThrow();
    });

    it('skips download if tool already installed', async () => {
      fsMock.existsSync.mockReturnValue(true);
      const fetchSpy = vi.spyOn(global, 'fetch');

      // Calling getToolPath returns a valid path, so downloadJadx should short-circuit
      // We test this via ensureTools which checks getToolPath first
      const paths = await manager.ensureTools();

      // No fetch calls should have been made since all tools appear installed
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('handles download failure', async () => {
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v1.5.1',
            assets: [
              { name: 'jadx-1.5.1.zip', browser_download_url: 'https://github.com/jadx-1.5.1.zip' },
            ],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        } as any);

      fsMock.existsSync.mockReturnValue(false);

      await expect(manager.downloadTool('jadx')).rejects.toThrow('Download failed');
    });
  });

  describe('ensureTools()', () => {
    it('downloads all missing tools', async () => {
      fsMock.existsSync.mockReturnValue(false);
      execFileSyncMock.mockImplementation(() => { throw new Error('no java'); });

      // Mock fetch for jadx, apktool GitHub releases + downloads (4 calls)
      const mockBuffer = Buffer.from('fake-data');
      const fetchSpy = vi.spyOn(global, 'fetch');

      // jadx: release API + download
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v1.5.1',
            assets: [{ name: 'jadx-1.5.1.zip', browser_download_url: 'https://github.com/jadx.zip' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockBuffer.buffer,
        } as any);

      // apktool: release API + download
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v2.10.0',
            assets: [{ name: 'apktool_2.10.0.jar', browser_download_url: 'https://github.com/apktool.jar' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockBuffer.buffer,
        } as any);

      // mobsfscan: pip install
      execFileSyncMock.mockReturnValue('');

      const paths = await manager.ensureTools();

      // Should have attempted to download each tool
      expect(fetchSpy).toHaveBeenCalledTimes(4); // 2 tools * 2 (api + download)
      expect(execFileSyncMock).toHaveBeenCalled(); // mobsfscan pip install
    });

    it('skips already-installed tools', async () => {
      fsMock.existsSync.mockReturnValue(true);
      execFileSyncMock.mockReturnValue(Buffer.from('openjdk version "17.0.10"'));

      const fetchSpy = vi.spyOn(global, 'fetch');
      const paths = await manager.ensureTools();

      // Nothing should be downloaded
      expect(fetchSpy).not.toHaveBeenCalled();
      // execFileSync IS called once (the java -version probe in hasJava). It
      // must NOT be called with pip-install args — that's the installation
      // path we're asserting did not run.
      const pipInstallCalls = execFileSyncMock.mock.calls.filter(
        (call: any[]) => Array.isArray(call[1]) && call[1].includes('install'),
      );
      expect(pipInstallCalls).toHaveLength(0);
    });

    it('returns status summary with paths', async () => {
      fsMock.existsSync.mockReturnValue(true);
      execFileSyncMock.mockReturnValue(Buffer.from('openjdk version "17.0.10"'));

      const paths = await manager.ensureTools();

      expect(paths).toHaveProperty('jadx');
      expect(paths).toHaveProperty('apktool');
      expect(paths).toHaveProperty('mobsfscan');
      expect(paths).toHaveProperty('java');
    });

    it('continues if one tool fails to download', async () => {
      fsMock.existsSync.mockReturnValue(false);
      execFileSyncMock.mockImplementation(() => { throw new Error('no java'); });

      const fetchSpy = vi.spyOn(global, 'fetch');

      // jadx fails
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      } as any);

      // apktool succeeds
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v2.10.0',
            assets: [{ name: 'apktool_2.10.0.jar', browser_download_url: 'https://github.com/apktool.jar' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => Buffer.from('fake').buffer,
        } as any);

      // mobsfscan pip install
      execFileSyncMock.mockReturnValue('');

      // Should not throw — continues past jadx failure
      const paths = await manager.ensureTools();
      expect(paths).toBeDefined();
    });
  });

  describe('getInstalledVersion()', () => {
    it('returns version for jadx', () => {
      fsMock.existsSync.mockReturnValue(true);
      const version = manager.getInstalledVersion('jadx');
      expect(version).toBe('1.5.1');
    });

    it('returns version for apktool', () => {
      fsMock.existsSync.mockReturnValue(true);
      const version = manager.getInstalledVersion('apktool');
      expect(version).toBe('2.10.0');
    });

    it('returns mobsfscan version from pip', () => {
      execFileSyncMock.mockReturnValue('1.60.0\n');
      const version = manager.getInstalledVersion('mobsfscan');
      expect(version).toBe('1.60.0');
    });

    it('returns null for mobsfscan when not installed', () => {
      execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
      const version = manager.getInstalledVersion('mobsfscan');
      expect(version).toBeNull();
    });
  });

  describe('GitHub release URL construction', () => {
    it('constructs correct jadx GitHub releases API URL', async () => {
      fsMock.existsSync.mockReturnValue(false);

      const fetchSpy = vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v1.5.1',
            assets: [{ name: 'jadx-1.5.1.zip', browser_download_url: 'https://github.com/jadx.zip' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => Buffer.from('fake').buffer,
        } as any);

      await manager.downloadTool('jadx');

      const firstCallUrl = fetchSpy.mock.calls[0][0] as string;
      expect(firstCallUrl).toContain('github.com/repos/skylot/jadx/releases/tags/v1.5.1');
    });

    it('constructs correct apktool GitHub releases API URL', async () => {
      fsMock.existsSync.mockReturnValue(false);

      const fetchSpy = vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'v2.10.0',
            assets: [{ name: 'apktool_2.10.0.jar', browser_download_url: 'https://github.com/apktool.jar' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => Buffer.from('fake').buffer,
        } as any);

      await manager.downloadTool('apktool');

      const firstCallUrl = fetchSpy.mock.calls[0][0] as string;
      expect(firstCallUrl).toContain('github.com/repos/iBotPeaches/Apktool/releases/tags/v2.10.0');
    });

  });
});
