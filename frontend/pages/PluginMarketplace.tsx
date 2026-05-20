import React, { useState, useEffect, useCallback } from 'react';
import { Download, ExternalLink, ShieldCheck, ShieldAlert, ShieldX, RefreshCw } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { RestartBanner } from '@darkrideapp/plugin-sdk/react';
import { Link } from 'react-router-dom';
import { SourceManagerModal } from '../components/plugins/SourceManagerModal';
import { PluginInstallProgressModal } from '../components/plugins/PluginInstallProgressModal';

interface PluginVerification {
  status: 'verified' | 'unsigned' | 'untrusted';
  signedBy?: string;
  keyLabel?: string;
}

interface MarketplacePlugin {
  name: string;
  displayName: string;
  description: string;
  author: string;
  repo: string;
  latestVersion: string;
  category: string;
  license: string;
  npmPackage: string;
  source: string;
  installUrl?: string;
  verification?: PluginVerification;
  /** Other plugin names this plugin requires. Set by the registry; surfaced
   * in the card so users see "Requires: X" before clicking Install. */
  dependencies?: string[];
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function PluginMarketplace() {
  useDocumentTitle('Plugin Marketplace');
  const ws = useWebSocket();
  const toast = useToast();

  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  // Maps plugin runtime name → installedVia ('npm' | 'managed' | 'workspace' | 'missing').
  // 'missing' means the registry knows about it but its files have vanished — we
  // surface a Reinstall button rather than hiding it as "Installed".
  const [installedPlugins, setInstalledPlugins] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [installing, setInstalling] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  // Plugin name whose install is in progress; null when no modal is open.
  // Set from handleInstall and cleared by the modal's onClose.
  const [progressPluginName, setProgressPluginName] = useState<string | null>(null);
  // Pending confirmation dialog for unverified plugins. The backend's first
  // install POST returns confirmRequired + a warning string when the plugin
  // is unsigned by a trusted publisher; the user has to acknowledge before
  // we re-POST with confirmed:true. Was a native confirm() previously.
  const [pendingConfirm, setPendingConfirm] = useState<{
    plugin: MarketplacePlugin;
    warning: string;
  } | null>(null);

  const fetchPlugins = useCallback(async () => {
    const installedRes = await ws.sendRestApi('GET', '/v1/plugins/installed');
    if (installedRes.body?.success) {
      const map: Record<string, string> = {};
      for (const p of (installedRes.body.data?.plugins ?? []) as { name: string; installedVia: string }[]) {
        map[p.name] = p.installedVia;
      }
      setInstalledPlugins(map);
    }
  }, [ws]);

  const fetchMarketplace = useCallback(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      ws.sendRestApi('GET', '/v1/plugins/marketplace'),
      ws.sendRestApi('GET', '/v1/plugins/installed'),
    ])
      .then(([marketRes, installedRes]) => {
        if (marketRes.body?.success) {
          setPlugins(marketRes.body.data?.plugins ?? []);
          if (marketRes.body.data?.fetchedAt != null) {
            setFetchedAt(marketRes.body.data.fetchedAt);
          }
        } else {
          setError(marketRes.body?.error || 'Failed to load marketplace');
        }
        if (installedRes.body?.success) {
          const map: Record<string, string> = {};
          for (const p of (installedRes.body.data?.plugins ?? []) as { name: string; installedVia: string }[]) {
            map[p.name] = p.installedVia;
          }
          setInstalledPlugins(map);
        }
      })
      .catch(() => {
        setError('Failed to load marketplace');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [ws]);

  useEffect(() => {
    fetchMarketplace();
  }, [fetchMarketplace]);

  const handleRefresh = useCallback(async () => {
    setRefreshCooldown(true);
    const res = await ws.sendRestApi('POST', '/v1/plugins/marketplace/refresh');
    if (res.body?.success) {
      setPlugins(res.body.data.plugins || []);
      if (res.body.data?.fetchedAt != null) {
        setFetchedAt(res.body.data.fetchedAt);
      }
      toast.success('Marketplace refreshed');
    }
    setTimeout(() => setRefreshCooldown(false), 60_000);
  }, [ws, toast]);

  const categories = ['All', ...Array.from(new Set(plugins.map(p => p.category).filter(Boolean)))];

  const filtered = plugins.filter(p => {
    const matchesCategory = activeCategory === 'All' || p.category === activeCategory;
    if (!matchesCategory) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.displayName.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.author.toLowerCase().includes(q)
    );
  });

