import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { FilterBar, FilterField } from '@darkrideapp/plugin-sdk/react';
import { TrafficInspector } from '../components/traffic/TrafficInspector';
import { DataTable } from '@darkrideapp/plugin-sdk/react';
import type { Column } from '@darkrideapp/plugin-sdk/react';
import type { AutomationSession, Screenshot } from '../../shared/types/api';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { Breadcrumbs } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import type { ExecutionLogEntry } from '../../shared/types/automation';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

export function AutomationReviewer() {
  useDocumentTitle('Automation History');
  const auth = useAuthOptional();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const ws = useWebSocket();
  const [sessions, setSessions] = useState<AutomationSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [triggerFilter, setTriggerFilter] = useState('');

  const fetchSessions = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (triggerFilter) params.set('triggerType', triggerFilter);
      params.set('limit', '50');
      const endpoint = id ? `/v1/automation/sessions/${id}` : `/v1/automation/sessions/0`;
      const res = await ws.sendRestApi('GET', `${endpoint}?${params}`);
      setSessions(res.body?.data?.items || res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws, id, statusFilter, triggerFilter]);

  useEffect(() => {
    if (ws.connected) fetchSessions();
  }, [ws.connected, fetchSessions]);

  if (auth && !auth.hasScope('core.automations:read')) return <AccessDenied scope="core.automations:read" />;
  if (loading) return <LoadingSpinner large center />;

  return (
    <div data-testid="automation-reviewer">
      <Breadcrumbs items={[
        { label: 'Automations', to: '/ui/automations' },
        { label: 'History' },
      ]} />
      <PageHeader
        title={id ? `Session History - Automation #${id}` : 'Session History'}
        actions={id ? <button className="btn" onClick={() => navigate(`/ui/automations/${id}/edit`)}>Edit Automation</button> : undefined}
      />

      <FilterBar>
        <FilterField label="Status">
          <select className="form-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </FilterField>
        <FilterField label="Trigger">
          <select className="form-select" value={triggerFilter} onChange={e => setTriggerFilter(e.target.value)}>
            <option value="">All</option>
            <option value="manual">Manual</option>
            <option value="schedule">Schedule</option>
            <option value="api">API</option>
          </select>
        </FilterField>
      </FilterBar>

      {sessions.length === 0 ? (
        <div className="empty-state">No sessions found</div>
      ) : (
        <DataTable<AutomationSession>
          tableId="automation-sessions"
          testId="sessions-table"
          keyField="id"
          data={sessions}
          onRowClick={s => navigate(`/ui/automations/session/${s.id}`)}
          emptyMessage="No sessions found"
          columns={[
            {
              key: 'name',
              header: 'Session',
              sortable: true,
              render: s => <>{s.name || `#${s.id}`}</>,
            },
            {
              key: 'status',
              header: 'Status',
              sortable: true,
              render: s => <StatusBadge status={s.status} />,
            },
            {
              key: 'triggerType',
              header: 'Trigger',
              sortable: true,
            },
            {
              key: 'deviceId',
              header: 'Device',
              sortable: true,
              render: s => <>{s.deviceId || '—'}</>,
            },
            {
              key: 'startedAt',
              header: 'Started',
              sortable: true,
              render: s => <>{new Date(s.startedAt).toLocaleString()}</>,
            },
            {
              key: 'completedAt',
              header: 'Completed',
              sortable: true,
              render: s => <>{s.completedAt ? new Date(s.completedAt).toLocaleString() : '—'}</>,
            },
          ] as Column<AutomationSession>[]}
        />
      )}
    </div>
  );
}

