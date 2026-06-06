import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { ElapsedTimer } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { FilterBar, FilterField } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { DataTable } from '@darkrideapp/plugin-sdk/react';
import type { Column } from '@darkrideapp/plugin-sdk/react';
import type { AutomationSession } from '../../shared/types/api';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

interface DeviceInfo {
  id: string;
  name: string | null;
}

export function SessionHistory() {
  useDocumentTitle('Sessions');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const toast = useToast();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AutomationSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [triggerFilter, setTriggerFilter] = useState('');
  const [pinnedFilter, setPinnedFilter] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');
  // Hide plugin-driven (managed) sessions by default — they'd otherwise
  // drown an operator's own automations in the feed. Operator can flip it.
  const [showManaged, setShowManaged] = useState(false);
  const [managedTotal, setManagedTotal] = useState(0);
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState(''); // debounced value sent to API
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});
  const [deviceList, setDeviceList] = useState<DeviceInfo[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<AutomationSession[] | null>(null);

  const LIMIT = 50;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchText);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const fetchSessions = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('limit', String(LIMIT));
      params.set('offset', String(page * LIMIT));
      if (statusFilter) params.set('status', statusFilter);
      if (triggerFilter) params.set('triggerType', triggerFilter);
      if (pinnedFilter) params.set('pinned', pinnedFilter);
      if (deviceFilter) params.set('deviceId', deviceFilter);
      if (searchQuery) params.set('search', searchQuery);
      if (showManaged) params.set('showManaged', 'true');

      const res = await ws.sendRestApi('GET', `/v1/automation/sessions?${params}`);
      const data = res.body?.data;
      if (data?.items) {
        setSessions(data.items);
        setTotal(data.total || 0);
        setManagedTotal(typeof data.managedTotal === 'number' ? data.managedTotal : 0);
      } else {
        setSessions(data || []);
        setTotal(Array.isArray(data) ? data.length : 0);
        setManagedTotal(0);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws, page, statusFilter, triggerFilter, pinnedFilter, deviceFilter, searchQuery, showManaged]);

  const hasScope = auth?.hasScope ?? (() => true);

  useEffect(() => {
    if (ws.connected) {
      fetchSessions();
      if (hasScope('core.devices:read')) {
        ws.sendRestApi('GET', '/v1/device/list').then(res => {
          const devices: DeviceInfo[] = res.body?.data || [];
          setDeviceList(devices);
          const names: Record<string, string> = {};
          for (const d of devices) {
            if (d.name) names[d.id] = d.name;
          }
          setDeviceNames(names);
        }).catch(() => {});
      }
    }
  }, [ws.connected, fetchSessions]);

  useEffect(() => {
    return ws.subscribe('session-status', () => {
      fetchSessions();
    });
  }, [ws, fetchSessions]);

  const saveName = async (sessionId: number) => {
    try {
      await ws.sendRestApi('PATCH', `/v1/automation/session/${sessionId}`, { name: editName });
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, name: editName } : s));
    } catch {
      // ignore
    }
    setEditingId(null);
  };

  const togglePin = async (session: AutomationSession) => {
    const newPinned = !session.isPinned;
    try {
      await ws.sendRestApi('PATCH', `/v1/automation/session/${session.id}`, { isPinned: newPinned });
      setSessions(prev => prev.map(s => s.id === session.id ? { ...s, isPinned: newPinned } : s));
    } catch {
      // ignore
    }
  };

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const isZip = file.name.endsWith('.zip');
      const isHar = file.name.endsWith('.har');

      if (!isZip && !isHar) {
        toast.warning('Please select a .har or .zip file');
        return;
      }

      if (isZip) {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        await ws.sendRestApi('POST', '/v1/automation/session/import/zip', { zip: base64 });
      } else {
        const text = await file.text();
        const har = JSON.parse(text);
        await ws.sendRestApi('POST', '/v1/automation/session/import/har', { har });
      }

      fetchSessions();
      toast.success('Session imported successfully');
    } catch (err: any) {
      toast.error(`Import failed: ${err.message || 'Unknown error'}`);
    } finally {
      setImporting(false);
      // Reset file input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [ws, fetchSessions]);

  const handleBulkDelete = useCallback(async (items: AutomationSession[]) => {
    try {
      await Promise.all(
        items.map(s => ws.sendRestApi('DELETE', `/v1/automation/session/${s.id}`))
      );
      toast.success(`Deleted ${items.length} session${items.length > 1 ? 's' : ''}`);
      fetchSessions();
    } catch {
      toast.error('Failed to delete some sessions');
    }
    setBulkDeleteConfirm(null);
  }, [ws, fetchSessions, toast]);

  const totalPages = Math.ceil(total / LIMIT);

  if (auth && !auth.hasScope('core.automations:read')) return <AccessDenied scope="core.automations:read" />;
  if (loading) return <div className="table-card"><SkeletonTable rows={5} columns={6} /></div>;

  const canEdit = !auth || auth.hasScope('core.automations:edit');

  return (
    <div data-testid="session-history">
      <PageHeader
        title="Session History"
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".har,.zip"
              style={{ display: 'none' }}
              onChange={handleImport}
            />
            <button
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              data-testid="btn-import-session"
            >
              {importing ? 'Importing...' : 'Import Session'}
            </button>
          </>
        }
      />

      <FilterBar>
        <FilterField label="Search">
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              className="form-input"
              placeholder="Search by name..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              style={{ paddingLeft: 28, minWidth: 180 }}
            />
          </div>
        </FilterField>
        <FilterField label="Status">
          <select className="form-select" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0); }}>
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </FilterField>
        <FilterField label="Trigger">
          <select className="form-select" value={triggerFilter} onChange={e => { setTriggerFilter(e.target.value); setPage(0); }}>
            <option value="">All</option>
            <option value="manual">Manual</option>
            <option value="schedule">Schedule</option>
            <option value="api">API</option>
            <option value="capture">Capture</option>
          </select>
        </FilterField>
        <FilterField label="Device">
          <select className="form-select" value={deviceFilter} onChange={e => { setDeviceFilter(e.target.value); setPage(0); }}>
            <option value="">All Devices</option>
            {deviceList.map(d => (
              <option key={d.id} value={d.id}>{d.name || d.id}</option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Pinned">
          <select className="form-select" value={pinnedFilter} onChange={e => { setPinnedFilter(e.target.value); setPage(0); }}>
            <option value="">All</option>
            <option value="true">Pinned Only</option>
            <option value="false">Unpinned Only</option>
          </select>
        </FilterField>
        {(managedTotal > 0 || showManaged) && (
          <FilterField label="Managed">
            <label
              data-testid="show-managed-toggle"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
              title="Show sessions from plugin-managed automations"
            >
              <input
                type="checkbox"
                checked={showManaged}
                onChange={(e) => { setShowManaged(e.target.checked); setPage(0); }}
              />
              Show managed{managedTotal > 0 ? ` (${managedTotal})` : ''}
            </label>
          </FilterField>
        )}
      </FilterBar>

      {sessions.length === 0 ? (
        <div className="empty-state">No sessions found</div>
      ) : (
        <>
          <div className="table-card">
            <DataTable<AutomationSession>
              tableId="sessions"
              testId="sessions-table"
              keyField="id"
              data={sessions}
              onRowClick={s => navigate(`/ui/automations/session/${s.id}`)}
              emptyMessage="No sessions found"
              selectable
              onBulkDelete={canEdit ? (items => setBulkDeleteConfirm(items)) : undefined}
              bulkDeleteLabel="Delete"
              columns={[
                {
                  key: '_pin',
                  header: '',
                  render: s => (
                    <button
                      className="btn-icon"
                      onClick={e => { e.stopPropagation(); togglePin(s); }}
                      title={s.isPinned ? 'Unpin session' : 'Pin session'}
                      data-testid={`pin-btn-${s.id}`}
                      style={{ opacity: s.isPinned ? 1 : 0.3, fontSize: 16 }}
                    >
                      {'\u{1F4CC}'}
                    </button>
                  ),
                },
                {
                  key: 'name',
                  header: 'Name',
                  sortable: true,
                  render: s => editingId === s.id ? (
                    <input
                      className="form-input"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onBlur={() => saveName(s.id)}
                      onKeyDown={e => { if (e.key === 'Enter') saveName(s.id); if (e.key === 'Escape') setEditingId(null); }}
                      onClick={e => e.stopPropagation()}
                      autoFocus
                      style={{ width: '100%', padding: '2px 4px', fontSize: 13 }}
                    />
                  ) : (
                    <span
                      style={{ cursor: 'pointer' }}
                      onClick={e => { e.stopPropagation(); setEditingId(s.id); setEditName(s.name || `#${s.id}`); }}
                      title="Click to rename"
                    >
                      {s.name || `#${s.id}`}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  sortable: true,
                  hideable: true,
                  render: s => <StatusBadge status={s.status} />,
                },
                {
                  key: 'triggerType',
                  header: 'Trigger',
                  sortable: true,
                  hideable: true,
                },
                {
                  key: 'deviceId',
                  header: 'Device',
                  sortable: true,
                  hideable: true,
                  render: s => <>{s.deviceId ? (deviceNames[s.deviceId] || s.deviceId) : '\u2014'}</>,
                },
                {
                  key: 'startedAt',
                  header: 'Started',
                  sortable: true,
                  render: s => <>{new Date(s.startedAt).toLocaleString()}</>,
                },
                {
                  key: 'completedAt',
                  header: 'Duration / Completed',
                  sortable: true,
                  render: s => {
                    if (s.status === 'running' && s.startedAt) {
                      return (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
                            <ElapsedTimer since={s.startedAt} /> elapsed
                          </span>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            data-testid={`stop-session-${s.id}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const res = await ws.sendRestApi('POST', `/v1/automation/session/${s.id}/cancel`);
                                if (res?.body?.success) {
                                  toast.success('Stop requested');
                                } else if (res?.status === 404) {
                                  toast.error('No active run to stop');
                                } else {
                                  toast.error(res?.body?.error || 'Failed to stop');
                                }
                              } catch (err: any) {
                                toast.error(err?.message || 'Failed to stop');
                              }
                            }}
                          >
                            Stop
                          </button>
                        </span>
                      );
                    }
                    return <>{s.completedAt ? new Date(s.completedAt).toLocaleString() : '\u2014'}</>;
                  },
                },
              ] as Column<AutomationSession>[]}
            />
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
              <span style={{ alignSelf: 'center', fontSize: 13 }}>Page {page + 1} of {totalPages}</span>
              <button className="btn btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </>
      )}
      {bulkDeleteConfirm && (
        <ConfirmDialog
          title="Delete Sessions"
          message={`Are you sure you want to delete ${bulkDeleteConfirm.length} session${bulkDeleteConfirm.length > 1 ? 's' : ''}? This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => handleBulkDelete(bulkDeleteConfirm)}
          onCancel={() => setBulkDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
