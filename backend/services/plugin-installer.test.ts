import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginInstaller } from './plugin-installer';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { exec } from 'child_process';

function mockExecSuccess(stdout = '') {
  (exec as any).mockImplementation((_cmd: string, _opts: any, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

function mockExecFailure(message = 'command failed') {
  (exec as any).mockImplementation((_cmd: string, _opts: any, cb: Function) => {
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
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('npm install @darkride/plugin-foo'),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('rejects invalid package names', async () => {
      const result = await installer.install('../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid package name');
      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects package names with shell metacharacters', async () => {
      const result = await installer.install('foo; rm -rf /');
      expect(result.success).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('accepts scoped package names with dots in the scope', async () => {
      // Per npm spec, scope names can contain dots (e.g. @example.dots/plugin-foo).
      mockExecSuccess('added 1 package');
      const result = await installer.install('@example.dots/plugin-foo');
      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('npm install @example.dots/plugin-foo'),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('installs from git+https URL', async () => {
      mockExecSuccess('added 1 package');
      const result = await installer.install('git+https://gitea.local/org/plugin-foo.git');
      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('npm install git+https://gitea.local/org/plugin-foo.git'),
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
  });

  describe('uninstall', () => {
    it('runs npm uninstall', async () => {
      mockExecSuccess('removed 1 package');
      const result = await installer.uninstall('@darkride/plugin-foo');
      expect(result.success).toBe(true);
    });
  });

  describe('update', () => {
    it('runs npm update', async () => {
      mockExecSuccess('updated 1 package');
      const result = await installer.update('@darkride/plugin-foo');
      expect(result.success).toBe(true);
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
