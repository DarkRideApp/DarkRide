import { existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('vendor-manager');

const require_ = createRequire(__filename);

/**
 * Resolve the root directory of an npm package.
 * Tries `pkg/package.json` subpath first, then falls back to resolving
 * the main entry and walking up (needed for packages like @u4/minicap-prebuilt
 * that restrict subpath access via the "exports" field).
 */
function packageDir(pkg: string): string {
  // Try direct package.json resolution (works when no exports field blocks it)
  try {
    return dirname(require_.resolve(`${pkg}/package.json`));
  } catch {
    // Blocked by exports — resolve main entry and walk up
  }
  const entry = require_.resolve(pkg);
  let dir = dirname(entry);
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not find package root for ${pkg}`);
}

/**
 * Find the minicap shared library for the given arch and API level.
 * Searches @u4/minicap-prebuilt first (has API 21–32), then
 * @devicefarmer/minicap-prebuilt (API 21–30).
 * If no exact match, falls back to the highest available API level.
 */
function findMinicapSharedLib(arch: string, apiLevel: number): string {
  const packages = ['@u4/minicap-prebuilt', '@devicefarmer/minicap-prebuilt'];
  const exactTarget = `android-${apiLevel}`;

  // Try exact match first across all packages
  for (const pkg of packages) {
    try {
      const so = resolve(packageDir(pkg), 'prebuilt', arch, 'lib', exactTarget, 'minicap.so');
      if (existsSync(so)) {
        log(`Found exact minicap.so for ${arch}/API ${apiLevel} in ${pkg}`);
        return so;
      }
    } catch {
      // Package not installed, skip
    }
  }

  // No exact match — find the highest available API level
  log(`No exact minicap.so for API ${apiLevel}, searching for highest available`);
  let bestLevel = 0;
  let bestPath = '';

  for (const pkg of packages) {
    try {
      const libDir = resolve(packageDir(pkg), 'prebuilt', arch, 'lib');
      if (!existsSync(libDir)) continue;
      for (const entry of readdirSync(libDir)) {
        const m = entry.match(/^android-(\d+)$/);
        if (!m) continue;
        const level = parseInt(m[1], 10);
        if (level > bestLevel) {
          const so = resolve(libDir, entry, 'minicap.so');
          if (existsSync(so)) {
            bestLevel = level;
            bestPath = so;
          }
        }
      }
    } catch {
      // Package not installed, skip
    }
  }

  if (bestPath) {
    log(`Using minicap.so from API ${bestLevel} as fallback for API ${apiLevel} (${arch})`);
    return bestPath;
  }

  throw new Error(`No minicap.so found for arch=${arch} apiLevel=${apiLevel}`);
}

/**
 * Ensure the minicap binary and shared library are available.
 * Resolves from installed npm packages (@devicefarmer/minicap-prebuilt, @u4/minicap-prebuilt).
 */
export async function ensureMinicap(
  arch: string,
  apiLevel: number,
): Promise<{ binary: string; sharedLib: string }> {
  log(`Ensuring minicap for arch=${arch}, apiLevel=${apiLevel}`);

  // Resolve binary from @devicefarmer/minicap-prebuilt
  let binary = '';
  try {
    binary = resolve(packageDir('@devicefarmer/minicap-prebuilt'), 'prebuilt', arch, 'bin', 'minicap');
  } catch {
    // Try @u4 as fallback
    try {
      binary = resolve(packageDir('@u4/minicap-prebuilt'), 'prebuilt', arch, 'bin', 'minicap');
    } catch {
      throw new Error(`No minicap-prebuilt package found. Install @devicefarmer/minicap-prebuilt`);
    }
  }

  if (!existsSync(binary)) {
    error(`Minicap binary not found at ${binary}`);
    throw new Error(`Minicap binary not found for arch=${arch}`);
  }

  const sharedLib = findMinicapSharedLib(arch, apiLevel);

  log(`Minicap binary: ${binary}`);
  log(`Minicap shared lib: ${sharedLib}`);

  return { binary, sharedLib };
}

/**
 * Ensure the minitouch binary is available.
 * Resolves from @devicefarmer/minitouch-prebuilt npm package.
 */
export async function ensureMinitouch(arch: string): Promise<string> {
  log(`Ensuring minitouch for arch=${arch}`);

  let binary = '';
  try {
    binary = resolve(packageDir('@devicefarmer/minitouch-prebuilt'), 'prebuilt', arch, 'bin', 'minitouch');
  } catch {
    throw new Error(`@devicefarmer/minitouch-prebuilt not installed. Run: npm install @devicefarmer/minitouch-prebuilt`);
  }

  if (!existsSync(binary)) {
    error(`Minitouch binary not found at ${binary}`);
    throw new Error(`Minitouch binary not found for arch=${arch}`);
  }

  log(`Minitouch binary: ${binary}`);
  return binary;
}

const SCRCPY_VERSION = '3.3.1';

/**
 * Get the scrcpy-server jar path from @u4/minicap-prebuilt.
 * scrcpy-server works on all Android versions (API 21+) and replaces minicap
 * for devices where minicap's native .so is incompatible (API 31+).
 */
export function getScrcpyServerJar(): string {
  log(`Resolving scrcpy-server v${SCRCPY_VERSION} jar`);

  try {
    const jar = resolve(
      packageDir('@u4/minicap-prebuilt'),
      'prebuilt', 'scrcpy', `scrcpy-server-v${SCRCPY_VERSION}.jar`,
    );
    if (existsSync(jar)) {
      log(`scrcpy-server jar: ${jar}`);
      return jar;
    }
    error(`scrcpy-server jar not found at ${jar}`);
  } catch {
    error(`@u4/minicap-prebuilt not installed — cannot resolve scrcpy-server`);
  }

  throw new Error(`scrcpy-server v${SCRCPY_VERSION} jar not found. Install @u4/minicap-prebuilt`);
}
