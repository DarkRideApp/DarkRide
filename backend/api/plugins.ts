import { readFileSync, utimesSync, existsSync, rmSync, statSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { spawn } from 'child_process';
import { registerEndpoint } from './api-service';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';
import type { PluginManager } from '../plugins/plugin-manager';
import type { PluginStateManager } from '../services/plugin-state-manager';
import type { PluginInstaller } from '../services/plugin-installer';
import type { PluginSourceManager } from '../services/plugin-source-manager';
import type { PluginVerifier, SignablePlugin } from '../services/plugin-verifier';
import type { PluginInstallsRepo } from '../services/plugin-installs-repo';
import type Database from 'better-sqlite3';
import type { SystemStateService } from '../services/system-state-service';
import { getDataRoot } from '../config/paths';
import { safeJoinInside } from '../utils/safe-path';
import { dropPluginTables, listPluginTables } from '../db/plugin-migrator';
import { isNewer } from '../services/version-compare';

const { log, error } = createLoggers('plugins-api');

// In dev (__dirname = backend/api/) → ../../package.json
// In prod (__dirname = dist/backend/api/) → ../../../package.json
const devPkg = resolve(__dirname, '../../package.json');
const prodPkg = resolve(__dirname, '../../../package.json');
const darkrideVersion = JSON.parse(
  readFileSync(existsSync(devPkg) ? devPkg : prodPkg, 'utf-8'),
).version;

/** Recursive directory size in bytes. Returns 0 if the directory is missing. */
function dirSize(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      try { total += statSync(full).size; } catch { /* skip inaccessible */ }
    }
  }
  return total;
}