  const handleInstall = useCallback(async (plugin: MarketplacePlugin) => {
    if (installing) return;
    const key = plugin.npmPackage || plugin.installUrl || plugin.name;
    setInstalling(key);
    // Open the per-plugin progress modal as soon as the install kicks off
    // — the backend will fan out 'plugin-install-progress' events keyed
    // by plugin.name, which the modal subscribes to.
    setProgressPluginName(plugin.name);

    const res = await ws.sendRestApi('POST', '/v1/plugins/install', {
      npmPackage: plugin.npmPackage,
      installUrl: plugin.installUrl,
      pluginData: plugin,
    });

    if (res.body?.blocked) {
      toast.error(res.body.error);
      setInstalling(null);
      return;
    }

    if (res.body?.confirmRequired) {
      // Stash the request and let the ConfirmDialog handler re-issue with
      // confirmed:true if the user proceeds. The progress modal stays open
      // (showing the install phase) while the dialog is up — visually
      // stacked, both functional, both keyboard-trapping.
      setPendingConfirm({
        plugin,
        warning: res.body.warning || 'This plugin is not verified by any trusted publisher.',
      });
      return;
    }

    if (res.body?.success) {
      toast.success(`${plugin.displayName} installed. Restart to activate.`);
      // RestartBanner picks up the backend's setRestartRequired(...) state
      // via useRestartRequired() and renders the banner + button itself.
      fetchPlugins();
    } else if (res.body?.nameCollision) {
      // 409 from the identity-collision gate. Re-frame the raw error
      // into something actionable — the host's error string is already
      // good, but prefix with a clear "what's wrong" headline.
      const src = res.body.nameCollision.existingSource;
      toast.error(`Name conflicts with an existing ${src} plugin. Uninstall the ${src} copy or rename this plugin to install both.`);
    } else if (res.body?.contentMismatch) {
      toast.error(`Refused: signed-manifest content pin mismatch. ${res.body.error ?? ''}`);
    } else {
      toast.error(res.body?.error || `Failed to install ${plugin.displayName}`);
    }
    setInstalling(null);
  }, [ws, toast, installing, fetchPlugins]);

  /** User accepted the unverified-plugin warning — re-POST install with the
   *  confirmed flag and resolve the same way as the verified path. */
  const handleConfirmedInstall = useCallback(async () => {
    if (!pendingConfirm) return;
    const { plugin } = pendingConfirm;
    setPendingConfirm(null);
    const res = await ws.sendRestApi('POST', '/v1/plugins/install', {
      npmPackage: plugin.npmPackage,
      installUrl: plugin.installUrl,
      pluginData: plugin,
      confirmed: true,
    });
    if (res.body?.success) {
      toast.success(`${plugin.displayName} installed. Restart to activate.`);
      fetchPlugins();
    } else if (res.body?.nameCollision) {
      const src = res.body.nameCollision.existingSource;
      toast.error(`Name conflicts with an existing ${src} plugin. Uninstall the ${src} copy or rename this plugin to install both.`);
    } else if (res.body?.contentMismatch) {
      toast.error(`Refused: signed-manifest content pin mismatch. ${res.body.error ?? ''}`);
    } else {
      toast.error(res.body?.error || 'Install failed');
    }
    setInstalling(null);
  }, [pendingConfirm, ws, toast, fetchPlugins]);

  /** User declined the unverified-plugin warning — close everything. */
  const handleCancelConfirm = useCallback(() => {
    setPendingConfirm(null);
    setProgressPluginName(null);
    setInstalling(null);
  }, []);

