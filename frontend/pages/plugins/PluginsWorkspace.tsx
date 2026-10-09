import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw, Settings2 } from 'lucide-react';
import {
  ConfirmDialog,
  LoadingSpinner,
  RestartBanner,
  useDocumentTitle,
  usePluginRegistrySnapshot,
  useToast,
} from '@darkrideapp/plugin-sdk/react';
import { PluginInstallProgressModal } from '../../components/plugins/PluginInstallProgressModal';
import { ScopeConsentModal } from '../../components/plugins/ScopeConsentModal';
import { SourceManagerModal } from '../../components/plugins/SourceManagerModal';
import { UninstallPluginModal } from '../../components/plugins/UninstallPluginModal';
import {
  applyInstalledFilter,
  countByFilter,
  forTab,
  matchesQuery,
  timeAgo,
  unmetDependencies,
  updatableEntries,
  type InstalledFilter,
  type PluginEntry,
  type PluginTab,
} from './catalog';
import { PluginDrawer } from './PluginDrawer';
import { PluginRow } from './PluginRow';
import { usePluginActions } from './usePluginActions';
import { usePluginCatalog } from './usePluginCatalog';
import { useUrlText } from './useUrlText';

const REFRESH_COOLDOWN_MS = 60_000;

const FILTERS: Array<{ key: InstalledFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'updates', label: 'Updates' },
  { key: 'disabled', label: 'Disabled' },
  { key: 'errors', label: 'Errors' },
];

const asTab = (v: string | null): PluginTab | null => (v === 'installed' || v === 'discover' ? v : null);
const asFilter = (v: string | null): InstalledFilter =>
  v === 'updates' || v === 'disabled' || v === 'errors' ? v : 'all';

/**
 * One home for plugins: what you have (Installed) and what you could have
 * (Discover). Both tabs render the same row, so an update, an install or an
 * enable toggle works the same wherever you are. All view state (tab, search,
 * filter, open plugin) lives in the URL, so every view is linkable and the
 * back button closes the detail drawer.
 */
