import React from 'react';
import { Package, ToggleLeft, ToggleRight, Trash2, RefreshCw, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';

interface PluginCardProps {
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  enabled: boolean;
  installedVia: string;
  loaded: boolean;
  extensionPoints?: { tools: number; pages: number; settings: number };
  verificationStatus?: 'verified' | 'unsigned' | 'untrusted';
  signedByLabel?: string;
  /** Marketplace's latest version, when known. Used in the chip + Update button label. */
  latestVersion?: string;
  /** True when a newer version exists in the marketplace cache. */
  updateAvailable?: boolean;
  /** True while an update is in flight; disables the Update button + shows spinner. */
  updating?: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onUninstall: () => void;
  onUpdate?: () => void;
  /** Extra elements rendered alongside the Enable/Disable/Uninstall actions (e.g. a Settings link). */
  actions?: React.ReactNode;
}

export function PluginCard({
  name,
  version,
  description,
  author,
  enabled,
  installedVia,
  loaded,
  extensionPoints,
  verificationStatus,
  signedByLabel,
  latestVersion,
  updateAvailable,
  updating,
  onEnable,
  onDisable,
  onUninstall,
  onUpdate,
  actions,
}: PluginCardProps) {
  return (
    <div className={`plugin-card${enabled ? '' : ' plugin-card-disabled'}`}>
      <div className="plugin-card-header">
        <Package size={18} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
        <div className="plugin-card-title">
          <h3>{name}</h3>
          {version && <span className="plugin-card-version">v{version}</span>}
          {updateAvailable && latestVersion && (
            <span className="version-update-chip">v{version} → v{latestVersion}</span>
          )}
          <span className="plugin-card-badge">{installedVia}</span>
          {verificationStatus === 'verified' && (
            <span className="plugin-verified">
              <ShieldCheck size={14} />Verified by {signedByLabel ?? 'unknown'}
            </span>
          )}
          {verificationStatus === 'unsigned' && (
            <span className="plugin-unverified">
              <ShieldAlert size={14} />Unverified
            </span>
          )}
          {verificationStatus === 'untrusted' && (
            <span className="plugin-untrusted">
              <ShieldX size={14} />Unknown signer
            </span>
          )}
          {installedVia === 'managed' && !enabled && (
            <span className="plugin-card-badge plugin-card-badge--disabled">Disabled — enable to activate</span>
          )}
        </div>
        <div className="plugin-card-actions">
          {actions}
          {onUpdate && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={onUpdate}
              disabled={updating}
              title="Update plugin"
            >
              <RefreshCw size={14} className={updating ? 'spin' : undefined} />
              <span>{updating ? 'Updating…' : (latestVersion ? `Update to v${latestVersion}` : 'Update')}</span>
            </button>
          )}
          {(installedVia === 'npm' || installedVia === 'managed') && (
            <button className="btn btn-sm btn-danger" onClick={onUninstall} title="Uninstall plugin">
              <Trash2 size={14} />
            </button>
          )}
          {installedVia === 'missing' && (
            <button className="btn btn-sm btn-danger" onClick={onUninstall} title="Remove leftover state">
              <Trash2 size={14} />
              <span style={{ marginLeft: 6 }}>Remove leftover state</span>
            </button>
          )}
          <button
            className={`btn btn-sm ${enabled ? 'btn-primary' : 'btn-secondary'}`}
            onClick={enabled ? onDisable : onEnable}
            title={enabled ? 'Disable plugin' : 'Enable plugin'}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {enabled
              ? <><ToggleRight size={16} /><span>Enabled</span></>
              : <><ToggleLeft size={16} /><span>Disabled</span></>
            }
          </button>
        </div>
      </div>

      {description && <p className="plugin-card-description">{description}</p>}
      {author && <div className="plugin-card-author">by {author}</div>}

      {extensionPoints && (
        <div className="plugin-card-extensions">
          <span>{extensionPoints.tools} tools</span>
          <span>{extensionPoints.pages} pages</span>
          <span>{extensionPoints.settings} settings</span>
        </div>
      )}

      {enabled && !loaded && (
        <span className="plugin-card-warning">Restart required to load</span>
      )}
    </div>
  );
}
