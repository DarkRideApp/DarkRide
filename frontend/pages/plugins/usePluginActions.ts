import { useCallback, useRef, useState } from 'react';
import { useToast, useWebSocket } from '@darkrideapp/plugin-sdk/react';
import type { ScopeRow } from '../../components/plugins/ScopeConsentModal';
import type { UninstallFootprint } from '../../components/plugins/UninstallPluginModal';
import { needsConsent, type PluginEntry, type RegistryPlugin } from './catalog';
import type { PluginBusy } from './PrimaryActionButton';
import type { ScopeStatusMap } from './usePluginCatalog';

interface Options {
  scopeStatuses: ScopeStatusMap;
  /** Refetch the installed list after something changed. */
  reloadInstalled: () => Promise<void>;
  /** Called after a plugin is uninstalled, so the page can close anything showing it. */
  onUninstalled?: (name: string) => void;
}

interface ConsentState {
  entry: PluginEntry;
  scopes: ScopeRow[];
}

const withDetail = (message: string, detail: unknown) =>
  typeof detail === 'string' && detail ? `${message}: ${detail}` : message;

/**
 * Every write the Plugins workspace can make (install, update, enable, disable,
 * uninstall, approve permissions), with the dialog state those flows need.
 * Success paths reload the installed list; the backend flags "restart required"
 * itself, so there is no restart bookkeeping here.
 */