  return (
    <>
      <header className="settings-page-header">
        <h1>Marketplace</h1>
      </header>
      <RestartBanner />
      <div className="marketplace-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Plugin Marketplace</h2>
          {fetchedAt && (
            <span className="marketplace-updated">
              Last updated: {formatTimeAgo(fetchedAt)}
            </span>
          )}
        </div>
        <div className="marketplace-header-actions">
          <button
            className="btn btn-sm"
            onClick={handleRefresh}
            disabled={refreshCooldown || loading}
            title={refreshCooldown ? 'Refresh available in 60s' : 'Refresh marketplace data'}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button className="btn btn-sm" onClick={() => setShowSources(true)}>Manage Sources</button>
          {/* Marketplace is the top-level browse / install surface; managing
              what's already installed (enable, disable, update, uninstall)
              lives at Settings → Plugins. The promotion of Marketplace out
              of Settings (commit e8e1a72) made this link non-obvious — keep
              it discoverable from the header. */}
          <Link to="/ui/settings/plugins" className="btn btn-sm" data-testid="marketplace-manage-installed-link">
            Manage installed
          </Link>
        </div>
      </div>

      <div className="marketplace-toolbar">
        <input
          className="marketplace-search-input"
          type="text"
          placeholder="Search plugins..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="marketplace-categories">
          {categories.map(cat => (
            <button
              key={cat}
              className={`marketplace-category-btn${activeCategory === cat ? ' active' : ''}`}
              onClick={() => setActiveCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="marketplace-loading">
          <LoadingSpinner center />
        </div>
      )}

      {!loading && error && (
        <div className="marketplace-error">{error}</div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="marketplace-empty">
          {search || activeCategory !== 'All'
            ? 'No plugins match your search.'
            : 'No plugins available.'}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="marketplace-grid">
          {filtered.map(plugin => {
            const key = plugin.npmPackage || plugin.installUrl || plugin.name;
            const installState = installedPlugins[plugin.name];
            const isMissing = installState === 'missing';
            const isInstalled = installState !== undefined && !isMissing;
            const isInstalling = installing === key;
            const repoUrl = plugin.repo
              ? (plugin.repo.startsWith('http') ? plugin.repo : `https://github.com/${plugin.repo}`)
              : null;

            return (
              <div key={plugin.name} className="marketplace-card">
                <div className="marketplace-card-header">
                  <div>
                    <p className="marketplace-card-title">{plugin.displayName}</p>
                    <div className="marketplace-card-meta">
                      <span>by {plugin.author}</span>
                      <span>v{plugin.latestVersion}</span>
                      {plugin.license && <span>{plugin.license}</span>}
                      {plugin.category && (
                        <span className="marketplace-category">{plugin.category}</span>
                      )}
                      {repoUrl && (
                        <a href={repoUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 3 }}>
                          <ExternalLink size={11} />
                          Repo
                        </a>
                      )}
                      {plugin.verification?.status === 'verified' && (
                        <span className="plugin-verified">
                          <ShieldCheck size={14} />Verified by {plugin.verification.keyLabel ?? plugin.verification.signedBy ?? 'unknown'}
                        </span>
                      )}
                      {plugin.verification?.status === 'unsigned' && (
                        <span className="plugin-unverified">
                          <ShieldAlert size={14} />Unverified
                        </span>
                      )}
                      {plugin.verification?.status === 'untrusted' && (
                        <span className="plugin-untrusted">
                          <ShieldX size={14} />Unknown signer
                        </span>
                      )}
                    </div>
                  </div>
                  {isInstalled && (
                    <span className="marketplace-installed">Installed</span>
                  )}
                </div>

                <p className="marketplace-card-description">{plugin.description}</p>

                {plugin.dependencies && plugin.dependencies.length > 0 && (() => {
                  // Annotate each dep with whether it's currently satisfied so
                  // we can show "Requires: maps (not installed)" inline.
                  const missing = plugin.dependencies.filter((d) => {
                    const s = installedPlugins[d];
                    return !s || s === 'missing';
                  });
                  const hasUnmet = missing.length > 0;
                  return (
                    <p
                      className={hasUnmet ? 'marketplace-requires-unmet' : 'marketplace-requires'}
                      style={{ fontSize: 12, color: hasUnmet ? 'var(--danger)' : 'var(--text-secondary)', margin: '4px 0 8px' }}
                      data-testid="marketplace-requires"
                    >
                      Requires: {plugin.dependencies.map((d) => {
                        const isMissing = missing.includes(d);
                        return isMissing ? `${d} (not installed)` : d;
                      }).join(', ')}
                    </p>
                  );
                })()}

                <div className="marketplace-card-footer">
                  <span className="marketplace-source-badge">{plugin.source}</span>
                  {!isInstalled && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => handleInstall(plugin)}
                      disabled={isInstalling || !!installing}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      title={isMissing ? 'Plugin files are missing on disk. Reinstall preserves your existing data.' : undefined}
                    >
                      {isInstalling ? <LoadingSpinner /> : <Download size={14} />}
                      {isInstalling
                        ? (isMissing ? 'Reinstalling...' : 'Installing...')
                        : (isMissing ? 'Reinstall' : 'Install')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showSources && (
        <SourceManagerModal
          onClose={() => setShowSources(false)}
          onSourcesChanged={() => { setShowSources(false); fetchMarketplace(); }}
        />
      )}

      {progressPluginName && (
        <PluginInstallProgressModal
          pluginName={progressPluginName}
          onClose={() => setProgressPluginName(null)}
        />
      )}

      {pendingConfirm && (
        <ConfirmDialog
          title={`Install unverified "${pendingConfirm.plugin.displayName}"?`}
          message={pendingConfirm.warning + ' Only continue if you trust the source.'}
          confirmLabel="Install anyway"
          cancelLabel="Cancel"
          onConfirm={handleConfirmedInstall}
          onCancel={handleCancelConfirm}
        />
      )}
    </>
  );
}
