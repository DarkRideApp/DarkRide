import React, { useState, useRef } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';

interface ClientCertModalProps {
  cert?: any;
  onClose: () => void;
  onSaved: () => void;
}

export function ClientCertModal({ cert, onClose, onSaved }: ClientCertModalProps) {
  const ws = useWebSocket();
  const isEdit = Boolean(cert);

  const [name, setName] = useState(cert?.name || '');
  const [hostnames, setHostnames] = useState(
    Array.isArray(cert?.hostnames) ? cert.hostnames.join('\n') : ''
  );
  const [certPem, setCertPem] = useState(cert?.certPem || '');
  const [keyPem, setKeyPem] = useState(cert?.keyPem || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const certFileRef = useRef<HTMLInputElement>(null);
  const keyFileRef = useRef<HTMLInputElement>(null);

  const handleFileRead = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setter((ev.target?.result as string) || '');
    };
    reader.readAsText(file);
    // Reset the input so the same file can be re-selected
    e.target.value = '';
  };

  const handleSave = async () => {
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    const hostnameArray = hostnames
      .split('\n')
      .map((h) => h.trim())
      .filter(Boolean);

    const body: Record<string, any> = {
      name: name.trim(),
      hostnames: hostnameArray,
      certPem: certPem.trim(),
      keyPem: keyPem.trim(),
    };

    setSaving(true);
    try {
      if (isEdit) {
        await ws.sendRestApi('PUT', `/v1/certs/${cert.id}`, body);
      } else {
        await ws.sendRestApi('POST', '/v1/certs', body);
      }
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Failed to save certificate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit Client Certificate' : 'Add Client Certificate'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Certificate'}
          </button>
        </>
      }
    >
      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>
      )}

      <div className="form-group">
        <label>Name *</label>
        <input
          className="form-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Client Certificate"
          data-testid="cert-name-input"
        />
      </div>

      <div className="form-group">
        <label>Hostnames</label>
        <textarea
          className="form-input"
          value={hostnames}
          onChange={(e) => setHostnames(e.target.value)}
          placeholder="api.example.com&#10;*.internal.example.com"
          rows={3}
          style={{ resize: 'vertical' }}
          data-testid="cert-hostnames-input"
        />
        <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          One hostname per line. Leave empty to apply to all hosts.
        </small>
      </div>

      <div className="form-group">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <label style={{ margin: 0 }}>Certificate PEM</label>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => certFileRef.current?.click()}
            style={{ fontSize: 11 }}
          >
            Upload File
          </button>
          <input
            ref={certFileRef}
            type="file"
            accept=".pem,.crt,.cer"
            style={{ display: 'none' }}
            onChange={handleFileRead(setCertPem)}
            data-testid="cert-pem-file-input"
          />
        </div>
        <textarea
          className="form-input"
          value={certPem}
          onChange={(e) => setCertPem(e.target.value)}
          placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
          rows={6}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
          data-testid="cert-pem-input"
        />
      </div>

      <div className="form-group">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <label style={{ margin: 0 }}>Private Key PEM</label>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => keyFileRef.current?.click()}
            style={{ fontSize: 11 }}
          >
            Upload File
          </button>
          <input
            ref={keyFileRef}
            type="file"
            accept=".pem,.key"
            style={{ display: 'none' }}
            onChange={handleFileRead(setKeyPem)}
            data-testid="cert-key-file-input"
          />
        </div>
        <textarea
          className="form-input"
          value={keyPem}
          onChange={(e) => setKeyPem(e.target.value)}
          placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
          rows={6}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
          data-testid="cert-key-input"
        />
      </div>
    </Modal>
  );
}
