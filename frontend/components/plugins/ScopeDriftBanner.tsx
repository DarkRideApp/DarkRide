import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ScopeRow } from './ScopeConsentModal';

interface Props {
  pluginName: string;
  pluginVersion: string;
  added: ScopeRow[];
  removed: string[];
  onReview: () => void;
  onUninstall: () => void;
  busy?: boolean;
  /**
   * 'drift' (default): plugin's manifest grew beyond the user's prior consent.
   * 'pending': plugin declares AI scopes but has never been consented to.
   */
  variant?: 'drift' | 'pending';
}

/**
 * Inline banner shown above a plugin card when the plugin needs user
 * attention on AI scope consent — either because the manifest grew after
 * approval (drift) or because the plugin was never consented in the
 * first place (pending).
 */
export function ScopeDriftBanner({
  pluginName,
  pluginVersion,
  added,
  removed,
  onReview,
  onUninstall,
  busy,
  variant = 'drift',
}: Props): JSX.Element {
  const isPending = variant === 'pending';
  const headline = isPending
    ? `Plugin ${pluginName} v${pluginVersion} requests AI permissions.`
    : `Plugin ${pluginName} v${pluginVersion} requests additional AI scopes.`;
  return (
    <div role="alert" className="scope-drift-banner">
      <div className="scope-drift-banner-header">
        <AlertTriangle size={15} style={{ flexShrink: 0 }} />
        <strong>{headline}</strong>
      </div>
      <ul className="scope-drift-list">
        {added.map((s) => (
          <li key={s.key} className={isPending ? 'scope-drift-pending' : 'scope-drift-added'}>
            {isPending ? '' : '+ '}{s.label} <code>{s.key}</code>
          </li>
        ))}
        {!isPending && removed.map((s) => (
          <li key={s} className="scope-drift-removed">
            - <code>{s}</code>
          </li>
        ))}
      </ul>
      <div className="scope-drift-actions">
        <button
          type="button"
          className="btn btn-sm btn-warning"
          onClick={onReview}
          disabled={busy}
        >
          Review
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={onUninstall}
          disabled={busy}
        >
          Uninstall
        </button>
      </div>
    </div>
  );
}
