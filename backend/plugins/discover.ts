import { readdirSync, existsSync, readFileSync, statSync, type Dirent } from 'fs';
import { join, resolve, delimiter as pathDelimiter } from 'path';
import { pathToFileURL } from 'url';
import { createLoggers } from '../logs';
import type { PluginDefinition } from '@darkrideapp/plugin-sdk';

const { log, error: logError } = createLoggers('plugin-discover');

/**
 * Default plugins directory, resolved relative to this file.
 *
 * In dev mode (tsx), __dirname is <project>/backend/plugins and __dirname/../../plugins
 * resolves to <project>/plugins (source tree).
 *
 * In production (compiled), __dirname is <project>/dist/backend/plugins and
 * __dirname/../../plugins resolves to <project>/dist/plugins (compiled plugin .js files).
 *
 * Both paths work with dynamic import() because tsx loads .ts files in dev and
 * Node loads .js files in prod.
 */
const DEFAULT_PLUGINS_DIR = resolve(__dirname, '../../plugins');

/**
 * Resolve the plugin source directories. Honours `DARKRIDE_PLUGIN_DIRS`
 * (path-delimiter-separated list — `:` on Linux/macOS, `;` on Windows) so
 * plugin source can live anywhere on disk. Falls back to the default
 * `<project>/plugins/` when the env var is unset or empty.
 */
function getPluginsDirs(): string[] {
  const env = process.env.DARKRIDE_PLUGIN_DIRS;
  if (!env || !env.trim()) return [DEFAULT_PLUGINS_DIR];
  return env.split(pathDelimiter).map(s => s.trim()).filter(Boolean);
}

/**
 * Is this directory entry a directory, following symlinks/junctions?
 *
 * `Dirent.isDirectory()` returns false for a symlink-to-directory (Linux/macOS)
 * and for a Windows directory junction — both surface as reparse-point dirents.
 * That caused a plugin *linked* into plugins/ for local dev (the workflow the
 * docs recommend) to be silently skipped, even though Vite's frontend glob
 * follows the link. Resolve such entries with a stat. Real dirs and real files
 * are decided without the extra syscall; only reparse points pay for it.
 */
function isDirEntry(entry: Dirent, fullPath: string): boolean {
  if (entry.isDirectory()) return true;
  if (entry.isFile()) return false;
  try {
    return statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

export interface DiscoveredPlugin {
  name: string;
  path: string;
  definition: PluginDefinition;
  source?: 'workspace' | 'npm' | 'managed';
  /** The package's npm name (e.g. "@darkrideapp/plugin-foo"), populated for npm/managed sources. */
  npmPackage?: string;
  /**
   * The plugin's `package.json#version`. Authoritative for what's actually
   * installed; preferred over `definition.version` (which is hardcoded in
   * the plugin's source and routinely drifts behind tarball releases). The
   * marketplace's "update available" check compares this against the
   * registry's `latestVersion`, so it must reflect the published tag.
   */
  packageVersion?: string;
}

export async function discoverPlugins(pluginsDirs: string[] = getPluginsDirs()): Promise<DiscoveredPlugin[]> {
  const all: DiscoveredPlugin[] = [];

  for (const pluginsDir of pluginsDirs) {
    if (!existsSync(pluginsDir)) {
      log(`Plugins dir not found, skipping: ${pluginsDir}`);
      continue;
    }

    const entries = readdirSync(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      const pluginDir = join(pluginsDir, entry.name);
      // Follow symlinked / junctioned plugin directories (see isDirEntry) so a
      // plugin linked into plugins/ for local dev isn't silently skipped.
      if (!isDirEntry(entry, pluginDir)) continue;

      const entryFile = findEntryFile(pluginDir);

      if (!entryFile) {
        log(`Skipping ${entry.name}: no darkride-plugin entry file found`);
        continue;
      }

      // Read package.json#version where present — preferred over the
      // hardcoded definition.version which routinely drifts behind release tags.
      let packageVersion: string | undefined;
      const pkgJsonPath = join(pluginDir, 'package.json');
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          if (typeof pkg?.version === 'string' && pkg.version) packageVersion = pkg.version;
        } catch { /* ignore; falls back to definition.version */ }
      }

      try {
        // In CJS mode (compiled production), await import() is transformed to require()
        // which takes a path, not a file:// URL. In ESM mode (tsx dev), native import()
        // accepts both. Use pathToFileURL in dev so Windows paths with C:\ work with
        // native import(); use the plain path in compiled mode so require() works.
        const isCompiled = __filename.endsWith('.js');
        const importTarget = isCompiled ? entryFile : pathToFileURL(entryFile).href;
        const module = await import(importTarget);
        // Handle ESM/CJS interop: tsx can double-wrap default exports
        let definition: PluginDefinition = module.default ?? module;
        const maybeWrapped = definition as { default?: PluginDefinition; name?: string };
        if (maybeWrapped.default && !maybeWrapped.name) definition = maybeWrapped.default;

        if (!definition.name || !definition.register) {
          logError(`Invalid plugin in ${entry.name}: missing name or register function`);
          continue;
        }

        all.push({ name: definition.name, path: pluginDir, definition, source: 'workspace', packageVersion });
        log(`Discovered plugin: ${definition.name}@${packageVersion ?? definition.version} at ${pluginDir}`);
      } catch (err: any) {
        logError(`Failed to load plugin from ${entry.name}: ${err?.message || err}`);
        if (err?.stack) logError(err.stack);
      }
    }
  }

  return all;
}

