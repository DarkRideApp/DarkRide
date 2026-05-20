import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PluginInstaller } from './plugin-installer';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

function mockExecSuccess(stdout = '') {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

function mockExecFailure(message = 'command failed') {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(new Error(message));
  });
}

describe('PluginInstaller', () => {
  let installer: PluginInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    installer = new PluginInstaller();
  });

  describe('install', () => {
    it('runs npm install with valid package name', async () => {
      mockExecSuccess('added 1 package');
      const result = await installer.install('@darkride/plugin-foo');
      expect(result.success).toBe(true);
      expect(execFile).toHaveBeenCalledWith(
        'npm',
        ['install', '@darkride/plugin-foo'],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('rejects invalid package names', async () => {
      const result = await installer.install('../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid package name');
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects package names with shell metacharacters', async () => {
      const result = await installer.install('foo; rm -rf /');
      expect(result.success).toBe(false);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('accepts scoped package names with dots in the scope', async () => {
      // Per npm spec, scope names can contain dots (e.g. @example.dots/plugin-foo).
      mockExecSuccess('added 1 package');
      const result = await installer.install('@example.dots/plugin-foo');
      expect(result.success).toBe(true);
      expect(execFile).toHaveBeenCalledWith(
        'npm',
        ['install', '@example.dots/plugin-foo'],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('installs from git+https URL', async () => {
      mockExecSuccess('added 1 package');
      const result = await installer.install('git+https://gitea.local/org/plugin-foo.git');
      expect(result.success).toBe(true);
      expect(execFile).toHaveBeenCalledWith(
        'npm',
        ['install', 'git+https://gitea.local/org/plugin-foo.git'],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('rejects git URL without git+ prefix', async () => {
      const result = await installer.install('https://gitea.local/org/plugin-foo.git');
      expect(result.success).toBe(false);
    });

    it('returns error when npm fails', async () => {
      mockExecFailure('npm ERR! 404 Not Found');
      const result = await installer.install('@darkride/plugin-nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });

    it('passes installTarget as a single argv slot (no shell interpretation)', async () => {
      // Regression test for the command-injection fix: a package name containing
      // shell metacharacters that bypassed validation (it won't, but defence-
      // in-depth) must NOT be interpreted by the host shell. Verifying that
      // execFile receives the value as one argv slot guarantees this.
      mockExecSuccess('added 1 package');
      await installer.install('@darkride/plugin-foo');
      const call = (execFile as any).mock.calls[0];
      expect(call[0]).toBe('npm');
      expect(Array.isArray(call[1])).toBe(true);
      // Whole installTarget appears as ONE element of args, not split or interpolated.
      expect(call[1]).toContain('@darkride/plugin-foo');
    });
  });

  describe('uninstall', () => {
    it('runs npm uninstall', async () => {
      mockExecSuccess('removed 1 package');
      const result = await installer.uninstall('@darkride/plugin-foo');
      expect(result.success).toBe(true);
      expect(execFile).toHaveBeenCalledWith(
        'npm',
        ['uninstall', '@darkride/plugin-foo'],
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe('update', () => {
    let tmpManagedRoot: string;

    beforeEach(() => {
      // The update path reads the post-update package-lock.json to surface
      // the new pkgName/resolvedRef/npmShasum for content-pin verification
      // (see plugin-architecture-review 2026-05-20 I6). Provide an isolated
      // managedRoot with a synthesized lockfile rather than relying on
      // whatever leftover state the host's real DATA_ROOT happens to have.
      tmpManagedRoot = mkdtempSync(join(tmpdir(), 'plugin-installer-update-'));
      mkdirSync(tmpManagedRoot, { recursive: true });
      writeFileSync(join(tmpManagedRoot, 'package-lock.json'), JSON.stringify({
        packages: {
          'node_modules/@darkride/plugin-foo': {
            integrity: 'sha512-FAKE-INTEGRITY',
            resolved: 'https://registry.npmjs.org/@darkride/plugin-foo/-/plugin-foo-1.2.3.tgz',
          },
        },
      }));
      installer = new PluginInstaller({ managedRoot: tmpManagedRoot });
    });

    afterEach(() => {
      if (tmpManagedRoot) rmSync(tmpManagedRoot, { recursive: true, force: true });
    });

    it('runs npm install --prefix with @latest and surfaces lockfile-derived fingerprints', async () => {
      mockExecSuccess('updated 1 package');
      const result = await installer.update('@darkride/plugin-foo');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.pkgName).toBe('@darkride/plugin-foo');
        expect(result.npmShasum).toBe('sha512-FAKE-INTEGRITY');
        expect(result.resolvedRef).toBe(null); // not a git URL
      }
      const args = (execFile as any).mock.calls[0][1] as string[];
      expect(args).toContain(`--prefix=${tmpManagedRoot}`);
      expect(args).toContain('@darkride/plugin-foo@latest');
    });

    it('returns error when the post-update lockfile is missing', async () => {
      // Simulate npm install completing but no lockfile being written
      // (corrupted prefix dir, --no-package-lock somewhere, etc.).
      rmSync(join(tmpManagedRoot, 'package-lock.json'));
      mockExecSuccess('updated 1 package');
      const result = await installer.update('@darkride/plugin-foo');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/package-lock\.json/);
      }
    });
  });

  describe('getLatestVersion', () => {
    it('returns version string', async () => {
      mockExecSuccess('2.0.0\n');
      const version = await installer.getLatestVersion('@darkride/plugin-foo');
      expect(version).toBe('2.0.0');
    });

    it('returns null on error', async () => {
      mockExecFailure('npm ERR!');
      const version = await installer.getLatestVersion('nonexistent');
      expect(version).toBeNull();
    });
  });

  describe('isCompatible', () => {
    it('returns true when current >= min', () => {
      expect(installer.isCompatible('1.0.0', '1.0.0')).toBe(true);
      expect(installer.isCompatible('1.0.0', '2.0.0')).toBe(true);
      expect(installer.isCompatible('1.0.0', '1.1.0')).toBe(true);
      expect(installer.isCompatible('1.0.0', '1.0.1')).toBe(true);
    });

    it('returns false when current < min', () => {
      expect(installer.isCompatible('2.0.0', '1.0.0')).toBe(false);
      expect(installer.isCompatible('1.1.0', '1.0.0')).toBe(false);
      expect(installer.isCompatible('1.0.1', '1.0.0')).toBe(false);
    });
  });
});