export function PluginsWorkspace() {
  useDocumentTitle('Plugins');
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const catalog = usePluginCatalog();
  const { entries, scopeStatuses } = catalog;

  // ── URL state ──────────────────────────────────────────────────────────────

  const tabParam = asTab(searchParams.get('tab'));
  const filter = asFilter(searchParams.get('filter'));
  const category = searchParams.get('category');
  const pluginParam = searchParams.get('plugin');
  const urlQuery = searchParams.get('q') ?? '';

  const setParams = useCallback(
    (changes: Record<string, string | null>, opts: { push?: boolean; state?: unknown } = {}) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const search = next.toString();
      navigate({ search: search ? `?${search}` : '' }, { replace: !opts.push, state: opts.state });
    },
    [searchParams, navigate],
  );

  // The search box keeps its own text so typing never waits on a route transition.
  const writeQuery = useCallback((value: string) => setParams({ q: value }), [setParams]);
  const [query, onQueryChange] = useUrlText(urlQuery, writeQuery);

  // ── derived lists ──────────────────────────────────────────────────────────

  const installedAll = useMemo(() => forTab(entries, 'installed'), [entries]);
  const discoverAll = useMemo(() => forTab(entries, 'discover'), [entries]);

  // With no ?tab=, land on Installed if there is anything installed, else Discover.
  // Decided once, after the first load: deciding on every render would bounce you to
  // Discover the moment you uninstall your last plugin.
  const [landing, setLanding] = useState<PluginTab | null>(null);
  useEffect(() => {
    if (landing === null && !catalog.installedLoading) setLanding(installedAll.length > 0 ? 'installed' : 'discover');
  }, [landing, catalog.installedLoading, installedAll.length]);
  const tab: PluginTab | null = tabParam ?? landing;

  const searched = useMemo(
    () => (tab === 'discover' ? discoverAll : installedAll).filter(e => matchesQuery(e, query)),
    [tab, discoverAll, installedAll, query],
  );
  const filterCounts = useMemo(() => countByFilter(searched), [searched]);
  const visible = useMemo(() => {
    if (tab === 'installed') return applyInstalledFilter(searched, filter);
    return category ? searched.filter(e => e.category === category) : searched;
  }, [tab, searched, filter, category]);
  const categories = useMemo(
    () => [...new Set(discoverAll.map(e => e.category).filter((c): c is string => !!c))].sort(),
    [discoverAll],
  );
  const updatable = useMemo(() => updatableEntries(entries), [entries]);

  const settled = !catalog.installedLoading && !catalog.registryLoading;

  // ── drawer ─────────────────────────────────────────────────────────────────

  const pluginSettings = usePluginRegistrySnapshot(r => r.getSettings());
  const drawerEntry = pluginParam ? (entries.find(e => e.name === pluginParam) ?? null) : null;

  const openDrawer = useCallback(
    (entry: PluginEntry) => {
      // Opening from the list pushes one history entry, which Back (or Close) pops. Switching
      // plugins while the drawer is open swaps it in place, so Close still closes in one step.
      if (pluginParam) setParams({ plugin: entry.name }, { state: location.state });
      else setParams({ plugin: entry.name }, { push: true, state: { fromList: true } });
    },
    [pluginParam, location.state, setParams],
  );
  const closeDrawer = useCallback(() => {
    // We pushed the entry when opening from the list, so step back over it; a deep link just drops the param.
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else setParams({ plugin: null });
  }, [location.state, navigate, setParams]);

  // ── actions ────────────────────────────────────────────────────────────────

  const actions = usePluginActions({
    scopeStatuses,
    reloadInstalled: catalog.reloadInstalled,
    onUninstalled: name => {
      if (pluginParam === name) closeDrawer();
    },
  });

  // ── header: refresh and sources ────────────────────────────────────────────

  const [cooling, setCooling] = useState(false);
  const coolTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(coolTimer.current), []);

  const handleRefresh = async () => {
    setCooling(true);
    const ok = await catalog.refreshRegistry();
    if (ok) {
      toast.success('Marketplace refreshed');
      coolTimer.current = setTimeout(() => setCooling(false), REFRESH_COOLDOWN_MS);
    } else {
      toast.error('Could not refresh the marketplace');
      setCooling(false);
    }
  };

  const [showSources, setShowSources] = useState(false);

  // ── render ─────────────────────────────────────────────────────────────────

  const renderBody = () => {
    const isInstalled = tab === 'installed';
    const loading = isInstalled ? catalog.installedLoading : catalog.registryLoading;
    const error = isInstalled ? catalog.installedError : catalog.registryError;
    const retry = isInstalled ? catalog.reloadInstalled : catalog.reloadRegistry;
    const noun = isInstalled ? 'installed plugins' : 'the marketplace';

    if (loading) return <div className="plugins-state"><LoadingSpinner center /></div>;

    if (error && visible.length === 0 && (isInstalled ? installedAll : discoverAll).length === 0) {
      return (
        <div className="plugins-state plugins-state--error" role="alert">
          <p>{`Couldn't load ${noun}: ${error}`}</p>
          <button type="button" className="btn btn-sm" onClick={() => void retry()}>Retry</button>
        </div>
      );
    }

    if (visible.length === 0) {
      if (query.trim()) {
        return (
          <div className="plugins-state">
            <p>{`No plugins match "${query.trim()}".`}</p>
            <button type="button" className="btn btn-sm" onClick={() => onQueryChange('')}>Clear search</button>
          </div>
        );
      }
      if (isInstalled && filter !== 'all') {
        return (
          <div className="plugins-state">
            <p>Nothing to show for this filter.</p>
            <button type="button" className="btn btn-sm" onClick={() => setParams({ filter: null })}>Show all</button>
          </div>
        );
      }
      if (isInstalled) {
        return (
          <div className="plugins-state">
            <p>No plugins installed.</p>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setParams({ tab: 'discover' }, { push: true })}>
              Browse the marketplace
            </button>
          </div>
        );
      }
      return <div className="plugins-state"><p>The marketplace has no plugins to show.</p></div>;
    }

    return (
      <>
        {error && (
          <div className="plugins-notice" role="alert">
            <span>{`Couldn't refresh ${noun}: ${error}`}</span>
            <button type="button" className="btn btn-sm" onClick={() => void retry()}>Retry</button>
          </div>
        )}
        <ul className="plugins-list">
          {visible.map(entry => (
            <PluginRow
              key={entry.name}
              entry={entry}
              tab={tab as PluginTab}
              busy={actions.busyOf(entry.name)}
              installBlocked={actions.installBlocked}
              unmetDependencies={unmetDependencies(entry, entries)}
              scopeStatus={scopeStatuses[entry.name]}
              selected={pluginParam === entry.name}
              onOpen={openDrawer}
              onInstall={actions.install}
              onUpdate={actions.update}
              onToggleEnabled={actions.toggleEnabled}
              onReviewPermissions={actions.openConsent}
            />
          ))}
        </ul>
      </>
    );
  };

  const tabs: Array<{ key: PluginTab; label: string; count: number | null }> = [
    { key: 'installed', label: 'Installed', count: catalog.installedLoading ? null : installedAll.length },
    { key: 'discover', label: 'Discover', count: catalog.registryLoading || catalog.registryError ? null : discoverAll.length },
  ];

  return (
    <div className="plugins-workspace" data-testid="plugins-workspace" aria-busy={!settled}>
      <header className="page-header">
        <div>
          <h1>Plugins</h1>
          {catalog.fetchedAt != null && (
            <div className="page-subtitle" data-testid="plugins-updated">
              {`Updated ${timeAgo(catalog.fetchedAt)}`}
            </div>
          )}
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleRefresh()}
            disabled={cooling}
            title={cooling ? 'Marketplace data was just refreshed' : 'Fetch the latest marketplace data'}
          >
            <RefreshCw size={14} aria-hidden />
            Refresh
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setShowSources(true)}>
            <Settings2 size={14} aria-hidden />
            Sources
          </button>
        </div>
      </header>

      <RestartBanner />

      {tab === null ? (
        <div className="plugins-state"><LoadingSpinner center /></div>
      ) : (
        <div className={`plugins-layout${pluginParam ? ' has-drawer' : ''}`}>
          <div className="plugins-main">
            <div className="plugins-tabs" role="tablist" aria-label="Plugin views">
              {tabs.map(t => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`plugins-tab${tab === t.key ? ' active' : ''}`}
                  onClick={() => setParams({ tab: t.key, filter: null, category: null }, { push: true })}
                >
                  {t.label}
                  {t.count !== null && <>{' '}<span className="plugins-tab-count">{t.count}</span></>}
                </button>
              ))}
            </div>

            <div className="plugins-toolbar">
              <input
                type="search"
                className="plugins-search"
                aria-label="Search plugins"
                placeholder="Search plugins"
                value={query}
                onChange={e => onQueryChange(e.target.value)}
              />
              <div className="plugins-chips">
                {tab === 'installed'
                  ? FILTERS.filter(f => f.key === 'all' || f.key === filter || filterCounts[f.key] > 0).map(f => (
                      <button
                        key={f.key}
                        type="button"
                        className={`plugins-chip${filter === f.key ? ' active' : ''}`}
                        aria-pressed={filter === f.key}
                        onClick={() => setParams({ filter: f.key === 'all' ? null : f.key })}
                      >
                        {f.label} <span className="plugins-chip-count">{filterCounts[f.key]}</span>
                      </button>
                    ))
                  : categories.length > 0 && (
                      <>
                        <button
                          type="button"
                          className={`plugins-chip${!category ? ' active' : ''}`}
                          aria-pressed={!category}
                          onClick={() => setParams({ category: null })}
                        >
                          All
                        </button>
                        {categories.map(c => (
                          <button
                            key={c}
                            type="button"
                            className={`plugins-chip${category === c ? ' active' : ''}`}
                            aria-pressed={category === c}
                            onClick={() => setParams({ category: c })}
                          >
                            {c}
                          </button>
                        ))}
                      </>
                    )}
              </div>
            </div>

            {tab === 'installed' && updatable.length > 0 && (
              <div className="plugins-update-strip" data-testid="plugins-update-strip">
                <span>{`${updatable.length} update${updatable.length === 1 ? '' : 's'} available`}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={actions.updating}
                  onClick={() => (updatable.length === 1 ? void actions.update(updatable[0]) : void actions.updateAll(updatable))}
                >
                  {updatable.length === 1 ? 'Update' : 'Update all'}
                </button>
              </div>
            )}

            {renderBody()}
          </div>

          {pluginParam && (drawerEntry || settled) && (
            <PluginDrawer
              entry={drawerEntry}
              requestedName={pluginParam}
              entries={entries}
              scopeStatus={drawerEntry ? scopeStatuses[drawerEntry.name] : undefined}
              busy={drawerEntry ? actions.busyOf(drawerEntry.name) : null}
              installBlocked={actions.installBlocked}
              hasSettingsPage={drawerEntry ? pluginSettings.some(s => s.pluginName === drawerEntry.name) : false}
              onClose={closeDrawer}
              onInstall={actions.install}
              onUpdate={actions.update}
              onToggleEnabled={actions.toggleEnabled}
              onReviewPermissions={actions.openConsent}
              onUninstall={actions.openUninstall}
            />
          )}
        </div>
      )}

      {showSources && (
        <SourceManagerModal
          onClose={() => setShowSources(false)}
          // Fires after every add, edit, remove and toggle. The server caches the marketplace for an
          // hour and does not clear it when sources change, so bust it; leave the dialog open.
          onSourcesChanged={() => void catalog.refreshRegistry()}
        />
      )}

      {actions.progressPluginName && !actions.pendingConfirm && (
        <PluginInstallProgressModal pluginName={actions.progressPluginName} onClose={actions.closeProgress} />
      )}

      {actions.pendingConfirm && (
        <ConfirmDialog
          title={`Install unverified "${actions.pendingConfirm.entry.displayName}"?`}
          message={`${actions.pendingConfirm.warning} Only continue if you trust the source.`}
          confirmLabel="Install anyway"
          cancelLabel="Cancel"
          onConfirm={() => void actions.confirmInstall()}
          onCancel={actions.cancelInstall}
        />
      )}

      {actions.consent && (
        <ScopeConsentModal
          pluginName={actions.consent.entry.displayName}
          pluginVersion={actions.consent.entry.version ?? undefined}
          scopes={actions.consent.scopes}
          busy={actions.consentBusy}
          onApprove={approved => void actions.approveConsent(approved)}
          onDisable={actions.closeConsent}
          onCancel={actions.closeConsent}
        />
      )}

      {actions.uninstall && (
        <UninstallPluginModal
          pluginName={actions.uninstall.entry.name}
          footprint={actions.uninstall.footprint}
          onCancel={actions.cancelUninstall}
          onConfirm={actions.confirmUninstall}
        />
      )}
    </div>
  );
}
