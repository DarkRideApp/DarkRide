import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';

const TEST_PLUGIN = 'test-e2e-plugin';
const PLUGIN_DIR = resolve('./plugins', TEST_PLUGIN);

function cleanup() {
  if (existsSync(PLUGIN_DIR)) rmSync(PLUGIN_DIR, { recursive: true });
  // frontend/plugins.ts uses auto-discovery — no manual cleanup needed
}

describe('darkride plugin create (e2e)', () => {
  afterEach(cleanup);

  it('scaffolds a working plugin that loads and passes its own tests', { timeout: 30_000 }, () => {
    // Create plugin via CLI (name, description, confirm Y)
    execSync(`echo "${TEST_PLUGIN}\nA test plugin for E2E\nY" | node bin/darkride.js plugin create`, {
      cwd: resolve('.'),
      stdio: 'pipe',
    });

    // Verify directory structure
    expect(existsSync(join(PLUGIN_DIR, 'package.json'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'darkride-plugin.ts'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'backend/schema.ts'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'backend/routes.ts'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'frontend/plugin.ts'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'frontend/pages/Main.tsx'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, '__tests__/plugin-load.test.ts'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'migrations/meta/_journal.json'))).toBe(true);

    // Verify package.json content
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf-8'));
    expect(pkg.keywords).toContain('darkride-plugin');
    expect(pkg.description).toBe('A test plugin for E2E');

    // Verify migrations journal
    const journal = JSON.parse(readFileSync(join(PLUGIN_DIR, 'migrations/meta/_journal.json'), 'utf-8'));
    expect(journal.version).toBe('7');
    expect(journal.dialect).toBe('sqlite');
    expect(journal.entries).toHaveLength(0);

    // Verify the generated plugin's own tests pass
    const result = execSync(`npx vitest run plugins/${TEST_PLUGIN}/ --reporter=verbose`, {
      cwd: resolve('.'),
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    expect(result).toContain('2 passed');

    // Verify it shows up in plugin list
    const listOutput = execSync('node bin/darkride.js plugin list', {
      cwd: resolve('.'),
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    expect(listOutput).toContain(TEST_PLUGIN);
  });

  it('scaffolded frontend/plugin.ts imports pluginRegistry from the SDK, not host internals', () => {
    execSync(`echo "${TEST_PLUGIN}\nA test plugin\nY" | node bin/darkride.js plugin create`, {
      cwd: resolve('.'),
      stdio: 'pipe',
    });

    const frontendCode = readFileSync(join(PLUGIN_DIR, 'frontend/plugin.ts'), 'utf-8');
    // Standalone plugins can't resolve relative paths back into the host repo.
    expect(frontendCode).not.toMatch(/from\s+['"]\.\.\/\.\.\/\.\.\/frontend\//);
    // The SDK's /react subpath is the only canonical pluginRegistry source.
    expect(frontendCode).toMatch(/from\s+['"]@darkrideapp\/plugin-sdk\/react['"]/);
  });

  it('scaffolded backend/routes.ts uses ctx.api(), not host internals', () => {
    execSync(`echo "${TEST_PLUGIN}\nA test plugin\nY" | node bin/darkride.js plugin create`, {
      cwd: resolve('.'),
      stdio: 'pipe',
    });

    const backendCode = readFileSync(join(PLUGIN_DIR, 'backend/routes.ts'), 'utf-8');
    // Reaching into ../../../backend/api/* breaks for standalone plugin repos.
    expect(backendCode).not.toMatch(/from\s+['"]\.\.\/\.\.\/\.\.\/backend\//);
    // Should accept a PluginContext and register via ctx.api().
    expect(backendCode).toMatch(/ctx\.api\(/);
  });

  it('scaffolded package.json pins SDK peer dep to a range that includes ctx-extensions', () => {
    execSync(`echo "${TEST_PLUGIN}\nA test plugin\nY" | node bin/darkride.js plugin create`, {
      cwd: resolve('.'),
      stdio: 'pipe',
    });

    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf-8'));
    const range: string = pkg.peerDependencies['@darkrideapp/plugin-sdk'];
    // ^1.0.0 admits SDK builds without ctx.dispatcher/apks/cloudFiles/automations/paths/websocket.
    // The minimum that includes the full ctx-extensions surface is 1.4.0.
    expect(range).not.toBe('^1.0.0');
    expect(range).toMatch(/^\^1\.(?:[4-9]|\d{2,})/);
  });

  it('rejects duplicate plugin names', () => {
    // Create first
    execSync(`echo "${TEST_PLUGIN}\nFirst\nY" | node bin/darkride.js plugin create`, {
      cwd: resolve('.'),
      stdio: 'pipe',
    });

    // Try to create again — should fail (directory exists)
    expect(() => {
      execSync(`echo "${TEST_PLUGIN}\nSecond\nY" | node bin/darkride.js plugin create`, {
        cwd: resolve('.'),
        stdio: 'pipe',
      });
    }).toThrow();
  });
});
