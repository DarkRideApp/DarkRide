import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit, Lock, FlaskConical, Globe, GitBranch } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';

interface PluginSource {
  id: number;
  name: string;
  type: 'registry' | 'git';
  url: string;
  authToken: string | null;
  enabled: boolean;
  isDefault: boolean;
  priority: number;
}

interface AddFormState {
  name: string;
  type: 'registry' | 'git';
  url: string;
  authToken: string;
}

interface EditFormState {
  name: string;
  url: string;
  authToken: string;
  enabled: boolean;
}

interface SourceManagerModalProps {
  onClose: () => void;
  onSourcesChanged?: () => void;
}

const EMPTY_ADD_FORM: AddFormState = { name: '', type: 'registry', url: '', authToken: '' };

function TypeBadge({ type }: { type: 'registry' | 'git' }) {
  return (
    <span className="source-type-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {type === 'registry' ? <Globe size={11} /> : <GitBranch size={11} />}
      {type === 'registry' ? 'Registry' : 'Git'}
    </span>
  );
}

export function SourceManagerModal({ onClose, onSourcesChanged }: SourceManagerModalProps) {
  const ws = useWebSocket();
  const toast = useToast();

  const [sources, setSources] = useState<PluginSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>(EMPTY_ADD_FORM);
  const [addSaving, setAddSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditFormState>({ name: '', url: '', authToken: '', enabled: true });
  const [editSaving, setEditSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const fetchSources = useCallback(async () => {
    const res = await ws.sendRestApi('GET', '/v1/plugins/sources');
    if (res?.body?.success) {
      setSources(Array.isArray(res.body.data) ? res.body.data : []);
    }
    setLoading(false);
  }, [ws]);

  useEffect(() => { fetchSources(); }, [fetchSources]);

  const handleAdd = useCallback(async () => {
    if (!addForm.name.trim() || !addForm.url.trim()) {
      toast.error('Name and URL are required');
      return;
    }
    setAddSaving(true);
    const body: Record<string, string> = { name: addForm.name, type: addForm.type, url: addForm.url };
    if (addForm.authToken.trim()) body.authToken = addForm.authToken;
    const res = await ws.sendRestApi('POST', '/v1/plugins/sources', body);
    setAddSaving(false);
    if (res?.body?.success) {
      toast.success(`Source "${addForm.name}" added`);
      setAddForm(EMPTY_ADD_FORM);
      setShowAddForm(false);
      await fetchSources();
      onSourcesChanged?.();
    } else {
      toast.error(res?.body?.error ?? 'Failed to add source');
    }
  }, [ws, toast, addForm, fetchSources, onSourcesChanged]);

  const handleStartEdit = useCallback((source: PluginSource) => {
    setEditingId(source.id);
    setEditForm({ name: source.name, url: source.url, authToken: '', enabled: source.enabled });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleSaveEdit = useCallback(async (source: PluginSource) => {
    setEditSaving(true);
    const body: Record<string, string | boolean> = {};
    if (editForm.name !== source.name) body.name = editForm.name;
    if (editForm.url !== source.url) body.url = editForm.url;
    if (editForm.authToken.trim()) body.authToken = editForm.authToken;
    if (editForm.enabled !== source.enabled) body.enabled = editForm.enabled;
    const res = await ws.sendRestApi('PUT', `/v1/plugins/sources/${source.id}`, body);
    setEditSaving(false);
    if (res?.body?.success) {
      toast.success(`Source "${editForm.name}" updated`);
      setEditingId(null);
      await fetchSources();
      onSourcesChanged?.();
    } else {
      toast.error(res?.body?.error ?? 'Failed to update source');
    }
  }, [ws, toast, editForm, fetchSources, onSourcesChanged]);

  const handleToggleEnabled = useCallback(async (source: PluginSource) => {
    const res = await ws.sendRestApi('PUT', `/v1/plugins/sources/${source.id}`, { enabled: !source.enabled });
    if (res?.body?.success) {
      await fetchSources();
      onSourcesChanged?.();
    } else {
      toast.error('Failed to update source');
    }
  }, [ws, toast, fetchSources, onSourcesChanged]);

  const handleDelete = useCallback(async (source: PluginSource) => {
    if (!confirm(`Remove source "${source.name}"? This cannot be undone.`)) return;
    const res = await ws.sendRestApi('DELETE', `/v1/plugins/sources/${source.id}`);
    if (res?.body?.success) {
      toast.success(`Source "${source.name}" removed`);
      await fetchSources();
      onSourcesChanged?.();
    } else {
      toast.error(res?.body?.error ?? 'Failed to remove source');
    }
  }, [ws, toast, fetchSources, onSourcesChanged]);

  const handleTest = useCallback(async (source: PluginSource) => {
    setTestingId(source.id);
    const res = await ws.sendRestApi('POST', `/v1/plugins/sources/${source.id}/test`);
    setTestingId(null);
    if (res?.body?.success) {
      const count = res.body.data?.plugins?.length ?? 0;
      toast.success(`Found ${count} plugin${count !== 1 ? 's' : ''} in "${source.name}"`);
    } else {
      toast.error(res?.body?.error ?? `Failed to connect to "${source.name}"`);
    }
  }, [ws, toast]);

  const urlPlaceholder = addForm.type === 'registry'
    ? 'https://plugins.example.com/plugins.json'
    : 'https://gitea.local/org/my-plugin.git';

  return (
    <Modal title="Plugin Sources" onClose={onClose} className="modal-lg">
      <div className="plugin-manager-header">
        <div />
        <button
          className="btn btn-primary"
          onClick={() => { setShowAddForm(v => !v); setAddForm(EMPTY_ADD_FORM); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Plus size={15} />
          Add Source
        </button>
      </div>

      {showAddForm && (
        <div className="source-add-form">
          <h3>Add Plugin Source</h3>
          <div className="source-form-row">
            <div style={{ flex: 1 }}>
              <label>Name</label>
              <input
                type="text"
                placeholder="My Plugin Registry"
                value={addForm.name}
                onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div style={{ width: 160 }}>
              <label>Type</label>
              <select
                value={addForm.type}
                onChange={e => setAddForm(f => ({ ...f, type: e.target.value as 'registry' | 'git', url: '' }))}
              >
                <option value="registry">Registry</option>
                <option value="git">Git Repository</option>
              </select>
            </div>
          </div>
          <div className="source-form-row">
            <div style={{ flex: 1 }}>
              <label>URL</label>
              <input
                type="text"
                placeholder={urlPlaceholder}
                value={addForm.url}
                onChange={e => setAddForm(f => ({ ...f, url: e.target.value }))}
              />
            </div>
          </div>
          <div className="source-form-row">
            <div style={{ flex: 1 }}>
              <label>Auth Token (optional — for private repos)</label>
              <input
                type="password"
                placeholder="ghp_..."
                value={addForm.authToken}
                onChange={e => setAddForm(f => ({ ...f, authToken: e.target.value }))}
              />
            </div>
          </div>
          <div className="source-form-actions">
            <button className="btn btn-secondary" onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleAdd} disabled={addSaving}>
              {addSaving ? 'Saving\u2026' : 'Save Source'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="plugin-loading">Loading sources\u2026</div>
      ) : sources.length === 0 ? (
        <div className="plugin-empty">No plugin sources configured.</div>
      ) : (
        <div className="source-list">
          {sources.map(source => (
            <div key={source.id} className="source-card">
              {editingId === source.id ? (
                /* Inline edit form */
                <>
                  <div className="source-form-row">
                    <div style={{ flex: 1 }}>
                      <label>Name</label>
                      <input
                        type="text"
                        value={editForm.name}
                        onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                      />
                    </div>
                    <div style={{ width: 120 }}>
                      <label>Enabled</label>
                      <select
                        value={editForm.enabled ? 'yes' : 'no'}
                        onChange={e => setEditForm(f => ({ ...f, enabled: e.target.value === 'yes' }))}
                      >
                        <option value="yes">Enabled</option>
                        <option value="no">Disabled</option>
                      </select>
                    </div>
                  </div>
                  <div className="source-form-row">
                    <div style={{ flex: 1 }}>
                      <label>URL</label>
                      <input
                        type="text"
                        value={editForm.url}
                        onChange={e => setEditForm(f => ({ ...f, url: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="source-form-row">
                    <div style={{ flex: 1 }}>
                      <label>Auth Token (optional — leave blank to keep existing)</label>
                      <input
                        type="password"
                        placeholder="Leave blank to keep existing token"
                        value={editForm.authToken}
                        onChange={e => setEditForm(f => ({ ...f, authToken: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="source-form-actions">
                    <button className="btn btn-secondary" onClick={handleCancelEdit}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={() => handleSaveEdit(source)} disabled={editSaving}>
                      {editSaving ? 'Saving\u2026' : 'Save Changes'}
                    </button>
                  </div>
                </>
              ) : (
                /* Read-only view */
                <>
                  <div className="source-card-header">
                    <TypeBadge type={source.type} />
                    <div className="source-card-title">{source.name}</div>
                    <div className="source-card-actions">
                      <button
                        className="btn btn-secondary"
                        title="Test connection"
                        onClick={() => handleTest(source)}
                        disabled={testingId === source.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <FlaskConical size={13} />
                        {testingId === source.id ? 'Testing\u2026' : 'Test'}
                      </button>
                      {!source.isDefault && (
                        <button
                          className="btn btn-secondary"
                          title="Edit source"
                          onClick={() => handleStartEdit(source)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                        >
                          <Edit size={13} />
                          Edit
                        </button>
                      )}
                      {!source.isDefault && (
                        <button
                          className="btn btn-danger"
                          title="Remove source"
                          onClick={() => handleDelete(source)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                        >
                          <Trash2 size={13} />
                          Remove
                        </button>
                      )}
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={source.enabled}
                          onChange={() => handleToggleEnabled(source)}
                          disabled={source.isDefault}
                        />
                        Enabled
                      </label>
                    </div>
                  </div>
                  <div className="source-card-url">{source.url}</div>
                  {source.isDefault && (
                    <div className="source-default-note">
                      <Lock size={11} />
                      Default — read only
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
