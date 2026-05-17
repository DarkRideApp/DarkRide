import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { InterceptRulesTab } from '../components/intercept/InterceptRulesTab';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import type { Automation } from '../../shared/types/api';

type AutomationTab = 'automation' | 'rule' | 'captureRule' | 'templates' | 'queue' | 'intercept';
const AUTOMATION_TABS: AutomationTab[] = ['automation', 'rule', 'captureRule', 'templates', 'queue', 'intercept'];

interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  requiresDevice: boolean;
  requiresHttpsCapture: boolean;
}

interface QueueEntry {
  automationId: number;
  automationName: string | null;
  triggerType: string;
  queuedAt: string;
  waitingSeconds: number;
  reason: string | null;
}

interface DeviceStatus {
  id: string;
  online: boolean;
  busy: boolean;
}

interface QueueStatus {
  queue: QueueEntry[];
  processingQueue: boolean;
  devices: DeviceStatus[];
}

export function Automations() {
  useDocumentTitle('Automations');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateCategory, setTemplateCategory] = useState<string>('all');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Automation | null>(null);

  const tabParam = searchParams.get('tab') as AutomationTab | null;
  const activeTab: AutomationTab = tabParam && AUTOMATION_TABS.includes(tabParam) ? tabParam : 'automation';
  const setActiveTab = useCallback((tab: AutomationTab) => {
    setSearchParams(tab === 'automation' ? {} : { tab }, { replace: false });
  }, [setSearchParams]);

  const fetchAutomations = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/automation/list');
      setAutomations(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  const fetchQueueStatus = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/automation/queue/status');
      setQueueStatus(res.body?.data || null);
    } catch {
      // ignore
    } finally {
      setQueueLoading(false);
    }
  }, [ws]);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/automation/templates');
      setTemplates(res.body?.data || []);
    } catch {
      // ignore
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      fetchAutomations();
      fetchTemplates();
      // Fetch queue count for badge on all tabs
      fetchQueueStatus();
    }
  }, [ws.connected, fetchAutomations, fetchTemplates, fetchQueueStatus]);

  // Poll queue status when on queue tab
  useEffect(() => {
    if (activeTab === 'queue' && ws.connected) {
      setQueueLoading(true);
      fetchQueueStatus();
      pollRef.current = setInterval(fetchQueueStatus, 5000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [activeTab, ws.connected, fetchQueueStatus]);

  // Refresh queue on session status changes
  useEffect(() => {
    if (activeTab !== 'queue') return;
    return ws.subscribe('session-status', () => {
      fetchQueueStatus();
    });
  }, [ws, activeTab, fetchQueueStatus]);

  const clearQueue = async () => {
    try {
      await ws.sendRestApi('DELETE', '/v1/automation/queue');
      fetchQueueStatus();
      toast.success('Queue cleared');
    } catch {
      toast.error('Failed to clear queue');
    }
  };

  const filtered = automations.filter(a => {
    if (activeTab === 'queue' || activeTab === 'templates') return false;
    if (activeTab === 'automation' && (a.isRule || a.isCaptureRule)) return false;
    if (activeTab === 'rule' && !a.isRule) return false;
    if (activeTab === 'captureRule' && !a.isCaptureRule) return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  if (auth && !auth.hasScope('core.automations:read')) return <AccessDenied scope="core.automations:read" />;
  if (loading) return <div className="table-card"><SkeletonTable rows={4} columns={5} /></div>;

  const canEdit = !auth || auth.hasScope('core.automations:edit');
  const canExecute = !auth || auth.hasScope('core.automations:execute');

  return (
    <div data-testid="automations-page">
      <PageHeader title="Automations" actions={
        activeTab !== 'queue' && activeTab !== 'intercept' && activeTab !== 'templates' ? (
          canEdit && <button className="btn btn-primary" onClick={() => navigate('/ui/automations/new', { state: { type: activeTab } })}>Create New</button>
        ) : activeTab === 'queue' && queueStatus && queueStatus.queue.length > 0 ? (
          <button className="btn btn-danger" onClick={clearQueue}>Clear Queue</button>
        ) : undefined
      } />

      <div className="tab-bar">
        <button className={`tab-btn ${activeTab === 'automation' ? 'active' : ''}`} onClick={() => setActiveTab('automation')}>Automations</button>
        <button className={`tab-btn ${activeTab === 'rule' ? 'active' : ''}`} onClick={() => setActiveTab('rule')}>Rules</button>
        <button className={`tab-btn ${activeTab === 'captureRule' ? 'active' : ''}`} onClick={() => setActiveTab('captureRule')}>Capture Rules</button>
        <button className={`tab-btn ${activeTab === 'templates' ? 'active' : ''}`} onClick={() => setActiveTab('templates')}>Templates</button>
        <button className={`tab-btn ${activeTab === 'queue' ? 'active' : ''}`} onClick={() => setActiveTab('queue')}>
          Queue{queueStatus && queueStatus.queue.length > 0 ? ` (${queueStatus.queue.length})` : ''}
        </button>
        <button className={`tab-btn ${activeTab === 'intercept' ? 'active' : ''}`} onClick={() => setActiveTab('intercept')}>Intercept</button>
      </div>

      {activeTab === 'queue' ? (
        <QueueTab status={queueStatus} loading={queueLoading} />
      ) : activeTab === 'intercept' ? (
        <InterceptRulesTab />
      ) : activeTab === 'templates' ? (
        <TemplatesTab
          templates={templates}
          search={templateSearch}
          onSearchChange={setTemplateSearch}
          category={templateCategory}
          onCategoryChange={setTemplateCategory}
        />
      ) : (
        <>
          <div className="filter-bar">
            <div className="form-group">
              <label>Search</label>
              <input
                className="form-input"
                type="text"
                placeholder="Filter by name..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">⚡</div>
              <div>{activeTab === 'automation' ? 'No automations created' : activeTab === 'rule' ? 'No rules created' : 'No capture rules created'}</div>
            </div>
          ) : (
            <div className="table-card"><table className="data-table" data-testid="automations-table">
              <thead>
                <tr>
                  <th>Name</th>
                  {activeTab !== 'automation' && <th>Priority</th>}
                  <th className="hide-mobile">Timeout</th>
                  <th className="hide-mobile">HTTPS</th>
                  <th className="hide-mobile">Updated</th>
                  {activeTab !== 'automation' && <th>Enabled</th>}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id} className="clickable-row" onClick={() => navigate(`/ui/automations/${a.id}/edit`)}>
                    <td><strong>{a.name}</strong></td>
                    {activeTab !== 'automation' && <td>{a.priority}</td>}
                    <td className="hide-mobile">{Math.round(a.timeoutMs / 1000)}s</td>
                    <td className="hide-mobile">{a.requiresHttpsCapture ? 'Yes' : 'No'}</td>
                    <td className="hide-mobile">{new Date(a.updatedAt).toLocaleDateString()}</td>
                    {activeTab !== 'automation' && (
                      <td>
                        {canEdit ? (
                          <button
                            className={`btn btn-sm${a.enabled ? ' btn-success' : ''}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              const endpoint = a.enabled ? 'disable' : 'enable';
                              try {
                                await ws.sendRestApi('POST', `/v1/automation/${endpoint}/${a.id}`);
                                fetchAutomations();
                              } catch (err: any) {
                                toast.error(err?.message || `Failed to ${endpoint} automation`);
                              }
                            }}
                          >
                            {a.enabled ? 'On' : 'Off'}
                          </button>
                        ) : (
                          <span className={`badge badge-sm${a.enabled ? '' : ' badge-muted'}`}>{a.enabled ? 'On' : 'Off'}</span>
                        )}
                      </td>
                    )}
                    <td style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="btn btn-sm"
                        onClick={e => { e.stopPropagation(); navigate(`/ui/automations/${a.id}/history`); }}
                      >
                        History
                      </button>
                      {canEdit && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={e => { e.stopPropagation(); setDeleteConfirm(a); }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Automation"
          message={`Are you sure you want to delete "${deleteConfirm.name}"?`}
          onConfirm={async () => {
            await ws.sendRestApi('DELETE', `/v1/automation/delete/${deleteConfirm.id}`);
            setDeleteConfirm(null);
            fetchAutomations();
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  'all': 'All',
  'login': 'Login Flows',
  'navigation': 'Navigation',
  'data-extraction': 'Data Extraction',
  'maintenance': 'Maintenance',
};

function TemplatesTab({
  templates,
  search,
  onSearchChange,
  category,
  onCategoryChange,
}: {
  templates: TemplateSummary[];
  search: string;
  onSearchChange: (s: string) => void;
  category: string;
  onCategoryChange: (c: string) => void;
}) {
  const navigate = useNavigate();

  const filtered = templates.filter(t => {
    if (category !== 'all' && t.category !== category) return false;
    if (search) {
      const q = search.toLowerCase();
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.tags.some(tag => tag.includes(q));
    }
    return true;
  });

  const categories = ['all', ...Array.from(new Set(templates.map(t => t.category)))];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
      <div className="filter-bar">
        <div className="form-group">
          <label>Search</label>
          <input
            className="form-input"
            type="text"
            placeholder="Filter templates..."
            value={search}
            onChange={e => onSearchChange(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Category</label>
          <select
            className="form-input"
            value={category}
            onChange={e => onCategoryChange(e.target.value)}
          >
            {categories.map(c => (
              <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <div>No templates match your search</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {filtered.map(t => (
            <div
              key={t.id}
              className="table-card clickable-row"
              style={{ padding: 16, cursor: 'pointer' }}
              onClick={() => navigate('/ui/automations/new', { state: { templateId: t.id } })}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <strong style={{ fontSize: 15 }}>{t.name}</strong>
                <span className="badge badge-sm">{CATEGORY_LABELS[t.category] || t.category}</span>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px 0', lineHeight: 1.4 }}>
                {t.description}
              </p>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {t.tags.map(tag => (
                  <span key={tag} className="badge badge-sm" style={{ opacity: 0.7 }}>{tag}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QueueTab({ status, loading }: { status: QueueStatus | null; loading: boolean }) {
  if (loading && !status) return <LoadingSpinner center />;

  if (!status) return null;

  const { queue, processingQueue, devices } = status;
  const onlineDevices = devices.filter(d => d.online);
  const busyDevices = devices.filter(d => d.online && d.busy);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
      {/* Device summary */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span className="badge">{devices.length} device{devices.length !== 1 ? 's' : ''}</span>
        <span className={`badge ${onlineDevices.length > 0 ? 'badge-online' : 'badge-failed'}`}>
          {onlineDevices.length} online
        </span>
        {busyDevices.length > 0 && (
          <span className="badge badge-warning">{busyDevices.length} busy</span>
        )}
        {processingQueue && (
          <span className="badge badge-warning">Processing</span>
        )}
      </div>

      {/* Device list */}
      {devices.length > 0 && (
        <div className="table-card"><table className="data-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {devices.map(d => (
              <tr key={d.id}>
                <td><code style={{ fontSize: 12 }}>{d.id}</code></td>
                <td>
                  {!d.online ? (
                    <span className="badge badge-failed">Offline</span>
                  ) : d.busy ? (
                    <span className="badge badge-warning">Busy</span>
                  ) : (
                    <span className="badge badge-online">Available</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {/* Queue entries */}
      {queue.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">✓</div>
          <div>Queue is empty</div>
        </div>
      ) : (
        <div className="table-card"><table className="data-table">
          <thead>
            <tr>
              <th>Automation</th>
              <th>Trigger</th>
              <th>Waiting</th>
              <th>Blocked By</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((entry, i) => (
              <tr key={`${entry.automationId}-${i}`}>
                <td><strong>{entry.automationName || `#${entry.automationId}`}</strong></td>
                <td><span className="badge badge-sm">{entry.triggerType}</span></td>
                <td>{formatWaitTime(entry.waitingSeconds)}</td>
                <td>
                  {entry.reason ? (
                    <span style={{ color: 'var(--text-warning, var(--text-secondary))' }}>{entry.reason}</span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>ready</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function formatWaitTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
