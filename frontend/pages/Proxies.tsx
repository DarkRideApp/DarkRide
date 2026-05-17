import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { DataTable } from '@darkrideapp/plugin-sdk/react';
import type { Column } from '@darkrideapp/plugin-sdk/react';
import type { Proxy } from '../../shared/types/api';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { SectionCard, FieldRow, Field, SaveButton } from '../components/settings/SettingsShared';

function failureClass(count: number): string {
  if (count < 3) return 'failure-low';
  if (count < 7) return 'failure-medium';
  return 'failure-high';
}

export function Proxies() {
  useDocumentTitle('Proxies');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const toast = useToast();
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editProxy, setEditProxy] = useState<Proxy | null>(null);
  const [form, setForm] = useState({ url: '', username: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Proxy | null>(null);

  // NordVPN credentials — moved here 2026-05-13 from Settings → Integrations
  // (the credentials are proxy config; they belong with proxies).
  const [nordUsername, setNordUsername] = useState('');
  const [nordPassword, setNordPassword] = useState('');
  const [nordConfigured, setNordConfigured] = useState(false);
  const [nordSaving, setNordSaving] = useState(false);
  const [nordSaved, setNordSaved] = useState(false);

  const fetchNordVpn = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/settings/list');
      const data: Array<{ key: string; value: string }> = res.body?.data || [];
      const map = new Map(data.map(s => [s.key, s.value]));
      setNordConfigured(map.has('nordvpn_username') || map.has('nordvpn_password'));
      if (map.has('nordvpn_username')) setNordUsername(map.get('nordvpn_username')!);
    } catch { /* settings fetch is best-effort */ }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) fetchNordVpn();
  }, [ws.connected, fetchNordVpn]);

  const handleSaveNordVPN = async () => {
    setNordSaving(true);
    setNordSaved(false);
    try {
      if (nordUsername) {
        await ws.sendRestApi('PUT', '/v1/settings/nordvpn_username', { value: nordUsername });
      }
      if (nordPassword) {
        await ws.sendRestApi('PUT', '/v1/settings/nordvpn_password', { value: nordPassword });
      }
      setNordConfigured(true);
      setNordPassword('');
      setNordSaved(true);
      toast.success('NordVPN settings saved');
    } catch {
      toast.error('Failed to save NordVPN settings');
    } finally {
      setNordSaving(false);
    }
  };

  const fetchProxies = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/proxy/list');
      setProxies(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) fetchProxies();
  }, [ws.connected, fetchProxies]);

  const openAdd = () => {
    setEditProxy(null);
    setForm({ url: '', username: '', password: '' });
    setShowModal(true);
  };

  const openEdit = (proxy: Proxy) => {
    setEditProxy(proxy);
    setForm({ url: proxy.url, username: proxy.username || '', password: '' });
    setShowModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editProxy) {
        await ws.sendRestApi('PUT', `/v1/proxy/update/${editProxy.id}`, {
          url: form.url,
          username: form.username || undefined,
          password: form.password || undefined,
        });
      } else {
        await ws.sendRestApi('POST', '/v1/proxy/add', {
          url: form.url,
          username: form.username || undefined,
          password: form.password || undefined,
        });
      }
      toast.success(editProxy ? 'Proxy updated' : 'Proxy added');
      setShowModal(false);
      fetchProxies();
    } catch {
      toast.error('Failed to save proxy');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/proxy/delete/${id}`);
      fetchProxies();
      toast.success('Proxy deleted');
    } catch {
      toast.error('Failed to delete proxy');
    }
  };

  const handleToggle = async (proxy: Proxy) => {
    try {
      const action = proxy.enabled ? 'disable' : 'enable';
      await ws.sendRestApi('POST', `/v1/proxy/${action}/${proxy.id}`);
      fetchProxies();
      toast.success(`Proxy ${proxy.enabled ? 'disabled' : 'enabled'}`);
    } catch {
      toast.error('Failed to toggle proxy');
    }
  };

  if (auth && !auth.hasScope('core.proxies:manage')) return <AccessDenied scope="core.proxies:manage" />;
  if (loading) return <div className="table-card"><SkeletonTable rows={5} columns={5} /></div>;

  return (
    <div data-testid="proxies-page">
      <header className="settings-page-header">
        <h1>Proxies</h1>
        <div className="settings-page-actions">
          <button className="btn btn-primary" onClick={openAdd} data-testid="add-proxy-btn">Add Proxy</button>
        </div>
      </header>

      {proxies.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">⇄</div>
          <div>No proxies configured</div>
        </div>
      ) : (
        <div className="table-card">
          <DataTable<Proxy>
            tableId="proxies"
            testId="proxies-table"
            keyField="id"
            data={proxies}
            emptyMessage="No proxies configured"
            columns={[
              {
                key: 'url',
                header: 'URL',
                sortable: true,
              },
              {
                key: 'username',
                header: 'Username',
                sortable: true,
                render: p => <>{p.username || '—'}</>,
              },
              {
                key: 'failureCount',
                header: 'Failures',
                sortable: true,
                render: p => (
                  <span className={failureClass(p.failureCount)} data-testid={`failure-count-${p.id}`}>
                    {p.failureCount}
                  </span>
                ),
              },
              {
                key: '_status',
                header: 'Status',
                render: p => (
                  <button
                    className={`btn btn-sm ${p.enabled ? 'btn-primary' : ''}`}
                    onClick={() => handleToggle(p)}
                    data-testid={`toggle-${p.id}`}
                  >
                    {p.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                ),
              },
              {
                key: '_actions',
                header: 'Actions',
                render: p => (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-sm" onClick={() => openEdit(p)} data-testid={`edit-${p.id}`}>
                      Edit
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteConfirm(p)}
                      data-testid={`delete-${p.id}`}
                    >
                      Delete
                    </button>
                  </div>
                ),
              },
            ] as Column<Proxy>[]}
          />
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <SectionCard
          id="nordvpn"
          title="NordVPN SOCKS5 proxy"
          description={
            <>
              Service credentials for SOCKS5 proxy. Get them from{' '}
              <a href="https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/" target="_blank" rel="noopener noreferrer">
                my.nordaccount.com → NordVPN → Set up manually
              </a>
              . Once saved, automations can route traffic with <code>device.setProxy('nordvpn', {'{'} country: 'us' {'}'})</code>.
            </>
          }
          status={nordConfigured ? 'configured' : 'not-configured'}
        >
          <FieldRow style={{ marginBottom: 12 }}>
            <Field label="Username" width={260}>
              <input
                className="form-input"
                value={nordUsername}
                onChange={e => setNordUsername(e.target.value)}
                placeholder="NordVPN service username"
                data-testid="nordvpn-username"
                style={{ width: '100%' }}
              />
            </Field>
            <Field label="Password" width={260}>
              <input
                className="form-input"
                type="password"
                value={nordPassword}
                onChange={e => setNordPassword(e.target.value)}
                placeholder={nordConfigured ? 'Enter new password to replace' : 'NordVPN service password'}
                data-testid="nordvpn-password"
                style={{ width: '100%' }}
              />
            </Field>
          </FieldRow>
          <SaveButton
            saving={nordSaving}
            saved={nordSaved}
            onClick={handleSaveNordVPN}
            disabled={!nordUsername && !nordPassword}
            testId="save-nordvpn-btn"
          />
        </SectionCard>
      </div>

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Proxy"
          message={`Are you sure you want to delete the proxy "${deleteConfirm.url}"? This action cannot be undone.`}
          onConfirm={() => { handleDelete(deleteConfirm.id); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {showModal && (
        <Modal
          title={editProxy ? 'Edit Proxy' : 'Add Proxy'}
          onClose={() => setShowModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving} data-testid="save-proxy-btn">
                {saving ? 'Saving...' : (editProxy ? 'Update' : 'Add')}
              </button>
            </>
          }
        >
          <div className="form-group">
            <label htmlFor="proxy-url">URL</label>
            <input
              id="proxy-url"
              className="form-input"
              value={form.url}
              onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              placeholder="http://proxy:8080"
              data-testid="proxy-url-input"
            />
          </div>
          <div className="form-group">
            <label htmlFor="proxy-username">Username</label>
            <input
              id="proxy-username"
              className="form-input"
              value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
              placeholder="Optional"
              data-testid="proxy-username-input"
            />
          </div>
          <div className="form-group">
            <label htmlFor="proxy-password">Password</label>
            <input
              id="proxy-password"
              className="form-input"
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Optional"
              data-testid="proxy-password-input"
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
