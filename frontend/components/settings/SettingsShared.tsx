import React, { useState } from 'react';
import type { BlockedDomain, HiddenDomain } from '../../../shared/types/api';
import type { AiModelConfig } from '../../../shared/types/ai-models';
import type { AiProviderConfig, AiProviderType } from '../../../shared/types/ai-providers';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';

export const PROVIDER_TYPE_OPTIONS: { value: AiProviderType; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'codestral', label: 'Codestral' },
  { value: 'claude-cli', label: 'Claude CLI' },
];

export type CloudProvider = '' | 's3' | 'b2' | 'r2' | 'custom';

export const CLOUD_PROVIDER_OPTIONS: { value: CloudProvider; label: string }[] = [
  { value: '', label: 'None' },
  { value: 's3', label: 'AWS S3' },
  { value: 'b2', label: 'Backblaze B2' },
  { value: 'r2', label: 'Cloudflare R2' },
  { value: 'custom', label: 'Custom S3-compatible' },
];

export function SectionCard({ id, title, description, status, children }: {
  id: string;
  title: string;
  description?: string;
  status?: 'configured' | 'not-configured';
  children: React.ReactNode;
}) {
  return (
    <div id={`section-${id}`} className="card" style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: description ? 4 : 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          {title}
          {status && (
            <span data-testid={`${id}-status`} style={{
              fontSize: 11, fontWeight: 500, padding: '1px 8px', borderRadius: 10,
              background: status === 'configured' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)',
              color: status === 'configured' ? 'var(--status-online, #22c55e)' : 'var(--text-muted)',
            }}>
              {status === 'configured' ? 'Configured' : 'Not configured'}
            </span>
          )}
        </h3>
        {description && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

export function FieldRow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="settings-inline-row" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', ...style }}>
      {children}
    </div>
  );
}

export function Field({ label, children, width }: { label: React.ReactNode; children: React.ReactNode; width?: number }) {
  return (
    <div className="form-group" style={{ margin: 0 }}>
      <label>{label}</label>
      <div style={width ? { width } : undefined}>{children}</div>
    </div>
  );
}

export function SaveButton({ saving, saved, onClick, disabled, testId }: {
  saving: boolean;
  saved: boolean;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      className="btn btn-primary"
      onClick={onClick}
      disabled={saving || disabled}
      data-testid={testId}
    >
      {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
    </button>
  );
}

export function Divider() {
  return <div style={{ borderTop: '1px solid var(--border-color)', margin: '16px 0' }} />;
}

export function StatusBadge({ color, bg, text }: { color: string; bg: string; text: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 500, padding: '1px 6px', borderRadius: 8,
      background: bg, color,
    }}>
      {text}
    </span>
  );
}

export function ProviderTypeBadge({ type }: { type: string }) {
  const label = PROVIDER_TYPE_OPTIONS.find(o => o.value === type)?.label || type;
  return <StatusBadge color="var(--text-muted)" bg="rgba(128,128,128,0.1)" text={label} />;
}

export function ProviderStatusBadge({ provider }: { provider: AiProviderConfig }) {
  if (!provider.hasApiKey && provider.type !== 'ollama' && provider.type !== 'claude-cli') {
    return <StatusBadge color="var(--status-error, #ef4444)" bg="rgba(239,68,68,0.1)" text="No Key" />;
  }
  if (provider.type === 'claude-cli' && provider.hasApiKey) {
    return <StatusBadge color="var(--status-online, #22c55e)" bg="rgba(34,197,94,0.12)" text="Token Set" />;
  }
  return <StatusBadge color="var(--status-online, #22c55e)" bg="rgba(34,197,94,0.12)" text="Ready" />;
}

export function ModelStatusBadge({ model }: { model: AiModelConfig }) {
  if (!model.enabled) {
    return <StatusBadge color="var(--text-muted)" bg="rgba(128,128,128,0.1)" text="Disabled" />;
  }
  if (!model.providerId) {
    return <StatusBadge color="var(--status-error, #ef4444)" bg="rgba(239,68,68,0.1)" text="No Provider" />;
  }
  return <StatusBadge color="var(--status-online, #22c55e)" bg="rgba(34,197,94,0.12)" text="Active" />;
}

export function DomainList({ domains, onDelete, onAdd, testIdPrefix, emptyText }: {
  domains: (BlockedDomain | HiddenDomain)[];
  onDelete: (id: number) => void;
  onAdd: () => void;
  testIdPrefix: string;
  emptyText: string;
}) {
  const [deleteConfirm, setDeleteConfirm] = useState<(BlockedDomain | HiddenDomain) | null>(null);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button
          className="btn btn-sm btn-primary"
          onClick={onAdd}
          data-testid={`add-${testIdPrefix}-btn`}
        >
          Add Domain
        </button>
        {domains.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {domains.length} domain{domains.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {domains.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>{emptyText}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {domains.map(d => (
            <div
              key={d.id}
              data-testid={`${testIdPrefix}-row-${d.id}`}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 10px', borderRadius: 6,
                background: 'var(--bg-secondary)',
                fontSize: 13,
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{d.domain}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(d.createdAt).toLocaleDateString()}
                </span>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => setDeleteConfirm(d)}
                  data-testid={`delete-${testIdPrefix}-${d.id}`}
                  style={{ padding: '2px 8px', fontSize: 11 }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Domain"
          message={`Are you sure you want to remove "${deleteConfirm.domain}"? This action cannot be undone.`}
          confirmLabel="Remove"
          onConfirm={() => { onDelete(deleteConfirm.id); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: 'var(--text-primary)' }}>
      {children}
    </h2>
  );
}
