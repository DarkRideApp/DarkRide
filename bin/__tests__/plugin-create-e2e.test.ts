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
