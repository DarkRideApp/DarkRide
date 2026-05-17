#!/usr/bin/env node
/**
 * DarkRide CLI bootstrap.
 *
 * Picks the right entry point depending on how DarkRide was installed:
 *
 *   - Production install (`npm install --production` or from a packaged build):
 *     dist/bin/darkride.js exists → require it directly, no tsx needed.
 *
 *   - Source checkout (cloned from GitHub, ran `npm install`):
 *     dist/ doesn't exist → spawn tsx to run the TypeScript source.
 *
 * tsx is a devDependency, so we only spawn it when we can reasonably assume
 * it's available (i.e. a dev checkout, where devDependencies are installed).
 */
const { existsSync } = require('fs');
const { resolve, dirname } = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
const compiledEntry = resolve(here, '..', 'dist', 'bin', 'darkride.js');
const sourceEntry = resolve(here, 'darkride.ts');

if (existsSync(compiledEntry)) {
  // Production: load the compiled CLI directly.
  require(compiledEntry);
} else if (existsSync(sourceEntry)) {
  // Development: run the TypeScript source via tsx.
  // On Windows, npm bin links are *.cmd files (e.g. tsx.cmd, not tsx). The
  // bare path won't exist; we must check the platform-specific extension or
  // spawn through the shell.
  const isWindows = process.platform === 'win32';
  const tsxBinBase = resolve(here, '..', 'node_modules', '.bin', 'tsx');
  const tsxBin = isWindows
    ? (existsSync(tsxBinBase + '.cmd') ? tsxBinBase + '.cmd' : tsxBinBase)
    : tsxBinBase;
  const tsxCmd = existsSync(tsxBin) ? tsxBin : 'tsx';
  const result = spawnSync(tsxCmd, [sourceEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    // shell: true makes Windows resolve *.cmd from PATH if the explicit path
    // didn't pan out; harmless on Unix where the resolved path is exact.
    shell: isWindows,
  });
  if (result.error) {
    console.error(`darkride CLI: failed to spawn tsx: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} else {
  console.error('darkride CLI: neither dist/bin/darkride.js nor bin/darkride.ts was found.');
  console.error('Run `npm run build` or ensure you cloned the full repository.');
  process.exit(1);
}
