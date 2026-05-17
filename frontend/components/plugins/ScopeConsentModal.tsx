import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Modal } from '@darkrideapp/plugin-sdk/react';

export interface ScopeRow {
  key: string;
  label: string;
  description: string;
  category?: string;
}

interface Props {
  pluginName: string;
  pluginVersion?: string;
  scopes: ScopeRow[];
  onApprove: (approved: string[]) => void;
  onDisable: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/**
 * Install-time consent modal for a plugin's declared AI scopes.
 * Three actions:
 *   - Allow and enable  → onApprove(allScopeKeys)
 *   - Install but leave disabled → onDisable()
 *   - Cancel → onCancel()
 */
export function ScopeConsentModal({
  pluginName,
  pluginVersion,
  scopes,
  onApprove,
  onDisable,
  onCancel,
  busy,
}: Props): JSX.Element {
  const title = pluginVersion
    ? `${pluginName} v${pluginVersion} — AI scope request`
    : `${pluginName} — AI scope request`;

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onDisable}
            disabled={busy}
          >
            Install but leave disabled
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onApprove(scopes.map((s) => s.key))}
            disabled={busy}
          >
            Allow and enable
          </button>
        </div>
      }
    >
      <div className="scope-consent-body">
        <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
          <ShieldCheck size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          Approving grants this plugin&apos;s AI integration access to these capabilities on
          your behalf.
        </p>
        <ul className="scope-consent-list">
          {scopes.map((s) => (
            <li key={s.key} className="scope-consent-row">
              <div className="scope-consent-row-header">
                <strong>{s.label}</strong>
                <code className="scope-consent-key">{s.key}</code>
                {s.category && (
                  <span className="scope-consent-category">{s.category}</span>
                )}
              </div>
              <div className="scope-consent-description">{s.description}</div>
            </li>
          ))}
        </ul>
        {scopes.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            No AI scopes declared by this plugin.
          </p>
        )}
      </div>
    </Modal>
  );
}
