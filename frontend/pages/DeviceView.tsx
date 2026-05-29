import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Navigate, useParams, useNavigate, Link } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { AppsTab } from '../components/devices/AppsTab';
import { WireGuardSetup } from '../components/devices/WireGuardSetup';
import { DeviceViewer, DeviceAction } from '../components/devices/DeviceViewer';
import { VncViewer } from '../lib/video/VncViewer';
import { SetupWizardModal } from '../components/devices/SetupWizardModal';
import { CURRENT_SETUP_VERSION } from '../../shared/types/api';
import type { Device, Setting } from '../../shared/types/api';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import type { AutomationLogMessage, CaptureStatusMessage, CaptureSubsystemStatus, BusyTimeoutWarningMessage } from '../../shared/types/websocket';
import type { CapturedTrafficEntry, WebSocketMessageEntry } from '../../shared/types/api';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { TrafficTable } from '../components/traffic/TrafficTable';
import { useTrafficReplay } from '../components/traffic/TrafficEntryRow';

type TabKey = 'details' | 'apps' | 'capture' | 'crashes' | 'processes';

function capitalizeTab(t: TabKey): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function DeviceView() {
  useDocumentTitle('Device');
  const auth = useAuthOptional();
  const { id: deviceId, tab: tabParam } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const ws = useWebSocket();
  const toast = useToast();
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [capturingDom, setCapturingDom] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [automationLog, setAutomationLog] = useState<AutomationLogMessage[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureSessionId, setCaptureSessionId] = useState<number | null>(null);
  const [streamBackend, setStreamBackend] = useState<string | null>(null);
  const [captureSubsystems, setCaptureSubsystems] = useState<CaptureSubsystemStatus | null>(null);
  const [showSetupModal, setShowSetupModal] = useState(false);
  // Legacy DeviceView-level proxy/TLS state. Provides a default fallback for
  // `handleStartCapture` when it's called from the DeviceViewer primary
  // button (no form). The CaptureTab owns its own form state and passes the
  // chosen values through as opts — this fallback will be removed in Task 5
  // once the DeviceViewer button routes through the Capture tab.
  const [proxyMode] = useState<'none' | 'normal' | 'nordvpn'>('none');
  const [proxyCountry] = useState('us');
  const [tlsProfile] = useState<'chrome' | 'okhttp' | 'default'>('default');
  const [hasNordCredentials, setHasNordCredentials] = useState(false);
  const [reprobing, setReprobing] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [busyWarning, setBusyWarning] = useState<number | null>(null); // remaining seconds
  const [videoTransport, setVideoTransport] = useState<'vnc' | 'scrcpy' | null>(null);
  const [vncWsPath, setVncWsPath] = useState<string | null>(null);
  const [showSyslog, setShowSyslog] = useState(false);
  const [syslogRunning, setSyslogRunning] = useState(false);
  const [syslogEntries, setSyslogEntries] = useState<Array<{
    timestamp: string; pid: number; process: string;
    level: string; message: string; subsystem: string; category: string;
  }>>([]);
  const [syslogFilter, setSyslogFilter] = useState('');
  const syslogEndRef = useRef<HTMLDivElement>(null);
  const syslogAutoScrollRef = useRef(true);

  // Fetch device info
  useEffect(() => {
    if (!ws.connected || !deviceId) return;
    ws.sendRestApi('GET', `/v1/device/view/${encodeURIComponent(deviceId)}`).then(res => {
      setDevice(res.body?.data || null);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [ws, deviceId]);

  // Fetch video transport type — determines whether to render VncViewer
  // (docker-android emulators) or the default scrcpy DeviceViewer.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    void ws.sendRestApi('GET', `/v1/devices/${encodeURIComponent(deviceId)}/video-transport`).then((r: any) => {
      if (cancelled) return;
      const data = r?.body?.data ?? {};
      setVideoTransport(data.transport === 'vnc' ? 'vnc' : 'scrcpy');
      setVncWsPath(data.wsPath ?? null);
    });
    return () => { cancelled = true; };
  }, [deviceId, ws]);

  // DeviceViewer drives the live stream. When it fires onStreamReady we treat
  // the stream as live and clear any prior polling/error state.
  const handleStreamReady = useCallback((info: { screenWidth: number; screenHeight: number; backend: string }) => {
    setStreaming(true);
    setStreamError(null);
    if (info.backend) setStreamBackend(info.backend);
  }, []);

  const handleStreamError = useCallback((err: string) => {
    setStreamError(err);
    // If the stream errors out the sidebar "Stream: Live" badge must flip to
    // the warning state — leaving streaming=true while showing a red error
    // banner produces contradictory UI.
    setStreaming(false);
  }, []);

  // Handle live stream failure (scrcpy died and exhausted restarts)
  useEffect(() => {
    return ws.subscribe('device-stream-failed', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      setStreaming(false);
      setStreamBackend(null);
      setStreamError('Live stream failed');
    });
  }, [ws, deviceId]);

  // Stream error subscription
  useEffect(() => {
    return ws.subscribe('error', (msg: { error: string }) => {
      if (msg.error?.toLowerCase().includes('stream')) {
        setStreamError('Live stream unavailable');
      }
    });
  }, [ws]);

  // Automation log subscription
  useEffect(() => {
    return ws.subscribe('automation-log', (msg: AutomationLogMessage) => {
      setAutomationLog(prev => [...prev.slice(-50), msg]);
    });
  }, [ws]);

  // Subscribe to capture-status WebSocket messages
  useEffect(() => {
    return ws.subscribe('capture-status', (msg: CaptureStatusMessage) => {
      if (msg.deviceId !== deviceId) return;
      if (msg.subsystems) setCaptureSubsystems(msg.subsystems);
      if (msg.status === 'capturing') {
        setCapturing(true);
        if (msg.sessionId) setCaptureSessionId(msg.sessionId);
      } else if (msg.status === 'stopped') {
        setCapturing(false);
        setCaptureSubsystems(null);
      } else if (msg.status === 'error') {
        setCapturing(false);
      }
    });
  }, [ws, deviceId]);

  // Subscribe to busy-timeout-warning messages
  useEffect(() => {
    return ws.subscribe('busy-timeout-warning', (msg: BusyTimeoutWarningMessage) => {
      if (msg.deviceId !== deviceId) return;
      setBusyWarning(msg.remainingSeconds);
    });
  }, [ws, deviceId]);

  // Clear warning when device is no longer busy (capture stopped, etc.)
  useEffect(() => {
    if (!capturing && busyWarning !== null) {
      setBusyWarning(null);
    }
  }, [capturing, busyWarning]);

  // Subscribe to iOS syslog entries
  useEffect(() => {
    return ws.subscribe('ios-syslog', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      setSyslogEntries(prev => {
        const combined = [...prev, ...msg.entries];
        // Keep last 5000 entries in memory
        return combined.length > 5000 ? combined.slice(combined.length - 5000) : combined;
      });
    });
  }, [ws, deviceId]);

  // Subscribe to ios-syslog-stopped
  useEffect(() => {
    return ws.subscribe('ios-syslog-stopped', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      setSyslogRunning(false);
    });
  }, [ws, deviceId]);

  // Auto-scroll syslog to bottom when new entries arrive
  useEffect(() => {
    if (showSyslog && syslogAutoScrollRef.current && syslogEndRef.current) {
      syslogEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [syslogEntries, showSyslog]);

  // Stop syslog stream when navigating away
  useEffect(() => {
    return () => {
      if (syslogRunning && deviceId) {
        ws.sendMessage('ios-syslog/stop', { deviceId });
      }
    };
  }, [syslogRunning, deviceId, ws]);

  const hasScope = auth?.hasScope ?? (() => true);

  // Check if NordVPN credentials are configured
  useEffect(() => {
    if (!ws.connected) return;
    if (!hasScope('core.settings:read')) return;
    ws.sendRestApi('GET', '/v1/settings/list').then(res => {
      const data: Setting[] = res.body?.data || [];
      const hasUser = data.some((s: Setting) => s.key === 'nordvpn_username');
      const hasPass = data.some((s: Setting) => s.key === 'nordvpn_password');
      setHasNordCredentials(hasUser && hasPass);
    }).catch(() => {});
  }, [ws]);

  // Poll capture status on mount (handles page refresh during active capture)
  useEffect(() => {
    if (!ws.connected || !deviceId) return;
    if (!hasScope('core.traffic:read')) return;
    ws.sendRestApi('GET', `/v1/capture/status/${encodeURIComponent(deviceId)}`).then(res => {
      if (res.body?.data?.capturing) {
        setCapturing(true);
        setCaptureSessionId(res.body.data.sessionId || null);
        if (res.body.data.subsystems) setCaptureSubsystems(res.body.data.subsystems);
      }
    }).catch(() => {});
  }, [ws, deviceId]);

  // Cleanup on unmount — stop capture if actively capturing
  useEffect(() => {
    return () => {
      if (capturing && deviceId) {
        // Fire-and-forget stop on unmount
        ws.sendRestApi('POST', '/v1/capture/stop', { deviceId }).catch(() => {});
      }
    };
  }, [capturing, deviceId, ws]);

  // Key forwarding — page-level, not canvas-related.
  useEffect(() => {
    if (!deviceId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.target as HTMLElement).closest?.('.live-log-wrapper')) return;
      e.preventDefault();
      ws.sendMessage('device-key', { deviceId, key: e.key });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [ws, deviceId]);

  // DOM capture: fetch DOM via ADB, store in sessionStorage, open selector debugger
  const handleCaptureDom = useCallback(async () => {
    if (!deviceId || capturingDom) return;
    setCapturingDom(true);
    try {
      const res = await ws.sendRestApi('GET', `/v1/device/dom/${encodeURIComponent(deviceId)}`);
      const dom = res.body?.data?.dom || '';
      sessionStorage.setItem('darkride_dom', dom);
      window.open('/ui/selector-debugger?fromStorage=1', '_blank');
    } catch (err: any) {
      toast.error(err?.message || 'DOM capture failed');
    } finally {
      setCapturingDom(false);
    }
  }, [deviceId, capturingDom, ws, toast]);

  // Start traffic capture.
  // Accepts an optional form-provided options object (used by the Capture tab).
  // If no options are provided it falls back to the DeviceView-level proxy /
  // TLS state, so the existing DeviceViewer extraAction primary button still
  // works without form inputs (Task 5 will unify the entry point).
  const handleStartCapture = useCallback(async (opts?: {
    proxyMode?: 'none' | 'normal' | 'nordvpn';
    proxyCountry?: string;
    tlsProfile?: 'chrome' | 'okhttp' | 'default';
  }) => {
    if (!deviceId || capturing) return;
    try {
      const effectiveProxyMode = opts?.proxyMode ?? proxyMode;
      const effectiveProxyCountry = opts?.proxyCountry ?? proxyCountry;
      const effectiveTlsProfile = opts?.tlsProfile ?? tlsProfile;
      const body: any = { deviceId, tlsProfile: effectiveTlsProfile };
      if (effectiveProxyMode !== 'none') {
        body.proxyMode = effectiveProxyMode;
        if (effectiveProxyMode === 'nordvpn') body.proxyCountry = effectiveProxyCountry;
      }
      const res = await ws.sendRestApi('POST', '/v1/capture/start', body);
      if (res.body?.data?.sessionId) {
        setCapturing(true);
        setCaptureSessionId(res.body.data.sessionId);
        toast.success('Capture started');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to start capture');
    }
  }, [deviceId, capturing, tlsProfile, proxyMode, proxyCountry, ws, toast]);

  // Stop traffic capture
  const handleStopCapture = useCallback(async () => {
    if (!deviceId) return;
    try {
      await ws.sendRestApi('POST', '/v1/capture/stop', { deviceId });
      setCapturing(false);
      setCaptureSubsystems(null);
      toast.success('Capture stopped');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to stop capture');
    }
  }, [deviceId, ws, toast]);

  // Exit capture view
  const handleExitCaptureView = () => {
    setCaptureSessionId(null);
    setCaptureSubsystems(null);
  };

  // When the DeviceViewer's primary "Start capture" button is clicked we kick
  // off the capture with DeviceView-level defaults and then route the user to
  // the Capture tab so the live-session UI (and any subsystem feedback) is
  // immediately visible. This unifies the entry point with the header's
  // "Capturing" badge link.
  const handleStartCaptureAndNavigate = useCallback(async () => {
    await handleStartCapture();
    navigate(`/ui/devices/${deviceId}/capture`);
  }, [handleStartCapture, navigate, deviceId]);

  // Consumer-specific DeviceViewer actions. Memoized so the viewer doesn't
  // re-register buttons on every render.
  const extraActions: DeviceAction[] = useMemo(() => [
    capturing
      ? { key: 'capture-stop',  label: 'Stop capture',   icon: '⏹', onClick: handleStopCapture,                placement: 'primary' as const }
      : { key: 'capture-start', label: 'Start capture',  icon: '●', onClick: handleStartCaptureAndNavigate,    placement: 'primary' as const },
    { key: 'capture-dom', label: 'Capture DOM', icon: '📄', onClick: handleCaptureDom, placement: 'overflow' as const },
  ], [capturing, handleStartCaptureAndNavigate, handleStopCapture, handleCaptureDom]);

  if (auth && !auth.hasScope('core.devices:read')) return <AccessDenied scope="core.devices:read" />;
  if (loading) return <LoadingSpinner large center />;
  if (!device) return <div className="empty-state">Device not found</div>;

  // --- Tab routing ---
  // Only redirect AFTER `device` has loaded from the DB — otherwise we'd briefly
  // redirect away from e.g. `/crashes` on iOS before the platform is known.
  const availableTabs: TabKey[] = device.platform === 'ios'
    ? ['details', 'apps', 'capture', 'crashes', 'processes']
    : ['details', 'apps', 'capture'];

  if (!tabParam || !availableTabs.includes(tabParam as TabKey)) {
    return <Navigate to={`/ui/devices/${deviceId}/details`} replace />;
  }

  const tab: TabKey = tabParam as TabKey;

  const tabStrip = (
    <nav
      className="tab-bar"
      data-testid="dv-tab-strip"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        background: 'var(--bg-primary, #0f1117)',
        margin: 0,
      }}
    >
      {availableTabs.map(t => (
        <Link
          key={t}
          to={`/ui/devices/${deviceId}/${t}`}
          data-testid={tab === t ? `dv-tab-active-${t}` : `dv-tab-${t}`}
          className={tab === t ? 'tab-btn active' : 'tab-btn'}
          style={{ textDecoration: 'none' }}
        >
          {capitalizeTab(t)}
        </Link>
      ))}
    </nav>
  );

  const canManageTraffic = !auth || auth.hasScope('core.traffic:manage');
  const canManageDevice = !auth || auth.hasScope('core.devices:manage');

  const sidebarCard = (
    <div className="card">
      {/*
        Device Info rows are moved to the Details tab in Task 3; for Task 2 we
        keep just the actions + capture controls so existing features remain
        reachable while the redesign is in flight.
      */}
      {streamError && (
        <div className="info-row" style={{ color: 'var(--color-warning, #f59e0b)', fontSize: 12 }} data-testid="stream-error">
          {streamError}
        </div>
      )}
      {captureSubsystems && (() => {
        const subsystems = [
          ['mitmproxy', 'Proxy'],
          ['certInjection', 'Cert'],
          ['wireguard', 'Tunnel'],
          ['connectivity', 'Test'],
        ] as const;
        const allOk = subsystems.every(([k]) => captureSubsystems[k] === 'ok');
        const anyPending = subsystems.some(([k]) => captureSubsystems[k] === 'pending');
        const failures = subsystems.filter(([k]) => captureSubsystems[k] === 'error' || captureSubsystems[k] === 'warning');

        if (allOk) return null; // Clean — no noise needed

        return (
          <div data-testid="capture-subsystems" style={{ marginTop: 8, fontSize: 12 }}>
            {anyPending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                <span className="spinner-tiny" />
                <span>Starting capture... {subsystems.filter(([k]) => captureSubsystems[k] === 'ok').length}/4</span>
              </div>
            )}
            {failures.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {failures.map(([key, label]) => (
                  <div key={key} data-testid={`subsystem-${key}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <StatusBadge status={captureSubsystems[key] === 'error' ? 'error' : 'warning'} />
                    <span style={{ color: captureSubsystems[key] === 'error' ? 'var(--status-error, #ef4444)' : 'var(--status-warn, #f59e0b)' }}>{label} {captureSubsystems[key]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
        {device.platform !== 'ios' && (
          <>
            <button
              className="btn btn-sm"
              onClick={async () => {
                if (!deviceId || reprobing) return;
                setReprobing(true);
                try {
                  const res = await ws.sendRestApi('POST', `/v1/device/reprobe/${encodeURIComponent(deviceId)}`);
                  if (res.body?.data) setDevice(res.body.data);
                  toast.success('Device properties updated');
                } catch (err: any) { toast.error(err?.message || 'Re-probe failed'); }
                setReprobing(false);
              }}
              disabled={reprobing}
              data-testid="btn-reprobe"
            >
              {reprobing ? 'Probing...' : 'Re-probe Properties'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('terminal:open', { detail: { deviceId: device.id, deviceName: device.name } }));
              }}
              data-testid="btn-open-terminal"
            >
              Open Terminal
            </button>
          </>
        )}
        {device.platform === 'ios' && (
          <>
            <button
              className="btn btn-sm"
              onClick={async () => {
                if (!deviceId || pairing) return;
                setPairing(true);
                try {
                  await ws.sendRestApi('POST', `/v1/device/pair/${encodeURIComponent(deviceId)}`);
                  // Refresh device info
                  const res = await ws.sendRestApi('GET', `/v1/device/view/${encodeURIComponent(deviceId)}`);
                  if (res.body?.data) setDevice(res.body.data);
                  toast.success('Device paired successfully');
                } catch (err: any) { toast.error(err?.message || 'Pairing failed'); }
                setPairing(false);
              }}
              disabled={pairing}
              data-testid="btn-pair-ios"
            >
              {pairing ? 'Pairing...' : 'Pair Device (Trust)'}
            </button>
            <button
              className="btn btn-sm"
              data-testid="btn-ios-reboot"
              onClick={async () => {
                if (!deviceId || !window.confirm('Reboot this device?')) return;
                try {
                  await ws.sendRestApi('POST', `/v1/device/command/${encodeURIComponent(deviceId)}`, { command: 'reboot' });
                  toast.success('Device rebooting...');
                } catch (err: any) { toast.error(err?.message || 'Reboot failed'); }
              }}
            >
              Reboot
            </button>
            <button
              className="btn btn-sm"
              data-testid="btn-ios-shutdown"
              onClick={async () => {
                if (!deviceId || !window.confirm('Shut down this device?')) return;
                try {
                  await ws.sendRestApi('POST', `/v1/device/command/${encodeURIComponent(deviceId)}`, { command: 'shutdown' });
                  toast.success('Device shutting down...');
                } catch (err: any) { toast.error(err?.message || 'Shutdown failed'); }
              }}
            >
              Shutdown
            </button>
            <button
              className="btn btn-sm"
              data-testid="btn-ios-sleep"
              onClick={async () => {
                if (!deviceId) return;
                try {
                  await ws.sendRestApi('POST', `/v1/device/command/${encodeURIComponent(deviceId)}`, { command: 'sleep' });
                  toast.success('Device sleeping...');
                } catch (err: any) { toast.error(err?.message || 'Sleep failed'); }
              }}
            >
              Sleep
            </button>
            <button
              className="btn btn-sm"
              data-testid="btn-ios-syslog"
              onClick={async () => {
                if (!deviceId) return;
                if (!showSyslog) {
                  setShowSyslog(true);
                  if (!syslogRunning) {
                    setSyslogEntries([]);
                    ws.sendMessage('ios-syslog/start', { deviceId });
                    setSyslogRunning(true);
                  }
                } else {
                  setShowSyslog(false);
                }
              }}
              style={{ background: showSyslog ? 'var(--accent-color, #4a9eff)' : undefined }}
            >
              {showSyslog ? 'Hide Syslog' : 'Syslog'}
            </button>
          </>
        )}
        {/*
          Proxy mode, TLS profile, Start/Stop capture, and Exit-capture-view
          buttons moved into the Capture tab in Task 4. The sidebarCard is kept
          only for the interim iOS-specific actions + subsystem indicators that
          will be relocated to the Crashes / Processes tabs in Task 6.
        */}
        {captureSessionId != null && !capturing && (
          <button
            className="btn btn-sm"
            onClick={handleExitCaptureView}
            data-testid="btn-exit-capture"
          >
            Exit Capture View
          </button>
        )}
      </div>
    </div>
  );

  const canvasSection = (
    <div className="device-canvas-container">
      {videoTransport === 'vnc' && vncWsPath ? (
        <VncViewer
          serial={deviceId!}
          wsPath={vncWsPath}
          onReady={() => handleStreamReady({ screenWidth: 0, screenHeight: 0, backend: 'vnc' })}
          onError={(e) => handleStreamError(e.message)}
        />
      ) : (
        <DeviceViewer
          deviceId={deviceId!}
          captureSessionId={captureSessionId ?? undefined}
          extraActions={extraActions}
          onStreamReady={handleStreamReady}
          onError={handleStreamError}
        />
      )}
      {automationLog.length > 0 && (
        <div className="automation-overlay" data-testid="automation-overlay">
          <strong>Automation Running</strong>
          <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {automationLog.slice(-3).map((l, i) => (
              <div key={i}>Line {l.line}: {l.message}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  // iOS syslog panel
  const SYSLOG_LEVEL_COLORS: Record<string, string> = {
    ERROR: '#ff5f5f',
    FAULT: '#ff5f5f',
    WARNING: '#f0c040',
    NOTICE: 'inherit',
    INFO: '#9ec8ff',
    DEBUG: '#888',
    USER_ACTION: '#88d8b0',
  };

  const filteredSyslogEntries = syslogFilter
    ? syslogEntries.filter(e =>
        e.process.toLowerCase().includes(syslogFilter.toLowerCase()) ||
        e.message.toLowerCase().includes(syslogFilter.toLowerCase()) ||
        e.subsystem.toLowerCase().includes(syslogFilter.toLowerCase()) ||
        String(e.pid).includes(syslogFilter)
      )
    : syslogEntries;

  const syslogPanel = showSyslog ? (
    <div
      data-testid="ios-syslog-panel"
      style={{
        marginTop: 12,
        border: '1px solid var(--border-color, #333)',
        borderRadius: 6,
        overflow: 'hidden',
        background: '#0d0d14',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        background: 'var(--bg-secondary, #1a1a2e)',
        borderBottom: '1px solid var(--border-color, #333)',
      }}>
        <span style={{ fontWeight: 600, fontSize: 13, flexShrink: 0 }}>iOS Syslog</span>
        <span style={{
          fontSize: 11, padding: '1px 6px', borderRadius: 10,
          background: syslogRunning ? '#22c55e22' : '#ef444422',
          color: syslogRunning ? '#4ade80' : '#f87171',
          border: `1px solid ${syslogRunning ? '#22c55e55' : '#ef444455'}`,
          flexShrink: 0,
        }}>
          {syslogRunning ? 'Live' : 'Stopped'}
        </span>
        <input
          type="text"
          placeholder="Filter by process, message, or PID..."
          value={syslogFilter}
          onChange={e => setSyslogFilter(e.target.value)}
          style={{
            flex: 1, background: 'var(--bg-primary, #111)', border: '1px solid var(--border-color, #333)',
            borderRadius: 4, padding: '2px 8px', fontSize: 12, color: 'inherit', minWidth: 0,
          }}
        />
        <button
          className="btn btn-sm"
          onClick={() => setSyslogEntries([])}
          style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
        >
          Clear
        </button>
        {syslogRunning ? (
          <button
            className="btn btn-sm"
            onClick={() => {
              if (!deviceId) return;
              ws.sendMessage('ios-syslog/stop', { deviceId });
              setSyslogRunning(false);
            }}
            style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0, background: '#ef444422', color: '#f87171' }}
          >
            Stop
          </button>
        ) : (
          <button
            className="btn btn-sm"
            onClick={() => {
              if (!deviceId) return;
              setSyslogEntries([]);
              ws.sendMessage('ios-syslog/start', { deviceId });
              setSyslogRunning(true);
            }}
            style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0, background: '#22c55e22', color: '#4ade80' }}
          >
            Start
          </button>
        )}
        <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>
          {filteredSyslogEntries.length} entries
        </span>
      </div>
      <div
        style={{ height: 320, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: '1.5' }}
        onScroll={e => {
          const el = e.currentTarget;
          syslogAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
        }}
      >
        {filteredSyslogEntries.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.4, textAlign: 'center' }}>
            {syslogRunning ? 'Waiting for log entries...' : 'No entries. Start the syslog stream.'}
          </div>
        ) : (
          filteredSyslogEntries.map((entry, i) => (
            <div
              key={i}
              style={{
                display: 'flex', gap: 6, padding: '1px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.03)',
                color: SYSLOG_LEVEL_COLORS[entry.level] || 'inherit',
              }}
            >
              <span style={{ opacity: 0.45, flexShrink: 0, minWidth: 80 }}>
                {entry.timestamp ? entry.timestamp.slice(11, 23) : ''}
              </span>
              <span style={{ opacity: 0.55, flexShrink: 0, minWidth: 40, textAlign: 'right' }}>
                {entry.pid || ''}
              </span>
              <span style={{ flexShrink: 0, minWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.75 }}>
                {entry.process}
              </span>
              <span style={{ flexShrink: 0, minWidth: 52, opacity: 0.6 }}>
                [{entry.level}]
              </span>
              <span style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                {entry.message}
              </span>
            </div>
          ))
        )}
        <div ref={syslogEndRef} />
      </div>
    </div>
  ) : null;

  // iOS device view: canvas with WDA streaming + gesture hints
  const iosGestureHints = (
    <div className="ios-gesture-hints" style={{ display: 'flex', gap: 8, padding: '8px 0', fontSize: 11, opacity: 0.6 }}>
      <span>Swipe from left edge: Back</span>
      <span>|</span>
      <span>Swipe up from bottom: Home</span>
      <span>|</span>
      <span>Swipe up + hold: App Switcher</span>
    </div>
  );

  const isIos = device.platform === 'ios';

  return (
    <div
      className="device-page"
      data-testid="device-view"
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      <header
        className="device-page-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-color, #333)',
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18 }}>{device.name || device.id}</h1>
        <StatusBadge status={device.lastSeen ? 'online' : 'offline'} />
        {capturing && (
          <Link
            to={`/ui/devices/${deviceId}/capture`}
            data-testid="header-capturing-badge"
            style={{
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: 'inherit',
            }}
          >
            <StatusBadge status="running" />
            <span>Capturing</span>
          </Link>
        )}
        {busyWarning !== null && (
          <span className="busy-timeout-warning" data-testid="busy-warning">
            Device will be put to sleep in ~{Math.ceil(busyWarning / 60)} min due to inactivity.
          </span>
        )}
      </header>
      <div
        className="device-page-body"
        style={{
          display: 'grid',
          // Tighter phone-view column — the old 420px max was too wide for a
          // portrait device and crowded the right panel. 280-360px is plenty.
          gridTemplateColumns: 'clamp(280px, 22vw, 360px) 1fr',
          gap: 8,
          padding: 0,
          // Fill remaining vertical space instead of hard-calcing against
          // 100vh — keeps us robust to sidebar chrome or future header size
          // changes and avoids the main scrollbar we saw before.
          flex: 1,
          minHeight: 0,
        }}
      >
        <aside
          className="device-page-left"
          style={{ overflow: 'auto', minWidth: 0 }}
        >
          {canvasSection}
          {isIos && iosGestureHints}
        </aside>
        <section
          className="device-page-right"
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
            // The right column doesn't scroll itself — each tab's content
            // decides whether it scrolls internally (Capture tab delegates
            // scrolling to TrafficTable's built-in scroll area). This avoids
            // the "two scrollbars" bug when the traffic view is mounted.
          }}
        >
          {tabStrip}
          <div
            className="device-page-tab-content"
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              // Only non-capture tabs scroll internally; the Capture tab's
              // child (CaptureLiveTrafficView) handles its own scrolling.
              overflow: tab === 'capture' && capturing ? 'hidden' : 'auto',
              padding: tab === 'capture' && capturing ? 0 : '12px 0',
              gap: 12,
            }}
          >
            {tab === 'details' && (
              <DetailsTab
                device={device}
                streaming={streaming}
                streamBackend={streamBackend}
                onDeviceChange={setDevice}
                onRunSetup={() => setShowSetupModal(true)}
              />
            )}
            {tab === 'apps' && <AppsTab deviceId={deviceId!} />}
            {tab === 'capture' && (
              <CaptureTab
                deviceId={deviceId!}
                capturing={capturing}
                sessionId={captureSessionId}
                platform={device.platform ?? 'android'}
                isRooted={!!device.isRooted}
                canManageTraffic={canManageTraffic}
                hasNordCredentials={hasNordCredentials}
                captureSubsystems={captureSubsystems}
                streamError={streamError}
                onStartCapture={(opts) => handleStartCapture(opts)}
                onStopCapture={handleStopCapture}
              />
            )}
            {tab === 'crashes' && isIos && <CrashesTab deviceId={deviceId!} />}
            {tab === 'processes' && isIos && <ProcessesTab deviceId={deviceId!} />}
            {isIos && tab === 'details' && sidebarCard}
            {isIos && tab !== 'capture' && (
              <div style={{ marginTop: 4 }}>
                <WireGuardSetup deviceId={device.id} />
              </div>
            )}
            {isIos && tab !== 'capture' && syslogPanel}
          </div>
        </section>
      </div>
      {showSetupModal && (
        <SetupWizardModal
          device={device}
          onClose={() => setShowSetupModal(false)}
          onSetupComplete={async () => {
            setShowSetupModal(false);
            // Refresh device info to pick up updated setupVersion
            if (deviceId) {
              try {
                const res = await ws.sendRestApi('GET', `/v1/device/view/${encodeURIComponent(deviceId)}`);
                if (res.body?.data) setDevice(res.body.data);
              } catch {}
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DetailsTab — Device Info rows + Setup card.
// Device Info rows are ported verbatim from the old pre-redesign sidebarCard
// (see commit 4372780 for the original). Name-edit state lives here now
// because the old DeviceView-level state was only consumed by these rows.
// ---------------------------------------------------------------------------
function DetailsTab({
  device,
  streaming,
  streamBackend,
  onDeviceChange,
  onRunSetup,
}: {
  device: Device;
  streaming: boolean;
  streamBackend: string | null;
  onDeviceChange: (d: Device) => void;
  onRunSetup: () => void;
}) {
  const ws = useWebSocket();
  const toast = useToast();
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');

  const handleSaveName = async () => {
    try {
      const res = await ws.sendRestApi('PUT', `/v1/device/${encodeURIComponent(device.id)}`, { name: nameInput });
      if (res.body?.data) onDeviceChange(res.body.data);
      toast.success('Device name saved');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save device name');
    }
    setEditingName(false);
  };

  const needsSetup = device.platform !== 'ios' && (device.setupVersion ?? 0) < CURRENT_SETUP_VERSION;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="details-tab">
      <div className="card">
        <h3 style={{ marginBottom: 12, fontSize: 15 }}>Device Info</h3>
        <div className="info-row">
          <span className="info-label">Name</span>
          {editingName ? (
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                className="form-input"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingName(false); }}
                style={{ fontSize: 13, padding: '2px 6px', width: 120 }}
                autoFocus
                data-testid="name-input"
              />
              <button className="btn btn-sm" onClick={handleSaveName} data-testid="name-save">Save</button>
              <button className="btn btn-sm" onClick={() => setEditingName(false)} data-testid="name-cancel">Cancel</button>
            </span>
          ) : (
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span>{device.name || 'Unnamed'}</span>
              <button
                className="btn btn-sm"
                onClick={() => { setNameInput(device.name || ''); setEditingName(true); }}
                style={{ fontSize: 11, padding: '1px 5px' }}
                data-testid="name-edit"
              >
                &#9998;
              </button>
            </span>
          )}
        </div>
        <div className="info-row">
          <span className="info-label">{device.platform === 'ios' ? 'UDID' : 'ADB ID'}</span>
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{device.id}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Platform</span>
          <span>{device.platform === 'ios' ? 'iOS' : 'Android'}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Status</span>
          <StatusBadge status={device.lastSeen ? 'online' : 'offline'} />
        </div>
        {device.platform !== 'ios' && (
          <div className="info-row">
            <span className="info-label">Rooted</span>
            <span>{device.isRooted ? 'Yes' : 'No'}</span>
          </div>
        )}
        {device.platform !== 'ios' && (
          <div className="info-row">
            <span className="info-label">Setup Version</span>
            <span>{device.setupVersion}</span>
          </div>
        )}
        {device.platform !== 'ios' && (
          <div className="info-row">
            <span className="info-label">Stream</span>
            <StatusBadge status={streaming ? (streamBackend === 'scrcpy' ? 'running' : 'online') : 'warning'} />
            <span style={{ marginLeft: 4 }}>{streaming ? (streamBackend || 'Live') : 'Connecting...'}</span>
          </div>
        )}
        {device.batteryLevel !== null && device.batteryLevel !== undefined && (
          <div className="info-row">
            <span className="info-label">Battery</span>
            <span>{device.batteryLevel}%</span>
          </div>
        )}
        {device.manufacturer && (
          <div className="info-row">
            <span className="info-label">Manufacturer</span>
            <span>{device.manufacturer}</span>
          </div>
        )}
        {device.model && (
          <div className="info-row">
            <span className="info-label">Model</span>
            <span>{device.model}</span>
          </div>
        )}
        {device.platform === 'ios' && device.iosVersion && (
          <div className="info-row">
            <span className="info-label">iOS</span>
            <span>{device.iosVersion}</span>
          </div>
        )}
        {device.platform === 'ios' && device.wifiAddress && (
          <div className="info-row">
            <span className="info-label">Wi-Fi MAC</span>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{device.wifiAddress}</span>
          </div>
        )}
        {device.platform === 'ios' && device.wifiSsid && (
          <div className="info-row">
            <span className="info-label">Wi-Fi Network</span>
            <span>{device.wifiSsid}</span>
          </div>
        )}
        {device.platform === 'ios' && device.bluetoothAddress && (
          <div className="info-row">
            <span className="info-label">Bluetooth MAC</span>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{device.bluetoothAddress}</span>
          </div>
        )}
        {device.platform === 'ios' && device.phoneNumber && (
          <div className="info-row">
            <span className="info-label">Phone Number</span>
            <span>{device.phoneNumber}</span>
          </div>
        )}
        {device.platform !== 'ios' && device.androidVersion && (
          <div className="info-row">
            <span className="info-label">Android</span>
            <span>{device.androidVersion}{device.apiLevel ? ` (API ${device.apiLevel})` : ''}</span>
          </div>
        )}
        {device.cpuAbi && (
          <div className="info-row">
            <span className="info-label">CPU ABI</span>
            <span>{device.cpuAbi}</span>
          </div>
        )}
        {device.serialNumber && (
          <div className="info-row">
            <span className="info-label">Serial</span>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{device.serialNumber}</span>
          </div>
        )}
        {device.bootloaderLocked !== null && (
          <div className="info-row">
            <span className="info-label">Bootloader</span>
            <span style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 4,
              background: device.bootloaderLocked ? 'var(--color-success, #22c55e)' : 'var(--color-warning, #f59e0b)',
              color: '#fff',
            }}>
              {device.bootloaderLocked ? 'Locked' : 'Unlocked'}
            </span>
          </div>
        )}
      </div>
      {device.platform !== 'ios' && (
        <div className="card" data-testid="setup-card">
          <h3 style={{ marginBottom: 12, fontSize: 15 }}>Setup</h3>
          {needsSetup ? (
            <>
              <p style={{ marginBottom: 8, fontSize: 13, opacity: 0.8 }}>
                This device is missing required setup steps (version {device.setupVersion ?? 0} of {CURRENT_SETUP_VERSION}).
              </p>
              <button
                className="btn btn-primary"
                onClick={onRunSetup}
                data-testid="btn-run-setup"
                style={{
                  background: 'var(--color-warning, #f59e0b)',
                  color: '#fff',
                  borderColor: 'var(--color-warning, #f59e0b)',
                }}
              >
                Run setup
              </button>
            </>
          ) : (
            <>
              <p style={{ marginBottom: 8, fontSize: 13, opacity: 0.7 }}>
                Device is fully set up (version {CURRENT_SETUP_VERSION}).
              </p>
              <button
                className="btn btn-sm"
                onClick={onRunSetup}
                data-testid="btn-rerun-setup"
              >
                Re-run setup
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CaptureTab — Start-capture form (when idle) + live-session view (when
// capturing). Owns its own form state for proxy / TLS selections. On Start
// it calls onStartCapture(opts); status polling or the capture-status WS
// subscription flips `capturing` on the parent, which flips the tab into
// the live-session view.
// ---------------------------------------------------------------------------
/**
 * Live traffic list scoped to a single device. Fetches the initial page from
 * /v1/traffic/list?deviceId=... and appends rows as `traffic-entry` WS events
 * arrive for this device. Kept intentionally small — full-fidelity filtering,
 * pagination, and detail views live on the standalone Traffic page.
 */
function CaptureLiveTrafficView({
  deviceId,
  sessionId,
}: {
  deviceId: string;
  /** When set, initial fetch + live filter scope to this session only. Prevents
   *  old-session traffic from "pre-populating" the view on a fresh capture. */
  sessionId: number | null;
}) {
  const ws = useWebSocket();
  const handleReplay = useTrafficReplay();
  const [entries, setEntries] = useState<CapturedTrafficEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [wsFrames, setWsFrames] = useState<Map<number, WebSocketMessageEntry[]>>(new Map());

  useEffect(() => {
    if (!ws.connected || !deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        params.set('deviceId', deviceId);
        if (sessionId != null) params.set('sessionId', String(sessionId));
        params.set('limit', '50');
        params.set('sortBy', 'capturedAt');
        // Ascending order so newest entries land at the bottom — TrafficTable's
        // live-mode auto-scroll then keeps the newest visible (tail-log style).
        params.set('sortDir', 'asc');
        const res = await ws.sendRestApi('GET', `/v1/traffic/list?${params}`);
        if (cancelled) return;
        const data = res.body?.data;
        const items: CapturedTrafficEntry[] = data?.items ?? (Array.isArray(data) ? data : []);
        setEntries(items);
      } catch {
        // ignore — list stays empty
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ws, deviceId, sessionId]);

  useEffect(() => {
    const unsubEntry = ws.subscribe('traffic-entry', (msg: any) => {
      const e = msg.entry;
      if (!e || e.deviceId !== deviceId) return;
      // When a specific session is active, ignore entries from other (past)
      // sessions for this device — keeps the view scoped to "this capture".
      if (sessionId != null && e.sessionId !== sessionId) return;
      const entry: CapturedTrafficEntry = {
        id: e.id,
        sessionId: e.sessionId,
        deviceId: e.deviceId,
        requestMethod: e.requestMethod,
        requestUrl: e.requestUrl,
        requestHeaders: e.requestHeaders,
        requestBody: e.requestBody,
        responseStatus: e.responseStatus,
        responseHeaders: e.responseHeaders ?? null,
        responseBody: e.responseBody,
        type: e.trafficType || e.type,
        wsMessageCount: e.wsMessageCount ?? null,
        capturedAt: e.capturedAt,
        matchedRules: e.matchedRules ?? null,
        responseContentType: e.responseContentType ?? null,
        hasImage: e.hasImage ?? false,
      };
      // Append (newest at bottom) so the live tail matches the initial sort order.
      setEntries(prev => {
        if (prev.some(p => p.id === entry.id)) return prev;
        const next = [...prev, entry];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
    const unsubFrame = ws.subscribe('ws-frame', (msg: any) => {
      const { trafficId, frame } = msg;
      if (!trafficId) return;
      setWsFrames(prev => {
        const next = new Map(prev);
        const existing = next.get(trafficId) || [];
        next.set(trafficId, [...existing, frame]);
        return next;
      });
      setEntries(prev => prev.map(e =>
        e.id === trafficId ? { ...e, wsMessageCount: (e.wsMessageCount ?? 0) + 1 } : e,
      ));
    });
    return () => { unsubEntry(); unsubFrame(); };
  }, [ws, deviceId, sessionId]);

  const loadWsFrames = useCallback(async (id: number) => {
    try {
      const res = await ws.sendRestApi('GET', `/v1/traffic/${id}/ws-frames`);
      const frames: WebSocketMessageEntry[] = res.body?.data ?? [];
      setWsFrames(prev => new Map(prev).set(id, frames));
    } catch {
      // ignore
    }
  }, [ws]);

  // Fills the remaining vertical space in the capture tab. TrafficTable's
  // own .traffic-table-container / .traffic-main / .traffic-table-wrap stack
  // already handles the internal scrolling + selected-entry detail panel
  // docked at the bottom; we only need to give it a flex-1 parent with
  // minHeight:0 so those CSS rules can do their job without wrapping it in
  // a card that would add padding / width constraints.
  return (
    <div
      data-testid="capture-live-traffic"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <TrafficTable
        entries={entries}
        loading={loading}
        liveMode
        emptyMessage={loading ? 'Loading traffic…' : 'No traffic yet — tap around the device.'}
        onReplay={handleReplay}
        wsFrames={wsFrames}
        onLoadWsFrames={loadWsFrames}
        onClear={() => setEntries([])}
      />
    </div>
  );
}

function CaptureTab({
  deviceId,
  capturing,
  sessionId,
  platform,
  isRooted,
  canManageTraffic,
  hasNordCredentials,
  captureSubsystems,
  streamError,
  onStartCapture,
  onStopCapture,
}: {
  deviceId: string;
  capturing: boolean;
  sessionId: number | null;
  platform: 'android' | 'ios';
  isRooted: boolean;
  canManageTraffic: boolean;
  hasNordCredentials: boolean;
  captureSubsystems: CaptureSubsystemStatus | null;
  streamError: string | null;
  onStartCapture: (opts: {
    proxyMode: 'none' | 'normal' | 'nordvpn';
    proxyCountry?: string;
    tlsProfile: 'chrome' | 'okhttp' | 'default';
  }) => Promise<void>;
  onStopCapture: () => Promise<void>;
}) {
  const [proxyMode, setProxyMode] = useState<'none' | 'normal' | 'nordvpn'>('none');
  const [proxyCountry, setProxyCountry] = useState('us');
  const [tlsProfile, setTlsProfile] = useState<'chrome' | 'okhttp' | 'default'>('default');
  const [starting, setStarting] = useState(false);
  // Tracks "we were capturing at some point on this mount" so that after the
  // user clicks Stop, we keep the traffic view visible (read-only) instead of
  // wiping straight back to the Start form. Reset when they click "New capture".
  const wasCapturingRef = useRef(false);
  const [showingPastTraffic, setShowingPastTraffic] = useState(false);
  // Keyed session id — bumps when the user starts a new capture so
  // CaptureLiveTrafficView remounts and clears its entry buffer.
  const [trafficKey, setTrafficKey] = useState<string>(() => `initial-${Date.now()}`);

  // Session name rename state — click the Session #… text to rename.
  const ws = useWebSocket();
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');

  // Fetch the session's current name so we can display custom names, not
  // just "Session #123".
  useEffect(() => {
    if (sessionId == null) { setSessionName(null); return; }
    ws.sendRestApi('GET', `/v1/automation/session/${sessionId}`).then(res => {
      const name = res.body?.data?.name;
      if (typeof name === 'string') setSessionName(name);
    }).catch(() => { /* ignore — fall back to default */ });
  }, [ws, sessionId]);

  const saveSessionName = useCallback(async () => {
    if (sessionId == null) return;
    const trimmed = nameInput.trim();
    const newName = trimmed.length > 0 ? trimmed : null;
    try {
      await ws.sendRestApi('PATCH', `/v1/automation/session/${sessionId}`, { name: newName });
      setSessionName(newName);
    } catch { /* ignore */ }
    setEditingName(false);
  }, [ws, sessionId, nameInput]);

  // Clear the "initializing" state once the capture-status poll flips capturing=true.
  useEffect(() => {
    if (capturing) {
      setStarting(false);
      wasCapturingRef.current = true;
      setShowingPastTraffic(false);
    } else if (wasCapturingRef.current) {
      // Transitioned true → false: keep the traffic visible until the user
      // chooses to start a fresh capture.
      setShowingPastTraffic(true);
    }
  }, [capturing]);

  const startFreshCapture = useCallback(() => {
    setShowingPastTraffic(false);
    wasCapturingRef.current = false;
    setTrafficKey(`new-${Date.now()}`);
  }, []);

  // If the user clicked Start but a subsystem has already failed, bail out of
  // initializing so the form re-renders with the error rather than hanging.
  const subsystemFailed = captureSubsystems
    ? (['mitmproxy', 'certInjection', 'wireguard', 'connectivity'] as const).some(
        k => captureSubsystems[k] === 'error',
      )
    : false;
  useEffect(() => {
    if (subsystemFailed) setStarting(false);
  }, [subsystemFailed]);

  if (capturing || showingPastTraffic) {
    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        data-testid="capture-tab-live"
      >
        {/* Compact capture status bar — sticks at top, doesn't dominate the view. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '6px 12px',
            borderBottom: '1px solid var(--border-color)',
            flexShrink: 0,
          }}
        >
          {sessionId !== null && editingName ? (
            <input
              className="form-input"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={() => saveSessionName()}
              onKeyDown={e => {
                if (e.key === 'Enter') saveSessionName();
                if (e.key === 'Escape') setEditingName(false);
              }}
              autoFocus
              style={{ fontSize: 13, fontWeight: 500, width: 260 }}
              data-testid="capture-session-name-input"
              placeholder={`Session #${sessionId}`}
            />
          ) : (
            <span
              style={{ fontSize: 13, fontWeight: 500, cursor: sessionId !== null ? 'pointer' : 'default' }}
              data-testid="capture-session-id"
              title={sessionId !== null ? 'Click to rename' : undefined}
              onClick={() => {
                if (sessionId === null) return;
                setNameInput(sessionName ?? '');
                setEditingName(true);
              }}
            >
              {capturing
                ? (sessionId !== null ? (sessionName ?? `Session #${sessionId}`) : 'Session starting…')
                : (sessionId !== null ? `${sessionName ?? `Session #${sessionId}`} (stopped)` : 'Capture stopped')}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {sessionId !== null && canManageTraffic && (
            <>
              <button
                className="btn btn-sm"
                onClick={() => window.open(`/v1/automation/session/${sessionId}/export/har`, '_blank')}
                data-testid="btn-export-har"
                title="Download captured traffic as HAR"
              >
                Export HAR
              </button>
              <button
                className="btn btn-sm"
                onClick={() => window.open(`/v1/automation/session/${sessionId}/export/zip`, '_blank')}
                data-testid="btn-export-zip"
                title="Download full session bundle (HAR + screenshots + logs)"
              >
                Export ZIP
              </button>
            </>
          )}
          {canManageTraffic && capturing && (
            <button
              className="btn btn-sm"
              onClick={onStopCapture}
              style={{ background: 'var(--color-danger, #ef4444)', color: '#fff' }}
              data-testid="btn-stop-capture"
            >
              Stop Capture
            </button>
          )}
          {canManageTraffic && !capturing && (
            <button
              className="btn btn-sm btn-primary"
              onClick={startFreshCapture}
              data-testid="btn-new-capture"
            >
              New capture
            </button>
          )}
        </div>
        {/* Subsystem health / stream error — collapsed into a sub-bar, only when pending/failed. */}
        <div style={{ flexShrink: 0 }}>
          {captureSubsystems && (() => {
            const subsystems = [
              ['mitmproxy', 'Proxy'],
              ['certInjection', 'Cert'],
              ['wireguard', 'Tunnel'],
              ['connectivity', 'Test'],
            ] as const;
            const allOk = subsystems.every(([k]) => captureSubsystems[k] === 'ok');
            const anyPending = subsystems.some(([k]) => captureSubsystems[k] === 'pending');
            const failures = subsystems.filter(([k]) => captureSubsystems[k] === 'error' || captureSubsystems[k] === 'warning');
            if (allOk) return null;
            return (
              <div data-testid="capture-subsystems" style={{ marginTop: 12, fontSize: 12 }}>
                {anyPending && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                    <span className="spinner-tiny" />
                    <span>Starting capture... {subsystems.filter(([k]) => captureSubsystems[k] === 'ok').length}/4</span>
                  </div>
                )}
                {failures.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                    {failures.map(([key, label]) => (
                      <div key={key} data-testid={`subsystem-${key}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <StatusBadge status={captureSubsystems[key] === 'error' ? 'error' : 'warning'} />
                        <span style={{ color: captureSubsystems[key] === 'error' ? 'var(--status-error, #ef4444)' : 'var(--status-warn, #f59e0b)' }}>{label} {captureSubsystems[key]}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          {streamError && (
            <div
              style={{ marginTop: 8, fontSize: 12, color: 'var(--color-warning, #f59e0b)' }}
              data-testid="capture-stream-error"
            >
              {streamError}
            </div>
          )}
        </div>
        <CaptureLiveTrafficView key={trafficKey} deviceId={deviceId} sessionId={sessionId} />
      </div>
    );
  }

  // Initializing state: user clicked Start, POST has fired (or is in flight)
  // but capturing hasn't flipped true yet. Show subsystem progress instead of
  // rendering the form again, which would flash and look broken.
  if (starting) {
    const subsystems = captureSubsystems
      ? ([
          ['mitmproxy', 'Proxy'],
          ['certInjection', 'Cert'],
          ['wireguard', 'Tunnel'],
          ['connectivity', 'Test'],
        ] as const)
      : null;
    const okCount = subsystems
      ? subsystems.filter(([k]) => captureSubsystems![k] === 'ok').length
      : 0;
    return (
      <div
        className="card"
        data-testid="capture-tab-initializing"
        style={{ maxWidth: 480, margin: '24px auto', width: '100%' }}
      >
        <h3 style={{ marginBottom: 12, fontSize: 15 }}>Starting capture…</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span className="spinner-tiny" />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {subsystems
              ? `Initializing subsystems ${okCount}/4`
              : 'Contacting server…'}
          </span>
        </div>
        {subsystems && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            {subsystems.map(([key, label]) => {
              const state = captureSubsystems![key];
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <StatusBadge status={
                    state === 'ok' ? 'online' :
                    state === 'error' ? 'error' :
                    state === 'warning' ? 'warning' :
                    state === 'skipped' ? 'unknown' :
                    'pending' as any
                  } />
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const canStart = canManageTraffic && (platform === 'ios' || isRooted);
  const disabledReason = !canManageTraffic
    ? 'You do not have permission to manage traffic.'
    : platform !== 'ios' && !isRooted
      ? 'Device must be rooted for HTTPS capture.'
      : '';

  return (
    <div
      className="card"
      data-testid="capture-tab-start-form"
      style={{ maxWidth: 480, margin: '24px auto', width: '100%' }}
    >
      <h3 style={{ marginBottom: 12, fontSize: 15 }}>Start traffic capture</h3>
      <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
        <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, opacity: 0.8 }}>Proxy mode</span>
        <select
          className="form-input"
          value={proxyMode}
          onChange={e => setProxyMode(e.target.value as 'none' | 'normal' | 'nordvpn')}
          data-testid="capture-proxy-mode"
          style={{ display: 'block', width: '100%', fontSize: 13, padding: '6px 8px' }}
        >
          <option value="none">None</option>
          <option value="normal">HTTP proxy (rotation)</option>
          <option value="nordvpn" disabled={!hasNordCredentials}>
            NordVPN SOCKS5{!hasNordCredentials ? ' (not configured)' : ''}
          </option>
        </select>
      </label>
      {proxyMode === 'nordvpn' && (
        <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, opacity: 0.8 }}>Country</span>
          <input
            className="form-input"
            value={proxyCountry}
            onChange={e => setProxyCountry(e.target.value)}
            placeholder="us"
            data-testid="capture-proxy-country"
            style={{ display: 'block', width: '100%', fontSize: 13, padding: '6px 8px' }}
          />
        </label>
      )}
      <label style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
        <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, opacity: 0.8 }}>TLS profile</span>
        <select
          className="form-input"
          value={tlsProfile}
          onChange={e => setTlsProfile(e.target.value as 'chrome' | 'okhttp' | 'default')}
          data-testid="capture-tls-profile"
          style={{ display: 'block', width: '100%', fontSize: 13, padding: '6px 8px' }}
        >
          <option value="chrome">Chrome (Android)</option>
          <option value="okhttp">OkHttp</option>
          <option value="default">Default (no spoofing)</option>
        </select>
      </label>
      <button
        className="btn btn-primary"
        disabled={starting || !canStart}
        onClick={async () => {
          setStarting(true);
          try {
            await onStartCapture({
              proxyMode,
              proxyCountry: proxyMode === 'nordvpn' ? (proxyCountry || undefined) : undefined,
              tlsProfile,
            });
          } finally {
            setStarting(false);
          }
        }}
        data-testid="btn-start-capture"
        title={disabledReason}
        style={{
          background: 'var(--color-success, #22c55e)',
          color: '#fff',
          width: '100%',
        }}
      >
        {starting ? 'Starting…' : 'Start Capture'}
      </button>
      {disabledReason && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }} data-testid="capture-disabled-reason">
          {disabledReason}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CrashesTab — iOS crash logs list + per-log viewer. Relocated from the
// inline crash-logs modal so the list is always visible when the tab is
// active (no extra "open modal" click). Data-fetching is co-located here so
// the GET only fires while the tab is mounted.
// ---------------------------------------------------------------------------
function CrashesTab({ deviceId }: { deviceId: string }) {
  const ws = useWebSocket();
  const toast = useToast();
  const [crashLogs, setCrashLogs] = useState<Array<{ filename: string; path: string }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [crashLogContent, setCrashLogContent] = useState<string | null>(null);
  const [crashLogFilename, setCrashLogFilename] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    setLoading(true);
    ws.sendRestApi('GET', `/v1/device/ios-crashes/${encodeURIComponent(deviceId)}`)
      .then(res => {
        if (cancelled) return;
        setCrashLogs(res.body?.data || []);
      })
      .catch((err: any) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load crash logs');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [deviceId, ws, toast]);

  return (
    <div className="card" data-testid="crashes-tab">
      {crashLogContent ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>
            {crashLogFilename || 'Report'}
          </h3>
          <button
            className="btn btn-sm"
            onClick={() => { setCrashLogContent(null); setCrashLogFilename(null); }}
            data-testid="crashes-back"
          >
            Back
          </button>
        </div>
      ) : (
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Crash Logs</h3>
      )}
      {crashLogContent ? (
        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, maxHeight: '70vh', overflow: 'auto' }}>
          {crashLogContent}
        </pre>
      ) : loading ? (
        <p style={{ opacity: 0.6 }}>Loading...</p>
      ) : crashLogs && crashLogs.length === 0 ? (
        <p style={{ opacity: 0.6 }}>No crash logs found.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {(crashLogs || []).map(log => (
            <li key={log.path} style={{ borderBottom: '1px solid var(--border-color, #333)', padding: '6px 0' }}>
              <button
                className="btn btn-sm"
                style={{ textAlign: 'left', fontFamily: 'monospace', fontSize: 12 }}
                onClick={async () => {
                  if (!deviceId) return;
                  try {
                    const res = await ws.sendRestApi('GET', `/v1/device/ios-crash/${encodeURIComponent(deviceId)}?path=${encodeURIComponent(log.path)}`);
                    setCrashLogFilename(log.filename);
                    setCrashLogContent(res.body?.data?.content || '(empty)');
                  } catch (err: any) {
                    toast.error(err?.message || 'Failed to read crash log');
                  }
                }}
              >
                {log.filename}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProcessesTab — iOS running-process table. Relocated from the inline
// process-list modal. Data-fetching is co-located; the GET only fires
// while the tab is mounted.
// ---------------------------------------------------------------------------
function ProcessesTab({ deviceId }: { deviceId: string }) {
  const ws = useWebSocket();
  const toast = useToast();
  const [processList, setProcessList] = useState<Array<{ pid: number; name: string }> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    setLoading(true);
    ws.sendRestApi('GET', `/v1/device/ios-processes/${encodeURIComponent(deviceId)}`)
      .then(res => {
        if (cancelled) return;
        setProcessList(res.body?.data || []);
      })
      .catch((err: any) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load process list');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [deviceId, ws, toast]);

  return (
    <div className="card" data-testid="processes-tab">
      <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Running Processes</h3>
      {loading ? (
        <p style={{ opacity: 0.6 }}>Loading...</p>
      ) : processList && processList.length === 0 ? (
        <p style={{ opacity: 0.6 }}>No processes found.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', opacity: 0.6 }}>PID</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', opacity: 0.6 }}>Name</th>
            </tr>
          </thead>
          <tbody>
            {(processList || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map(proc => (
              <tr key={proc.pid} style={{ borderTop: '1px solid var(--border-color, #333)' }}>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>{proc.pid}</td>
                <td style={{ padding: '4px 8px' }}>{proc.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
