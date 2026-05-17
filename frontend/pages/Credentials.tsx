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
import type { Credential } from '../../shared/types/api';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

export function Credentials() {
  useDocumentTitle('Credentials');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const toast = useToast();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [appIdInput, setAppIdInput] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [customFieldsInput, setCustomFieldsInput] = useState('');
  const [customFieldsError, setCustomFieldsError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<Credential | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchCredentials = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/credentials/list');
      setCredentials(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) fetchCredentials();
  }, [ws.connected, fetchCredentials]);

  const resetForm = () => {
    setAppIdInput('');
    setUsernameInput('');
    setPasswordInput('');
    setCustomFieldsInput('');
    setCustomFieldsError('');
    setEditingId(null);
  };

  const openAdd = () => {
    resetForm();
    setShowModal(true);
  };

  const openEdit = (cred: Credential) => {
    setEditingId(cred.id);
    setAppIdInput(cred.appId);
    setUsernameInput(cred.username);
    setPasswordInput(cred.password);
    setCustomFieldsInput(cred.customFields ? JSON.stringify(cred.customFields, null, 2) : '');
    setCustomFieldsError('');
    setShowModal(true);
  };

  const parseCustomFields = (): Record<string, string> | undefined => {
    if (!customFieldsInput.trim()) return undefined;
    try {
      const parsed = JSON.parse(customFieldsInput);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        setCustomFieldsError('Must be a JSON object');
        return undefined;
      }
      setCustomFieldsError('');
      return parsed;
    } catch {
      setCustomFieldsError('Invalid JSON');
      return undefined;
    }
  };

  const handleSave = async () => {
    if (!appIdInput.trim() || !usernameInput.trim() || !passwordInput.trim()) return;

    let customFields: Record<string, string> | undefined;
    if (customFieldsInput.trim()) {
      customFields = parseCustomFields();
      if (customFieldsError) return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await ws.sendRestApi('PUT', `/v1/credentials/update/${editingId}`, {
          appId: appIdInput.trim(),
          username: usernameInput.trim(),
          password: passwordInput.trim(),
          customFields: customFields ?? null,
        });
      } else {
        await ws.sendRestApi('POST', '/v1/credentials/add', {
          appId: appIdInput.trim(),
          username: usernameInput.trim(),
          password: passwordInput.trim(),
          customFields,
        });
      }
      toast.success('Credential saved');
      setShowModal(false);
      resetForm();
      fetchCredentials();
    } catch {
      toast.error('Failed to save credential');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/credentials/delete/${id}`);
      fetchCredentials();
      toast.success('Credential deleted');
    } catch {
      toast.error('Failed to delete credential');
    }
  };

  const customFieldsCount = (cf: Record<string, string> | null): string => {
    if (!cf) return '-';
    const count = Object.keys(cf).length;
    return count === 0 ? '-' : `${count} field${count > 1 ? 's' : ''}`;
  };

  if (auth && !auth.hasScope('core.credentials:read')) return <AccessDenied scope="core.credentials:read" />;
  if (loading) return <div className="table-card"><SkeletonTable rows={5} columns={6} /></div>;

  const canWrite = !auth || auth.hasScope('core.credentials:write');

  return (
    <div data-testid="credentials-page">
      <header className="settings-page-header">
        <h1>Credentials</h1>
        {canWrite && (
          <div className="settings-page-actions">
            <button className="btn btn-primary" onClick={openAdd} data-testid="add-credential-btn">Add Credential</button>
          </div>
        )}
      </header>

      {credentials.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔑</div>
          <div>No credentials stored</div>
        </div>
      ) : (
        <div className="table-card">
          <DataTable<Credential>
            tableId="credentials"
            testId="credentials-table"
            keyField="id"
            data={credentials}
            emptyMessage="No credentials stored"
            columns={[
              {
                key: 'appId',
                header: 'App ID',
                sortable: true,
                render: cred => <code>{cred.appId}</code>,
              },
              {
                key: 'username',
                header: 'Username',
                sortable: true,
              },
              {
                key: '_password',
                header: 'Password',
                render: () => <>{'•••••'}</>,
              },
              {
                key: '_customFields',
                header: 'Custom Fields',
                hideable: true,
                render: cred => <>{customFieldsCount(cred.customFields)}</>,
              },
              {
                key: 'lastUsedAt',
                header: 'Last Used',
                sortable: true,
                hideable: true,
                render: cred => <>{cred.lastUsedAt ? new Date(cred.lastUsedAt).toLocaleString() : 'Never'}</>,
              },
              {
                key: '_actions',
                header: 'Actions',
                render: cred => (
                  <>
                    {canWrite && (
                      <button
                        className="btn btn-sm"
                        onClick={() => openEdit(cred)}
                        style={{ marginRight: 8 }}
                        data-testid={`edit-credential-${cred.id}`}
                      >
                        Edit
                      </button>
                    )}
                    {canWrite && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setDeleteConfirm(cred)}
                        data-testid={`delete-credential-${cred.id}`}
                      >
                        Delete
                      </button>
                    )}
                  </>
                ),
              },
            ] as Column<Credential>[]}
          />
        </div>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Credential"
          message={`Are you sure you want to delete the credential for "${deleteConfirm.appId}"? This action cannot be undone.`}
          onConfirm={() => { handleDelete(deleteConfirm.id); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {showModal && (
        <Modal
          title={editingId ? 'Edit Credential' : 'Add Credential'}
          onClose={() => { setShowModal(false); resetForm(); }}
          footer={
            <>
              <button className="btn" onClick={() => { setShowModal(false); resetForm(); }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving} data-testid="save-credential-btn">
                {saving ? 'Saving...' : (editingId ? 'Save' : 'Add')}
              </button>
            </>
          }
        >
          <div className="form-group">
            <label htmlFor="cred-app-id">App ID (package name)</label>
            <input
              id="cred-app-id"
              className="form-input"
              value={appIdInput}
              onChange={e => setAppIdInput(e.target.value)}
              placeholder="com.example.app"
              data-testid="appid-input"
            />
          </div>
          <div className="form-group">
            <label htmlFor="cred-username">Username</label>
            <input
              id="cred-username"
              className="form-input"
              value={usernameInput}
              onChange={e => setUsernameInput(e.target.value)}
              placeholder="username"
              data-testid="username-input"
            />
          </div>
          <div className="form-group">
            <label htmlFor="cred-password">Password</label>
            <input
              id="cred-password"
              className="form-input"
              type="password"
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
              placeholder="password"
              data-testid="password-input"
            />
          </div>
          <div className="form-group">
            <label htmlFor="cred-custom-fields">Custom Fields (JSON, optional)</label>
            <textarea
              id="cred-custom-fields"
              className="form-input"
              value={customFieldsInput}
              onChange={e => { setCustomFieldsInput(e.target.value); setCustomFieldsError(''); }}
              placeholder='{"apiKey": "abc123"}'
              rows={3}
              data-testid="customfields-input"
            />
            {customFieldsError && (
              <small style={{ color: 'var(--danger, #e74c3c)', fontSize: 11 }}>{customFieldsError}</small>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
