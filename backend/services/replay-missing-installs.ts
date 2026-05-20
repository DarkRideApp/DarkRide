import type { PluginInstallsRepo, PluginInstallRecord } from './plugin-installs-repo';
import type { PluginInstaller } from './plugin-installer';

/**
 * Source manager surface used during replay — just the auth-token lookup.
 * Typed as a minimal interface so tests don't need to construct the full
 * PluginSourceManager.
 */
export interface ReplaySourceManager {
  getAll(): Array<{ id: number; authToken: string | null }>;
}

export interface ReplayMissingInstallsOpts {
  installsRepo: Pick<PluginInstallsRepo, 'getMissingDirs'>;
  installer: Pick<PluginInstaller, 'installManaged'>;
  sourceManager: ReplaySourceManager | null;
  managedNodeModules: string;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

/**
 * Re-install any managed plugins whose on-disk directories went missing
 * between server runs (e.g. DATA_ROOT got wiped, the npm cache was
 * cleared, the user moved the host between machines). Authoritative
 * state is `plugin_installs`; if a row exists but the dir is gone, we
 * try to re-fetch the same package.
 *
 * Failure isolation: each row's install is independent. A failed
 * replay logs a structured error and continues to the next row — the
 * server still boots, the plugin is left absent on disk and will
 * appear as `installedVia: 'missing'` in the UI after reconcile().
 *
 * Auth token resolution: prefers the per-install token (column added
 * in migration 0090), falls back to the originating source row, then
 * gives up. A no-auth git URL gets a hint logged so the user knows to
 * refresh credentials via the marketplace UI.
 */
export async function replayMissingInstalls({
  installsRepo,
  installer,
  sourceManager,
  managedNodeModules,
  log,
  logError,
}: ReplayMissingInstallsOpts): Promise<void> {
  const missing = installsRepo.getMissingDirs(managedNodeModules);
  if (missing.length === 0) return;

  log(`Replaying ${missing.length} managed plugin install(s)...`);
  for (const row of missing) {
    const target = row.resolvedRef
      ? `${row.sourceUrl}#${row.resolvedRef}`
      : row.sourceUrl;
    const authToken = resolveAuthToken(row, sourceManager);
    const result = await installer.installManaged(target, authToken);
    if (!result.success) {
      const hint = !authToken && target.startsWith('git+')
        ? ' (no auth token available — if this is a private repo, reinstall via the marketplace UI to refresh credentials)'
        : '';
      logError(`Plugin install replay failed: ${row.name} — ${result.error}${hint}`);
    }
  }
}

function resolveAuthToken(
  row: PluginInstallRecord,
  sourceManager: ReplaySourceManager | null,
): string | null {
  if (row.authToken) return row.authToken;
  if (row.sourceId == null || !sourceManager) return null;
  const src = sourceManager.getAll().find((s) => s.id === row.sourceId);
  return src?.authToken ?? null;
}
