import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { useAuth } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';

interface AdminUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  providerId: string;
  scopes: string[] | string;
  kind: 'human' | 'core-service' | 'plugin-service';
  serviceOwner: string | null;
  enabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const CORE_SCOPES = [
  { id: 'core.devices:read', label: 'View devices' },
  { id: 'core.devices:manage', label: 'Manage devices' },
  { id: 'core.devices:shell', label: 'Device shell' },
  { id: 'core.automations:read', label: 'View automations' },
  { id: 'core.automations:edit', label: 'Edit automations' },
  { id: 'core.automations:execute', label: 'Run automations' },
  { id: 'core.traffic:read', label: 'View traffic' },
  { id: 'core.traffic:manage', label: 'Manage capture' },
  { id: 'core.apk:read', label: 'View APK analysis' },
  { id: 'core.apk:manage', label: 'Manage APK analysis' },
  { id: 'core.frida:read', label: 'View Frida scripts' },
  { id: 'core.frida:manage', label: 'Manage Frida' },
  { id: 'core.settings:read', label: 'View settings' },
  { id: 'core.settings:write', label: 'Modify settings' },
  { id: 'core.credentials:read', label: 'View credentials' },
  { id: 'core.credentials:write', label: 'Manage credentials' },
  { id: 'core.proxies:manage', label: 'Manage proxies' },
  { id: 'core.host:shell', label: 'Host shell' },
  { id: 'core.system:backup', label: 'System backup' },
  { id: 'core.plugins:manage', label: 'Manage plugins' },
  { id: 'core.users:admin', label: 'User administration' },
  { id: 'core.jobs:manage', label: 'Manage jobs' },
];

const OPERATOR_SCOPES = CORE_SCOPES.filter(s =>
  !['core.host:shell', 'core.system:backup', 'core.plugins:manage', 'core.users:admin', 'core.settings:write'].includes(s.id)
).map(s => s.id);

const VIEWER_SCOPES = CORE_SCOPES.filter(s => s.id.endsWith(':read')).map(s => s.id);

const PRESETS: Record<string, string[]> = {
  admin: ['core.admin:*'],
  operator: OPERATOR_SCOPES,
  viewer: VIEWER_SCOPES,
};

