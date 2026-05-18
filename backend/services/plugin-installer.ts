import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'fs';
import { createLoggers } from '../logs';
import { getDataRoot } from '../config/paths';
import { safeJoinInside } from '../utils/safe-path';

const execFile = promisify(execFileCb);

const { log, error } = createLoggers('plugin-installer');

const PROJECT_ROOT = resolve(__dirname, '../..');

const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VALID_GIT_URL_RE = /^git\+https?:\/\/.+\.git$/;
const VALID_FILE_GIT_URL_RE = /^git\+file:\/\/.+\.git\/?$/;

const TIMEOUT_INSTALL = 120_000;
const TIMEOUT_VERSION = 15_000;

export interface InstallResult {
  success: boolean;
  error?: string;
  stdout?: string;
}

function validatePackageName(packageName: string): string | null {
  if (
    !PACKAGE_NAME_RE.test(packageName) &&
    !VALID_GIT_URL_RE.test(packageName) &&
    !VALID_FILE_GIT_URL_RE.test(packageName)
  ) {
    return `Invalid package name or URL: ${packageName}`;
  }
  return null;
}

export interface PluginInstallerOpts {
  /** Override the managed-plugin root (default: <DATA_ROOT>/installed-plugins). */
  managedRoot?: string;
}

export class PluginInstaller {
  private readonly managedRoot: string;

  constructor(opts: PluginInstallerOpts = {}) {
    this.managedRoot = opts.managedRoot ?? join(getDataRoot(), 'installed-plugins');
  }

  /**
   * Install an npm package into the project root. When `authToken` is
   * provided AND the target is a git+https:// URL, embed the token so npm's
   * underlying git ls-remote can authenticate against private repos.
   */
  async install(packageName: string, authToken?: string | null): Promise<InstallResult> {
    const validationError = validatePackageName(packageName);
    if (validationError) {
      return { success: false, error: validationError };
    }

    let installTarget = packageName;
    if (authToken && /^git\+https:\/\//.test(packageName)) {
      installTarget = packageName.replace(
        /^git\+https:\/\//,
        `git+https://token:${encodeURIComponent(authToken)}@`,
      );
    }

    log(`Installing ${packageName}...`); // log the un-tokenised URL only — never the token
    try {
      const { stdout } = await execFile('npm', ['install', installTarget], { cwd: PROJECT_ROOT, timeout: TIMEOUT_INSTALL });
      log(`Installed ${packageName}`);
      return { success: true, stdout };
    } catch (err: any) {
      // Strip any embedded token from the message before logging or returning
      const sanitisedMsg = (err.message ?? String(err)).replace(/token:[^@]+@/g, 'token:***@');
      error(`Failed to install ${packageName}: ${sanitisedMsg}`);
      return { success: false, error: sanitisedMsg };
    }
  }

