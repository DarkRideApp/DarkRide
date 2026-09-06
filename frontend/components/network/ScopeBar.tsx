import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Link2, Globe, Smartphone, Layers } from 'lucide-react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import type { NetworkScope } from './NetworkScopeContext';

interface Device { id: string; name?: string | null }
interface Session { id: number; name?: string | null; deviceId?: string | null }
interface ScopeBarProps {
  ws: {
    sendRestApi: (method: string, path: string) => Promise<any>;
    subscribe?: (type: string, callback: (message: any) => void) => () => void;
  };
  scope: NetworkScope;
  onScopeChange: (scope: NetworkScope) => void;
}

/**
 * ScopeBar — the Network workspace scope selector: All devices / one device /
 * one capture session. A selected session is a shareable, exportable unit
 * (HAR / ZIP via the existing export endpoints, plus a copyable deep link).
 */
export function ScopeBar({ ws, scope, onScopeChange }: ScopeBarProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [copied, setCopied] = useState(false);

  const auth = useAuthOptional();
  const canManageTraffic = auth?.hasScope('core.traffic:manage') ?? true;
  const [captureStatus, setCaptureStatus] = useState<{ capturing: boolean; sessionId: number | null }>({ capturing: false, sessionId: null });
  const [stoppingCapture, setStoppingCapture] = useState(false);
  const stoppingCaptureRef = useRef(false);

  // The selected session carries its device id; device scope already has one.
  // This lets Network remain a useful control surface after leaving DeviceView.
  const targetDeviceId = scope.kind === 'device'
    ? scope.deviceId || null
    : scope.kind === 'session'
      ? sessions.find(s => s.id === scope.sessionId)?.deviceId ?? null
      : null;

  // Reconcile status on scope changes and after entering Network from a live
  // capture. The websocket subscription below keeps the affordance current.
  useEffect(() => {
    let cancelled = false;
    setCaptureStatus({ capturing: false, sessionId: null });
    if (!targetDeviceId) return;
    ws.sendRestApi('GET', `/v1/capture/status/${encodeURIComponent(targetDeviceId)}`)
      .then(res => {
        if (cancelled) return;
        const data = res.body?.data;
        setCaptureStatus({ capturing: !!data?.capturing, sessionId: data?.sessionId ?? null });
      })
      .catch(() => {
        if (!cancelled) setCaptureStatus({ capturing: false, sessionId: null });
      });
    return () => { cancelled = true; };
  }, [ws, targetDeviceId]);

  useEffect(() => {
    if (!ws.subscribe || !targetDeviceId) return;
    return ws.subscribe('capture-status', (msg: any) => {
      if (msg.deviceId !== targetDeviceId) return;
      if (msg.status === 'capturing') {
        setCaptureStatus({ capturing: true, sessionId: msg.sessionId ?? null });
      } else if (msg.status === 'stopped' || msg.status === 'error') {
        setCaptureStatus(prev => ({ ...prev, capturing: false }));
      }
    });
  }, [ws, targetDeviceId]);

  const stopCapture = useCallback(async () => {
    if (!targetDeviceId || stoppingCaptureRef.current) return;
    stoppingCaptureRef.current = true;
    setStoppingCapture(true);
    try {
      await ws.sendRestApi('POST', '/v1/capture/stop', { deviceId: targetDeviceId });
      setCaptureStatus(prev => ({ ...prev, capturing: false }));
    } catch {
      // Keep the active state visible when the explicit stop request fails.
    } finally {
      setStoppingCapture(false);
      stoppingCaptureRef.current = false;
    }
  }, [ws, targetDeviceId]);

  useEffect(() => {
    ws.sendRestApi('GET', '/v1/device/list')
      .then(res => setDevices(res.body?.data?.devices ?? res.body?.data ?? []))
      .catch(() => setDevices([]));
    ws.sendRestApi('GET', '/v1/automation/sessions?triggerType=capture&limit=100')
      .then(res => setSessions(res.body?.data?.sessions ?? res.body?.data ?? []))
      .catch(() => setSessions([]));
  }, [ws]);

  const copyLink = useCallback(() => {
    if (scope.kind !== 'session') return;
    const link = `${location.origin}/ui/network?scope=session:${scope.sessionId}`;
    navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [scope]);

  return (
    <div className="scope-bar" data-testid="scope-bar">
      <div className="scope-kind-group" role="group" aria-label="Scope">
        <button
          className={`scope-kind-btn${scope.kind === 'all' ? ' active' : ''}`}
          data-testid="scope-kind-all"
          onClick={() => onScopeChange({ kind: 'all' })}
        >
          <Globe size={13} /> All devices
        </button>
        <button
          className={`scope-kind-btn${scope.kind === 'device' ? ' active' : ''}`}
          data-testid="scope-kind-device"
          onClick={() => onScopeChange({ kind: 'device', deviceId: devices[0]?.id ?? '' })}
        >
          <Smartphone size={13} /> Device
        </button>
        <button
          className={`scope-kind-btn${scope.kind === 'session' ? ' active' : ''}`}
          data-testid="scope-kind-session"
          onClick={() => onScopeChange(sessions[0] ? { kind: 'session', sessionId: sessions[0].id } : { kind: 'all' })}
        >
          <Layers size={13} /> Session
        </button>
      </div>

      {scope.kind === 'device' && (
        <select
          className="form-input scope-select"
          data-testid="scope-device-select"
          value={scope.deviceId}
          onChange={e => onScopeChange({ kind: 'device', deviceId: e.target.value })}
        >
          <option value="">Select device…</option>
          {devices.map(d => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
        </select>
      )}

      {scope.kind === 'session' && (
        <div className="scope-session-controls">
          <select
            className="form-input scope-select"
            data-testid="scope-session-select"
            value={scope.sessionId}
            onChange={e => onScopeChange({ kind: 'session', sessionId: parseInt(e.target.value, 10) })}
          >
            {sessions.map(s => (
              <option key={s.id} value={s.id}>{s.name || `Session #${s.id}`}</option>
            ))}
          </select>
          <a
            className="btn btn-sm"
            data-testid="scope-export-har"
            href={`/v1/automation/session/${scope.sessionId}/export/har`}
            title="Export this session as HAR"
          >
            <Download size={13} /> HAR
          </a>
          <a
            className="btn btn-sm"
            data-testid="scope-export-zip"
            href={`/v1/automation/session/${scope.sessionId}/export/zip`}
            title="Export this session as a ZIP bundle"
          >
            <Download size={13} /> ZIP
          </a>
          <button className="btn btn-sm" data-testid="scope-copy-link" onClick={copyLink} title="Copy a shareable link to this session">
            <Link2 size={13} /> {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      {captureStatus.capturing && targetDeviceId && (
        <div className="scope-capture-status" data-testid="scope-capture-status">
          <span>Capture active</span>
          {canManageTraffic && (
            <button
              className="btn btn-sm"
              data-testid="scope-stop-capture"
              onClick={stopCapture}
              disabled={stoppingCapture}
            >
              {stoppingCapture ? 'Stopping…' : 'Stop capture'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
