import React from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import type { PluginEntry, PrimaryAction } from './catalog';

export type PluginBusy = 'installing' | 'updating' | null;

/** Whether `busy` is work this action started. A running update must not freeze an unrelated Review button. */
function isWorking(action: PrimaryAction, busy: PluginBusy): boolean {
  if (busy === 'installing') return action === 'install' || action === 'reinstall';
  if (busy === 'updating') return action === 'update';
  return false;
}

function labelOf(action: PrimaryAction, entry: PluginEntry, busy: PluginBusy): string {
  const working = isWorking(action, busy);
  switch (action) {
    case 'install':
      return working ? 'Installing…' : 'Install';
    case 'reinstall':
      return working ? 'Reinstalling…' : 'Reinstall';
    case 'review':
      return 'Review permissions';
    case 'update':
      if (working) return 'Updating…';
      return entry.latestVersion ? `Update to v${entry.latestVersion}` : 'Update';
  }
}

/** The single lead action for a plugin, shared by the list row and the detail drawer. */
export function PrimaryActionButton({
  action,
  entry,
  busy,
  installBlocked,
  onRun,
}: {
  action: PrimaryAction;
  entry: PluginEntry;
  busy: PluginBusy;
  /** Another plugin is installing; only one install may run at a time. */
  installBlocked: boolean;
  onRun: (action: PrimaryAction) => void;
}) {
  const working = isWorking(action, busy);
  const isInstall = action === 'install' || action === 'reinstall';
  const tone = isInstall ? 'btn-primary' : action === 'review' ? 'btn-warning' : 'btn-secondary';
  return (
    <button
      type="button"
      className={`btn btn-sm ${tone}`}
      onClick={() => onRun(action)}
      disabled={working || (isInstall && installBlocked)}
      aria-busy={working || undefined}
    >
      {working ? (
        <LoadingSpinner />
      ) : action === 'update' ? (
        <RefreshCw size={14} aria-hidden />
      ) : isInstall ? (
        <Download size={14} aria-hidden />
      ) : null}
      <span>{labelOf(action, entry, busy)}</span>
    </button>
  );
}