function normaliseScopes(raw: string[] | string): string[] {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function scopePresetLabel(scopes: string[]): string {
  if (scopes.includes('core.admin:*')) return 'Admin';
  const operatorMatch = OPERATOR_SCOPES.every(s => scopes.includes(s)) &&
    scopes.every(s => OPERATOR_SCOPES.includes(s));
  if (operatorMatch) return 'Operator';
  const viewerMatch = VIEWER_SCOPES.every(s => scopes.includes(s)) &&
    scopes.every(s => VIEWER_SCOPES.includes(s));
  if (viewerMatch) return 'Viewer';
  return `Custom (${scopes.length} scope${scopes.length !== 1 ? 's' : ''})`;
}

function formatDate(d: string | null | undefined): string {
  if (!d) return 'Never';
  return new Date(d).toLocaleString();
}

interface EditState {
  displayName: string;
  email: string;
  enabled: boolean;
  scopes: string[];
}

export function AdminUsersPage() {
  useDocumentTitle('User Administration');
  const ws = useWebSocket();
  const toast = useToast();
  const auth = useAuth();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showServiceAccounts, setShowServiceAccounts] = useState(false);

  // Add user modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({ username: '', displayName: '', email: '', scopes: ['core.admin:*'] });
  const [addScopePreset, setAddScopePreset] = useState<string>('admin');
  const [claimResult, setClaimResult] = useState<{ claimUrl: string; token: string } | null>(null);

  // Edit user panel
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [editState, setEditState] = useState<EditState>({ displayName: '', email: '', enabled: true, scopes: [] });
  const [editPreset, setEditPreset] = useState<string>('custom');

  // Delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState<AdminUser | null>(null);

  // Reset URL result
  const [resetResult, setResetResult] = useState<{ claimUrl: string } | null>(null);

  const fetchUsers = useCallback(async (includeServiceAccounts: boolean) => {
    try {
      const path = includeServiceAccounts ? '/v1/admin/users?kind=all' : '/v1/admin/users';
      const res = await ws.sendRestApi('GET', path);
      setUsers(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) fetchUsers(showServiceAccounts);
  }, [ws.connected, fetchUsers, showServiceAccounts]);

  const openEdit = (user: AdminUser) => {
    const scopes = normaliseScopes(user.scopes);
    setEditUser(user);
    setEditState({
      displayName: user.displayName ?? '',
      email: user.email ?? '',
      enabled: user.enabled,
      scopes,
    });
    setEditPreset(detectPreset(scopes));
  };

  function detectPreset(scopes: string[]): string {
    if (scopes.includes('core.admin:*')) return 'admin';
    const operatorMatch = OPERATOR_SCOPES.every(s => scopes.includes(s)) &&
      scopes.every(s => OPERATOR_SCOPES.includes(s));
    if (operatorMatch) return 'operator';
    const viewerMatch = VIEWER_SCOPES.every(s => scopes.includes(s)) &&
      scopes.every(s => VIEWER_SCOPES.includes(s));
    if (viewerMatch) return 'viewer';
    return 'custom';
  }

  const applyPreset = (preset: string, target: 'add' | 'edit') => {
    const scopes = PRESETS[preset] ?? [];
    if (target === 'add') {
      setAddForm(f => ({ ...f, scopes }));
      setAddScopePreset(preset);
    } else {
      setEditState(s => ({ ...s, scopes }));
      setEditPreset(preset);
    }
  };

  const handleAddUser = async () => {
    if (!addForm.username.trim()) return;
    try {
      const res = await ws.sendRestApi('POST', '/v1/admin/users', {
        username: addForm.username.trim(),
        displayName: addForm.displayName.trim() || null,
        email: addForm.email.trim() || null,
        scopes: addForm.scopes,
      });
      setShowAddModal(false);
      setAddForm({ username: '', displayName: '', email: '', scopes: ['core.admin:*'] });
      setAddScopePreset('admin');
      setClaimResult(res.body?.data ?? null);
      fetchUsers(showServiceAccounts);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create user');
    }
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;
    try {
      await ws.sendRestApi('PATCH', `/v1/admin/users/${editUser.id}`, {
        displayName: editState.displayName || null,
        email: editState.email || null,
        enabled: editState.enabled,
        scopes: editState.scopes,
      });
      toast.success('User updated');
      setEditUser(null);
      fetchUsers(showServiceAccounts);
    } catch {
      toast.error('Failed to update user');
    }
  };

  const handleDeleteUser = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/admin/users/${id}`);
      toast.success('User deleted');
      fetchUsers(showServiceAccounts);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete user');
    }
  };

  const handleResetUrl = async (userId: number) => {
    try {
      const res = await ws.sendRestApi('POST', `/v1/admin/users/${userId}/reset`);
      setResetResult(res.body?.data ?? null);
    } catch {
      toast.error('Failed to generate reset URL');
    }
  };

  const handleRevokeSessions = async (userId: number) => {
    try {
      await ws.sendRestApi('POST', `/v1/admin/users/${userId}/revoke-sessions`);
      toast.success('All sessions revoked');
    } catch {
      toast.error('Failed to revoke sessions');
    }
  };

  const handleToggleEnabled = async (user: AdminUser) => {
    try {
      await ws.sendRestApi('PATCH', `/v1/admin/users/${user.id}`, {
        enabled: !user.enabled,
      });
      toast.success(user.enabled ? 'User disabled' : 'User enabled');
      fetchUsers(showServiceAccounts);
    } catch {
      toast.error('Failed to toggle user status');
    }
  };

  const scopeCheckboxes = (
    scopes: string[],
    onChange: (scopes: string[]) => void,
    onPresetChange: (preset: string) => void,
    currentPreset: string,
  ) => (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {['admin', 'operator', 'viewer'].map(p => (
          <button
            key={p}
            className={`btn btn-sm${currentPreset === p ? ' btn-primary' : ''}`}
            onClick={() => {
              applyPreset(p, editUser ? 'edit' : 'add');
              onPresetChange(p);
            }}
            type="button"
          >
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
        {currentPreset === 'custom' && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>Custom</span>
        )}
      </div>
      {currentPreset !== 'admin' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
          {CORE_SCOPES.map(s => (
            <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={scopes.includes(s.id)}
                onChange={e => {
                  const next = e.target.checked
                    ? [...scopes, s.id]
                    : scopes.filter(x => x !== s.id);
                  onChange(next);
                  onPresetChange(detectPreset(next));
                }}
              />
              {s.label}
            </label>
          ))}
        </div>
      )}
      {currentPreset === 'admin' && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          Admin has unrestricted access to all features.
        </p>
      )}
    </div>
  );

  if (!auth.hasScope('core.users:admin')) {
    return (
      <div data-testid="admin-users-page">
        <PageHeader title="User Administration" />
        <div className="card">
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            You do not have permission to manage users.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="admin-users-page">
      <PageHeader
        title="User Administration"
        actions={
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            Add User
          </button>
        }
      />

      <div style={{ marginBottom: 12 }}>
        <label
          htmlFor="show-service-accounts"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}
        >
          <input
            id="show-service-accounts"
            type="checkbox"
            checked={showServiceAccounts}
            onChange={(e) => setShowServiceAccounts(e.target.checked)}
          />
          Show service accounts
        </label>
      </div>

      {loading ? (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading...</p>
        </div>
      ) : users.length === 0 ? (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No users found</p>
        </div>
      ) : (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Display Name</th>
                <th>Provider</th>
                <th>Scopes</th>
                <th>Last Login</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const scopes = normaliseScopes(u.scopes);
                const isSelf = auth.user?.id === u.id;
                const isServiceAccount = u.kind !== 'human';
                const serviceDisabledTitle = isServiceAccount
                  ? (u.kind === 'plugin-service'
                    ? `Uninstall the owning plugin "${u.serviceOwner}" to remove this account.`
                    : 'Core service accounts are managed in-code.')
                  : undefined;
                return (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.username}</strong>
                      {isSelf && (
                        <span style={{
                          marginLeft: 6,
                          background: 'var(--accent)',
                          color: '#fff',
                          borderRadius: 4,
                          padding: '1px 5px',
                          fontSize: 10,
                          fontWeight: 600,
                          verticalAlign: 'middle',
                        }}>
                          You
                        </span>
                      )}
                      {u.kind === 'plugin-service' && (
                        <span
                          className="badge badge-info"
                          style={{ marginLeft: 6 }}
                          aria-label={`Plugin service account owned by ${u.serviceOwner}`}
                        >
                          Plugin service
                        </span>
                      )}
                      {u.kind === 'core-service' && (
                        <span className="badge badge-info" style={{ marginLeft: 6 }}>
                          Core service
                        </span>
                      )}
                    </td>
                    <td style={{ color: u.displayName ? undefined : 'var(--text-muted)', fontSize: 13 }}>
                      {u.displayName ?? '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <code>{u.providerId}</code>
                    </td>
                    <td style={{ fontSize: 12 }}>{scopePresetLabel(scopes)}</td>
                    <td style={{ fontSize: 12 }}>{formatDate(u.lastLoginAt)}</td>
                    <td>
                      <span style={{
                        display: 'inline-block',
                        borderRadius: 4,
                        padding: '2px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        background: u.enabled ? 'var(--success-bg, #1a3a1a)' : 'var(--danger-bg, #3a1a1a)',
                        color: u.enabled ? 'var(--success, #4caf50)' : 'var(--danger, #e74c3c)',
                      }}>
                        {u.enabled ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="btn btn-sm" onClick={() => openEdit(u)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleResetUrl(u.id)}
                          disabled={isServiceAccount}
                          title={isServiceAccount ? serviceDisabledTitle : undefined}
                          aria-label={`Reset URL for ${u.username}`}
                        >
                          Reset URL
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleRevokeSessions(u.id)}
                          disabled={isServiceAccount}
                          title={isServiceAccount ? serviceDisabledTitle : undefined}
                          aria-label={`Revoke sessions for ${u.username}`}
                        >
                          Revoke Sessions
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleToggleEnabled(u)}
                          disabled={isSelf || isServiceAccount}
                          title={isSelf ? 'Cannot disable your own account' : (isServiceAccount ? serviceDisabledTitle : undefined)}
                        >
                          {u.enabled ? 'Disable' : 'Enable'}
                        </button>
                        {!isSelf && (
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => !isServiceAccount && setDeleteConfirm(u)}
                            disabled={isServiceAccount}
                            title={isServiceAccount ? serviceDisabledTitle : undefined}
                            aria-label={`Delete ${u.username}`}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add user modal */}
      {showAddModal && (
        <Modal
          title="Add User"
          onClose={() => setShowAddModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddUser} disabled={!addForm.username.trim()}>
                Create User
              </button>
            </>
          }
        >
          <div className="form-group">
            <label htmlFor="add-username">Username</label>
            <input
              id="add-username"
              className="form-input"
              value={addForm.username}
              onChange={e => setAddForm(f => ({ ...f, username: e.target.value }))}
              placeholder="username"
            />
          </div>
          <div className="form-group">
            <label htmlFor="add-display-name">Display Name (optional)</label>
            <input
              id="add-display-name"
              className="form-input"
              value={addForm.displayName}
              onChange={e => setAddForm(f => ({ ...f, displayName: e.target.value }))}
              placeholder="Display name"
            />
          </div>
          <div className="form-group">
            <label htmlFor="add-email">Email (optional)</label>
            <input
              id="add-email"
              className="form-input"
              type="email"
              value={addForm.email}
              onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
              placeholder="user@example.com"
            />
          </div>
          <div className="form-group">
            <label>Scopes</label>
            {scopeCheckboxes(
              addForm.scopes,
              (scopes) => setAddForm(f => ({ ...f, scopes })),
              setAddScopePreset,
              addScopePreset,
            )}
          </div>
        </Modal>
      )}

      {/* Edit user modal */}
      {editUser && (
        <Modal
          title={`Edit User: ${editUser.username}`}
          onClose={() => setEditUser(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditUser(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveEdit}>Save</button>
            </>
          }
        >
          <div className="form-group">
            <label htmlFor="edit-display-name">Display Name</label>
            <input
              id="edit-display-name"
              className="form-input"
              value={editState.displayName}
              onChange={e => setEditState(s => ({ ...s, displayName: e.target.value }))}
              placeholder="Display name"
            />
          </div>
          <div className="form-group">
            <label htmlFor="edit-email">Email</label>
            <input
              id="edit-email"
              className="form-input"
              type="email"
              value={editState.email}
              onChange={e => setEditState(s => ({ ...s, email: e.target.value }))}
              placeholder="user@example.com"
            />
          </div>
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={editState.enabled}
                onChange={e => setEditState(s => ({ ...s, enabled: e.target.checked }))}
                disabled={auth.user?.id === editUser.id}
              />
              Account enabled
            </label>
          </div>
          <div className="form-group">
            <label>Scopes</label>
            {scopeCheckboxes(
              editState.scopes,
              (scopes) => setEditState(s => ({ ...s, scopes })),
              setEditPreset,
              editPreset,
            )}
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <ConfirmDialog
          title="Delete User"
          message={`Are you sure you want to permanently delete "${deleteConfirm.username}"? This cannot be undone.`}
          onConfirm={() => { handleDeleteUser(deleteConfirm.id); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* Claim URL after create */}
      {claimResult && (
        <Modal
          title="User Created"
          onClose={() => setClaimResult(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setClaimResult(null)}>Done</button>
          }
        >
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Share this link with the user. It expires in 24 hours. The user will set their own password when they visit this URL.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="form-input"
              value={`${window.location.origin}${claimResult.claimUrl}`}
              readOnly
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}${claimResult.claimUrl}`)
                  .then(() => toast.success('Copied!'));
              }}
            >
              Copy
            </button>
          </div>
        </Modal>
      )}

      {/* Reset URL result */}
      {resetResult && (
        <Modal
          title="Password Reset URL"
          onClose={() => setResetResult(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setResetResult(null)}>Done</button>
          }
        >
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Share this link with the user. It expires in 24 hours and can only be used once.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="form-input"
              value={`${window.location.origin}${resetResult.claimUrl}`}
              readOnly
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}${resetResult.claimUrl}`)
                  .then(() => toast.success('Copied!'));
              }}
            >
              Copy
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
