import React, { useState, useEffect, useCallback } from 'react';
import { ShoppingBag, RotateCcw } from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { usePluginRegistrySnapshot } from '@darkrideapp/plugin-sdk/react';
import { PluginCard } from '../components/plugins/PluginCard';
import { ScopeConsentModal } from '../components/plugins/ScopeConsentModal';
import { ScopeDriftBanner } from '../components/plugins/ScopeDriftBanner';
import type { ScopeRow } from '../components/plugins/ScopeConsentModal';
import { UninstallPluginModal, type UninstallFootprint } from '../components/plugins/UninstallPluginModal';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';

interface InstalledPlugin {
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  enabled: boolean;
  installedVia: string;
  loaded: boolean;
  extensionPoints?: { tools: number; pages: number; settings: number };
  updateAvailable?: boolean;
  latestVersion?: string;
  /** Set by the host when a fatal error (e.g. migration failure) auto-disabled the plugin. */
  lastError?: string | null;
}

/** Shape returned by GET /v1/plugins/:name/scope-status */
interface ScopeStatus {
  state: 'unconsented' | 'approved' | 'drift-wider' | 'drift-narrower' | 'no-scopes';
  manifestScopes: string[];
  approvedScopes: string[] | null;
  added: Array<{ key: string; metadata?: { label: string; description: string; category?: string } }>;
  removed: string[];
}

/** Scope-status cache keyed by plugin name */
type ScopeStatusMap = Record<string, ScopeStatus>;

interface ConsentModalState {
  pluginName: string;
  pluginVersion: string | null;
  scopes: ScopeRow[];
  /** true when opened from ScopeDriftBanner (re-review) rather than fresh install */
  isDrift: boolean;
}

