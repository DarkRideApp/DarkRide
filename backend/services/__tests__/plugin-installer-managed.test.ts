import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PluginInstaller } from '../plugin-installer';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));
import { exec } from 'child_process';

function setupManagedTreeWithPlugin(
  prefix: string,
  scope: string,
  pkg: string,
  opts: { withEntry?: boolean; lockfileResolved?: string; tsContent?: string; jsContent?: string; tsxContent?: string } = {},
) {
  const pkgDir = join(prefix, 'node_modules', scope, pkg);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: `${scope}/${pkg}`, version: '0.0.1' }));
  if (opts.withEntry !== false) {
    if (opts.tsContent !== undefined) {
      writeFileSync(join(pkgDir, 'darkride-plugin.ts'), opts.tsContent);
    }
    if (opts.tsxContent !== undefined) {
      writeFileSync(join(pkgDir, 'darkride-plugin.tsx'), opts.tsxContent);
    }
    if (opts.jsContent !== undefined) {
      writeFileSync(join(pkgDir, 'darkride-plugin.js'), opts.jsContent);
    }
    if (opts.tsContent === undefined && opts.tsxContent === undefined && opts.jsContent === undefined) {
      writeFileSync(join(pkgDir, 'darkride-plugin.js'), '/* fixture */');
    }
  }
  const lock = {
    name: 'darkride-managed-plugins',
    lockfileVersion: 3,
    packages: {
      [`node_modules/${scope}/${pkg}`]: {
        version: '0.0.1',
        ...(opts.lockfileResolved ? { resolved: opts.lockfileResolved } : {}),
      },
    },
  };
  writeFileSync(join(prefix, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(join(prefix, 'package.json'), JSON.stringify({ name: 'darkride-managed-plugins', version: '0.0.0', private: true }));
}

describe('PluginInstaller.installManaged', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'installer-managed-'));
    vi.mocked(exec).mockReset();
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('creates the prefix package.json stub on first install', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((cmd: any, _opts: any, cb: any) => {
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test', { lockfileResolved: 'git+https://e.com/x.git#abc123' });
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    const result = await installer.installManaged('git+https://e.com/x.git', null);
    expect(result.success).toBe(true);
    expect(existsSync(join(tmp, 'package.json'))).toBe(true);
  });

  it('runs npm install with --prefix, --no-save, --legacy-peer-deps', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((cmd: any, _opts: any, cb: any) => {
      expect(cmd).toContain(`--prefix=${tmp}`);
      expect(cmd).toContain('--no-save');
      expect(cmd).toContain('--legacy-peer-deps');
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test');
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });
    await installer.installManaged('git+https://e.com/x.git', null);
    expect(vi.mocked(exec)).toHaveBeenCalled();
  });

  it('embeds the auth token for git+https URLs', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((cmd: any, _opts: any, cb: any) => {
      expect(cmd).toContain('token:secret123@');
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test');
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });
    await installer.installManaged('git+https://e.com/x.git', 'secret123');
  });

  it('returns success with pkgName + resolvedRef parsed from package-lock', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test', { lockfileResolved: 'git+https://e.com/x.git#deadbeef' });
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });
    const result = await installer.installManaged('git+https://e.com/x.git', null);
    expect(result).toMatchObject({ success: true, pkgName: '@darkrideapp/plugin-test', resolvedRef: 'deadbeef' });
  });

  it('rolls back when entry file is missing', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test', { withEntry: false });
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });
    const result = await installer.installManaged('git+https://e.com/x.git', null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/darkride-plugin/);
    expect(existsSync(join(tmp, 'node_modules', '@darkrideapp', 'plugin-test'))).toBe(false);
  });

  it('rejects invalid install targets', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    const result = await installer.installManaged('not://a-valid-target', null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Invalid/);
    expect(vi.mocked(exec)).not.toHaveBeenCalled();
  });

  it('redacts auth token from error messages on install failure', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(Object.assign(new Error('npm fail token:abc123@e.com fail'), { code: 1 }), { stdout: '', stderr: '' });
      return {} as any;
    });
    const result = await installer.installManaged('git+https://e.com/x.git', 'abc123');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toContain('abc123');
  });

  it('compiles darkride-plugin.ts to .js when only TS is shipped', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test', {
        tsContent: `const greeting: string = 'hi';\nmodule.exports = { name: 'test', greeting };\n`,
        lockfileResolved: 'git+https://e.com/x.git#abc123',
      });
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    const result = await installer.installManaged('git+https://e.com/x.git', null);
    expect(result.success).toBe(true);
    const jsPath = join(tmp, 'node_modules', '@darkrideapp', 'plugin-test', 'darkride-plugin.js');
    expect(existsSync(jsPath)).toBe(true);
    // The compiled output should be require()-able and behave like the source
    delete require.cache[require.resolve(jsPath)];
    const mod = require(jsPath);
    expect(mod.name).toBe('test');
    expect(mod.greeting).toBe('hi');
  });

  it('prefers existing .js over .ts (no recompile)', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test', {
        jsContent: `module.exports = { name: 'js-wins' };\n`,
        tsContent: `module.exports = { name: 'ts-loses' };\n`,
      });
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    const result = await installer.installManaged('git+https://e.com/x.git', null);
    expect(result.success).toBe(true);
    const jsPath = join(tmp, 'node_modules', '@darkrideapp', 'plugin-test', 'darkride-plugin.js');
    delete require.cache[require.resolve(jsPath)];
    const mod = require(jsPath);
    expect(mod.name).toBe('js-wins');
  });

  it('rolls back when .ts has a syntax error and surfaces the compile error', async () => {
    const installer = new PluginInstaller({ managedRoot: tmp });
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      setupManagedTreeWithPlugin(tmp, '@darkrideapp', 'plugin-test', {
        tsContent: `const x: string = ;\nthis is not valid typescript\n`,
      });
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    const result = await installer.installManaged('git+https://e.com/x.git', null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/compile|syntax|TypeScript/i);
    expect(existsSync(join(tmp, 'node_modules', '@darkrideapp', 'plugin-test'))).toBe(false);
  });
});