export function usePluginActions({ scopeStatuses, reloadInstalled, onUninstalled }: Options) {
  const ws = useWebSocket();
  const toast = useToast();

  const [installingName, setInstallingName] = useState<string | null>(null);
  const [progressPluginName, setProgressPluginName] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ entry: PluginEntry; warning: string } | null>(null);
  const [updatingNames, setUpdatingNames] = useState<Set<string>>(new Set());
  const [uninstall, setUninstall] = useState<{ entry: PluginEntry; footprint: UninstallFootprint | null } | null>(null);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);

  // Ignore a second click on the same switch while its request is in flight.
  const toggling = useRef(new Set<string>());

  // ── install ────────────────────────────────────────────────────────────────

  const failInstall = useCallback((message: string) => {
    toast.error(message);
    setInstallingName(null);
    setProgressPluginName(null);
  }, [toast]);

  /** Resolve an install response. `allowConfirm` is false on the confirmed retry, so a server that keeps asking cannot loop. */
  const settleInstall = useCallback(
    async (entry: PluginEntry, body: any, allowConfirm: boolean) => {
      if (body?.blocked) return failInstall(body.error || `${entry.displayName} cannot be installed`);
      if (body?.confirmRequired && allowConfirm) {
        // Nothing is installed yet. Keep the progress dialog and the install lock while the warning is up.
        setPendingConfirm({ entry, warning: body.warning || 'This plugin is not verified by any trusted publisher.' });
        return;
      }
      if (body?.success) {
        toast.success(`${entry.displayName} installed. Restart to activate.`);
        await reloadInstalled();
        setInstallingName(null);
        return;
      }
      if (body?.nameCollision) {
        const src = body.nameCollision.existingSource;
        return failInstall(`Name conflicts with an existing ${src} plugin. Uninstall the ${src} copy or rename this plugin to install both.`);
      }
      if (body?.contentMismatch) {
        return failInstall(`Refused: signed-manifest content pin mismatch. ${body.error ?? ''}`.trim());
      }
      failInstall(body?.error || `Failed to install ${entry.displayName}`);
    },
    [toast, reloadInstalled, failInstall],
  );

  const postInstall = useCallback(
    (reg: RegistryPlugin, confirmed: boolean) =>
      ws.sendRestApi('POST', '/v1/plugins/install', {
        npmPackage: reg.npmPackage,
        installUrl: reg.installUrl,
        pluginData: reg,
        ...(confirmed ? { confirmed: true } : {}),
      }),
    [ws],
  );

  const install = useCallback(
    async (entry: PluginEntry) => {
      if (installingName || !entry.registry) return;
      setInstallingName(entry.name);
      // The backend fans out progress events keyed by the registry name; the dialog subscribes to them.
      setProgressPluginName(entry.registry.name);
      try {
        const res = await postInstall(entry.registry, false);
        await settleInstall(entry, res?.body, true);
      } catch (err) {
        failInstall(err instanceof Error && err.message ? err.message : `Failed to install ${entry.displayName}`);
      }
    },
    [installingName, postInstall, settleInstall, failInstall],
  );

  const confirmInstall = useCallback(async () => {
    if (!pendingConfirm?.entry.registry) return;
    const { entry } = pendingConfirm;
    setPendingConfirm(null);
    try {
      const res = await postInstall(entry.registry!, true);
      await settleInstall(entry, res?.body, false);
    } catch (err) {
      failInstall(err instanceof Error && err.message ? err.message : `Failed to install ${entry.displayName}`);
    }
  }, [pendingConfirm, postInstall, settleInstall, failInstall]);

  const cancelInstall = useCallback(() => {
    setPendingConfirm(null);
    setProgressPluginName(null);
    setInstallingName(null);
  }, []);

  const closeProgress = useCallback(() => setProgressPluginName(null), []);

  // ── update ─────────────────────────────────────────────────────────────────

  const update = useCallback(
    async (entry: PluginEntry, quiet = false): Promise<boolean> => {
      setUpdatingNames(prev => new Set(prev).add(entry.name));
      try {
        const res = await ws.sendRestApi('POST', '/v1/plugins/update', { name: entry.name });
        if (res?.body?.success) {
          if (!quiet) toast.success(`Updated ${entry.displayName}`);
          await reloadInstalled();
          return true;
        }
        if (!quiet) toast.error(withDetail(`Failed to update ${entry.displayName}`, res?.body?.error));
        return false;
      } catch (err) {
        if (!quiet) toast.error(withDetail(`Failed to update ${entry.displayName}`, err instanceof Error ? err.message : null));
        return false;
      } finally {
        setUpdatingNames(prev => {
          const next = new Set(prev);
          next.delete(entry.name);
          return next;
        });
      }
    },
    [ws, toast, reloadInstalled],
  );

  /** Update plugins one at a time: concurrent npm installs into the same managed root are unsafe. */
  const updateAll = useCallback(
    async (entries: PluginEntry[]) => {
      let ok = 0;
      for (const entry of entries) {
        if (await update(entry, true)) ok++;
      }
      const total = entries.length;
      if (ok === total) toast.success(`Updated ${total} plugin${total === 1 ? '' : 's'}`);
      else if (ok === 0) toast.error(`Could not update ${total === 1 ? 'the plugin' : `any of ${total} plugins`}`);
      else toast.success(`Updated ${ok} of ${total} plugins. ${total - ok} failed.`);
    },
    [update, toast],
  );

  // ── consent ────────────────────────────────────────────────────────────────

  const openConsent = useCallback(
    (entry: PluginEntry) => {
      const status = scopeStatuses[entry.name];
      if (!status) return;
      const scopes: ScopeRow[] = status.manifestScopes.map(key => {
        const meta = status.added.find(a => a.key === key)?.metadata;
        return { key, label: meta?.label ?? key, description: meta?.description ?? '', category: meta?.category };
      });
      setConsent({ entry, scopes });
    },
    [scopeStatuses],
  );

  const closeConsent = useCallback(() => setConsent(null), []);

  const approveConsent = useCallback(
    async (approved: string[]) => {
      if (!consent) return;
      setConsentBusy(true);
      try {
        const res = await ws.sendRestApi('POST', `/v1/plugins/${encodeURIComponent(consent.entry.name)}/approve-scopes`, {
          approvedScopes: approved,
        });
        if (res?.body?.success) {
          toast.success(`Permissions approved for ${consent.entry.displayName}`);
          setConsent(null);
          await reloadInstalled();
        } else {
          toast.error(`Failed to approve permissions: ${res?.body?.error ?? 'unknown error'}`);
        }
      } finally {
        setConsentBusy(false);
      }
    },
    [consent, ws, toast, reloadInstalled],
  );

  // ── enable / disable ───────────────────────────────────────────────────────

  const toggleEnabled = useCallback(
    async (entry: PluginEntry) => {
      // Enabling a plugin whose AI permissions were never approved goes through consent first.
      if (!entry.enabled && needsConsent(scopeStatuses[entry.name])) {
        openConsent(entry);
        return;
      }
      if (toggling.current.has(entry.name)) return;
      toggling.current.add(entry.name);
      const verb = entry.enabled ? 'disable' : 'enable';
      try {
        const res = await ws.sendRestApi('POST', `/v1/plugins/${encodeURIComponent(entry.name)}/${verb}`);
        if (res?.body?.success) {
          toast.success(`${entry.displayName} ${verb}d`);
          await reloadInstalled();
        } else {
          toast.error(withDetail(`Failed to ${verb} ${entry.displayName}`, res?.body?.error));
        }
      } catch (err) {
        toast.error(withDetail(`Failed to ${verb} ${entry.displayName}`, err instanceof Error ? err.message : null));
      } finally {
        toggling.current.delete(entry.name);
      }
    },
    [scopeStatuses, openConsent, ws, toast, reloadInstalled],
  );

  // ── uninstall ──────────────────────────────────────────────────────────────

  const openUninstall = useCallback(
    async (entry: PluginEntry) => {
      // Open straight away with a loading state; the footprint arrives after.
      setUninstall({ entry, footprint: null });
      let footprint: UninstallFootprint = { tables: [], fileStorageBytes: 0, npmPackage: null };
      try {
        const res = await ws.sendRestApi('GET', `/v1/plugins/${encodeURIComponent(entry.name)}/uninstall-footprint`);
        if (res?.body?.success) footprint = res.body.data as UninstallFootprint;
      } catch {
        // Keep the conservative empty footprint so the user can still proceed.
      }
      setUninstall(prev => (prev && prev.entry.name === entry.name ? { entry, footprint } : prev));
    },
    [ws],
  );

  const cancelUninstall = useCallback(() => setUninstall(null), []);

  const confirmUninstall = useCallback(
    async (preserveData: boolean) => {
      if (!uninstall) return;
      const { entry } = uninstall;
      setUninstall(null);
      try {
        const res = await ws.sendRestApi('POST', '/v1/plugins/uninstall', { name: entry.name, preserveData });
        if (res?.body?.success) {
          toast.success(`${entry.displayName} uninstalled (${preserveData ? 'data kept' : 'data deleted'})`);
          await reloadInstalled();
          onUninstalled?.(entry.name);
        } else {
          toast.error(withDetail(`Failed to uninstall ${entry.displayName}`, res?.body?.error));
        }
      } catch (err) {
        toast.error(withDetail(`Failed to uninstall ${entry.displayName}`, err instanceof Error ? err.message : null));
      }
    },
    [uninstall, ws, toast, reloadInstalled, onUninstalled],
  );

  const busyOf = useCallback(
    (name: string): PluginBusy => (installingName === name ? 'installing' : updatingNames.has(name) ? 'updating' : null),
    [installingName, updatingNames],
  );

  return {
    busyOf,
    installBlocked: installingName !== null,
    updating: updatingNames.size > 0,
    install,
    confirmInstall,
    cancelInstall,
    pendingConfirm,
    progressPluginName,
    closeProgress,
    update,
    updateAll,
    toggleEnabled,
    uninstall,
    openUninstall,
    cancelUninstall,
    confirmUninstall,
    consent,
    consentBusy,
    openConsent,
    closeConsent,
    approveConsent,
  };
}