export function PluginManager() {
  useDocumentTitle('Plugins');
  const ws = useWebSocket();
  const toast = useToast();
  const navigate = useNavigate();

  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Scope-status state
  const [scopeStatuses, setScopeStatuses] = useState<ScopeStatusMap>({});
  const [consentModal, setConsentModal] = useState<ConsentModalState | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);

  // Uninstall confirmation modal
  const [uninstallModal, setUninstallModal] = useState<{ name: string; footprint: UninstallFootprint | null } | null>(null);

  // Empty set declared here so the file compiles; Task 6 wires the actual
  // mutation in handleUpdate. Used by PluginCard's `updating` prop.
  const [updatingNames, setUpdatingNames] = useState<Set<string>>(new Set());
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  const pluginSettings = usePluginRegistrySnapshot(r => r.getSettings());
  const hasSettings = (name: string) => pluginSettings.some(s => s.pluginName === name);

  const fetchPlugins = useCallback(async () => {
    const res = await ws.sendRestApi('GET', '/v1/plugins/installed');
    if (res?.body?.success) {
      setPlugins(Array.isArray(res.body.data?.plugins) ? res.body.data.plugins : []);
    }
    setLoading(false);
  }, [ws]);

  useEffect(() => { fetchPlugins(); }, [fetchPlugins]);

  // Fetch scope-status for all LOADED plugins whenever the plugin list changes.
  // Skipping unloaded plugins (installedVia: 'missing', disabled, or pending
  // first-restart-after-install) avoids 404s from /v1/plugins/:name/scope-status,
  // which the global onApiError bridge would otherwise surface as "Unknown plugin"
  // toasts on every plugins-page visit.
  useEffect(() => {
    const loadedPlugins = plugins.filter(p => p.loaded);
    if (loadedPlugins.length === 0) return;

    void (async () => {
      const entries = await Promise.all(
        loadedPlugins.map(async (p) => {
          const res = await ws.sendRestApi('GET', `/v1/plugins/${encodeURIComponent(p.name)}/scope-status`);
          if (res?.body?.success) {
            return [p.name, res.body as ScopeStatus] as const;
          }
          return null;
        }),
      );
      const map: ScopeStatusMap = {};
      for (const entry of entries) {
        if (entry) map[entry[0]] = entry[1];
      }
      setScopeStatuses(map);
    })();
  }, [plugins, ws]);

  const handleEnable = useCallback(async (name: string) => {
    const res = await ws.sendRestApi('POST', `/v1/plugins/${encodeURIComponent(name)}/enable`);
    if (res?.body?.success) {
      toast.success(`Plugin "${name}" enabled`);
      if (res.body.restartRequired) setPendingRestart(true);
      await fetchPlugins();
    } else {
      toast.error(`Failed to enable plugin "${name}"`);
    }
  }, [ws, toast, fetchPlugins]);

  const handleDisable = useCallback(async (name: string) => {
    const res = await ws.sendRestApi('POST', `/v1/plugins/${encodeURIComponent(name)}/disable`);
    if (res?.body?.success) {
      toast.success(`Plugin "${name}" disabled`);
      if (res.body.restartRequired) setPendingRestart(true);
      await fetchPlugins();
    } else {
      toast.error(`Failed to disable plugin "${name}"`);
    }
  }, [ws, toast, fetchPlugins]);

  const handleUninstall = useCallback(async (name: string) => {
    // Open modal immediately with a loading state; fetch footprint in the background.
    setUninstallModal({ name, footprint: null });
    const res = await ws.sendRestApi('GET', `/v1/plugins/${encodeURIComponent(name)}/uninstall-footprint`);
    if (res?.body?.success) {
      setUninstallModal({ name, footprint: res.body.data as UninstallFootprint });
    } else {
      // Footprint fetch failed — let the user proceed but with a conservative summary.
      setUninstallModal({ name, footprint: { tables: [], fileStorageBytes: 0, npmPackage: null } });
    }
  }, [ws]);

  const handleUninstallConfirm = useCallback(async (preserveData: boolean) => {
    if (!uninstallModal) return;
    const name = uninstallModal.name;
    setUninstallModal(null);
    const res = await ws.sendRestApi('POST', '/v1/plugins/uninstall', { name, preserveData });
    if (res?.body?.success) {
      toast.success(preserveData
        ? `Plugin "${name}" uninstalled (data kept)`
        : `Plugin "${name}" uninstalled and data deleted`);
      if (res.body.restartRequired) setPendingRestart(true);
      await fetchPlugins();
    } else {
      toast.error(`Failed to uninstall plugin "${name}"`);
    }
  }, [ws, toast, fetchPlugins, uninstallModal]);

  const handleUpdate = useCallback(async (name: string) => {
    setUpdatingNames(prev => new Set(prev).add(name));
    try {
      const res = await ws.sendRestApi('POST', '/v1/plugins/update', { name });
      if (res?.body?.success) {
        toast.success(`Plugin "${name}" updated`);
        if (res.body.restartRequired) setPendingRestart(true);
        await fetchPlugins();
      } else {
        toast.error(`Failed to update plugin "${name}"`);
      }
    } finally {
      setUpdatingNames(prev => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }, [ws, toast, fetchPlugins]);

  const handleUpdateAll = useCallback(async () => {
    const updatable = plugins.filter(p => p.updateAvailable);
    // Sequential: concurrent npm installs in the same managedRoot are unsafe.
    for (const p of updatable) {
      await handleUpdate(p.name);
    }
  }, [plugins, handleUpdate]);

  const handleCheckForUpdates = useCallback(async () => {
    setCheckingUpdates(true);
    try {
      await ws.sendRestApi('POST', '/v1/plugins/marketplace/refresh');
      await fetchPlugins();
      toast.success('Checked for updates');
    } catch {
      toast.error('Could not check for updates');
    } finally {
      setCheckingUpdates(false);
    }
  }, [ws, toast, fetchPlugins]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    await ws.sendRestApi('POST', '/v1/system/restart');
  }, [ws]);

  // ── Scope consent helpers ────────────────────────────────────────────────────

  /** Open the consent modal for a plugin, building ScopeRow[] from its scope-status. */
  const openConsentModal = useCallback((plugin: InstalledPlugin, status: ScopeStatus, isDrift: boolean) => {
    const scopes: ScopeRow[] = (status.manifestScopes ?? []).map((key) => {
      // For drift-wider, scope metadata comes from status.added[]; for unconsented, fetch from added too
      const addedEntry = status.added.find((a) => a.key === key);
      return {
        key,
        label: addedEntry?.metadata?.label ?? key,
        description: addedEntry?.metadata?.description ?? '',
        category: addedEntry?.metadata?.category,
      };
    });
    setConsentModal({ pluginName: plugin.name, pluginVersion: plugin.version, scopes, isDrift });
  }, []);

  /** POST approve-scopes, then refresh and close modal. */
  const handleConsentApprove = useCallback(async (approved: string[]) => {
    if (!consentModal) return;
    setConsentBusy(true);
    try {
      const res = await ws.sendRestApi(
        'POST',
        `/v1/plugins/${encodeURIComponent(consentModal.pluginName)}/approve-scopes`,
        { approvedScopes: approved },
      );
      if (res?.body?.success) {
        toast.success(`Scopes approved for "${consentModal.pluginName}"`);
        setConsentModal(null);
        await fetchPlugins();
      } else {
        toast.error(`Failed to approve scopes: ${res?.body?.error ?? 'unknown error'}`);
      }
    } finally {
      setConsentBusy(false);
    }
  }, [consentModal, ws, toast, fetchPlugins]);

  /** "Install but leave disabled" — just close the modal. Plugin stays installed+disabled. */
  const handleConsentDisable = useCallback(() => {
    setConsentModal(null);
  }, []);

  /**
   * Cancel action from consent modal.
   * - Fresh install: treat same as "install but leave disabled" (v1; no cancel-install flow)
   * - Drift review: same — just dismiss
   */
  const handleConsentCancel = useCallback(() => {
    setConsentModal(null);
  }, []);

  // ── Scope-status check after install (post-install hook) ────────────────────

  /**
   * After the install flow completes for a plugin, check its scope-status.
   * If state === 'unconsented' and there are scopes to declare, open the modal.
   *
   * Note: the existing page has no install flow — plugins arrive via the Marketplace page.
   * This function is called from within PluginManager when a plugin that is already
   * in the list still has state 'unconsented', giving users a way to consent.
   */
  const handleEnableWithConsentCheck = useCallback(async (plugin: InstalledPlugin) => {
    const status = scopeStatuses[plugin.name];
    if (status && status.state === 'unconsented' && status.manifestScopes.length > 0) {
      openConsentModal(plugin, status, false);
      return;
    }
    await handleEnable(plugin.name);
  }, [scopeStatuses, openConsentModal, handleEnable]);

  return (
    <>
      <header className="settings-page-header">
        <h1>Plugin Manager</h1>
      </header>
      <div className="plugin-manager-header">
        <h2 style={{ margin: 0, fontSize: 16 }}>Installed Plugins</h2>
        <div className="plugin-manager-actions">
          {pendingRestart && (
            <button
              className="btn btn-warning"
              onClick={handleRestart}
              disabled={restarting}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <RotateCcw size={15} />
              {restarting ? 'Restarting…' : 'Restart to Apply Changes'}
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleCheckForUpdates}
            disabled={checkingUpdates}
          >
            {checkingUpdates ? 'Checking…' : 'Check for updates'}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => navigate('/ui/marketplace')}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <ShoppingBag size={15} />
            Browse Marketplace
          </button>
        </div>
      </div>

      {loading ? (
        <div className="plugin-loading">Loading plugins…</div>
      ) : plugins.length === 0 ? (
        <div className="plugin-empty">
          <p>No plugins installed.</p>
          <p>Browse the marketplace to discover and install plugins.</p>
        </div>
      ) : (
        <>
          {(() => {
            const updatableCount = plugins.filter(p => p.updateAvailable).length;
            if (updatableCount < 2) return null;
            return (
              <div className="update-banner">
                <span>{updatableCount} updates available</span>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleUpdateAll}
                  disabled={updatingNames.size > 0}
                >
                  Update all ({updatableCount})
                </button>
              </div>
            );
          })()}
          <div className="plugin-list">
          {plugins.map((plugin) => {
            const status = scopeStatuses[plugin.name];
            const showDriftBanner = status?.state === 'drift-wider';
            // Surface an "AI permissions pending" banner when the plugin
            // declares AI scopes but the user has never consented. Without
            // this, the only trigger was the Enable button — which does
            // nothing if the plugin is already enabled, forcing a toggle cycle.
            const showPendingBanner =
              status?.state === 'unconsented' && (status.manifestScopes?.length ?? 0) > 0;

            return (
              <div key={plugin.name}>
                {showDriftBanner && (
                  <ScopeDriftBanner
                    pluginName={plugin.name}
                    pluginVersion={plugin.version ?? ''}
                    added={status.added.map((a) => ({
                      key: a.key,
                      label: a.metadata?.label ?? a.key,
                      description: a.metadata?.description ?? '',
                      category: a.metadata?.category,
                    }))}
                    removed={status.removed}
                    onReview={() => openConsentModal(plugin, status, true)}
                    onUninstall={() => handleUninstall(plugin.name)}
                  />
                )}
                {showPendingBanner && (
                  <ScopeDriftBanner
                    variant="pending"
                    pluginName={plugin.name}
                    pluginVersion={plugin.version ?? ''}
                    added={status.added.map((a) => ({
                      key: a.key,
                      label: a.metadata?.label ?? a.key,
                      description: a.metadata?.description ?? '',
                      category: a.metadata?.category,
                    }))}
                    removed={status.removed}
                    onReview={() => openConsentModal(plugin, status, false)}
                    onUninstall={() => handleUninstall(plugin.name)}
                  />
                )}
                <PluginCard
                  {...plugin}
                  onEnable={() => handleEnableWithConsentCheck(plugin)}
                  onDisable={() => handleDisable(plugin.name)}
                  onUninstall={() => handleUninstall(plugin.name)}
                  latestVersion={plugin.latestVersion}
                  updateAvailable={plugin.updateAvailable}
                  updating={updatingNames.has(plugin.name)}
                  lastError={plugin.lastError}
                  onUpdate={plugin.updateAvailable ? () => handleUpdate(plugin.name) : undefined}
                  actions={hasSettings(plugin.name) ? (
                    <Link
                      to={`/ui/settings/plugins/${plugin.name}/settings`}
                      className="btn btn-sm btn-ghost"
                    >
                      Settings
                    </Link>
                  ) : undefined}
                />
              </div>
            );
          })}
          </div>
        </>
      )}

      {consentModal && (
        <ScopeConsentModal
          pluginName={consentModal.pluginName}
          pluginVersion={consentModal.pluginVersion ?? undefined}
          scopes={consentModal.scopes}
          onApprove={handleConsentApprove}
          onDisable={handleConsentDisable}
          onCancel={handleConsentCancel}
          busy={consentBusy}
        />
      )}

      {uninstallModal && (
        <UninstallPluginModal
          pluginName={uninstallModal.name}
          footprint={uninstallModal.footprint}
          onCancel={() => setUninstallModal(null)}
          onConfirm={handleUninstallConfirm}
        />
      )}
    </>
  );
}
