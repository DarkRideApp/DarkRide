import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { FilterBar, FilterField } from '@darkrideapp/plugin-sdk/react';
import { EmptyState } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { DataTable } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import type { Column } from '@darkrideapp/plugin-sdk/react';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';

interface EndpointRow {
  id: number;
  method: string;
  hostname: string;
  pathPattern: string;
  firstSeen: string;
  lastSeen: string;
  requestCount: number;
  sampleResponseStatus: number | null;
  groupId: number | null;
  groupName: string | null;
}

interface EndpointDetail extends EndpointRow {
  sampleRequestHeaders: string | null;
  sampleRequestBody: string | null;
  sampleResponseHeaders: string | null;
  sampleResponseBody: string | null;
}

interface GroupPattern {
  id: number;
  groupId: number;
  pattern: string;
  patternType: string;
  createdAt: string | null;
}

interface EndpointGroup {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  endpointCount: number;
  patterns: GroupPattern[];
}

interface SessionLink {
  id: number;
  name: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  deviceId: string | null;
}

function methodColor(method: string): string {
  switch (method) {
    case 'GET': return 'var(--accent)';
    case 'POST': return 'var(--success)';
    case 'PUT': return 'var(--warning)';
    case 'PATCH': return '#50e3c2';
    case 'DELETE': return 'var(--danger)';
    case 'GQL_QUERY': return '#e535ab';
    case 'GQL_MUTATION': return '#f97316';
    case 'GQL_SUBSCRIPTION': return '#e535ab';
    case 'PROTO': return '#06b6d4';
    case 'GRPC': return '#06b6d4';
    default: return 'var(--text-muted)';
  }
}

function formatDate(val: string | number | null): string {
  if (!val) return '-';
  const d = typeof val === 'number' ? new Date(val) : new Date(val);
  return d.toLocaleString();
}

