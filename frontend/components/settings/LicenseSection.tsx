import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { SectionCard, SectionHeading, FieldRow, Field, SaveButton, Divider } from './SettingsShared';

interface LicenseInfo {
  active: boolean;
  email?: string;
  plan?: string;
  expiresAt?: string;
  issuedAt?: string;
  subscriptionId?: string;
  licenseId?: number;
}

export function LicenseSection() {
  const ws = useWebSocket();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [info, setInfo] = useState<LicenseInfo | null>(null);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const fetchInfo = useCallback(async () => {
    const res = await ws.sendRestApi('GET', '/v1/license');
    if (res.body?.success) setInfo(res.body.data);
  }, [ws]);

  // Initial fetch + auto-fill from ?key= deep link
  useEffect(() => {
    fetchInfo();
    const key = searchParams.get('key');
    if (key) {
      setPaste(key);
      // Strip the key from the URL so a refresh doesn't keep re-filling.
      const next = new URLSearchParams(searchParams);
      next.delete('key');
      setSearchParams(next, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async () => {
    if (!paste.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await ws.sendRestApi('PUT', '/v1/license', { jws: paste.trim() });
      if (res.body?.success) {
        setInfo(res.body.data);
        setPaste('');
        toast.success('License activated');
      } else {
        setError(res.body?.error ?? 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  const onRemove = async () => {
    setConfirmRemove(false);
    const res = await ws.sendRestApi('DELETE', '/v1/license');
    if (res.body?.success) {
      setInfo({ active: false });
      toast.success('License removed');
    } else {
      toast.error('Remove failed');
    }
  };

  const formatExpiry = (iso?: string) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  return (
    <SectionCard
      id="license"
      title="License"
      description="Activate DarkRide Pro by pasting your license key."
    >
      <SectionHeading>Status</SectionHeading>
      {info?.active ? (
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderLeft: '3px solid var(--success, #22c55e)',
            borderRadius: 6,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <p style={{ margin: 0, fontWeight: 500, color: 'var(--text-primary)' }}>
            DarkRide Pro is active.
          </p>
          <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 14 }}>
            Licensed to <strong>{info.email}</strong>. Plan: {info.plan}. Expires {formatExpiry(info.expiresAt)}.
          </p>
        </div>
      ) : (
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <p style={{ margin: 0, color: 'var(--text-primary)' }}>No license active. DarkRide is running in Free mode.</p>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--text-secondary)' }}>
            Subscribe at{' '}
            <a href="https://darkride.app/pro" target="_blank" rel="noreferrer" style={{ color: 'var(--accent, #4a9eff)' }}>
              darkride.app/pro
            </a>
            {' '}to get a license key.
          </p>
        </div>
      )}

      <Divider />

      <SectionHeading>{info?.active ? 'Replace license' : 'Paste license'}</SectionHeading>
      <FieldRow>
        <Field label="License key" width={9999}>
          <textarea
            className="form-input"
            value={paste}
            onChange={(e) => { setPaste(e.target.value); setError(null); }}
            placeholder="Paste the JWS string from your purchase or renewal email…"
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
          />
        </Field>
      </FieldRow>
      {error && (
        <p style={{ color: 'var(--danger, #ef4444)', fontSize: 14, margin: '8px 0' }}>{error}</p>
      )}
      <FieldRow style={{ alignItems: 'center', gap: 12 }}>
        <SaveButton saving={saving} saved={false} onClick={onSave} disabled={!paste.trim()} />
        {info?.active && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setConfirmRemove(true)}
          >
            Remove license
          </button>
        )}
      </FieldRow>

      {confirmRemove && (
        <ConfirmDialog
          title="Remove license?"
          message="Pro features will become unavailable until a new license is activated."
          confirmLabel="Remove"
          onConfirm={onRemove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </SectionCard>
  );
}
