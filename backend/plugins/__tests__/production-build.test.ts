import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

/**
 * Smoke test: verify the production build includes the plugins directory.
 *
 * This test exists because `tsconfig.json` must include `plugins/**\/*.ts` in its
 * `include` array, otherwise `npm run build` silently omits plugin code and
 * `npm start` fails with MODULE_NOT_FOUND at runtime.
 *
 * This test only runs when dist/ exists (i.e. after `npm run build`).
 * Skipped in dev mode where only tsx is used.
 */
describe('production build', () => {
  const distRoot = resolve('./dist');
  const distPluginsRoot = resolve('./dist/plugins');

  const hasDistBuild = existsSync(distRoot) && existsSync(distPluginsRoot);

  it.runIf(hasDistBuild)('includes compiled plugin entry files for kitchen-sink', () => {
    const pluginEntry = resolve('./dist/plugins/kitchen-sink/darkride-plugin.js');
    expect(existsSync(pluginEntry)).toBe(true);
    expect(statSync(pluginEntry).size).toBeGreaterThan(0);
  });

  it.runIf(hasDistBuild)('includes compiled backend code for kitchen-sink plugin', () => {
    // kitchen-sink has backend/routes.ts and backend/schema.ts — both should compile
    expect(existsSync(resolve('./dist/plugins/kitchen-sink/backend/routes.js'))).toBe(true);
    expect(existsSync(resolve('./dist/plugins/kitchen-sink/backend/schema.js'))).toBe(true);
  });

  it.runIf(hasDistBuild)('includes compiled discover module at expected path', () => {
    // discover.js computes PLUGINS_DIR as __dirname/../../plugins.
    // In dist this is dist/backend/plugins/discover.js → dist/plugins
    const discoverJs = resolve('./dist/backend/plugins/discover.js');
    expect(existsSync(discoverJs)).toBe(true);
  });
});
