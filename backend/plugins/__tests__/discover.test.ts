import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import fs from 'fs';
import path, { join } from 'path';
import { tmpdir } from 'os';
import os from 'os';
import { discoverPlugins, discoverNpmPlugins } from '../discover';

vi.mock('../../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

describe('discoverPlugins', () => {
  let tmpDir: string;
  let tmpPluginsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-discover-test-'));
    tmpPluginsDir = path.join(tmpDir, 'plugins');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── No plugins/ directory ────────────────────────────────────────

  it('should return empty array when plugins/ directory does not exist', async () => {
    const result = await discoverPlugins([tmpPluginsDir]);
    expect(result).toEqual([]);
  });

  // ── Skip non-directories ─────────────────────────────────────────

  it('should skip files that are not directories', async () => {
    fs.mkdirSync(tmpPluginsDir);
    fs.writeFileSync(path.join(tmpPluginsDir, 'not-a-dir.txt'), 'hello');

    const result = await discoverPlugins([tmpPluginsDir]);
    expect(result).toEqual([]);
  });

  // ── Skip directories without entry file ──────────────────────────

  it('should skip directories without a darkride-plugin entry file', async () => {
    fs.mkdirSync(tmpPluginsDir);
    fs.mkdirSync(path.join(tmpPluginsDir, 'no-entry'));

    const result = await discoverPlugins([tmpPluginsDir]);
    expect(result).toEqual([]);
  });

  // ── Invalid plugins (missing name or register) ───────────────────

  it('should skip plugins missing the name property', async () => {
    fs.mkdirSync(tmpPluginsDir);
    const pluginDir = path.join(tmpPluginsDir, 'bad-plugin');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'darkride-plugin.js'), `
      module.exports = {
        version: '1.0.0',
        register: function(ctx) {},
      };
    `);

    const result = await discoverPlugins([tmpPluginsDir]);
    expect(result).toEqual([]);
  });

  it('should skip plugins missing the register function', async () => {
    fs.mkdirSync(tmpPluginsDir);
    const pluginDir = path.join(tmpPluginsDir, 'no-register');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'darkride-plugin.js'), `
      module.exports = {
        name: 'no-register',
        version: '1.0.0',
      };
    `);

    const result = await discoverPlugins([tmpPluginsDir]);
    expect(result).toEqual([]);
  });

  // ── Plugins that throw during import ─────────────────────────────

  it('should handle plugins that throw during import and continue', async () => {
    fs.mkdirSync(tmpPluginsDir);
    const pluginDir = path.join(tmpPluginsDir, 'throws-plugin');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'darkride-plugin.js'), `
      throw new Error('Plugin init explosion');
    `);

    const result = await discoverPlugins([tmpPluginsDir]);
    expect(result).toEqual([]);
  });

  // ── Real plugins/ directory integration test ─────────────────────

  it('should discover real plugins from the default plugins/ directory', async () => {
    // Calls with no arg — uses DEFAULT_PLUGINS_DIR (the project's plugins/)
    const result = await discoverPlugins();

    expect(result.length).toBeGreaterThanOrEqual(1);
    const names = result.map(p => p.name);
    expect(names).toContain('kitchen-sink');

    for (const p of result) {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('path');
      expect(p).toHaveProperty('definition');
      expect(p.definition).toHaveProperty('name');
      expect(p.definition).toHaveProperty('version');
      expect(typeof p.definition.register).toBe('function');
    }
  });

  it('should handle plugins with ESM default export (kitchen-sink pattern)', async () => {
    // Real plugins use `export default definePlugin(...)` — ESM default export
    const result = await discoverPlugins();

    const kitchenSink = result.find(p => p.name === 'kitchen-sink');
    expect(kitchenSink).toBeDefined();
    expect(kitchenSink!.name).toBe('kitchen-sink');
    expect(typeof kitchenSink!.definition.register).toBe('function');
  });
});

function makePluginDir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  // Minimal valid plugin entry — must export a definition with name + register
  writeFileSync(
    join(dir, 'darkride-plugin.js'),
    `module.exports = { default: { name: '${name}', version: '0.0.1', dependencies: [], register: () => {} } };\n`,
  );
  return dir;
}

