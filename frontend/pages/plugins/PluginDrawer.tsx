import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink, Settings, Trash2, X } from 'lucide-react';
import {
  canToggle,
  canUninstall,
  needsConsent,
  primaryAction,
  statusLabel,
  unmetDependencies,
  type PluginEntry,
  type PrimaryAction,
  type ScopeStatus,
} from './catalog';
import { PluginSwitch } from './PluginSwitch';
import { PrimaryActionButton, type PluginBusy } from './PrimaryActionButton';
import { VerificationBadge } from './VerificationBadge';

export interface PluginDrawerProps {
  /** The plugin to show, or null when `?plugin=` names one that does not exist. */
  entry: PluginEntry | null;
  requestedName: string;
  /** Every entry, to tell which of this plugin's dependencies are installed. */
  entries: PluginEntry[];
  scopeStatus?: ScopeStatus;
  busy: PluginBusy;
  installBlocked: boolean;
  /** The plugin registered a page under Settings → Plugins. */
  hasSettingsPage: boolean;
  onClose: () => void;
  onInstall: (entry: PluginEntry) => void;
  onUpdate: (entry: PluginEntry) => void;
  onToggleEnabled: (entry: PluginEntry) => void;
  onReviewPermissions: (entry: PluginEntry) => void;
  onUninstall: (entry: PluginEntry) => void;
}

const INSTALLED_VIA: Record<string, string> = {
  managed: 'Marketplace',
  npm: 'npm package',
  workspace: 'Local workspace',
  manual: 'Local (manual)',
  missing: 'Files missing',
};

