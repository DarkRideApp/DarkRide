import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { DeviceStreamPreview } from '../common/DeviceStreamPreview';
import { TerminalTab } from '../terminal/TerminalTab';
import type { LiveLogMessage, SessionStatusUpdate } from '../../../shared/types/websocket';

interface TerminalSession {
  id: string;
  type: 'host' | 'device';
  deviceId?: string;
  label: string;
}

interface LogEntry {
  system: string;
  datetime: string;
  severity: string;
  message: string;
}

interface DeviceOption {
  id: string;
  name: string | null;
}

const SEVERITIES = ['error', 'warn', 'log', 'debug'] as const;
const SEVERITY_LABELS: Record<string, string> = {
  error: 'Err',
  warn: 'Warn',
  log: 'Info',
  debug: 'Dbg',
};

const TAB_STRIP_HEIGHT = 48;
const DEFAULT_PANEL_HEIGHT = 220;
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_FRACTION = 0.7; // max 70% of viewport
const STORAGE_KEY = 'live-log-panel-height';

function loadPersistedHeight(): number {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const n = Number(v);
      if (n >= MIN_PANEL_HEIGHT && n <= window.innerHeight * MAX_PANEL_FRACTION) return n;
    }
  } catch {}
  return DEFAULT_PANEL_HEIGHT;
}

/** Deterministic hue (0-359) from a system name string */
function systemHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}

function systemColor(name: string): string {
  return `hsl(${systemHue(name)}, 60%, 58%)`;
}