export function registerPluginEndpoints(
  pluginManager: PluginManager,
  stateManager?: PluginStateManager,
  installer?: PluginInstaller,
  sourceManager?: PluginSourceManager,
  verifier?: PluginVerifier,
  pluginInstallsRepo?: PluginInstallsRepo,
  rawSqlite?: Database.Database,
  systemStateService?: SystemStateService,
): void {
  // -------------------------------------------------------------------------
  // Existing endpoints (no scope gate — backward-compatible)
  // -------------------------------------------------------------------------

  registerEndpoint('GET', '/v1/plugins/registry', (_req, res) => {
    res.json({
      success: true,
      data: pluginManager.getPluginMetadata(),
    });
  });

  registerEndpoint('GET', '/v1/plugins/list', (_req, res) => {
    res.json({
      success: true,
      data: pluginManager.getPluginMetadata().map((p) => ({
        name: p.name,
        version: p.version,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // New management endpoints — all require core.plugins:manage
  // -------------------------------------------------------------------------

  /** GET /v1/plugins/installed — list all plugins with state + loaded metadata */
  registerEndpoint(
    'GET',
    '/v1/plugins/installed',
    (req, res) => {
      if (!stateManager) {
        res.status(501).json({ success: false, error: 'Plugin management not available' });
        return;
      }

      const states = stateManager.getAll();
      const loadedMeta = pluginManager.getPluginMetadata();
      const metaByName = new Map(loadedMeta.map((m) => [m.name, m]));

      // Build a lookup of marketplace plugins by npmPackage. Empty if no
      // sourceManager is configured or the cache is empty.
      const cachedPlugins = sourceManager?.getCachedPlugins() ?? [];
      const marketplaceByNpm = new Map(
        cachedPlugins
          .filter((p) => p.npmPackage)
          .map((p) => [p.npmPackage, p]),
      );

      const plugins = states.map((state) => {
        const marketEntry = state.npmPackage ? marketplaceByNpm.get(state.npmPackage) : undefined;
        const latestVersion = marketEntry?.latestVersion;
        const updateAvailable =
          latestVersion != null && state.version != null
            ? isNewer(latestVersion, state.version)
            : false;
        return {
          ...state,
          loaded: metaByName.has(state.name),
          metadata: metaByName.get(state.name) ?? null,
          updateAvailable,
          latestVersion,
        };
      });

      res.json({ success: true, data: { plugins, darkrideVersion } });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/:name/enable — enable a plugin */
  registerEndpoint(
    'POST',
    '/v1/plugins/:name/enable',
    (req, res) => {
      if (!stateManager) {
        res.status(501).json({ success: false, error: 'Plugin management not available' });
        return;
      }

      const name = decodeURIComponent(req.params.name);
      // Guard against ghost enables: a WHERE name=? update on an unknown name
      // is a silent no-op that still flips restart-required. The UI ends up
      // requiring a server bounce for a plugin that doesn't exist.
      if (!stateManager.get(name)) {
        res.status(404).json({ success: false, error: `Plugin "${name}" not found` });
        return;
      }
      stateManager.setEnabled(name, true);
      systemStateService?.setRestartRequired(`plugin ${name} enabled`);
      res.json({ success: true, restartRequired: true });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/:name/disable — disable a plugin */
  registerEndpoint(
    'POST',
    '/v1/plugins/:name/disable',
    (req, res) => {
      if (!stateManager) {
        res.status(501).json({ success: false, error: 'Plugin management not available' });
        return;
      }

      const name = decodeURIComponent(req.params.name);
      if (!stateManager.get(name)) {
        res.status(404).json({ success: false, error: `Plugin "${name}" not found` });
        return;
      }
      stateManager.setEnabled(name, false);
      systemStateService?.setRestartRequired(`plugin ${name} disabled`);
      res.json({ success: true, restartRequired: true });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/install — install a plugin from npm */
  registerEndpoint(
    'POST',
    '/v1/plugins/install',
    async (req, res) => {
      if (!stateManager || !installer) {
        res.status(501).json({ success: false, error: 'Plugin management not available' });
        return;
      }

      const { npmPackage, installUrl, signature, signedBy, confirmed, pluginData } = req.body as {
        npmPackage?: string;
        installUrl?: string;
        signature?: string;
        signedBy?: string;
        confirmed?: boolean;
        pluginData?: Record<string, any>;
      };
      const installTarget = installUrl || npmPackage;
      if (!installTarget) {
        res.status(400).json({ success: false, error: 'npmPackage or installUrl required' });
        return;
      }

      if (verifier) {
        const plugin = (pluginData ?? { name: npmPackage ?? '', npmPackage, signature, signedBy }) as SignablePlugin;
        const isAuthPlugin = plugin.category === 'auth-providers';
        const permission = verifier.checkInstallPermission(plugin, isAuthPlugin);

        if (permission === 'block') {
          res.status(403).json({
            success: false,
            error: 'Auth plugins must be signed by a trusted publisher. This plugin cannot be installed.',
            blocked: true,
          });
          return;
        }

        if (permission === 'prompt' && !confirmed) {
          res.json({
            success: false,
            confirmRequired: true,
            warning: 'This plugin is not verified by any trusted publisher. Unverified plugins could contain malicious code.',
          });
          return;
        }
      }

      // Look up the source's authToken so private git repos auth correctly.
      // pluginData.source carries the source's display name (set by the
      // marketplace fetcher); match it against the configured sources.
      let authToken: string | null = null;
      let sourceId: number | null = null;
      const sourceName = pluginData?.source;
      if (sourceName && sourceManager) {
        const sources = sourceManager.getAll();
        const matched = sources.find((s: any) => s.name === sourceName);
        if (matched) {
          if (matched.authToken) authToken = matched.authToken;
          if (matched.id != null) sourceId = matched.id;
        }
      }

      if (!pluginInstallsRepo || !stateManager) {
        res.status(501).json({ success: false, error: 'Plugin install tracking not available' });
        return;
      }

      // Surface progress to the UI. The install endpoint owns the
      // install + verify phases here; the load (migrate + start)
      // phases emit from the plugin lifecycle on next restart.
      // `name` is the marketplace runtime name when known, else the
      // installTarget string — the frontend filters events to a
      // specific plugin install modal.
      const installName = (pluginData as any)?.name ?? installTarget;
      const emitProgress = (phase: 'installing' | 'verifying' | 'recording' | 'migrating' | 'starting' | 'done', message: string) => {
        broadcastToAll({
          type: 'plugin-install-progress',
          plugin: installName,
          phase,
          message,
        });
      };

      emitProgress('installing', `npm install ${installTarget}`);
      const result = await installer.installManaged(installTarget, authToken);
      if (!result.success) {
        emitProgress('done', `Install failed: ${result.error}`);
        res.status(500).json({ success: false, error: result.error });
        return;
      }

      // Content-pin verification: if the signed manifest declared an
      // `npmShasum` or `gitRef`, the actually-installed package must match.
      // A mismatch here means either tampering or an unannounced re-publish;
      // either way refuse the install and roll back the npm artefact.
      // Legacy signed manifests (no pin) pass through with pinned: false —
      // the verify badge already covers the "publisher identity verified,
      // contents not pinned" case.
      if (verifier && pluginData) {
        const signed = pluginData as SignablePlugin;
        if (signed.signature && (signed.npmShasum || signed.gitRef)) {
          emitProgress('verifying', 'Checking signature + content pin');
          const contentCheck = verifier.verifyContents(
            { npmShasum: signed.npmShasum, gitRef: signed.gitRef },
            { npmShasum: result.npmShasum ?? undefined, gitRef: result.resolvedRef ?? undefined },
          );
          if (!contentCheck.ok) {
            const rollbackDir = safeJoinInside(getDataRoot(), 'installed-plugins', 'node_modules', result.pkgName);
            try { rmSync(rollbackDir, { recursive: true, force: true }); } catch (e) { log(`rollback rm -rf ${rollbackDir} failed: ${e}`); }
            emitProgress('done', `Verification failed: ${contentCheck.reason}`);
            res.status(400).json({
              success: false,
              error: `Refusing install — ${contentCheck.reason}`,
              contentMismatch: true,
            });
            return;
          }
        }
      }

      // Dynamically import the just-installed plugin to read its runtime name
      // (definition.name). This is what the rest of the plugin pipeline keys on —
      // reconcile(), applyPluginMigrations, dropPluginTables, enable/disable.
      // Honour package.json#main first (published plugins compile to dist/);
      // fall back to legacy root convention.
      const pkgDir = safeJoinInside(getDataRoot(), 'installed-plugins', 'node_modules', result.pkgName);
      let entryCandidate: string | undefined;
      const pkgJsonPath = safeJoinInside(pkgDir, 'package.json');
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          if (typeof pkg?.main === 'string') {
            const mainPath = safeJoinInside(pkgDir, pkg.main);
            if (existsSync(mainPath)) entryCandidate = mainPath;
          }
        } catch {
          // Malformed package.json — fall through to legacy lookup.
        }
      }
      if (!entryCandidate) {
        entryCandidate = ['darkride-plugin.js', 'darkride-plugin.ts']
          .map(f => join(pkgDir, f))
          .find(existsSync);
      }
      if (!entryCandidate) {
        res.status(500).json({ success: false, error: 'Installed plugin has no darkride-plugin entry file' });
        return;
      }

      let runtimeName: string;
      let pluginDependencies: string[] = [];
      // Resolve once so rollback paths can also clear the cache key with a
      // stable lookup (require.resolve on a wiped path still works because
      // it returns the canonical absolute path).
      const resolvedEntry = require.resolve(entryCandidate);
      try {
        // Clear require cache for any prior version of this plugin (re-install)
        delete require.cache[resolvedEntry];
        const imported = require(resolvedEntry);
        const definition = imported?.default?.default ?? imported?.default ?? imported;
        if (typeof definition?.name !== 'string' || !definition.name.trim()) {
          delete require.cache[resolvedEntry];
          res.status(500).json({ success: false, error: 'Installed plugin entry file did not export a definition.name' });
          return;
        }
        runtimeName = definition.name;
        pluginDependencies = Array.isArray(definition.dependencies) ? definition.dependencies : [];
      } catch (err: any) {
        delete require.cache[resolvedEntry];
        res.status(500).json({ success: false, error: `Failed to load installed plugin: ${err?.message ?? err}` });
        return;
      }

      // Plugin peer dependency gate: refuse if any required peer is absent or
      // 'missing'. Roll back the npm install so the next attempt is clean.
      // Optional dependencies are deliberately not checked — they're "use if
      // present", and an absent optional peer must not block install.
      const missingDeps = pluginDependencies.filter((depName) => {
        const depState = stateManager.get(depName);
        return !depState || depState.installedVia === 'missing';
      });
      if (missingDeps.length > 0) {
        // Stale cache entry would survive the rmSync below — clearing it
        // ensures the retry path resolves a fresh module.
        delete require.cache[resolvedEntry];
        try { rmSync(pkgDir, { recursive: true, force: true }); } catch (e) { log(`rollback rm -rf ${pkgDir} failed: ${e}`); }
        res.status(400).json({
          success: false,
          error: `Plugin "${runtimeName}" has unmet plugin dependenc${missingDeps.length === 1 ? 'y' : 'ies'}: ${missingDeps.join(', ')}. Install ${missingDeps.length === 1 ? 'it' : 'them'} first.`,
          missingDependencies: missingDeps,
        });
        return;
      }

      emitProgress('recording', 'Registering plugin');
      pluginInstallsRepo.record({
        name: runtimeName,
        npmPackage: result.pkgName,
        sourceUrl: installTarget,         // un-tokenised URL — never store the auth-tokenised version
        resolvedRef: result.resolvedRef,
        sourceId,
        // Persist the token so replay-on-boot can re-authenticate against
        // private repos. The originating source row may be deleted later,
        // or the install may have come from a raw installUrl with no
        // sourceId at all; without this column those installs become
        // unrecoverable across server restarts.
        authToken,
      });
      stateManager.upsertManagedPending(runtimeName, result.pkgName, sourceId);

      // Persist the installed version immediately. upsertManagedPending sets
      // version='' for new rows and leaves it untouched for existing rows;
      // without this read+setVersion the UI shows the stale (pre-install)
      // version until the next boot's reconcile runs.
      try {
        const installedPkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        if (typeof installedPkgJson?.version === 'string' && installedPkgJson.version) {
          stateManager.setVersion(runtimeName, installedPkgJson.version);
        }
      } catch {
        // Re-read failure is non-fatal — reconcile will fix it on next boot.
      }

      emitProgress('done', `Installed. Restart to load plugin "${runtimeName}".`);
      systemStateService?.setRestartRequired(`plugin ${runtimeName} installed`);
      res.json({ success: true, restartRequired: true, name: runtimeName });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/uninstall — uninstall a plugin */
  registerEndpoint(
    'POST',
    '/v1/plugins/uninstall',
    async (req, res) => {
      if (!stateManager || !installer) {
        res.status(501).json({ success: false, error: 'Plugin management not available' });
        return;
      }

      const { name, preserveData } = req.body as { name?: string; preserveData?: boolean };
      if (!name) {
        res.status(400).json({ success: false, error: 'name is required' });
        return;
      }

      const state = stateManager.get(name);
      if (!state) {
        res.status(404).json({ success: false, error: `Plugin "${name}" not found` });
        return;
      }

      // Default: preserve user data (DB tables, data/plugins/<name>/). Caller must
      // explicitly opt into destruction with preserveData: false.
      const wipeData = preserveData === false;

      switch (state.installedVia) {
        case 'managed': {
          if (!pluginInstallsRepo || !rawSqlite) {
            res.status(501).json({ success: false, error: 'Plugin install tracking not available' });
            return;
          }
          const pkgName = state.npmPackage ?? name;
          const pkgDir = safeJoinInside(getDataRoot(), 'installed-plugins', 'node_modules', pkgName);
          try { rmSync(pkgDir, { recursive: true, force: true }); } catch (e) { log(`rm -rf ${pkgDir} failed: ${e}`); }
          pluginInstallsRepo.remove(name);
          if (wipeData) {
            try { dropPluginTables(rawSqlite, name); } catch (e) { log(`dropPluginTables failed: ${e}`); }
            try { rmSync(safeJoinInside(getDataRoot(), 'plugins', name), { recursive: true, force: true }); } catch (e) { log(`rm -rf data/plugins/${name} failed: ${e}`); }
          }
          stateManager.remove(name);
          systemStateService?.setRestartRequired(`plugin ${name} uninstalled`);
          res.json({ success: true, restartRequired: true });
          return;
        }
        case 'missing': {
          if (!pluginInstallsRepo || !rawSqlite) {
            res.status(501).json({ success: false, error: 'Plugin install tracking not available' });
            return;
          }
          if (wipeData) {
            try { dropPluginTables(rawSqlite, name); } catch (e) { log(`dropPluginTables failed: ${e}`); }
            try { rmSync(safeJoinInside(getDataRoot(), 'plugins', name), { recursive: true, force: true }); } catch (e) { log(`rm -rf data/plugins/${name} failed: ${e}`); }
          }
          pluginInstallsRepo.remove(name);
          stateManager.remove(name);
          res.json({ success: true, restartRequired: false });
          return;
        }
        case 'npm': {
          if (state.npmPackage) {
            const result = await installer.uninstall(state.npmPackage);
            if (!result.success) {
              res.status(500).json({ success: false, error: result.error });
              return;
            }
          }
          if (wipeData) {
            if (rawSqlite) {
              try { dropPluginTables(rawSqlite, name); } catch (e) { log(`dropPluginTables failed: ${e}`); }
            }
            try { rmSync(safeJoinInside(getDataRoot(), 'plugins', name), { recursive: true, force: true }); } catch (e) { log(`rm -rf data/plugins/${name} failed: ${e}`); }
          }
          stateManager.remove(name);
          systemStateService?.setRestartRequired(`plugin ${name} uninstalled`);
          res.json({ success: true, restartRequired: true });
          return;
        }
        case 'workspace':
          res.status(400).json({ success: false, error: 'Workspace plugins are removed by code change, not the UI' });
          return;
        default:
          res.status(400).json({ success: false, error: `Unknown installedVia: ${state.installedVia}` });
          return;
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  /**
   * GET /v1/plugins/:name/uninstall-footprint — preview what would be removed.
   * Surfaces the plugin's DB tables, file storage size, and npm package so the
   * uninstall modal can show users what the destructive "delete all data"
   * option will affect.
   */
  registerEndpoint(
    'GET',
    '/v1/plugins/:name/uninstall-footprint',
    async (req, res) => {
      if (!stateManager) {
        res.status(501).json({ success: false, error: 'Plugin management not available' });
        return;
      }

      const name = decodeURIComponent(req.params.name);
      const state = stateManager.get(name);
      if (!state) {
        res.status(404).json({ success: false, error: `Plugin "${name}" not found` });
        return;
      }

      const tables = rawSqlite ? listPluginTables(rawSqlite, name) : [];
      const dataDir = safeJoinInside(getDataRoot(), 'plugins', name);
      const fileStorageBytes = dirSize(dataDir);

      res.json({
        success: true,
        data: {
          tables,
          fileStorageBytes,
          npmPackage: state.npmPackage ?? null,
        },
      });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/update — update a plugin */
  registerEndpoint(
    'POST',
    '/v1/plugins/update',
    async (req, res) => {
      if (!stateManager || !installer) {
        res.status(501).json({ success: false, error: 'Plugin management not available' });
        return;
      }

      const { name } = req.body as { name?: string };
      if (!name) {
        res.status(400).json({ success: false, error: 'name is required' });
        return;
      }

      const state = stateManager.get(name);
      if (!state) {
        res.status(404).json({ success: false, error: `Plugin "${name}" not found` });
        return;
      }

      if (!state.npmPackage) {
        res.status(400).json({ success: false, error: `Plugin "${name}" has no associated npm package` });
        return;
      }

      const result = await installer.update(state.npmPackage);
      if (!result.success) {
        res.status(500).json({ success: false, error: result.error });
        return;
      }

      // Content-pin re-verification on update. Without this, an attacker
      // who controls the npm registry (or MITMs the install) between the
      // initial install and the user clicking "Update" can serve a
      // malicious "latest" version. We re-fetch the marketplace manifest
      // and check the post-update artefact fingerprints against what the
      // publisher signed for this version. If the source has no signed
      // manifest for this plugin (legacy / unsigned marketplaces), the
      // check is skipped — the verify badge already covers the
      // "publisher identity verified, contents not pinned" case.
      if (verifier && sourceManager) {
        try {
          const marketplace = await sourceManager.fetchAll(true);
          const flat = marketplace.flatMap((src: any) => src.plugins ?? []);
          const signed = flat.find((p: any) => p?.npmPackage === state.npmPackage) as SignablePlugin | undefined;
          if (signed?.signature && (signed.npmShasum || signed.gitRef)) {
            const contentCheck = verifier.verifyContents(
              { npmShasum: signed.npmShasum, gitRef: signed.gitRef },
              { npmShasum: result.npmShasum ?? undefined, gitRef: result.resolvedRef ?? undefined },
            );
            if (!contentCheck.ok) {
              // Roll back the new tarball so the malicious code is off disk.
              // The previous version is not automatically restored — the
              // user must re-install from a clean source. We mark the row
              // as 'missing' so the UI surfaces the state clearly.
              const rollbackDir = safeJoinInside(getDataRoot(), 'installed-plugins', 'node_modules', state.npmPackage);
              try { rmSync(rollbackDir, { recursive: true, force: true }); } catch (e) { log(`update rollback rm -rf ${rollbackDir} failed: ${e}`); }
              res.status(400).json({
                success: false,
                error: `Refusing update — ${contentCheck.reason}`,
                contentMismatch: true,
              });
              return;
            }
          }
        } catch (err: any) {
          // Marketplace re-fetch failed — don't roll back, but log loudly.
          // The user can still reach the update via a separate path; this
          // is best-effort tamper detection.
          log(`Content pin re-check skipped (marketplace fetch failed): ${err?.message ?? err}`);
        }
      }

      // Read the freshly-installed package.json for the new version and
      // persist it. Without this, /v1/plugins/installed keeps reporting
      // the old version (set by reconcile on a previous boot), so the
      // updateAvailable flag stays true and the UI shows "Update to..."
      // even though the update succeeded.
      const pkgJsonPath = safeJoinInside(getDataRoot(), 'installed-plugins', 'node_modules', state.npmPackage, 'package.json');
      let newVersion: string | undefined;
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          if (typeof pkg?.version === 'string' && pkg.version) {
            newVersion = pkg.version;
            stateManager.setVersion(name, pkg.version);
          }
        } catch {
          // Malformed package.json — let the next reconcile fix it up.
        }
      }

      systemStateService?.setRestartRequired(
        newVersion ? `plugin ${name} updated to ${newVersion}` : `plugin ${name} updated`,
      );
      res.json({ success: true, restartRequired: true });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** GET /v1/plugins/marketplace — fetch plugins from all enabled sources */
  registerEndpoint(
    'GET',
    '/v1/plugins/marketplace',
    async (_req, res) => {
      if (!sourceManager) {
        res.status(501).json({ success: false, error: 'Source management not available' });
        return;
      }

      try {
        const results = await sourceManager.fetchAll();
        const allPlugins = results.flatMap(r => r.plugins);
        const verifiedPlugins = verifier
          ? allPlugins.map(p => ({ ...p, verification: verifier.verify(p) }))
          : allPlugins;
        const fetchedAt = sourceManager.getCacheFetchedAt();
        res.json({
          success: true,
          data: {
            sources: results,
            plugins: verifiedPlugins,
            fetchedAt,
          },
        });
      } catch (err: any) {
        res.status(502).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/marketplace/refresh — bust cache and fetch fresh data */
  registerEndpoint(
    'POST',
    '/v1/plugins/marketplace/refresh',
    async (_req, res) => {
      if (!sourceManager) {
        res.status(501).json({ success: false, error: 'Source management not available' });
        return;
      }

      try {
        const results = await sourceManager.fetchAll(true);
        const allPlugins = results.flatMap(r => r.plugins);
        const verifiedPlugins = verifier
          ? allPlugins.map(p => ({ ...p, verification: verifier.verify(p) }))
          : allPlugins;
        const fetchedAt = sourceManager.getCacheFetchedAt();
        res.json({
          success: true,
          data: {
            sources: results,
            plugins: verifiedPlugins,
            fetchedAt,
          },
        });
      } catch (err: any) {
        res.status(502).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  // -------------------------------------------------------------------------
  // Signing key management endpoints — all require core.plugins:manage
  // -------------------------------------------------------------------------

  /** GET /v1/plugins/signing-keys — list trusted signing keys */
  registerEndpoint(
    'GET',
    '/v1/plugins/signing-keys',
    (_req, res) => {
      if (!verifier) { res.status(501).json({ success: false, error: 'Not available' }); return; }
      const keys = verifier.getTrustedKeys().map(k => ({
        id: k.id,
        label: k.label,
        builtIn: k.builtIn,
        createdAt: k.createdAt,
      }));
      res.json({ success: true, data: keys });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/signing-keys — add a trusted signing key */
  registerEndpoint(
    'POST',
    '/v1/plugins/signing-keys',
    (req, res) => {
      if (!verifier) { res.status(501).json({ success: false, error: 'Not available' }); return; }
      const { id, publicKey, label } = req.body as { id?: string; publicKey?: string; label?: string };
      if (!id || !publicKey || !label) {
        res.status(400).json({ success: false, error: 'id, publicKey, and label required' });
        return;
      }
      try {
        const userId = (req as any).authUser?.userId as number;
        verifier.addTrustedKey(id, publicKey, label, userId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  /** DELETE /v1/plugins/signing-keys/:id — remove a trusted signing key */
  registerEndpoint(
    'DELETE',
    '/v1/plugins/signing-keys/:id',
    (req, res) => {
      if (!verifier) { res.status(501).json({ success: false, error: 'Not available' }); return; }
      try {
        verifier.removeTrustedKey(req.params.id);
        res.json({ success: true });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  // -------------------------------------------------------------------------
  // Source CRUD endpoints — all require core.plugins:manage
  // -------------------------------------------------------------------------

  /** GET /v1/plugins/sources — list all sources (auth tokens masked) */
  registerEndpoint(
    'GET',
    '/v1/plugins/sources',
    (_req, res) => {
      if (!sourceManager) {
        res.status(501).json({ success: false, error: 'Source management not available' });
        return;
      }

      const sources = sourceManager.getAll().map(s => ({
        ...s,
        authToken: s.authToken ? '********' : null,
      }));
      res.json({ success: true, data: sources });
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/sources — add a new source */
  registerEndpoint(
    'POST',
    '/v1/plugins/sources',
    (req, res) => {
      if (!sourceManager) {
        res.status(501).json({ success: false, error: 'Source management not available' });
        return;
      }

      const { name, type, url, authToken } = req.body as {
        name?: string;
        type?: string;
        url?: string;
        authToken?: string;
      };

      if (!name || !type || !url) {
        res.status(400).json({ success: false, error: 'name, type, and url are required' });
        return;
      }

      if (type !== 'registry' && type !== 'git') {
        res.status(400).json({ success: false, error: 'type must be "registry" or "git"' });
        return;
      }

      try {
        const id = sourceManager.add({ name, type, url, authToken });
        res.json({ success: true, id });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  /** PUT /v1/plugins/sources/:id — update a source */
  registerEndpoint(
    'PUT',
    '/v1/plugins/sources/:id',
    (req, res) => {
      if (!sourceManager) {
        res.status(501).json({ success: false, error: 'Source management not available' });
        return;
      }

      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, error: 'Invalid source id' });
        return;
      }

      const updates = req.body as {
        name?: string;
        url?: string;
        authToken?: string;
        enabled?: boolean;
      };

      try {
        const source = sourceManager.getAll().find(s => s.id === id);
        if (!source) {
          res.status(404).json({ success: false, error: 'Source not found' });
          return;
        }

        if (source.isDefault) {
          // Default source: only auth token can be changed
          const allowedUpdates: any = {};
          if (updates.authToken !== undefined) allowedUpdates.authToken = updates.authToken;
          if (Object.keys(allowedUpdates).length === 0) {
            res.status(400).json({ success: false, error: 'Cannot modify the default source (only auth token can be changed)' });
            return;
          }
          sourceManager.update(id, allowedUpdates);
        } else {
          sourceManager.update(id, { name: updates.name, url: updates.url, authToken: updates.authToken, enabled: updates.enabled });
        }
        res.json({ success: true });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  /** DELETE /v1/plugins/sources/:id — remove a source */
  registerEndpoint(
    'DELETE',
    '/v1/plugins/sources/:id',
    (req, res) => {
      if (!sourceManager) {
        res.status(501).json({ success: false, error: 'Source management not available' });
        return;
      }

      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, error: 'Invalid source id' });
        return;
      }

      try {
        sourceManager.remove(id);
        res.json({ success: true });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/plugins/sources/:id/test — test a source by fetching its plugins */
  registerEndpoint(
    'POST',
    '/v1/plugins/sources/:id/test',
    async (req, res) => {
      if (!sourceManager) {
        res.status(501).json({ success: false, error: 'Source management not available' });
        return;
      }

      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, error: 'Invalid source id' });
        return;
      }

      const sources = sourceManager.getAll();
      const source = sources.find(s => s.id === id);
      if (!source) {
        res.status(404).json({ success: false, error: 'Source not found' });
        return;
      }

      try {
        let plugins: unknown[];
        if (source.type === 'registry') {
          plugins = await sourceManager.fetchRegistry(source);
        } else {
          const plugin = await sourceManager.fetchGitRepo(source);
          plugins = plugin ? [plugin] : [];
        }
        res.json({ success: true, data: { plugins } });
      } catch (err: any) {
        res.status(502).json({ success: false, error: err.message });
      }
    },
    { requires: ['core.plugins:manage'] },
  );

  /** POST /v1/system/restart — graceful restart */
  registerEndpoint('POST', '/v1/system/restart', async (req, res) => {
    res.json({ success: true, message: 'Server restarting...' });
    broadcastToAll({ type: 'system:restarting', message: 'Applying plugin changes...' });

    // __dirname is <root>/backend/api in dev, <root>/dist/backend/api in prod.
    // Walk up to the project root by looking for package.json.
    const projectRoot = (() => {
      let dir = resolve(__dirname);
      while (true) {
        try {
          if (statSync(resolve(dir, 'package.json')).isFile()) return dir;
        } catch { /* keep walking */ }
        const parent = resolve(dir, '..');
        if (parent === dir) return resolve(__dirname);   // give up
        dir = parent;
      }
    })();

    // Dev mode: touch source files so the watching processes reload.
    //   - tsx watches backend/ → touching backend/index.ts kills + restarts the
    //     backend process.
    //   - Vite watches frontend/ → touching frontend/plugins.ts invalidates
    //     that module's HMR cache, so its import.meta.glob re-runs and picks
    //     up any newly-installed plugin's frontend/plugin.ts. Without this,
    //     Vite's glob result is frozen from the dev server's startup and the
    //     new plugin's pluginRegistry.registerPages/registerNav side effects
    //     never fire — nav and pages are missing until the dev server itself
    //     is restarted.
    //
    // In production: tsx isn't running and Vite isn't running. The .ts source
    // files exist in the deploy tree but nothing watches them, so these
    // touches are harmless no-ops. systemd handles the actual restart via
    // Restart=always when this process exits below.
    const now = new Date();
    for (const rel of ['backend/index.ts', 'frontend/plugins.ts']) {
      try { utimesSync(resolve(projectRoot, rel), now, now); } catch { /* file may not exist in this layout */ }
    }

    // Production: run the full build pipeline before exiting. The static
    // bundle has Vite's import.meta.glob result baked in at build time; if
    // a plugin was installed since the last build, its frontend/plugin.ts
    // isn't in the bundle and its UI never registers. Running npm run build
    // produces a fresh bundle that includes any newly-installed plugins.
    // We use npm run build (not bare vite build) so that npm run clean runs
    // first and wipes stale dist/ artifacts (notably old plugin frontends).
    if (process.env.NODE_ENV === 'production') {
      broadcastToAll({ type: 'system:restarting', message: 'Rebuilding (~30-60s)...' });

      // Full pipeline: clean → SDK build → tsc → asset copy → vite build.
      // Bare `vite build` skips the clean step, which causes stale dist/ artifacts
      // (notably plugin frontends from previous builds) to persist. See spec
      // 2026-05-11-settings-restart-redesign.md Section 5.
      const buildChild = spawn(
        'npm',
        ['run', 'build'],
        {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
        },
      );

      let buildOutput = '';
      buildChild.stdout?.on('data', d => { buildOutput += d.toString(); });
      buildChild.stderr?.on('data', d => { buildOutput += d.toString(); });

      buildChild.on('close', code => {
        if (code === 0) {
          systemStateService?.clearRestartRequired();
          log('Build succeeded — exiting for systemd to restart');
          process.exit(0);
        }
        const tail = buildOutput.split('\n').slice(-30).join('\n');
        error(`Build failed (exit ${code}):\n${tail}`);
        broadcastToAll({
          type: 'system:restart-failed',
          message: 'Build failed. Check server logs and run `npm run build` manually.',
          buildOutputTail: tail,
        });
      });

      buildChild.on('error', err => {
        error(`Could not spawn npm run build: ${err.message}`);
        broadcastToAll({
          type: 'system:restart-failed',
          message: `Could not spawn build: ${err.message}. Restart aborted.`,
        });
      });
      return;
    }

    systemStateService?.clearRestartRequired();
    setTimeout(() => {
      log('Graceful restart — exiting with code 0');
      process.exit(0);
    }, 500);
  }, { requires: ['core.plugins:manage'] });
}
