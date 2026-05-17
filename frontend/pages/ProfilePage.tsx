import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { useAuth } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useSlotInspectorEnabled, setSlotInspectorEnabled } from '@darkrideapp/plugin-sdk/react';

interface Session {
  id: string;
  userId: number;
  providerId: string;
  expiresAt: string;
  createdAt: string;
  userAgent: string | null;
  current: boolean;
}

interface ApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

interface OAuthGrant {
  client_id: string;
  client_name: string;
  software_id: string | null;
  scopes: string[];
  granted_at: number;
  last_used_at: number | null;
  active_tokens: number;
  active_refresh_tokens: number;
}

function formatDate(d: string | null | undefined): string {
  if (!d) return 'Never';
  return new Date(d).toLocaleString();
}

export function DeveloperToolsSection(): JSX.Element {
  const enabled = useSlotInspectorEnabled();
  return (
    <section className="card">
      <h2>Developer tools</h2>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setSlotInspectorEnabled(e.target.checked)}
        />
        Show UI slot inspector overlay
      </label>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
        Outlines every plugin UI slot on the page with its id and contribution count.
        Useful when building a plugin that contributes into another plugin&apos;s UI.
        Toggle with <kbd>Shift+Alt+S</kbd>.
      </p>
    </section>
  );
}