describe('discoverPlugins — multiple source directories', () => {
  let tmpA: string;
  let tmpB: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpA = mkdtempSync(join(tmpdir(), 'dr-pluginsA-'));
    tmpB = mkdtempSync(join(tmpdir(), 'dr-pluginsB-'));
    prevEnv = process.env.DARKRIDE_PLUGIN_DIRS;
  });

  afterEach(() => {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.DARKRIDE_PLUGIN_DIRS;
    else process.env.DARKRIDE_PLUGIN_DIRS = prevEnv;
  });

  it('reads DARKRIDE_PLUGIN_DIRS, scans every listed dir, merges results', async () => {
    makePluginDir(tmpA, 'plugin-a');
    makePluginDir(tmpB, 'plugin-b');
    // Use path.delimiter so Linux=":" and Windows=";"
    const { delimiter } = await import('path');
    process.env.DARKRIDE_PLUGIN_DIRS = `${tmpA}${delimiter}${tmpB}`;

    const found = await discoverPlugins();
    const names = found.map(p => p.name).sort();
    expect(names).toEqual(['plugin-a', 'plugin-b']);
  });

  it('tolerates a missing dir in DARKRIDE_PLUGIN_DIRS without aborting the others', async () => {
    makePluginDir(tmpA, 'plugin-a');
    const { delimiter } = await import('path');
    process.env.DARKRIDE_PLUGIN_DIRS = `${tmpA}${delimiter}/does/not/exist`;

    const found = await discoverPlugins();
    expect(found.map(p => p.name)).toEqual(['plugin-a']);
  });

  it('falls back to the default <project>/plugins dir when the env var is empty or unset', async () => {
    delete process.env.DARKRIDE_PLUGIN_DIRS;
    // No assertion on contents — the project's plugins/ may or may not exist in
    // test environments. We just verify discoverPlugins() does not throw.
    await expect(discoverPlugins()).resolves.toBeDefined();
  });

  it('ignores empty entries from a trailing delimiter', async () => {
    makePluginDir(tmpA, 'plugin-a');
    const { delimiter } = await import('path');
    process.env.DARKRIDE_PLUGIN_DIRS = `${tmpA}${delimiter}${delimiter}`;

    const found = await discoverPlugins();
    expect(found.map(p => p.name)).toEqual(['plugin-a']);
  });
});

describe('discoverNpmPlugins — scope-agnostic scanning', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'dr-nm-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('discovers plugins under any @<scope>/plugin-* dir', async () => {
    // Simulate node_modules layout for three different scopes
    makePluginDir(join(tmpRoot, '@example.dots'), 'plugin-foo');
    makePluginDir(join(tmpRoot, '@darkrideapp'), 'plugin-bar');
    makePluginDir(join(tmpRoot, '@some-other-org'), 'plugin-baz');
    // Non-plugin directories must be ignored
    mkdirSync(join(tmpRoot, '@example.dots', 'not-a-plugin'), { recursive: true });

    const found = await discoverNpmPlugins(tmpRoot);
    const names = found.map(p => p.name).sort();
    expect(names).toEqual(['plugin-bar', 'plugin-baz', 'plugin-foo']);
  });

  it('still discovers unscoped darkride-plugin-* packages', async () => {
    makePluginDir(tmpRoot, 'darkride-plugin-legacy');

    const found = await discoverNpmPlugins(tmpRoot);
    expect(found.map(p => p.name)).toEqual(['darkride-plugin-legacy']);
  });

  it('reads packageVersion from package.json (preferred over definition.version)', async () => {
    // Simulate a real failure mode: the published tarball is at v1.0.1 but
    // the in-source definition.version is still 1.0.0 (author forgot to bump
    // it on the patch release). Discovery must report the package.json
    // version so the marketplace's "update available" check is correct.
    const dir = makePluginDir(join(tmpRoot, '@scope'), 'plugin-versioned');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@scope/plugin-versioned', version: '1.0.1' }),
    );
    // The plugin's compiled definition still says 1.0.0 (drift).
    writeFileSync(
      join(dir, 'darkride-plugin.js'),
      `module.exports = { default: { name: 'plugin-versioned', version: '1.0.0', dependencies: [], register: () => {} } };\n`,
    );

    const found = await discoverNpmPlugins(tmpRoot);
    const plugin = found.find(p => p.name === 'plugin-versioned');
    expect(plugin).toBeDefined();
    expect(plugin?.packageVersion).toBe('1.0.1');
    expect(plugin?.definition.version).toBe('1.0.0');
  });
});