export function LiveLogPanel() {
  const [open, setOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeSystems, setActiveSystems] = useState<Set<string>>(new Set());
  const [activeSeverities, setActiveSeverities] = useState<Set<string>>(new Set());
  const [useLocalTime, setUseLocalTime] = useState(true);
  const [systems, setSystems] = useState<string[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [activeTab, setActiveTab] = useState<'log' | 'terminal'>('log');
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [panelHeight, setPanelHeight] = useState(loadPersistedHeight);
  const bodyRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const ws = useWebSocket();
  const navigate = useNavigate();

  // Total wrapper height = panel content + tab strip
  const wrapperHeight = open ? panelHeight + TAB_STRIP_HEIGHT : undefined;

  const startStreaming = useCallback(() => {
    ws.sendMessage('livelog/subscribe');
    setStreaming(true);
  }, [ws]);

  const stopStreaming = useCallback(() => {
    ws.sendMessage('livelog/unsubscribe');
    setStreaming(false);
  }, [ws]);

  useEffect(() => {
    const unsub = ws.subscribe('livelog', (msg: LiveLogMessage) => {
      setLogs(prev => {
        const next = [...prev, {
          system: msg.system,
          datetime: msg.datetime,
          severity: msg.severity,
          message: msg.message,
        }];
        return next.length > 500 ? next.slice(-500) : next;
      });
      setSystems(prev => {
        if (!prev.includes(msg.system)) return [...prev, msg.system];
        return prev;
      });
    });
    return unsub;
  }, [ws]);

  // Listen for external open requests (e.g. from automation Run button)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const filters: string[] = detail?.filters || (detail?.filter ? [detail.filter] : []);
      setActiveSystems(new Set(filters));
      if (detail?.deviceId) setSelectedDeviceId(detail.deviceId);
      setActiveTab('log');
      setOpen(true);
    };
    window.addEventListener('livelog:open', handler);
    return () => window.removeEventListener('livelog:open', handler);
  }, []);

  // ── Multi-session terminal management ─────────────────────────────────
  const addSession = useCallback((type: 'host' | 'device', deviceId?: string, label?: string) => {
    const id = `${type}-${deviceId || 'host'}-${Date.now()}`;
    const session: TerminalSession = {
      id,
      type,
      deviceId,
      label: label || (type === 'host' ? 'Host' : deviceId || 'Device'),
    };
    setSessions(prev => {
      if (type === 'device' && deviceId) {
        const existing = prev.find(s => s.type === 'device' && s.deviceId === deviceId);
        if (existing) {
          setActiveSessionId(existing.id);
          return prev;
        }
      }
      return [...prev, session];
    });
    setActiveSessionId(id);
    setActiveTab('terminal');
    setOpen(true);
    setShowAddMenu(false);
  }, []);

  // Listen for terminal open requests (e.g. from DeviceView "Open Terminal" button)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.deviceId) {
        addSession('device', detail.deviceId, detail.deviceName || detail.deviceId);
      }
    };
    window.addEventListener('terminal:open', handler);
    return () => window.removeEventListener('terminal:open', handler);
  }, [addSession]);

  // Auto-select device from session-status when a manual automation starts
  useEffect(() => {
    return ws.subscribe('session-status', (msg: SessionStatusUpdate) => {
      if (msg.status === 'running' && msg.deviceId && msg.triggerType === 'manual') {
        setSelectedDeviceId(msg.deviceId);
      }
    });
  }, [ws]);

  // Fetch device list when panel opens or ws reconnects
  useEffect(() => {
    if (!open || !ws.connected) return;
    ws.sendRestApi('GET', '/v1/device/list').then(res => {
      const list = res.body?.data;
      if (Array.isArray(list)) {
        setDevices(list.map((d: any) => ({ id: d.id, name: d.name })));
      }
    }).catch(() => {});
  }, [open, ws]);

  // Close add-session menu on outside click
  useEffect(() => {
    if (!showAddMenu) return;
    const handler = () => setShowAddMenu(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showAddMenu]);

  // Toggle body class for content padding and auto-start streaming on open
  useEffect(() => {
    if (open) {
      document.body.classList.add('live-log-open');
      // Set CSS custom property for dynamic panel height
      document.documentElement.style.setProperty('--live-log-height', `${panelHeight + TAB_STRIP_HEIGHT}px`);
      if (!streaming && ws.connected) startStreaming();
    } else {
      document.body.classList.remove('live-log-open');
      document.documentElement.style.removeProperty('--live-log-height');
    }
    return () => {
      document.body.classList.remove('live-log-open');
      document.documentElement.style.removeProperty('--live-log-height');
    };
  }, [open, panelHeight]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs]);

  // ── Resize drag handling ──────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startY = e.clientY;
    const startHeight = panelHeight;

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startY - ev.clientY; // dragging up = positive = taller
      const maxH = window.innerHeight * MAX_PANEL_FRACTION;
      const newH = Math.round(Math.min(maxH, Math.max(MIN_PANEL_HEIGHT, startHeight + delta)));
      setPanelHeight(newH);
      document.documentElement.style.setProperty('--live-log-height', `${newH + TAB_STRIP_HEIGHT}px`);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist
      setPanelHeight(h => { try { localStorage.setItem(STORAGE_KEY, String(h)); } catch {} return h; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [panelHeight]);

  const formatTime = (dt: string) => {
    try {
      const d = new Date(dt);
      return useLocalTime ? d.toLocaleTimeString() : dt.split('T')[1]?.slice(0, 8) || dt;
    } catch { return dt; }
  };

  const toggleSystem = useCallback((system: string) => {
    setActiveSystems(prev => {
      const next = new Set(prev);
      if (next.has(system)) next.delete(system);
      else next.add(system);
      return next;
    });
  }, []);

  const toggleSeverity = useCallback((sev: string) => {
    setActiveSeverities(prev => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  }, []);

  /** Per-system entry counts for the badges on chips */
  const systemCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of logs) counts[log.system] = (counts[log.system] || 0) + 1;
    return counts;
  }, [logs]);

  const filteredLogs = useMemo(() => logs.filter(l => {
    if (activeSystems.size > 0 && !activeSystems.has(l.system)) return false;
    if (activeSeverities.size > 0 && !activeSeverities.has(l.severity)) return false;
    return true;
  }), [logs, activeSystems, activeSeverities]);

  const hasFilter = activeSystems.size > 0 || activeSeverities.size > 0;

  const handleTabClick = useCallback((tab: 'log' | 'terminal') => {
    if (open && activeTab === tab) {
      setOpen(false);
    } else {
      setActiveTab(tab);
      setOpen(true);
    }
  }, [open, activeTab]);

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== sessionId);
      if (sessionId === activeSessionId) {
        setActiveSessionId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }, [activeSessionId]);

  const openTerminalForDevice = useCallback((deviceId: string, deviceName: string | null) => {
    addSession('device', deviceId, deviceName || deviceId);
  }, [addSession]);

  const openDeviceStream = useCallback((deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setActiveTab('log');
  }, []);

  return (
    <div
      className={`live-log-wrapper${open ? ' expanded' : ''}`}
      style={open ? { height: wrapperHeight } : undefined}
      data-testid="live-log-panel"
    >
      {/* Resize handle (visible when expanded) */}
      {open && (
        <div
          className="live-log-resize-handle"
          onMouseDown={handleResizeStart}
          title="Drag to resize"
        />
      )}

      {/* Expanded panel content (above the tab strip) */}
      {open && activeTab === 'log' && (
        <div className="live-log-panel">
          {/* Left column: controls + filter bar + log body */}
          <div className="live-log-main">
            {/* Controls row */}
            <div className="live-log-controls">
              <span className="live-log-title">
                Live Log
                {streaming && <span className="live-log-pulse" aria-hidden="true" />}
              </span>
              <span className="live-log-count">
                {hasFilter ? `${filteredLogs.length} / ${logs.length}` : logs.length}
              </span>
              <div style={{ flex: 1 }} />
              <label className="live-log-option">
                <input type="checkbox" checked={useLocalTime} onChange={e => setUseLocalTime(e.target.checked)} />
                Local time
              </label>
              <select
                className="form-select"
                value={selectedDeviceId ?? ''}
                onChange={e => setSelectedDeviceId(e.target.value || null)}
                data-testid="livelog-device-select"
                aria-label="Select device"
                style={{ width: 'auto', fontSize: 12, padding: '2px 6px', height: 26 }}
              >
                <option value="">No device</option>
                {devices.map(d => (
                  <option key={d.id} value={d.id}>{d.name || d.id}</option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={() => setLogs([])} data-testid="live-log-clear">Clear</button>
              {!streaming
                ? <button className="btn btn-sm btn-primary" onClick={startStreaming}>Start</button>
                : <button className="btn btn-sm" onClick={stopStreaming}>Stop</button>
              }
            </div>

            {/* Filter bar */}
            <div className="live-log-filterbar">
              <div className="live-log-filter-systems">
                <button
                  className="live-log-all-btn"
                  data-active={String(activeSystems.size === 0)}
                  onClick={() => setActiveSystems(new Set())}
                  title="Show all systems"
                >
                  All
                </button>
                {systems.length > 0 && <span className="live-log-filter-sep" />}
                <div className="live-log-system-chips">
                  {systems.map(s => {
                    const isSelected = activeSystems.has(s);
                    const isVisible = activeSystems.size === 0 || isSelected;
                    const color = systemColor(s);
                    return (
                      <button
                        key={s}
                        className="live-log-chip"
                        onClick={() => toggleSystem(s)}
                        data-selected={String(isSelected)}
                        aria-pressed={isSelected}
                        data-testid={`livelog-filter-${s}`}
                        style={{ '--chip-color': color, opacity: isVisible ? 1 : 0.3 } as React.CSSProperties}
                        title={`${s} · ${systemCounts[s] ?? 0} entries`}
                      >
                        <span className="live-log-chip-dot" />
                        {s}
                        {(systemCounts[s] ?? 0) > 0 && (
                          <span className="live-log-chip-count">{systemCounts[s]}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="live-log-severity-group">
                {SEVERITIES.map(sev => {
                  const isSelected = activeSeverities.has(sev);
                  const isVisible = activeSeverities.size === 0 || isSelected;
                  return (
                    <button
                      key={sev}
                      className={`live-log-sev-btn sev-${sev}`}
                      onClick={() => toggleSeverity(sev)}
                      data-selected={String(isSelected)}
                      aria-pressed={isSelected}
                      style={{ opacity: isVisible ? 1 : 0.3 }}
                      title={`Toggle ${sev} messages`}
                    >
                      {SEVERITY_LABELS[sev]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Log body */}
            <div className="live-log-body" ref={bodyRef} aria-live="polite" aria-relevant="additions" role="log">
              {filteredLogs.map((log, i) => (
                <div key={i} className={`log-entry severity-${log.severity}`}>
                  <span className="log-timestamp">{formatTime(log.datetime)}</span>
                  <span className="log-system" style={{ color: systemColor(log.system) }}>
                    <span className="log-system-dot" style={{ background: systemColor(log.system) }} />
                    {log.system}
                  </span>
                  {log.message}
                </div>
              ))}
              {filteredLogs.length === 0 && (
                <div className="live-log-empty">
                  {logs.length > 0 ? 'No logs match the current filters.' : 'Waiting for logs\u2026'}
                </div>
              )}
            </div>
          </div>

          {/* Right column: device preview, pops in when a device is selected */}
          {selectedDeviceId && (
            <DeviceStreamPreview
              deviceId={selectedDeviceId}
              onNavigate={() => navigate(`/ui/devices/${encodeURIComponent(selectedDeviceId)}`)}
            />
          )}
        </div>
      )}

      {/* Terminal panel content — stays mounted when sessions exist to preserve pty state */}
      {open && (activeTab === 'terminal' || sessions.length > 0) && (
        <div className="live-log-panel live-log-terminal-panel" style={{ flexDirection: 'column', display: activeTab === 'terminal' ? 'flex' : 'none' }}>
          {sessions.length > 0 ? (
            <>
              {/* Sub-tab bar */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 0,
                borderBottom: '1px solid #334155',
                background: '#0f172a',
                flexShrink: 0,
                minHeight: 32,
              }}>
                {sessions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setActiveSessionId(s.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      border: 'none',
                      borderBottom: s.id === activeSessionId ? '2px solid #3b82f6' : '2px solid transparent',
                      background: s.id === activeSessionId ? '#1e293b' : 'transparent',
                      color: s.id === activeSessionId ? '#e2e8f0' : '#64748b',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: s.type === 'host' ? '#22c55e' : '#3b82f6',
                      flexShrink: 0,
                    }} />
                    {s.label}
                    <span
                      onClick={(e) => { e.stopPropagation(); removeSession(s.id); }}
                      style={{
                        marginLeft: 4,
                        cursor: 'pointer',
                        opacity: 0.5,
                        fontSize: 14,
                        lineHeight: 1,
                      }}
                      title="Close session"
                    >
                      &times;
                    </span>
                  </button>
                ))}
                {/* Add session button */}
                <div style={{ position: 'relative', marginLeft: 4 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowAddMenu(v => !v); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 24,
                      height: 24,
                      border: '1px solid #334155',
                      borderRadius: 4,
                      background: 'transparent',
                      color: '#64748b',
                      cursor: 'pointer',
                      fontSize: 16,
                      lineHeight: 1,
                    }}
                    title="Add session"
                  >
                    +
                  </button>
                  {showAddMenu && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        marginTop: 4,
                        background: '#1e293b',
                        border: '1px solid #334155',
                        borderRadius: 6,
                        padding: 4,
                        zIndex: 100,
                        minWidth: 180,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                      }}
                    >
                      <button
                        onClick={() => addSession('host')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          padding: '6px 10px',
                          border: 'none',
                          background: 'transparent',
                          color: '#e2e8f0',
                          cursor: 'pointer',
                          fontSize: 12,
                          borderRadius: 4,
                          fontFamily: 'inherit',
                          textAlign: 'left',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#334155')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                        Host Terminal
                      </button>
                      {devices.map(d => (
                        <button
                          key={d.id}
                          onClick={() => addSession('device', d.id, d.name || d.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            padding: '6px 10px',
                            border: 'none',
                            background: 'transparent',
                            color: '#e2e8f0',
                            cursor: 'pointer',
                            fontSize: 12,
                            borderRadius: 4,
                            fontFamily: 'inherit',
                            textAlign: 'left',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#334155')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3b82f6', flexShrink: 0 }} />
                          {d.name || d.id}
                        </button>
                      ))}
                      {devices.length === 0 && (
                        <div style={{ padding: '6px 10px', color: '#64748b', fontSize: 12 }}>
                          No devices connected
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {/* Terminal bodies — all mounted, only active visible */}
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                {sessions.map(s => (
                  <TerminalTab
                    key={s.id}
                    sessionId={s.id}
                    type={s.type}
                    deviceId={s.deviceId}
                    visible={s.id === activeSessionId}
                    onExit={() => removeSession(s.id)}
                  />
                ))}
              </div>
            </>
          ) : (
            /* Empty state — no sessions */
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 12,
              color: '#64748b',
              fontSize: 13,
            }}>
              <div>No terminal sessions open.</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => addSession('host')}
                >
                  Open Host Terminal
                </button>
                {devices.map(d => (
                  <button
                    key={d.id}
                    className="btn btn-sm"
                    onClick={() => addSession('device', d.id, d.name || d.id)}
                  >
                    {d.name || d.id}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab strip (always visible) */}
      <div className="live-log-tabstrip">
        <button
          className={`live-log-tab${open && activeTab === 'log' ? ' active' : ''}`}
          onClick={() => handleTabClick('log')}
          data-testid="live-log-toggle"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          <span>Live Log</span>
          {streaming && <span className="live-log-pulse" aria-hidden="true" />}
        </button>
        <button
          className={`live-log-tab${open && activeTab === 'terminal' ? ' active' : ''}${sessions.length > 0 ? ' has-session' : ''}`}
          onClick={() => handleTabClick('terminal')}
          data-testid="terminal-tab-toggle"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          <span>Terminal{sessions.length > 0 ? ` (${sessions.length})` : ''}</span>
          {sessions.length > 0 && <span className="live-log-pulse" aria-hidden="true" />}
        </button>
        <div className="live-log-tabstrip-spacer" />
        <div className="live-log-tabstrip-status">
          {ws.connected && (
            <>
              <span className="live-log-uplink-dot" />
              <span>UPLINK ACTIVE</span>
            </>
          )}
          {!ws.connected && <span>DISCONNECTED</span>}
        </div>
      </div>
    </div>
  );
}
