import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import {
  buildEntries,
  type InstalledPlugin,
  type PluginEntry,
  type RegistryPlugin,
  type ScopeStatus,
} from './catalog';

export type { ScopeStatus };

export type ScopeStatusMap = Record<string, ScopeStatus>;

export interface PluginCatalog {
  entries: PluginEntry[];
  installedLoading: boolean;
  installedError: string | null;
  registryLoading: boolean;
  registryError: string | null;
  /** When the marketplace cache was last filled, in ms. */
  fetchedAt: number | null;
  scopeStatuses: ScopeStatusMap;
  reloadInstalled: () => Promise<void>;
  reloadRegistry: () => Promise<void>;
  /** Bust the marketplace cache. Resolves true on success; on failure the previous list stays. */
  refreshRegistry: () => Promise<boolean>;
}

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/**
 * Data layer for the Plugins workspace. The installed list and the marketplace
 * load independently, so a marketplace outage (offline, a bad source) never
 * hides the plugins you already have. Scope-status is fetched once per loaded
 * plugin, since the endpoint 404s for plugins the host has not loaded.
 */
export function usePluginCatalog(): PluginCatalog {
  const ws = useWebSocket();

  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
  const [installedLoading, setInstalledLoading] = useState(true);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [scopeStatuses, setScopeStatuses] = useState<ScopeStatusMap>({});

  // Drop results from a request that was superseded or outlived the component.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadScopeStatuses = useCallback(
    async (plugins: InstalledPlugin[]) => {
      const loaded = plugins.filter(p => p.loaded && p.installedVia !== 'missing');
      const results = await Promise.all(
        loaded.map(async p => {
          try {
            const res = await ws.sendRestApi('GET', `/v1/plugins/${encodeURIComponent(p.name)}/scope-status`);
            return res?.body?.success ? ([p.name, res.body as ScopeStatus] as const) : null;
          } catch {
            return null;
          }
        }),
      );
      if (!mounted.current) return;
      const next: ScopeStatusMap = {};
      for (const r of results) if (r) next[r[0]] = r[1];
      setScopeStatuses(next);
    },
    [ws],
  );

  const reloadInstalled = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/plugins/installed');
      if (!mounted.current) return;
      if (res?.body?.success) {
        const plugins: InstalledPlugin[] = Array.isArray(res.body.data?.plugins) ? res.body.data.plugins : [];
        setInstalled(plugins);
        setInstalledError(null);
        void loadScopeStatuses(plugins);
      } else {
        setInstalledError(res?.body?.error || 'Failed to load installed plugins');
      }
    } catch (err) {
      if (mounted.current) setInstalledError(messageOf(err, 'Failed to load installed plugins'));
    } finally {
      if (mounted.current) setInstalledLoading(false);
    }
  }, [ws, loadScopeStatuses]);

  const applyRegistry = useCallback((data: any) => {
    setRegistry(Array.isArray(data?.plugins) ? data.plugins : []);
    if (data?.fetchedAt != null) setFetchedAt(data.fetchedAt);
  }, []);

  const reloadRegistry = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/plugins/marketplace');
      if (!mounted.current) return;
      if (res?.body?.success) {
        applyRegistry(res.body.data);
        setRegistryError(null);
      } else {
        setRegistryError(res?.body?.error || 'Failed to load the marketplace');
      }
    } catch (err) {
      if (mounted.current) setRegistryError(messageOf(err, 'Failed to load the marketplace'));
    } finally {
      if (mounted.current) setRegistryLoading(false);
    }
  }, [ws, applyRegistry]);

  const refreshRegistry = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('POST', '/v1/plugins/marketplace/refresh');
      if (!mounted.current) return false;
      if (!res?.body?.success) return false;
      applyRegistry(res.body.data);
      setRegistryError(null);
      // The backend recomputes updateAvailable against the fresh cache.
      await reloadInstalled();
      return true;
    } catch {
      return false;
    }
  }, [ws, applyRegistry, reloadInstalled]);

  useEffect(() => {
    void reloadInstalled();
    void reloadRegistry();
  }, [reloadInstalled, reloadRegistry]);

  const entries = useMemo(() => buildEntries(registry, installed), [registry, installed]);

  return {
    entries,
    installedLoading,
    installedError,
    registryLoading,
    registryError,
    fetchedAt,
    scopeStatuses,
    reloadInstalled,
    reloadRegistry,
    refreshRegistry,
  };
}