function findEntryFile(dir: string): string | null {
  // Workspace plugins (in-monorepo) keep darkride-plugin.{ts,js} at the
  // package root. Published plugins compile to dist/darkride-plugin.js
  // and declare the entry via package.json#main. Try root first (workspace
  // convention is faster to check), then fall back to package.json#main.
  for (const name of ['darkride-plugin.ts', 'darkride-plugin.js']) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  const pkgJsonPath = join(dir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (typeof pkg?.main === 'string') {
        const mainPath = join(dir, pkg.main);
        if (existsSync(mainPath)) return mainPath;
      }
    } catch {
      // Malformed package.json — fall through and return null.
    }
  }
  return null;
}

/**
 * Scan node_modules for npm-installed DarkRide plugins.
 * Looks for @<scope>/plugin-* packages under any scope directory, plus
 * unscoped darkride-plugin-* packages.
 */
export async function discoverNpmPlugins(
  nodeModulesDir?: string,
  source: 'npm' | 'managed' = 'npm',
): Promise<DiscoveredPlugin[]> {
  const nmDir = nodeModulesDir ?? resolve(__dirname, '../../node_modules');
  const plugins: DiscoveredPlugin[] = [];

  if (!existsSync(nmDir)) return plugins;

  // Scan every @<scope>/plugin-* directory. Generalising lets new scopes
  // (e.g. @your-org/plugin-foo) be added without code changes.
  for (const top of readdirSync(nmDir, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    if (!top.name.startsWith('@')) continue;

    const scopeDir = resolve(nmDir, top.name);
    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('plugin-')) continue;
      const found = await tryLoadNpmPlugin(resolve(scopeDir, entry.name));
      if (found) plugins.push({ ...found, source });
    }
  }

  // Also scan unscoped darkride-plugin-* (legacy / convention).
  for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('darkride-plugin-')) continue;
    const found = await tryLoadNpmPlugin(resolve(nmDir, entry.name));
    if (found) plugins.push({ ...found, source });
  }

  if (plugins.length > 0) {
    log(`Discovered ${plugins.length} npm plugin(s): ${plugins.map(p => p.definition.name).join(', ')}`);
  }

  return plugins;
}

/**
 * Apply the DARKRIDE_PLUGINS env-var filter to a list of discovered plugins.
 *
 * - `filterEnv` falsy / empty → return `discovered` unchanged.
 * - Otherwise parse as a comma-separated list of plugin names. Only the named
 *   plugins (plus their transitive *required* dependencies) are returned.
 * - Unknown names are logged as warnings; they do not cause a failure.
 * - Optional dependencies are NOT auto-included unless explicitly listed.
 *
 * Exported so it can be unit-tested in isolation.
 */
export function applyPluginFilter(
  discovered: DiscoveredPlugin[],
  filterEnv: string | undefined,
  logFn: (msg: string) => void = log,
): DiscoveredPlugin[] {
  if (!filterEnv || !filterEnv.trim()) return discovered;

  const requested = new Set(
    filterEnv.split(',').map(s => s.trim()).filter(Boolean),
  );

  const known = new Set(discovered.map(p => p.definition.name));
  for (const name of requested) {
    if (!known.has(name)) {
      logFn(`WARN: DARKRIDE_PLUGINS includes "${name}" — no such plugin discovered. Ignoring.`);
    }
  }

  const byName = new Map(discovered.map(p => [p.definition.name, p]));
  const transitiveRequired = new Set<string>();

  const expand = (name: string) => {
    if (transitiveRequired.has(name)) return;
    const plugin = byName.get(name);
    if (!plugin) return;
    transitiveRequired.add(name);
    for (const dep of plugin.definition.dependencies) {
      if (!requested.has(dep)) {
        logFn(`Auto-including "${dep}" — required by "${name}"`);
      }
      expand(dep);
    }
  };

  for (const name of requested) {
    if (known.has(name)) expand(name);
  }

  const before = discovered.length;
  const filtered = discovered.filter(p => transitiveRequired.has(p.definition.name));
  logFn(
    `DARKRIDE_PLUGINS filter: loading ${filtered.length} of ${before} plugins (${[...transitiveRequired].join(', ')})`,
  );
  return filtered;
}

async function tryLoadNpmPlugin(pluginDir: string): Promise<DiscoveredPlugin | null> {
  const entryFile = findEntryFile(pluginDir);
  if (!entryFile) return null;

  // Read npm package name + version from package.json. The version here is
  // the published tarball's version, which is what the marketplace's
  // "update available" check compares against.
  let npmPackage: string | undefined;
  let packageVersion: string | undefined;
  const pkgJsonPath = join(pluginDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (typeof pkg?.name === 'string') npmPackage = pkg.name;
      if (typeof pkg?.version === 'string' && pkg.version) packageVersion = pkg.version;
    } catch { /* ignore — discovery still works without npmPackage */ }
  }

  try {
    const isCompiled = __filename.endsWith('.js');
    const importTarget = isCompiled ? entryFile : pathToFileURL(entryFile).href;
    const imported = await import(importTarget);
    const definition = imported.default?.default ?? imported.default;
    if (!definition?.name || !definition?.register) return null;
    return { name: definition.name, path: pluginDir, definition, source: 'npm', npmPackage, packageVersion };
  } catch (err: any) {
    log(`Failed to load npm plugin from ${pluginDir}: ${err.message}`);
    return null;
  }
}