function tryPrettyJson(str: string | null): string {
  if (!str) return '';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

export function ApiCatalogue() {
  useDocumentTitle('API Catalogue');
  const ws = useWebSocket();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // view: '' = group browser (default), 'ungrouped' = endpoints filtered to ungrouped, 'manage' = groups management
  const view = searchParams.get('view') || '';

  const setView = (v: string) => {
    if (v) {
      setSearchParams({ view: v });
    } else {
      setSearchParams({});
    }
  };

  // Endpoints state
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [sessions, setSessions] = useState<SessionLink[]>([]);

  // Filters
  const [filterMethod, setFilterMethod] = useState('');
  const [filterHostname, setFilterHostname] = useState('');
  const [filterPath, setFilterPath] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterGroupId, setFilterGroupId] = useState('');
  const [filterBodySearch, setFilterBodySearch] = useState('');

  // Groups state
  const [groups, setGroups] = useState<EndpointGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [deleteEndpointConfirmId, setDeleteEndpointConfirmId] = useState<number | null>(null);
  const [deletePatternConfirm, setDeletePatternConfirm] = useState<{ groupId: number; patternId: number; pattern: string } | null>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [deleteGroupConfirmId, setDeleteGroupConfirmId] = useState<number | null>(null);
  const [editingGroup, setEditingGroup] = useState<EndpointGroup | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);
  const [newPattern, setNewPattern] = useState('');
  const [newPatternType, setNewPatternType] = useState<'exact' | 'wildcard' | 'regex'>('exact');

  // Group browser search
  const [groupSearch, setGroupSearch] = useState('');

  // Ungrouped count
  const [ungroupedCount, setUngroupedCount] = useState(0);

  const LIMIT = 50;

  const fetchEndpoints = useCallback(async () => {
    if (!ws.connected) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(LIMIT));
      params.set('offset', String(page * LIMIT));
      if (filterMethod) params.set('method', filterMethod);
      if (filterHostname) params.set('hostname', filterHostname);
      if (filterPath) params.set('pathPattern', filterPath);
      if (filterStatus) params.set('statusCode', filterStatus);
      if (filterGroupId) params.set('groupId', filterGroupId);
      if (filterBodySearch) params.set('bodySearch', filterBodySearch);

      const res = await ws.sendRestApi('GET', `/v1/api-catalogue/endpoints?${params}`);
      const data = res.body?.data;
      if (data) {
        setEndpoints(data.items || []);
        setTotal(data.total || 0);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [ws, page, filterMethod, filterHostname, filterPath, filterStatus, filterGroupId, filterBodySearch]);

  const fetchGroups = useCallback(async () => {
    if (!ws.connected) return;
    setGroupsLoading(true);
    try {
      const res = await ws.sendRestApi('GET', '/v1/api-catalogue/groups');
      setGroups(res.body?.data || []);
    } catch { /* ignore */ } finally {
      setGroupsLoading(false);
    }
  }, [ws]);

  const fetchUngroupedCount = useCallback(async () => {
    if (!ws.connected) return;
    try {
      const res = await ws.sendRestApi('GET', '/v1/api-catalogue/endpoints?groupId=ungrouped&limit=1');
      const data = res.body?.data;
      if (data) {
        setUngroupedCount(data.total || 0);
      }
    } catch { /* ignore */ }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      fetchEndpoints();
      fetchGroups();
      fetchUngroupedCount();
    }
  }, [ws.connected, fetchEndpoints, fetchGroups, fetchUngroupedCount]);

  // When switching to ungrouped view, set the group filter
  useEffect(() => {
    if (view === 'ungrouped') {
      setFilterGroupId('ungrouped');
      setPage(0);
    }
  }, [view]);

  const handleExpand = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setSessions([]);
    try {
      const [detailRes, sessionsRes] = await Promise.all([
        ws.sendRestApi('GET', `/v1/api-catalogue/endpoints/${id}`),
        ws.sendRestApi('GET', `/v1/api-catalogue/endpoints/${id}/sessions`),
      ]);
      setDetail(detailRes.body?.data || null);
      setSessions(sessionsRes.body?.data || []);
    } catch { /* ignore */ }
  };

  const handleDeleteEndpoint = async (id: number) => {
    await ws.sendRestApi('DELETE', `/v1/api-catalogue/endpoints/${id}`);
    setExpandedId(null);
    fetchEndpoints();
  };

  const handleClearAll = async () => {
    await ws.sendRestApi('DELETE', '/v1/api-catalogue/endpoints');
    fetchEndpoints();
    fetchUngroupedCount();
  };

  const handleAssignGroup = async (endpointId: number, groupId: number | null) => {
    await ws.sendRestApi('PATCH', `/v1/api-catalogue/endpoints/${endpointId}`, { groupId });
    fetchEndpoints();
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    await ws.sendRestApi('POST', '/v1/api-catalogue/groups', {
      name: newGroupName.trim(),
      description: newGroupDesc.trim() || undefined,
    });
    setNewGroupName('');
    setNewGroupDesc('');
    fetchGroups();
  };

  const handleUpdateGroup = async () => {
    if (!editingGroup) return;
    await ws.sendRestApi('PUT', `/v1/api-catalogue/groups/${editingGroup.id}`, {
      name: editingGroup.name,
      description: editingGroup.description,
    });
    setEditingGroup(null);
    fetchGroups();
  };

  const handleDeleteGroup = async (id: number) => {
    await ws.sendRestApi('DELETE', `/v1/api-catalogue/groups/${id}`);
    setDeleteGroupConfirmId(null);
    fetchGroups();
    fetchEndpoints();
    fetchUngroupedCount();
  };

  const handleGroupClick = (groupId: number) => {
    setFilterGroupId(String(groupId));
    setPage(0);
    setView('ungrouped');
  };

  const handleAddPattern = async (groupId: number) => {
    if (!newPattern.trim()) return;
    await ws.sendRestApi('POST', `/v1/api-catalogue/groups/${groupId}/patterns`, {
      pattern: newPattern.trim(),
      patternType: newPatternType,
    });
    setNewPattern('');
    setNewPatternType('exact');
    fetchGroups();
  };

  const handleRemovePattern = async (groupId: number, patternId: number) => {
    await ws.sendRestApi('DELETE', `/v1/api-catalogue/groups/${groupId}/patterns/${patternId}`);
    fetchGroups();
  };

  const handleApplyPatterns = async (groupId: number) => {
    const res = await ws.sendRestApi('POST', `/v1/api-catalogue/groups/${groupId}/apply-patterns`);
    const count = res.body?.count || 0;
    if (count > 0) {
      fetchEndpoints();
      fetchGroups();
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  // Find active group name for the banner
  const activeGroup = filterGroupId && filterGroupId !== 'ungrouped'
    ? groups.find(g => g.id === parseInt(filterGroupId, 10))
    : null;

  const clearFilters = () => {
    setFilterMethod('');
    setFilterHostname('');
    setFilterPath('');
    setFilterStatus('');
    setFilterGroupId(view === 'ungrouped' ? 'ungrouped' : '');
    setFilterBodySearch('');
    setPage(0);
  };

  const totalEndpoints = groups.reduce((sum, g) => sum + g.endpointCount, 0) + ungroupedCount;

  const { sorted: sortedGroups, sortKey: groupSortKey, sortDir: groupSortDir, onSort: onGroupSort } = useSortableTable(groups, 'name');

  const filteredGroups = groupSearch.trim()
    ? sortedGroups.filter(g => g.name.toLowerCase().includes(groupSearch.trim().toLowerCase()))
    : sortedGroups;

  // ── Header actions (shared across views) ──────────────────────────────────
  const headerActions = (
    <>
      {ungroupedCount > 0 && (
        <button
          className="btn btn-sm"
          onClick={() => { setFilterGroupId('ungrouped'); setPage(0); setView('ungrouped'); }}
          data-testid="ungrouped-btn"
        >
          Ungrouped: {ungroupedCount}
        </button>
      )}
      <button
        className="btn btn-sm"
        onClick={() => setView('manage')}
        data-testid="manage-groups-btn"
      >
        Manage Groups
      </button>
      {total > 0 && (
        <button className="btn btn-sm btn-danger" onClick={() => setShowClearAllConfirm(true)}>Clear All</button>
      )}
    </>
  );

  // ── Endpoints table (used in ungrouped view) ──────────────────────────────
  const renderEndpointsTable = () => (
    <>
      {activeGroup && (
        <div style={{ padding: '8px 12px', marginBottom: 8, background: 'var(--bg-secondary)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Showing endpoints for group: <strong>{activeGroup.name}</strong></span>
          <button className="btn btn-sm" onClick={() => { setFilterGroupId(''); setPage(0); }}>Clear</button>
        </div>
      )}

      <FilterBar>
        <FilterField label="Method">
          <select value={filterMethod} onChange={e => { setFilterMethod(e.target.value); setPage(0); }} className="form-select">
            <option value="">All</option>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </FilterField>
        <FilterField label="Hostname">
          <input value={filterHostname} onChange={e => { setFilterHostname(e.target.value); setPage(0); }} placeholder="api.example.com" className="form-input" />
        </FilterField>
        <FilterField label="Path">
          <input value={filterPath} onChange={e => { setFilterPath(e.target.value); setPage(0); }} placeholder="/v1/users" className="form-input" />
        </FilterField>
        <FilterField label="Status">
          <input value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(0); }} placeholder="200" className="form-input" style={{ width: 80 }} />
        </FilterField>
        <FilterField label="Group">
          <select value={filterGroupId} onChange={e => { setFilterGroupId(e.target.value); setPage(0); }} className="form-select">
            <option value="">All</option>
            <option value="ungrouped">Ungrouped</option>
            {groups.map(g => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Body Search">
          <input value={filterBodySearch} onChange={e => { setFilterBodySearch(e.target.value); setPage(0); }} placeholder="keyword" className="form-input" />
        </FilterField>
        {(filterMethod || filterHostname || filterPath || filterStatus || (filterGroupId && filterGroupId !== 'ungrouped') || filterBodySearch) && (
          <FilterField label=" ">
            <button className="btn btn-sm" onClick={clearFilters}>Clear Filters</button>
          </FilterField>
        )}
      </FilterBar>

      {loading ? (
        <LoadingSpinner large center />
      ) : endpoints.length === 0 ? (
        <EmptyState
          icon="📡"
          message="No endpoints catalogued"
          description="Capture traffic from a device to automatically populate the API catalogue."
        />
      ) : (
        <>
          <div className="table-card">
            <DataTable<EndpointRow>
              tableId="api-catalogue"
              keyField="id"
              data={endpoints}
              onRowClick={ep => handleExpand(ep.id)}
              emptyMessage="No endpoints catalogued"
              columns={[
                {
                  key: 'method',
                  header: 'Method',
                  sortable: true,
                  render: ep => (
                    <span style={{ color: methodColor(ep.method), fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                      {ep.method}
                    </span>
                  ),
                },
                {
                  key: 'pathPattern',
                  header: 'Path Pattern',
                  sortable: true,
                  render: ep => (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{ep.pathPattern}</span>
                  ),
                },
                {
                  key: 'hostname',
                  header: 'Hostname',
                  sortable: true,
                  render: ep => <span style={{ fontSize: 13 }}>{ep.hostname}</span>,
                },
                {
                  key: 'requestCount',
                  header: 'Count',
                  sortable: true,
                  render: ep => <span style={{ textAlign: 'right', display: 'block' }}>{ep.requestCount}</span>,
                },
                {
                  key: 'sampleResponseStatus',
                  header: 'Status',
                  sortable: true,
                  hideable: true,
                  render: ep => ep.sampleResponseStatus ? (
                    <span className={`badge badge-sm ${ep.sampleResponseStatus < 300 ? 'badge-online' : ep.sampleResponseStatus < 400 ? 'badge-warning' : 'badge-failed'}`}>
                      {ep.sampleResponseStatus}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  ),
                },
                {
                  key: 'lastSeen',
                  header: 'Last Seen',
                  sortable: true,
                  hideable: true,
                  render: ep => (
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatDate(ep.lastSeen)}</span>
                  ),
                },
                {
                  key: 'groupName',
                  header: 'Group',
                  sortable: true,
                  hideable: true,
                  render: ep => ep.groupName ? (
                    <span className="badge badge-sm">{ep.groupName}</span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  ),
                },
              ] as Column<EndpointRow>[]}
            />
          </div>

          {/* Expanded endpoint detail panel */}
          {expandedId !== null && (() => {
            const ep = endpoints.find(e => e.id === expandedId);
            if (!ep) return null;
            return (
              <div className="traffic-detail" style={{ marginTop: 8 }}>
                {/* Group assignment */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Group</label>
                    <select
                      value={ep.groupId ?? ''}
                      onChange={e => handleAssignGroup(ep.id, e.target.value ? parseInt(e.target.value, 10) : null)}
                      className="form-select"
                    >
                      <option value="">None</option>
                      {groups.map(g => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
                    </select>
                  </div>
                  <button className="btn btn-sm" onClick={() => setExpandedId(null)} style={{ marginLeft: 'auto' }}>Close</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setDeleteEndpointConfirmId(ep.id)}>Delete</button>
                </div>

                {/* Sample request/response */}
                {detail ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div>
                      <h4>Request Headers</h4>
                      <pre>{tryPrettyJson(detail.sampleRequestHeaders) || '(none)'}</pre>
                      <h4>Request Body</h4>
                      <pre>{tryPrettyJson(detail.sampleRequestBody) || '(none)'}</pre>
                    </div>
                    <div>
                      <h4>Response Headers</h4>
                      <pre>{tryPrettyJson(detail.sampleResponseHeaders) || '(none)'}</pre>
                      <h4>Response Body</h4>
                      <pre>{tryPrettyJson(detail.sampleResponseBody) || '(none)'}</pre>
                    </div>
                  </div>
                ) : (
                  <LoadingSpinner />
                )}

                {/* Sessions */}
                {sessions.length > 0 && (
                  <>
                    <h4>Sessions ({sessions.length})</h4>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {sessions.slice(0, 5).map(s => (
                        <span key={s.id} className="badge badge-sm">
                          #{s.id} {s.name || s.status} ({s.deviceId || 'unknown'})
                        </span>
                      ))}
                      {sessions.length > 5 && <span className="badge badge-sm" style={{ opacity: 0.5 }}>+{sessions.length - 5} more</span>}
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {totalPages > 1 && (
            <div className="pagination">
              <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
              <span className="page-info">Page {page + 1} of {totalPages}</span>
              <button className="btn btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </>
  );

  // ── Groups management UI ───────────────────────────────────────────────────
  const renderManageGroups = () => (
    <div>
      {/* Create group form */}
      <FilterBar>
        <FilterField label="Name">
          <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Group name" className="form-input" />
        </FilterField>
        <FilterField label="Description">
          <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} placeholder="Optional description" className="form-input" />
        </FilterField>
        <FilterField label=" ">
          <button className="btn btn-primary" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>Create Group</button>
        </FilterField>
      </FilterBar>

      {groupsLoading ? (
        <LoadingSpinner large center />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="📂"
          message="No groups created"
          description="Groups help organise endpoints by service or domain."
        />
      ) : (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="Name" sortKey="name" currentSort={groupSortKey} dir={groupSortDir} onSort={onGroupSort} />
                <SortableHeader label="Description" sortKey="description" currentSort={groupSortKey} dir={groupSortDir} onSort={onGroupSort} />
                <SortableHeader label="Endpoints" sortKey="endpointCount" currentSort={groupSortKey} dir={groupSortDir} onSort={onGroupSort} style={{ width: 100 }} />
                <th style={{ width: 100 }}>Patterns</th>
                <th style={{ width: 260 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map(g => (
                <React.Fragment key={g.id}>
                  <tr>
                    <td>
                      {editingGroup?.id === g.id ? (
                        <input value={editingGroup.name} onChange={e => setEditingGroup({ ...editingGroup, name: e.target.value })} className="form-input" />
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <a
                            href={`/ui/api-catalogue/groups/${g.id}/explorer`}
                            data-testid={`group-link-${g.id}`}
                            onClick={e => { e.preventDefault(); navigate(`/ui/api-catalogue/groups/${g.id}/explorer`); }}
                            style={{ fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}
                          >
                            {g.name}
                          </a>
                          <button
                            className="btn btn-sm"
                            title="Filter endpoints by this group"
                            onClick={() => handleGroupClick(g.id)}
                            style={{ fontSize: 10, padding: '1px 6px', opacity: 0.7 }}
                          >
                            Filter
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {editingGroup?.id === g.id ? (
                        <input value={editingGroup.description || ''} onChange={e => setEditingGroup({ ...editingGroup, description: e.target.value })} className="form-input" />
                      ) : (
                        g.description || <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="badge badge-sm">{g.endpointCount}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="badge badge-sm">{g.patterns?.length || 0}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {editingGroup?.id === g.id ? (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={handleUpdateGroup}>Save</button>
                            <button className="btn btn-sm" onClick={() => setEditingGroup(null)}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => setEditingGroup(g)}>Edit</button>
                            <button className="btn btn-sm" onClick={() => setExpandedGroupId(expandedGroupId === g.id ? null : g.id)}>
                              {expandedGroupId === g.id ? 'Hide Patterns' : 'Patterns'}
                            </button>
                            <button className="btn btn-sm btn-danger" onClick={() => setDeleteGroupConfirmId(g.id)}>Delete</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedGroupId === g.id && (
                    <tr>
                      <td colSpan={5} style={{ padding: 0 }}>
                        <div className="traffic-detail">
                          <h4>Hostname Patterns</h4>

                          {/* Existing patterns */}
                          {g.patterns && g.patterns.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                              {g.patterns.map(p => (
                                <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                  <span className="badge badge-sm">{p.patternType}</span>
                                  <code style={{ fontSize: 13 }}>{p.pattern}</code>
                                  <button
                                    className="btn btn-sm btn-danger"
                                    onClick={() => setDeletePatternConfirm({ groupId: g.id, patternId: p.id, pattern: p.pattern })}
                                    style={{ marginLeft: 'auto', padding: '2px 8px' }}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p style={{ color: 'var(--text-muted)', marginBottom: 12 }}>No patterns configured.</p>
                          )}

                          {/* Add pattern form */}
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              value={newPattern}
                              onChange={e => setNewPattern(e.target.value)}
                              placeholder="e.g. *.example.com"
                              className="form-input"
                              style={{ flex: 1 }}
                            />
                            <select
                              value={newPatternType}
                              onChange={e => setNewPatternType(e.target.value as any)}
                              className="form-select"
                              style={{ width: 110 }}
                            >
                              <option value="exact">exact</option>
                              <option value="wildcard">wildcard</option>
                              <option value="regex">regex</option>
                            </select>
                            <button className="btn btn-sm btn-primary" onClick={() => handleAddPattern(g.id)} disabled={!newPattern.trim()}>Add</button>
                          </div>

                          {/* Apply to existing */}
                          {g.patterns && g.patterns.length > 0 && (
                            <div style={{ marginTop: 12 }}>
                              <button className="btn btn-sm" onClick={() => handleApplyPatterns(g.id)}>Apply to Existing Ungrouped</button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // ── Group browser (default view) ───────────────────────────────────────────
  const renderGroupBrowser = () => (
    <div>
      <input
        className="form-input"
        placeholder="Search groups..."
        value={groupSearch}
        onChange={e => setGroupSearch(e.target.value)}
        style={{ marginBottom: 16, maxWidth: 360 }}
        data-testid="group-search-input"
      />

      {groupsLoading ? (
        <LoadingSpinner large center />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="📂"
          message="No API groups yet"
          description="Capture traffic from devices and organize endpoints into groups."
          action={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={() => { setFilterGroupId(''); setView('ungrouped'); }}>
                View All Endpoints
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => setView('manage')}>
                Create First Group
              </button>
            </div>
          }
        />
      ) : filteredGroups.length === 0 ? (
        <EmptyState
          icon="🔍"
          message="No groups match your search"
          description={`No groups found matching "${groupSearch}"`}
        />
      ) : (
        <div className="api-group-list">
          {filteredGroups.map(g => (
            <div
              key={g.id}
              className="api-group-row"
              onClick={() => navigate(`/ui/api-catalogue/groups/${g.id}/explorer`)}
              data-testid={`group-row-${g.id}`}
            >
              <div className="api-group-info">
                <div className="api-group-name">{g.name}</div>
                {g.description && <div className="api-group-desc">{g.description}</div>}
              </div>
              <div className="api-group-meta">
                <span className="api-group-count">{g.endpointCount} endpoint{g.endpointCount !== 1 ? 's' : ''}</span>
                <ChevronRight size={16} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const subtitleParts: string[] = [];
  if (groups.length > 0) {
    subtitleParts.push(`${groups.reduce((s, g) => s + g.endpointCount, 0) + ungroupedCount} endpoints across ${groups.length} group${groups.length !== 1 ? 's' : ''}`);
  } else if (total > 0) {
    subtitleParts.push(`${total} endpoint${total !== 1 ? 's' : ''} catalogued`);
  }

  const backButton = (view === 'ungrouped' || view === 'manage') ? (
    <button className="btn btn-sm" onClick={() => setView('')} style={{ marginBottom: 12 }}>
      &larr; Back to Groups
    </button>
  ) : null;

  return (
    <div data-testid="api-catalogue-page">
      <PageHeader
        title="API Catalogue"
        subtitle={subtitleParts[0]}
        actions={headerActions}
      />

      {backButton && <div>{backButton}</div>}

      {view === '' && renderGroupBrowser()}
      {view === 'ungrouped' && renderEndpointsTable()}
      {view === 'manage' && renderManageGroups()}

      {deleteEndpointConfirmId !== null && (
        <ConfirmDialog
          title="Delete Endpoint"
          message="Are you sure you want to delete this catalogued endpoint? This action cannot be undone."
          onConfirm={() => { handleDeleteEndpoint(deleteEndpointConfirmId); setDeleteEndpointConfirmId(null); }}
          onCancel={() => setDeleteEndpointConfirmId(null)}
        />
      )}

      {deletePatternConfirm && (
        <ConfirmDialog
          title="Remove Pattern"
          message={`Are you sure you want to remove the pattern "${deletePatternConfirm.pattern}" from this group?`}
          confirmLabel="Remove"
          onConfirm={() => { handleRemovePattern(deletePatternConfirm.groupId, deletePatternConfirm.patternId); setDeletePatternConfirm(null); }}
          onCancel={() => setDeletePatternConfirm(null)}
        />
      )}

      {showClearAllConfirm && (
        <ConfirmDialog
          title="Clear All Endpoints"
          message={`Are you sure you want to delete all ${total} catalogued endpoints? This action cannot be undone.`}
          confirmLabel="Clear All"
          onConfirm={() => { handleClearAll(); setShowClearAllConfirm(false); }}
          onCancel={() => setShowClearAllConfirm(false)}
        />
      )}

      {deleteGroupConfirmId !== null && (
        <ConfirmDialog
          title="Delete Group"
          message="Delete this group? Endpoints will be ungrouped."
          onConfirm={() => handleDeleteGroup(deleteGroupConfirmId)}
          onCancel={() => setDeleteGroupConfirmId(null)}
        />
      )}
    </div>
  );
}