const TRUST_NOTE: Record<string, string> = {
  verified: 'The signature was checked against a trusted publisher key.',
  unsigned: 'Not signed by a trusted publisher. Only install it if you trust the source.',
  untrusted: 'Signed by a key this server does not trust. Only install it if you trust the source.',
  signed: 'A signature was recorded when this plugin was installed.',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `plugins-drawer-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section className="plugins-drawer-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (shown.length === 0) return null;
  return (
    <dl className="plugins-facts">
      {shown.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** Scopes to list in the permissions section, with a human label where the host knows one. */
function permissionRows(status: ScopeStatus): Array<{ key: string; label: string; description: string }> {
  if (status.state === 'approved') {
    return (status.approvedScopes ?? []).map(key => ({ key, label: key, description: '' }));
  }
  const keys = status.state === 'drift-wider' ? status.added.map(a => a.key) : status.manifestScopes;
  return keys.map(key => {
    const meta = status.added.find(a => a.key === key)?.metadata;
    return { key, label: meta?.label ?? key, description: meta?.description ?? '' };
  });
}

export function PluginDrawer({
  entry,
  requestedName,
  entries,
  scopeStatus,
  busy,
  installBlocked,
  hasSettingsPage,
  onClose,
  onInstall,
  onUpdate,
  onToggleEnabled,
  onReviewPermissions,
  onUninstall,
}: PluginDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the drawer on open, hand it back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Escape closes the drawer, unless a modal above it already took the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!entry) {
    return (
      <aside className="plugins-drawer" role="dialog" aria-label="Plugin not found">
        <header className="plugins-drawer-header">
          <h2>Plugin not found</h2>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" aria-label="Close details" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>
        <p className="plugins-drawer-empty">{`No plugin named "${requestedName}" is installed or listed in the marketplace.`}</p>
      </aside>
    );
  }

  const action = primaryAction(entry, scopeStatus);
  const label = statusLabel(entry, 'installed');
  const unmet = unmetDependencies(entry, entries);
  const showPermissions =
    !!scopeStatus &&
    scopeStatus.state !== 'no-scopes' &&
    (scopeStatus.manifestScopes.length > 0 || (scopeStatus.approvedScopes?.length ?? 0) > 0);
  const alsoUpdate = action !== null && action !== 'update' && entry.updateAvailable && entry.status !== 'missing';
  const runAction = (a: PrimaryAction) => {
    if (a === 'install' || a === 'reinstall') onInstall(entry);
    else if (a === 'update') onUpdate(entry);
    else onReviewPermissions(entry);
  };

  return (
    <aside className="plugins-drawer" role="dialog" aria-label={`${entry.displayName} details`} data-testid="plugin-drawer">
      <header className="plugins-drawer-header">
        <div className="plugins-drawer-heading">
          <h2>{entry.displayName}</h2>
          <div className="plugins-drawer-sub">
            {entry.version ? <span>v{entry.version}</span> : entry.latestVersion ? <span>v{entry.latestVersion}</span> : null}
            {label && <span className={`plugins-pill plugins-pill--${entry.status}`}>{label}</span>}
          </div>
        </div>
        <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" aria-label="Close details" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="plugins-drawer-actions">
        {action && (
          <PrimaryActionButton action={action} entry={entry} busy={busy} installBlocked={installBlocked} onRun={runAction} />
        )}
        {/* Review permissions can lead while an update is also waiting; the drawer offers both. */}
        {alsoUpdate && (
          <PrimaryActionButton action="update" entry={entry} busy={busy} installBlocked={installBlocked} onRun={runAction} />
        )}
        {canToggle(entry) && (
          <label className="plugins-drawer-toggle">
            <PluginSwitch checked={entry.enabled} label="Enabled" onChange={() => onToggleEnabled(entry)} />
            <span aria-hidden>Enabled</span>
          </label>
        )}
        {hasSettingsPage && entry.installed && (
          <Link to={`/ui/settings/plugins/${encodeURIComponent(entry.name)}/settings`} className="btn btn-sm btn-ghost">
            <Settings size={14} aria-hidden />
            Open settings
          </Link>
        )}
      </div>

      <div className="plugins-drawer-body">
        {entry.lastError && (
          <div className="plugins-drawer-error" role="alert">
            <AlertTriangle size={14} aria-hidden />
            <div>
              <strong>Auto-disabled by host.</strong>
              <pre>{entry.lastError}</pre>
            </div>
          </div>
        )}

        <Section title="About">
          {entry.description && <p className="plugins-drawer-desc">{entry.description}</p>}
          <Facts
            rows={[
              ['Author', entry.author],
              ['Category', entry.category],
              ['License', entry.license],
              ['Source', entry.source],
              ['Installed via', entry.installedVia ? (INSTALLED_VIA[entry.installedVia] ?? entry.installedVia) : null],
              ['Package', entry.npmPackage ? <code>{entry.npmPackage}</code> : null],
            ]}
          />
          {entry.repoUrl && (
            <a className="plugins-drawer-link" href={entry.repoUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} aria-hidden />
              Repository
            </a>
          )}
        </Section>

        {entry.verification && (
          <Section title="Trust">
            <VerificationBadge verification={entry.verification} showText />
            <p className="plugins-drawer-note">{TRUST_NOTE[entry.verification.status]}</p>
          </Section>
        )}

        {entry.dependencies.length > 0 && (
          <Section title="Requires">
            <ul className="plugins-drawer-list">
              {entry.dependencies.map(d => (
                <li key={d} className={unmet.includes(d) ? 'is-unmet' : undefined}>
                  {unmet.includes(d) ? `${d} (not installed)` : d}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {entry.installed && entry.status !== 'missing' && (
          <Section title="Provides">
            {entry.provides ? (
              <Facts
                rows={[
                  ['Tools', String(entry.provides.tools)],
                  ['Pages', String(entry.provides.pages)],
                  ['Settings', String(entry.provides.settings)],
                ]}
              />
            ) : (
              <p className="plugins-drawer-note">Counts appear once the plugin is loaded.</p>
            )}
          </Section>
        )}

        {showPermissions && scopeStatus && (
          <Section title="AI permissions">
            {needsConsent(scopeStatus) && (
              <p className="plugins-drawer-note">
                {scopeStatus.state === 'drift-wider'
                  ? 'This version asks for permissions you have not approved.'
                  : 'These permissions are waiting for your approval.'}
              </p>
            )}
            <ul className="plugins-drawer-list">
              {permissionRows(scopeStatus).map(row => (
                <li key={row.key}>
                  {row.label !== row.key && <span>{row.label}</span>}
                  <code>{row.key}</code>
                  {row.description && <small>{row.description}</small>}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      {canUninstall(entry) && (
        <footer className="plugins-drawer-footer">
          <button type="button" className="btn btn-sm btn-danger" onClick={() => onUninstall(entry)}>
            <Trash2 size={14} aria-hidden />
            {entry.status === 'missing' ? 'Remove leftover state' : 'Uninstall'}
          </button>
        </footer>
      )}
    </aside>
  );
}