/** Session Timeline Detail View */
export function SessionTimeline() {
  useDocumentTitle('Session Timeline');
  const auth = useAuthOptional();
  const hasScope = auth?.hasScope ?? (() => true);
  const { sessionId } = useParams<{ sessionId: string }>();
  const ws = useWebSocket();
  const [session, setSession] = useState<AutomationSession | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [showSleep, setShowSleep] = useState(false);
  const [activeTab, setActiveTab] = useState<'traffic' | 'timeline'>('traffic');
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesInput, setNotesInput] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);

  const saveSessionName = useCallback(async () => {
    if (!session || !sessionId) return;
    try {
      await ws.sendRestApi('PATCH', `/v1/automation/session/${sessionId}`, { name: nameInput });
      setSession(prev => prev ? { ...prev, name: nameInput } : prev);
    } catch { /* ignore */ }
    setEditingName(false);
  }, [ws, sessionId, nameInput, session]);

  const saveNotes = useCallback(async () => {
    if (!session || !sessionId) return;
    const value = notesInput.trim() || null;
    try {
      await ws.sendRestApi('PATCH', `/v1/automation/session/${sessionId}`, { notes: value });
      setSession(prev => prev ? { ...prev, notes: value } : prev);
      setNotesDirty(false);
    } catch { /* ignore */ }
  }, [ws, sessionId, notesInput, session]);

  useEffect(() => {
    if (!ws.connected || !sessionId) return;
    ws.sendRestApi('GET', `/v1/automation/session/${sessionId}`).then(res => {
      const data = res.body?.data;
      setSession(data?.session || null);
      setScreenshots(data?.screenshots || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [ws, sessionId]);

  if (loading) return <LoadingSpinner large center />;
  if (auth && !hasScope('core.automations:read')) return <AccessDenied scope="core.automations:read" />;
  if (!session) return <div className="empty-state">Session not found</div>;

  // Combine logs and screenshots into a timeline sorted by time.
  // `logIndex` on api-call events captures the position in the parsed logs
  // array — used by the "Debug in Selector Debugger" link so the debugger
  // can re-fetch the DOM snapshot from the session rather than inlining it
  // in the URL (which 431'd on large UI hierarchies). See task #521.
  type TimelineEvent =
    | { type: 'log'; time: string; message: string }
    | { type: 'api-call'; time: string; entry: ExecutionLogEntry; logIndex: number }
    | { type: 'screenshot'; time: string; screenshot: Screenshot };

  const events: TimelineEvent[] = [];

  // Parse logs
  if (session.logs) {
    try {
      const parsed = JSON.parse(session.logs);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].method) {
        (parsed as ExecutionLogEntry[]).forEach((entry, logIndex) => {
          events.push({ type: 'api-call', time: entry.timestamp, entry, logIndex });
        });
      } else if (Array.isArray(parsed)) {
        parsed.forEach((l: any) => {
          events.push({ type: 'log', time: l.timestamp, message: l.message });
        });
      }
    } catch {
      events.push({ type: 'log', time: session.startedAt, message: session.logs });
    }
  }

  screenshots.forEach(s => {
    events.push({ type: 'screenshot', time: s.capturedAt, screenshot: s });
  });

  events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const filteredEvents = showSleep
    ? events
    : events.filter(ev => !(ev.type === 'api-call' && ev.entry.method === 'sleep'));

  const sleepCount = events.length - events.filter(ev => !(ev.type === 'api-call' && ev.entry.method === 'sleep')).length;

  return (
    <div className="session-timeline-page page-full-bleed" data-testid="session-timeline">
      {/* Header */}
      <div className="session-timeline-header">
        <h1 className="session-timeline-title">
          {editingName ? (
            <input
              className="form-input"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={() => saveSessionName()}
              onKeyDown={e => { if (e.key === 'Enter') saveSessionName(); if (e.key === 'Escape') setEditingName(false); }}
              autoFocus
              style={{ fontSize: 'inherit', width: 300 }}
            />
          ) : (
            <span
              style={{ cursor: 'pointer' }}
              onClick={() => { setEditingName(true); setNameInput(session.name || `Session #${sessionId}`); }}
              title="Click to rename"
            >
              {session.name || `Session #${sessionId}`}
            </span>
          )}
        </h1>
        <StatusBadge status={session.status} />
        <div className="session-timeline-meta">
          <span><strong>Trigger:</strong> {session.triggerType}</span>
          <span><strong>Device:</strong> {session.deviceId || '—'}</span>
          <span><strong>Started:</strong> {new Date(session.startedAt).toLocaleString()}</span>
          {session.completedAt && (
            <span><strong>Completed:</strong> {new Date(session.completedAt).toLocaleString()}</span>
          )}
        </div>
        <div className="session-timeline-actions">
          <button
            className="btn btn-sm"
            onClick={() => window.open(`/v1/automation/session/${sessionId}/export/har`, '_blank')}
            data-testid="btn-export-har"
          >
            Export HAR
          </button>
          <button
            className="btn btn-sm"
            onClick={() => window.open(`/v1/automation/session/${sessionId}/export/zip`, '_blank')}
            data-testid="btn-export-zip"
          >
            Export ZIP
          </button>
        </div>

        {/* Session Notes */}
        <div className="session-timeline-notes" data-testid="session-notes">
          <button
            className="session-timeline-notes-toggle"
            onClick={() => {
              if (!notesOpen) {
                setNotesInput(session.notes || '');
                setNotesDirty(false);
              }
              setNotesOpen(o => !o);
            }}
            data-testid="toggle-notes"
          >
            Notes {session.notes ? '(has notes)' : '(none)'} {notesOpen ? '\u25B2' : '\u25BC'}
          </button>
          {notesOpen && (
            <div className="session-timeline-notes-body">
              <textarea
                className="form-input"
                value={notesInput}
                onChange={e => { setNotesInput(e.target.value); setNotesDirty(true); }}
                onBlur={() => { if (notesDirty) saveNotes(); }}
                placeholder="Add session notes..."
                rows={4}
                data-testid="notes-textarea"
                style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }}
              />
              {notesDirty && (
                <button
                  className="btn btn-sm"
                  onClick={saveNotes}
                  data-testid="save-notes"
                  style={{ marginTop: 4 }}
                >
                  Save Notes
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="session-timeline-tabs">
        <button
          className={`session-timeline-tab${activeTab === 'traffic' ? ' active' : ''}`}
          onClick={() => setActiveTab('traffic')}
        >
          Traffic
        </button>
        <button
          className={`session-timeline-tab${activeTab === 'timeline' ? ' active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline
          {events.length > 0 && <span className="session-timeline-tab-badge">{events.length}</span>}
        </button>
      </div>

      {/* Body */}
      <div className="session-timeline-body">
        {/* Traffic tab — full-height flex container so TrafficDetailPanel resolves height */}
        {activeTab === 'traffic' && (
          <div className="session-timeline-traffic">
            {hasScope('core.traffic:read') && (
              <TrafficInspector
                mode="static"
                deviceId={session.deviceId || ''}
                sessionId={session.id}
              />
            )}
          </div>
        )}

        {/* Timeline tab — scrollable */}
        {activeTab === 'timeline' && (
          <div className="session-timeline-scroll">
            {sleepCount > 0 && (
              <label className="session-timeline-sleep-toggle">
                <input
                  type="checkbox"
                  checked={showSleep}
                  onChange={e => setShowSleep(e.target.checked)}
                  data-testid="toggle-sleep"
                />
                Show sleep calls ({sleepCount})
              </label>
            )}

            {filteredEvents.length === 0 ? (
              <div className="empty-state">No timeline events</div>
            ) : (
              <div className="timeline" data-testid="timeline">
                {filteredEvents.map((ev, i) => (
                  <div key={i} className="timeline-event">
                    <div className="event-time">{new Date(ev.time).toLocaleTimeString()}</div>
                    <div className="event-content">
                      {ev.type === 'log' && <div>{ev.message}</div>}
                      {ev.type === 'api-call' && ev.entry.method.startsWith('console.') && (
                        <div
                          data-testid="console-event"
                          style={{
                            fontSize: 13,
                            fontFamily: 'var(--font-mono)',
                            color: ev.entry.method === 'console.error' ? '#e53e3e' : ev.entry.method === 'console.warn' ? '#d69e2e' : '#a0aec0',
                          }}
                        >
                          <span style={{ opacity: 0.6 }}>{ev.entry.method === 'console.error' ? '\u2718' : ev.entry.method === 'console.warn' ? '\u26A0' : '\u25B6'} </span>
                          {ev.entry.params.message}
                        </div>
                      )}
                      {ev.type === 'api-call' && !ev.entry.method.startsWith('console.') && (
                        <div data-testid="api-call-event">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <code style={{ fontWeight: 'bold' }}>{ev.entry.method}</code>
                            <span style={{ fontSize: 12, color: '#888' }}>{ev.entry.durationMs}ms</span>
                            {ev.entry.error && (
                              <span style={{ fontSize: 12, color: '#fff', background: '#e53e3e', borderRadius: 4, padding: '1px 6px' }}>
                                error
                              </span>
                            )}
                          </div>
                          {Object.keys(ev.entry.params).length > 0 && (
                            <div style={{ fontSize: 12, marginTop: 2 }}>
                              <code>{JSON.stringify(ev.entry.params)}</code>
                            </div>
                          )}
                          {ev.entry.error && (
                            <div style={{ fontSize: 12, color: '#e53e3e', marginTop: 2 }}>{ev.entry.error}</div>
                          )}
                          {ev.entry.result !== undefined && !ev.entry.error && (() => {
                            const resultStr = typeof ev.entry.result === 'string' ? ev.entry.result : JSON.stringify(ev.entry.result);
                            const isLarge = resultStr.length > 200;
                            if (isLarge) {
                              return (
                                <details style={{ fontSize: 12, marginTop: 2, color: '#38a169' }}>
                                  <summary style={{ cursor: 'pointer' }}>Result ({resultStr.length > 1000 ? `${Math.round(resultStr.length / 1024)}KB` : `${resultStr.length} chars`})</summary>
                                  <pre style={{ maxHeight: 200, overflow: 'auto', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{resultStr}</pre>
                                </details>
                              );
                            }
                            return (
                              <div style={{ fontSize: 12, marginTop: 2, color: '#38a169' }}>
                                Result: <code>{resultStr}</code>
                              </div>
                            );
                          })()}
                          {ev.entry.screenshotFilename && (
                            <div style={{ marginTop: 4 }}>
                              <img
                                src={`/v1/screenshots/${ev.entry.screenshotFilename}`}
                                alt="screenshot"
                                style={{ maxWidth: 400, border: '1px solid #ddd', borderRadius: 4 }}
                              />
                            </div>
                          )}
                          {ev.entry.domSnapshot && (
                            <details style={{ marginTop: 4 }}>
                              <summary style={{ cursor: 'pointer', fontSize: 13 }}>DOM Snapshot</summary>
                              {ev.entry.selector && (
                                <div style={{ fontSize: 12, marginTop: 2 }}>
                                  Selector: <code>{JSON.stringify(ev.entry.selector)}</code>
                                </div>
                              )}
                              <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', marginTop: 4 }}>
                                {ev.entry.domSnapshot}
                              </pre>
                              <a
                                href={`/ui/selector-debugger?session=${sessionId}&log=${ev.logIndex}`}
                                style={{ fontSize: 12 }}
                              >
                                Debug in Selector Debugger
                              </a>
                            </details>
                          )}
                        </div>
                      )}
                      {ev.type === 'screenshot' && (
                        <div>
                          <div>Screenshot: {ev.screenshot.name || ev.screenshot.filename}</div>
                          <img src={`/v1/screenshots/${ev.screenshot.filename}`} alt={ev.screenshot.name || ''} />
                          {ev.screenshot.domSnapshot && (
                            <details style={{ marginTop: 8 }}>
                              <summary style={{ cursor: 'pointer', fontSize: 13 }}>DOM Snapshot</summary>
                              <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', marginTop: 4 }}>
                                {ev.screenshot.domSnapshot}
                              </pre>
                              <a
                                href={`/ui/selector-debugger?session=${sessionId}&screenshot=${ev.screenshot.id}`}
                                style={{ fontSize: 12 }}
                              >
                                Debug in Selector Debugger
                              </a>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
