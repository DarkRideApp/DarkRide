import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { DataTable } from '@darkrideapp/plugin-sdk/react';
import type { Column } from '@darkrideapp/plugin-sdk/react';
import { ClientCertModal } from './ClientCertModal';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';

interface ClientCert {
  id: number;
  name: string;
  hostnames: string[] | string;
  enabled: number;
  createdAt: number | string;
}

export function ClientCertsSection() {
  const ws = useWebSocket();
  const auth = useAuthOptional();
  const hasScope = auth?.hasScope ?? (() => true);
  const [certs, setCerts] = useState<ClientCert[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCert, setEditingCert] = useState<ClientCert | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ClientCert | null>(null);

  const fetchCerts = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/certs');
      setCerts(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected && hasScope('core.traffic:manage')) {
      fetchCerts();
    }
  }, [ws.connected, fetchCerts]);

  useEffect(() => {
    return ws.subscribe('client-certs-changed', () => {
      fetchCerts();
    });
  }, [ws, fetchCerts]);

  const handleToggle = useCallback(async (cert: ClientCert) => {
    try {
      await ws.sendRestApi('PATCH', `/v1/certs/${cert.id}/toggle`);
      fetchCerts();
    } catch {
      // ignore
    }
  }, [ws, fetchCerts]);

  const handleDelete = useCallback(async (cert: ClientCert) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/certs/${cert.id}`);
      fetchCerts();
    } catch {
      // ignore
    }
  }, [ws, fetchCerts]);

  const getHostnamesDisplay = (cert: ClientCert): string => {
    if (Array.isArray(cert.hostnames)) {
      return cert.hostnames.length > 0 ? cert.hostnames.join(', ') : '—';
    }
    if (typeof cert.hostnames === 'string' && cert.hostnames) {
      try {
        const parsed = JSON.parse(cert.hostnames);
        if (Array.isArray(parsed)) {
          return parsed.length > 0 ? parsed.join(', ') : '—';
        }
      } catch {
        return cert.hostnames || '—';
      }
    }
    return '—';
  };

  const columns: Column<ClientCert>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (cert) => <strong>{cert.name}</strong>,
    },
    {
      key: 'hostnames',
      header: 'Hostnames',
      render: (cert) => (
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {getHostnamesDisplay(cert)}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      render: (cert) => (
        <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={Boolean(cert.enabled)}
            onChange={() => handleToggle(cert)}
          />
          <span className="toggle-slider" />
        </label>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (cert) => (
        <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-sm"
            onClick={() => {
              setEditingCert(cert);
              setModalOpen(true);
            }}
          >
            Edit
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => setDeleteConfirm(cert)}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  if (loading) {
    return <div style={{ padding: 16, color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditingCert(null);
            setModalOpen(true);
          }}
          data-testid="add-cert-btn"
        >
          Add Certificate
        </button>
      </div>

      <div className="table-card">
        <DataTable
          columns={columns}
          data={certs}
          keyField="id"
          tableId="client-certs"
          emptyMessage="No client certificates configured"
          testId="client-certs-table"
        />
      </div>

      {modalOpen && (
        <ClientCertModal
          cert={editingCert ?? undefined}
          onClose={() => {
            setModalOpen(false);
            setEditingCert(null);
          }}
          onSaved={() => {
            setModalOpen(false);
            setEditingCert(null);
            fetchCerts();
          }}
        />
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Certificate"
          message={`Are you sure you want to delete "${deleteConfirm.name}"?`}
          onConfirm={() => { handleDelete(deleteConfirm); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