export function ProfilePage() {
  useDocumentTitle('Profile');
  const ws = useWebSocket();
  const toast = useToast();
  const auth = useAuth();

  // Profile form
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);

  // Sessions
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [revokeConfirm, setRevokeConfirm] = useState<Session | null>(null);

  // API keys
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>([]);
  const [keyExpiresAt, setKeyExpiresAt] = useState('');
  const [availableScopes, setAvailableScopes] = useState<Array<{ key: string; label: string; description: string; category: string }>>([]);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showNewKeyModal, setShowNewKeyModal] = useState(false);
  const [revokeKeyConfirm, setRevokeKeyConfirm] = useState<ApiKey | null>(null);

  // OAuth grants
  const [oauthGrants, setOAuthGrants] = useState<OAuthGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [revokeGrantConfirm, setRevokeGrantConfirm] = useState<OAuthGrant | null>(null);

  // Initialise form from auth user
  useEffect(() => {
    if (auth.user) {
      setDisplayName(auth.user.displayName ?? '');
      setEmail(auth.user.email ?? '');
    }
  }, [auth.user]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/profile/sessions');
      setSessions(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setSessionsLoading(false);
    }
  }, [ws]);

  const fetchApiKeys = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/profile/api-keys');
      setApiKeys(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setKeysLoading(false);
    }
  }, [ws]);

  const fetchAvailableScopes = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/auth/scopes');
      setAvailableScopes(Array.isArray(res.body?.data) ? res.body.data : []);
    } catch {
      setAvailableScopes([]);
    }
  }, [ws]);

  const fetchOAuthGrants = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/profile/oauth-grants');
      setOAuthGrants(Array.isArray(res.body) ? res.body : []);
    } catch {
      // ignore
    } finally {
      setGrantsLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      fetchSessions();
      fetchApiKeys();
      fetchOAuthGrants();
      fetchAvailableScopes();
    }
  }, [ws.connected, fetchSessions, fetchApiKeys, fetchOAuthGrants, fetchAvailableScopes]);

  const handleProfileSave = async () => {
    setProfileSaving(true);
    try {
      await ws.sendRestApi('PATCH', '/v1/profile', { displayName, email });
      toast.success('Profile updated');
      await auth.refreshAuth();
    } catch {
      toast.error('Failed to update profile');
    } finally {
      setProfileSaving(false);
    }
  };

  const handlePasswordChange = async () => {
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setPasswordSaving(true);
    try {
      await ws.sendRestApi('POST', '/v1/profile/password', { currentPassword, newPassword });
      toast.success('Password changed');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/profile/sessions/${sessionId}`);
      toast.success('Session revoked');
      fetchSessions();
    } catch {
      toast.error('Failed to revoke session');
    }
  };

  const handleCreateKey = async () => {
    if (!keyName.trim()) return;
    if (keyScopes.length === 0) {
      toast.error('Pick at least one scope');
      return;
    }
    try {
      const res = await ws.sendRestApi('POST', '/v1/profile/api-keys', {
        name: keyName.trim(),
        scopes: keyScopes,
        expiresAt: keyExpiresAt || null,
      });
      if (res.status >= 400) {
        const msg = res.body?.error ?? res.body?.data?.error ?? `HTTP ${res.status}`;
        toast.error(msg);
        return; // Keep the create modal open so the user can adjust
      }
      const plaintext = res.body?.data?.key ?? res.body?.key ?? '';
      if (!plaintext) {
        toast.error('Key created but response was missing the plaintext token');
        return;
      }
      setShowKeyModal(false);
      setKeyName('');
      setKeyScopes([]);
      setKeyExpiresAt('');
      setNewKeyValue(plaintext);
      setShowNewKeyModal(true);
      fetchApiKeys();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to create API key');
    }
  };

  const handleRevokeKey = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/profile/api-keys/${id}`);
      toast.success('API key revoked');
      fetchApiKeys();
    } catch {
      toast.error('Failed to revoke API key');
    }
  };

  const handleRevokeGrant = async (clientId: string) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/profile/oauth-grants/${clientId}`);
      toast.success('App revoked');
      fetchOAuthGrants();
    } catch {
      toast.error('Failed to revoke app');
    }
  };

  const userScopes = auth.user?.scopes ?? [];

  return (
    <div data-testid="profile-page">
      <PageHeader title="My Profile" />

      {/* Profile Info */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Profile Information</h2>
        <div className="form-group">
          <label>Username</label>
          <input
            className="form-input"
            value={auth.user?.username ?? ''}
            disabled
            style={{ opacity: 0.6 }}
          />
          <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>Username cannot be changed</small>
        </div>
        <div className="form-group">
          <label htmlFor="profile-display-name">Display Name</label>
          <input
            id="profile-display-name"
            className="form-input"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Your name"
          />
        </div>
        <div className="form-group">
          <label htmlFor="profile-email">Email</label>
          <input
            id="profile-email"
            className="form-input"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <button
          className="btn btn-primary"
          onClick={handleProfileSave}
          disabled={profileSaving}
        >
          {profileSaving ? 'Saving...' : 'Save Profile'}
        </button>
      </div>

      {/* Change Password */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Change Password</h2>
        {auth.user?.providerId !== 'core.local' && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Password changes are not available for external auth providers.
          </p>
        )}
        {auth.user?.providerId === 'core.local' && (
          <>
            <div className="form-group">
              <label htmlFor="current-password">Current Password</label>
              <input
                id="current-password"
                className="form-input"
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="Current password"
              />
            </div>
            <div className="form-group">
              <label htmlFor="new-password">New Password</label>
              <input
                id="new-password"
                className="form-input"
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="At least 12 characters"
              />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">Confirm New Password</label>
              <input
                id="confirm-password"
                className="form-input"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={handlePasswordChange}
              disabled={passwordSaving || !newPassword}
            >
              {passwordSaving ? 'Saving...' : 'Change Password'}
            </button>
          </>
        )}
      </div>

      {/* Active Sessions */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Active Sessions</h2>
        {sessionsLoading ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading...</p>
        ) : sessions.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No active sessions</p>
        ) : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>User Agent</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontSize: 12 }}>{formatDate(s.createdAt)}</td>
                    <td style={{ fontSize: 12 }}>{formatDate(s.expiresAt)}</td>
                    <td style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.userAgent ?? '—'}
                    </td>
                    <td>
                      {s.current && (
                        <span style={{
                          background: 'var(--accent)',
                          color: '#fff',
                          borderRadius: 4,
                          padding: '2px 6px',
                          fontSize: 11,
                          fontWeight: 600,
                        }}>
                          Current
                        </span>
                      )}
                    </td>
                    <td>
                      {!s.current && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setRevokeConfirm(s)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* API Keys */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>API Keys</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowKeyModal(true)}>
            Create Key
          </button>
        </div>
        {keysLoading ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading...</p>
        ) : apiKeys.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No API keys yet</p>
        ) : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Scopes</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Last Used</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map(k => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td><code style={{ fontSize: 12 }}>{k.keyPrefix}…</code></td>
                    <td style={{ fontSize: 12 }}>{k.scopes.length} scope{k.scopes.length !== 1 ? 's' : ''}</td>
                    <td style={{ fontSize: 12 }}>{formatDate(k.createdAt)}</td>
                    <td style={{ fontSize: 12 }}>{k.expiresAt ? formatDate(k.expiresAt) : 'Never'}</td>
                    <td style={{ fontSize: 12 }}>{formatDate(k.lastUsedAt)}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setRevokeKeyConfirm(k)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Authorized Apps (OAuth Grants) */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Authorized Apps</h2>
        {grantsLoading ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading...</p>
        ) : oauthGrants.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No authorized apps</p>
        ) : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Scopes</th>
                  <th>Granted</th>
                  <th>Last Used</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {oauthGrants.map(g => (
                  <tr key={g.client_id}>
                    <td>{g.client_name}</td>
                    <td style={{ fontSize: 12 }}>{g.scopes.join(', ')}</td>
                    <td style={{ fontSize: 12 }}>{new Date(g.granted_at * 1000).toLocaleDateString()}</td>
                    <td style={{ fontSize: 12 }}>{g.last_used_at ? new Date(g.last_used_at * 1000).toLocaleString() : '—'}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setRevokeGrantConfirm(g)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Developer Tools */}
      <DeveloperToolsSection />

      {/* Revoke session confirm */}
      {revokeConfirm && (
        <ConfirmDialog
          title="Revoke Session"
          message="Are you sure you want to revoke this session? That device will be signed out."
          onConfirm={() => { handleRevokeSession(revokeConfirm.id); setRevokeConfirm(null); }}
          onCancel={() => setRevokeConfirm(null)}
        />
      )}

      {/* Revoke key confirm */}
      {revokeKeyConfirm && (
        <ConfirmDialog
          title="Revoke API Key"
          message={`Are you sure you want to revoke the key "${revokeKeyConfirm.name}"? Any requests using it will immediately fail.`}
          onConfirm={() => { handleRevokeKey(revokeKeyConfirm.id); setRevokeKeyConfirm(null); }}
          onCancel={() => setRevokeKeyConfirm(null)}
        />
      )}

      {/* Revoke grant confirm */}
      {revokeGrantConfirm && (
        <ConfirmDialog
          title="Revoke App"
          message={`Are you sure you want to revoke "${revokeGrantConfirm.client_name}"? Existing sessions will stop working immediately.`}
          onConfirm={() => { handleRevokeGrant(revokeGrantConfirm.client_id); setRevokeGrantConfirm(null); }}
          onCancel={() => setRevokeGrantConfirm(null)}
        />
      )}

      {/* Create API key modal */}
      {showKeyModal && (
        <Modal
          title="Create API Key"
          onClose={() => { setShowKeyModal(false); setKeyName(''); setKeyScopes([]); setKeyExpiresAt(''); }}
          footer={
            <>
              <button className="btn" onClick={() => setShowKeyModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreateKey} disabled={!keyName.trim()}>
                Create
              </button>
            </>
          }
        >
          <div className="form-group">
            <label htmlFor="key-name">Key Name</label>
            <input
              id="key-name"
              className="form-input"
              value={keyName}
              onChange={e => setKeyName(e.target.value)}
              placeholder="My API key"
            />
          </div>
          <div className="form-group">
            <label htmlFor="key-expires">Expires At (optional)</label>
            <input
              id="key-expires"
              className="form-input"
              type="date"
              value={keyExpiresAt}
              onChange={e => setKeyExpiresAt(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Scopes</label>
            {(() => {
              // API keys can't hold wildcards. Filter them out and group the
              // remaining catalog entries by category for a readable picker.
              // availableScopes already excludes anything this user can't grant.
              const grantable = availableScopes.filter(s => !s.key.includes('*'));
              if (grantable.length === 0) {
                return (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                    No scopes available. Ask an admin to grant you specific scopes (not just a wildcard).
                  </p>
                );
              }
              const grouped: Record<string, typeof grantable> = {};
              for (const s of grantable) {
                (grouped[s.category] ||= []).push(s);
              }
              const categories = Object.keys(grouped).sort();
              return (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 360, overflowY: 'auto', padding: '4px 4px 4px 0' }}>
                    {categories.map(cat => (
                      <div key={cat}>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 4 }}>
                          {cat}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {grouped[cat].map(scope => (
                            <label
                              key={scope.key}
                              style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer', padding: '2px 0' }}
                              title={scope.description}
                            >
                              <input
                                type="checkbox"
                                checked={keyScopes.includes(scope.key)}
                                onChange={e => {
                                  if (e.target.checked) setKeyScopes(s => [...s, scope.key]);
                                  else setKeyScopes(s => s.filter(x => x !== scope.key));
                                }}
                                style={{ marginTop: 2 }}
                              />
                              <div>
                                <div style={{ fontWeight: 500 }}>{scope.label}</div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{scope.description}</div>
                                <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{scope.key}</code>
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {keyScopes.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 12, paddingTop: 8, borderTop: '1px solid var(--border-color)' }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>Selected:</span>
                      {keyScopes.map(s => (
                        <span
                          key={s}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '2px 8px', borderRadius: 12,
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            fontSize: 11, fontFamily: 'monospace',
                          }}
                        >
                          {s}
                          <button
                            type="button"
                            onClick={() => setKeyScopes(prev => prev.filter(x => x !== s))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1 }}
                            aria-label={`remove ${s}`}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </Modal>
      )}

      {/* Show new key value (once) */}
      {showNewKeyModal && (
        <Modal
          title="API Key Created"
          onClose={() => { setShowNewKeyModal(false); setNewKeyValue(''); }}
          footer={
            <button className="btn btn-primary" onClick={() => { setShowNewKeyModal(false); setNewKeyValue(''); }}>
              Done
            </button>
          }
        >
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Copy this key now — it will <strong>never be shown again</strong>.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="form-input"
              value={newKeyValue}
              readOnly
              style={{ fontFamily: 'monospace', fontSize: 13 }}
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                navigator.clipboard.writeText(newKeyValue).then(() => toast.success('Copied!'));
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
