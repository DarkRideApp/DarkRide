import { execSync } from 'child_process';
import { rmSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Convert tests/fixtures/test-plugin/ into a bare git repo at
 * tests/fixtures/test-plugin.git/. Idempotent — re-runs blow away the bundle
 * and rebuild from the current source. Called by the e2e test setup.
 *
 * Returns the absolute path to the bare repo (suitable for `git+file://`
 * install URL).
 */
export function buildTestPluginBundle(): string {
  const src = resolve(__dirname, 'test-plugin');
  const bundle = resolve(__dirname, 'test-plugin.git');
  const workTmp = resolve(__dirname, 'test-plugin-work');

  if (existsSync(bundle)) rmSync(bundle, { recursive: true, force: true });
  if (existsSync(workTmp)) rmSync(workTmp, { recursive: true, force: true });

  execSync(`cp -r "${src}" "${workTmp}"`, { stdio: 'inherit' });
  execSync('git init -q -b main', { cwd: workTmp });
  execSync('git config user.email test@e.com', { cwd: workTmp });
  execSync('git config user.name test', { cwd: workTmp });
  execSync('git add -A', { cwd: workTmp });
  execSync('git commit -q -m "fixture"', { cwd: workTmp });
  execSync(`git clone -q --bare "${workTmp}" "${bundle}"`, { stdio: 'inherit' });
  rmSync(workTmp, { recursive: true, force: true });

  return bundle;
}

if (require.main === module) {
  const path = buildTestPluginBundle();
  console.log(`Built bundle at ${path}`);
}
