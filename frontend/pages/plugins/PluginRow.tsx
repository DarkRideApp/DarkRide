import React from 'react';
import { AlertTriangle, Package, ShieldQuestion } from 'lucide-react';
import {
  canToggle,
  primaryAction,
  statusLabel,
  type PluginEntry,
  type PluginTab,
  type PrimaryAction,
  type ScopeStatus,
} from './catalog';
import { PluginSwitch } from './PluginSwitch';
import { PrimaryActionButton, type PluginBusy } from './PrimaryActionButton';
import { VerificationBadge } from './VerificationBadge';

export interface PluginRowProps {
  entry: PluginEntry;
  /** Which tab renders the row; decides whether an ordinary installed plugin gets a pill. */
  tab: PluginTab;
  /** What this plugin is doing right now, if anything. */
  busy: PluginBusy;
  /** Another plugin is installing; only one install may run at a time. */
  installBlocked: boolean;
  unmetDependencies: string[];
  scopeStatus?: ScopeStatus;
  /** The detail drawer is open on this plugin. */
  selected?: boolean;
  onOpen: (entry: PluginEntry) => void;
  onInstall: (entry: PluginEntry) => void;
  onUpdate: (entry: PluginEntry) => void;
  onToggleEnabled: (entry: PluginEntry) => void;
  onReviewPermissions: (entry: PluginEntry) => void;
}

function versionText(entry: PluginEntry): string | null {
  if (entry.installed) {
    if (entry.updateAvailable && entry.latestVersion) return `v${entry.version} → v${entry.latestVersion}`;
    return entry.version ? `v${entry.version}` : null;
  }
  return entry.latestVersion ? `v${entry.latestVersion}` : null;
}

export function PluginRow({
  entry,
  tab,
  busy,
  installBlocked,
  unmetDependencies,
  scopeStatus,
  selected,
  onOpen,
  onInstall,
  onUpdate,
  onToggleEnabled,
  onReviewPermissions,
}: PluginRowProps) {
  const action = primaryAction(entry, scopeStatus);
  const label = statusLabel(entry, tab);
  const version = versionText(entry);
  const isLocal = entry.installedVia === 'workspace' || entry.installedVia === 'manual';
  const errorSummary = entry.lastError ? entry.lastError.split('\n')[0] : null;

  const runAction = (a: PrimaryAction) => {
    if (a === 'install' || a === 'reinstall') onInstall(entry);
    else if (a === 'update') onUpdate(entry);
    else onReviewPermissions(entry);
  };

  // A click anywhere on the row opens the drawer, except on the controls inside it.
  const handleRowClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, [role="switch"]')) return;
    onOpen(entry);
  };

  return (
    <li
      className={`plugins-row${entry.enabled || !entry.installed ? '' : ' plugins-row--off'}${selected ? ' is-selected' : ''}`}
      data-testid="plugin-row"
      data-plugin={entry.name}
      aria-current={selected ? 'true' : undefined}
      onClick={handleRowClick}
    >
      <Package size={18} className="plugins-row-icon" aria-hidden />

      <div className="plugins-row-main">
        <div className="plugins-row-title">
          <button type="button" className="plugins-row-name" onClick={() => onOpen(entry)}>
            {entry.displayName}
          </button>
          {version && <span className="plugins-row-version">{version}</span>}
          {entry.verification && <VerificationBadge verification={entry.verification} />}
          {isLocal && <span className="plugins-tag">Local</span>}
          {label && (
            <span className={`plugins-pill plugins-pill--${entry.status}`} data-testid="plugin-status">
              {label}
            </span>
          )}
        </div>

        {entry.description && <p className="plugins-row-desc">{entry.description}</p>}

        {(entry.author || entry.category) && (
          <div className="plugins-row-meta">
            {entry.author && <span>by {entry.author}</span>}
            {entry.category && <span className="plugins-tag">{entry.category}</span>}
          </div>
        )}

        {errorSummary && (
          <p className="plugins-row-note plugins-row-note--danger">
            <AlertTriangle size={13} aria-hidden />
            <span>{errorSummary}</span>
          </p>
        )}

        {unmetDependencies.length > 0 && (
          <p className="plugins-row-note plugins-row-note--warn">
            <ShieldQuestion size={13} aria-hidden />
            <span>{`Requires ${unmetDependencies.join(', ')} (not installed)`}</span>
          </p>
        )}
      </div>

      <div className="plugins-row-actions">
        {action && (
          <PrimaryActionButton
            action={action}
            entry={entry}
            busy={busy}
            installBlocked={installBlocked}
            onRun={runAction}
          />
        )}

        {canToggle(entry) && (
          <PluginSwitch
            checked={entry.enabled}
            label={`Enable ${entry.displayName}`}
            title={entry.enabled ? 'Enabled. Click to disable.' : 'Disabled. Click to enable.'}
            onChange={() => onToggleEnabled(entry)}
          />
        )}
      </div>
    </li>
  );
}