  /**
   * Uninstall an npm package from the project root.
   */
  async uninstall(packageName: string): Promise<InstallResult> {
    const validationError = validatePackageName(packageName);
    if (validationError) {
      return { success: false, error: validationError };
    }

    log(`Uninstalling ${packageName}...`);
    try {
      const { stdout } = await execFile('npm', ['uninstall', packageName], { cwd: PROJECT_ROOT, timeout: TIMEOUT_INSTALL });
      log(`Uninstalled ${packageName}`);
      return { success: true, stdout };
    } catch (err: any) {
      const msg = err.message ?? String(err);
      error(`Failed to uninstall ${packageName}: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Update an npm package in the project root.
   */
  async update(packageName: string): Promise<InstallResult> {
    const validationError = validatePackageName(packageName);
    if (validationError) {
      return { success: false, error: validationError };
    }

    // Use `npm install <pkg>@latest --prefix=<managedRoot>` rather than
    // `npm update`. Two reasons: (1) `npm update` looks at the current dir's
    // package.json and respects the semver range there, which doesn't apply
    // to managed plugins (they're installed flat with no governing range);
    // (2) we always want the absolute latest, including major-version bumps.
    mkdirSync(this.managedRoot, { recursive: true });
    log(`Updating ${packageName} (managed)...`);
    try {
      const { stdout } = await execFile('npm', ['install', `--prefix=${this.managedRoot}`, '--legacy-peer-deps', `${packageName}@latest`], { cwd: PROJECT_ROOT, timeout: TIMEOUT_INSTALL });
      log(`Updated ${packageName}`);
      return { success: true, stdout };
    } catch (err: any) {
      const msg = err.message ?? String(err);
      error(`Failed to update ${packageName}: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Fetch the latest published version of a package from the npm registry.
   * Returns null if the package is not found or the request fails.
   */
  async getLatestVersion(packageName: string): Promise<string | null> {
    const validationError = validatePackageName(packageName);
    if (validationError) {
      return null;
    }

    try {
      const { stdout } = await execFile('npm', ['view', packageName, 'version'], { cwd: PROJECT_ROOT, timeout: TIMEOUT_VERSION });
      return stdout.trim() || null;
    } catch (err: any) {
      error(`Failed to get latest version for ${packageName}: ${err.message}`);
      return null;
    }
  }

  /**
   * Check whether `currentVersion` satisfies the minimum required `minVersion`.
   * Uses a simple major.minor.patch integer comparison.
   *
   * @param minVersion  - The minimum required semver string (e.g. "1.2.0")
   * @param currentVersion - The installed semver string to check against
   * @returns true if currentVersion >= minVersion
   */
  isCompatible(minVersion: string, currentVersion: string): boolean {
    const parse = (v: string): [number, number, number] => {
      const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
      return [major, minor, patch];
    };

    const [minMaj, minMin, minPat] = parse(minVersion);
    const [curMaj, curMin, curPat] = parse(currentVersion);

    if (curMaj !== minMaj) return curMaj > minMaj;
    if (curMin !== minMin) return curMin > minMin;
    return curPat >= minPat;
  }

  /**
   * Install a plugin into an isolated prefix directory (managedRoot), leaving
   * the project's own node_modules untouched. Reads the resulting
   * package-lock.json to discover the installed package name and resolved git
   * ref, and rolls back if the package doesn't ship a darkride-plugin entry
   * file.
   */
  async installManaged(
    packageName: string,
    authToken?: string | null,
  ): Promise<
    | { success: true; pkgName: string; resolvedRef: string | null; npmShasum: string | null }
    | { success: false; error: string }
  > {
    const validationError = validatePackageName(packageName);
    if (validationError) return { success: false, error: validationError };

    mkdirSync(this.managedRoot, { recursive: true });
    const stubPkg = join(this.managedRoot, 'package.json');
    if (!existsSync(stubPkg)) {
      writeFileSync(stubPkg, JSON.stringify({
        name: 'darkride-managed-plugins', version: '0.0.0', private: true,
      }, null, 2));
    }

    let installTarget = packageName;
    if (authToken && /^git\+https:\/\//.test(packageName)) {
      installTarget = packageName.replace(
        /^git\+https:\/\//,
        `git+https://token:${encodeURIComponent(authToken)}@`,
      );
    }

    // Note: no --no-save here — with --prefix, npm writes to <managedRoot>/package.json
    // and <managedRoot>/package-lock.json, leaving the project root's files untouched.
    // --no-save would also suppress the lock file, breaking the resolvedRef lookup below.
    log(`Installing ${packageName} (managed)...`);

    try {
      // npm accepts a single positional install target including any auth-token-rewritten
      // git+https URL; passing as a separate argv slot avoids shell interpretation of
      // any meta-characters that might appear in the token or version specifier.
      await execFile('npm', ['install', `--prefix=${this.managedRoot}`, '--legacy-peer-deps', installTarget], { cwd: PROJECT_ROOT, timeout: TIMEOUT_INSTALL });
    } catch (err: any) {
      const sanitisedMsg = (err.message ?? String(err)).replace(/token:[^@]+@/g, 'token:***@');
      error(`Failed to install ${packageName}: ${sanitisedMsg}`);
      return { success: false, error: sanitisedMsg };
    }

    const lockPath = join(this.managedRoot, 'package-lock.json');
    if (!existsSync(lockPath)) {
      return { success: false, error: 'npm install completed but no package-lock.json was written' };
    }
    let lock: any;
    try {
      lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    } catch (err: any) {
      return { success: false, error: `Failed to parse package-lock.json: ${err?.message ?? err}` };
    }

    // For registry-name installs (e.g. `@scope/plugin-foo`), the installed
    // package name is exactly what we asked for — no need to scan disk
    // and risk picking up a stale partial install. For git-URL installs,
    // the package name comes from the cloned package.json, so scan.
    const pkgName = PACKAGE_NAME_RE.test(packageName)
      ? packageName
      : findInstalledPkgName(this.managedRoot);
    if (!pkgName) {
      return { success: false, error: 'Could not determine installed package name' };
    }

    const lockEntry = lock.packages?.[`node_modules/${pkgName}`] ?? {};
    const resolvedRef = parseGitRef(lockEntry.resolved);
    // npm's integrity field is the canonical content hash a publisher signs.
    // For registry installs this is `sha512-<base64>`; for git installs npm
    // typically omits it (the git SHA is the pin instead).
    const npmShasum = typeof lockEntry.integrity === 'string' ? lockEntry.integrity : null;

    const pkgDir = safeJoinInside(this.managedRoot, 'node_modules', pkgName);
    let entryFile: string | null;
    try {
      entryFile = await ensurePluginEntryJs(pkgDir);
    } catch (err: any) {
      rmSync(pkgDir, { recursive: true, force: true });
      return {
        success: false,
        error: `Plugin ${pkgName} TypeScript compile failed: ${err?.message ?? err}`,
      };
    }
    if (!entryFile) {
      rmSync(pkgDir, { recursive: true, force: true });
      return {
        success: false,
        error: `Plugin ${pkgName} ships no darkride-plugin.{js,ts,tsx}. Authors must commit a darkride-plugin entry file at the package root.`,
      };
    }

    log(`Installed ${pkgName} (managed) → ${pkgDir}`);
    return { success: true, pkgName, resolvedRef, npmShasum };
  }
}

/**
 * Locate the just-installed package under `<managedRoot>/node_modules/`.
 * Restricts to known plugin name conventions; picks the most recently
 * modified candidate (last installed wins).
 */
function findInstalledPkgName(managedRoot: string): string | null {
  const nm = join(managedRoot, 'node_modules');
  if (!existsSync(nm)) return null;

  const candidates: string[] = [];
  // Scan every @<scope>/plugin-* directory — generalising lets new scopes
  // (e.g. @your-org/plugin-foo) be installed without code changes. Mirrors the
  // approach in discoverNpmPlugins.
  for (const top of readdirSync(nm, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    if (top.name.startsWith('@')) {
      const scopeDir = join(nm, top.name);
      for (const entry of readdirSync(scopeDir)) {
        if (entry.startsWith('plugin-')) candidates.push(`${top.name}/${entry}`);
      }
    } else if (top.name.startsWith('darkride-plugin-')) {
      candidates.push(top.name);
    }
  }

  if (candidates.length === 0) return null;
  let best: string | null = null;
  let bestMtime = -1;
  for (const c of candidates) {
    const stat = statSync(join(nm, c));
    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      best = c;
    }
  }
  return best;
}

/**
 * Extract git SHA from package-lock.json `resolved` URL like
 * `git+https://example.com/x.git#abc123` → `'abc123'`.
 */
function parseGitRef(resolved: string | undefined): string | null {
  if (!resolved) return null;
  const m = /#([a-f0-9]{7,40})$/.exec(resolved);
  return m ? m[1] : null;
}

/**
 * Ensure `<pkgDir>/darkride-plugin.js` exists, returning its path.
 *
 * - If `darkride-plugin.js` already exists, prefer it (author intent).
 * - Otherwise, if `darkride-plugin.ts` or `.tsx` exists, esbuild it to `.js`
 *   alongside. Anything imported from `node_modules/` stays external (peer
 *   deps resolve to the host's tree at runtime); only relative imports get
 *   bundled. Sourcemaps inlined so prod stack traces point to the original
 *   TS lines.
 * - Returns `null` if no entry file is found. Throws if compile fails — the
 *   caller maps that to an install failure with rollback.
 */
async function ensurePluginEntryJs(pkgDir: string): Promise<string | null> {
  // Published plugins compile to dist/darkride-plugin.js and declare the
  // entry via package.json#main. Honour main first; fall back to legacy
  // root convention.
  const pkgJsonPath = safeJoinInside(pkgDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (typeof pkg?.main === 'string') {
        const mainPath = safeJoinInside(pkgDir, pkg.main);
        if (existsSync(mainPath)) return mainPath;
      }
    } catch {
      // Malformed package.json — fall through to legacy lookup.
    }
  }

  const jsPath = safeJoinInside(pkgDir, 'darkride-plugin.js');
  if (existsSync(jsPath)) return jsPath;

  const tsCandidate = ['darkride-plugin.ts', 'darkride-plugin.tsx']
    .map(f => safeJoinInside(pkgDir, f))
    .find(existsSync);
  if (!tsCandidate) return null;

  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [tsCandidate],
    outfile: jsPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: 'inline',
    packages: 'external',
    logLevel: 'silent',
  });
  return jsPath;
}
