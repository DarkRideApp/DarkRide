import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { X, Repeat, ArrowRight } from 'lucide-react';
import type { TrafficEntry } from './TrafficEntryRow';
import type { TlsProfileName } from '../../../shared/types/api';
import {
  diffLines,
  diffHeaders,
  hasLineChanges,
  prettyForDiff,
  type DiffLine,
  type HeaderChange,
} from '../../lib/response-diff';

// ---------------------------------------------------------------------------
// ReplayDrawer — an in-place Burp-style Repeater over the Traffic view.
//
// Opens with a captured entry, lets you edit method/URL/headers/body, pick how
// the request egresses ("Send via"), fire it, and read the response BESIDE the
// captured original with a status / header / body diff. When the entry's device
// is actively capturing, the default egress is the capture session itself —
// same proxy + TLS profile the app used — so the replay leaves the machine the
// way the app's own traffic did.
// ---------------------------------------------------------------------------

interface HeaderEntry {
  key: string;
  value: string;
  enabled: boolean;
}

interface ReplayResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  bodyBase64?: string | null;
  timingMs: number;
  proxyUsed?: string;
  error?: string;
}

interface HistoryItem {
  id: string;
  method: string;
  url: string;
  status: 'completed' | 'failed';
  responseStatus: number | null;
  proxyLabel: string;
  timingMs: number | null;
  completedAt: string;
}

interface ProxyOption {
  id: number;
  url: string;
  enabled: boolean;
}

interface ReplayDrawerProps {
  /** The captured entry to repeat, or null when the drawer is closed. */
  entry: TrafficEntry | null;
  onClose: () => void;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

// A compact NordVPN country set — mirrors the Request Builder list's common picks.
const NORDVPN_COUNTRIES: Array<[string, string]> = [
  ['us', 'United States'], ['gb', 'United Kingdom'], ['ca', 'Canada'], ['au', 'Australia'],
  ['de', 'Germany'], ['fr', 'France'], ['nl', 'Netherlands'], ['jp', 'Japan'],
  ['sg', 'Singapore'], ['hk', 'Hong Kong'], ['br', 'Brazil'], ['in', 'India'],
];

function parseHeaderEntries(json: string | null): HeaderEntry[] {
  if (!json) return [];
  try {
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return Object.entries(obj).map(([key, value]) => ({ key, value: String(value), enabled: true }));
    }
  } catch { /* fall through */ }
  return [];
}

function headersToRecord(headers: HeaderEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.enabled && h.key.trim()) out[h.key.trim()] = h.value;
  }
  return out;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function statusColor(status: number | null | undefined): string {
  if (status == null) return 'var(--text-muted, #888)';
  if (status === 0) return '#fca5a5';
  if (status >= 200 && status < 300) return '#4ade80';
  if (status >= 300 && status < 400) return '#60a5fa';
  if (status >= 400 && status < 500) return '#ffb95f';
  if (status >= 500) return '#fca5a5';
  return 'var(--text-muted, #888)';
}

export function ReplayDrawer({ entry, onClose }: ReplayDrawerProps) {
  const ws = useWebSocket();

  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderEntry[]>([]);
  const [body, setBody] = useState('');
  // sendVia is a compact string: 'direct' | 'captureSession' | 'proxy:<id>' | 'nordvpn:<code>'
  const [sendVia, setSendVia] = useState<string>('direct');

  const [proxies, setProxies] = useState<ProxyOption[]>([]);
  const [deviceCapturing, setDeviceCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ReplayResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const deviceId = entry?.deviceId ?? null;
  const host = entry ? hostOf(entry.requestUrl) : '';

  // (Re)initialise the editor whenever a new entry opens the drawer.
  useEffect(() => {
    if (!entry) return;
    setMethod((entry.requestMethod || 'GET').toUpperCase());
    setUrl(entry.requestUrl);
    setHeaders(parseHeaderEntries(entry.requestHeaders));
    setBody(entry.requestBody ?? '');
    setResponse(null);
  }, [entry?.id]);

  // Load saved proxies for the "Send via" list (best-effort).
  useEffect(() => {
    if (!entry) return;
    ws.sendRestApi('GET', '/v1/proxy/list').then((res: any) => {
      if (res?.body?.success) setProxies((res.body.data || []).filter((p: any) => p.enabled));
    }).catch(() => {});
  }, [entry?.id, ws]);

  // Check whether the capturing device is live, and default to routing through
  // the capture session when it is.
  useEffect(() => {
    if (!entry) return;
    if (!deviceId) { setDeviceCapturing(false); setSendVia('direct'); return; }
    ws.sendRestApi('GET', `/v1/capture/status/${encodeURIComponent(deviceId)}`).then((res: any) => {
      const capturing = !!res?.body?.data?.capturing;
      setDeviceCapturing(capturing);
      setSendVia(capturing ? 'captureSession' : 'direct');
    }).catch(() => {
      setDeviceCapturing(false);
      setSendVia('direct');
    });
  }, [entry?.id, deviceId, ws]);

  const loadHistory = useCallback(() => {
    ws.sendRestApi('GET', '/v1/proxied-request/history?limit=200').then((res: any) => {
      const all: HistoryItem[] = res?.body?.data || [];
      // Only replays that hit this host, most-recent first (server returns newest first).
      setHistory(all.filter((h) => hostOf(h.url) === host).slice(0, 8));
    }).catch(() => {});
  }, [ws, host]);

  useEffect(() => {
    if (entry) loadHistory();
  }, [entry?.id, loadHistory]);

  const addHeader = () => setHeaders((prev) => [...prev, { key: '', value: '', enabled: true }]);
  const removeHeader = (i: number) => setHeaders((prev) => prev.filter((_, idx) => idx !== i));
  const updateHeader = (i: number, field: keyof HeaderEntry, val: string | boolean) =>
    setHeaders((prev) => prev.map((h, idx) => (idx === i ? { ...h, [field]: val } : h)));

  const buildProxyPayload = useCallback((): { proxy: any; tlsProfile?: TlsProfileName } => {
    if (sendVia === 'captureSession' && deviceId) {
      // TLS profile is auto-derived server-side from the live session.
      return { proxy: { type: 'captureSession', deviceId } };
    }
    if (sendVia.startsWith('proxy:')) {
      return { proxy: { type: 'proxyId', proxyId: Number(sendVia.slice('proxy:'.length)) } };
    }
    if (sendVia.startsWith('nordvpn:')) {
      return { proxy: { type: 'nordvpn', country: sendVia.slice('nordvpn:'.length) } };
    }
    return { proxy: { type: 'direct' } };
  }, [sendVia, deviceId]);

  const handleSend = useCallback(async () => {
    if (!url.trim()) return;
    setSending(true);
    setResponse(null);
    try {
      const { proxy, tlsProfile } = buildProxyPayload();
      const payload: any = {
        url: url.trim(),
        method,
        headers: headersToRecord(headers),
        proxy,
      };
      if (tlsProfile) payload.tlsProfile = tlsProfile;
      if (body.trim() && !['GET', 'HEAD'].includes(method)) payload.body = body;

      const res = await ws.sendRestApi('POST', '/v1/proxied-request', payload);
      const wrapper = res?.body;
      if (wrapper?.success === false) {
        setResponse({ status: 0, headers: {}, body: null, timingMs: 0, error: wrapper.error || 'Request failed' });
      } else {
        const data = wrapper?.data;
        setResponse({
          status: data?.status ?? 0,
          headers: data?.headers || {},
          body: data?.body ?? null,
          bodyBase64: data?.bodyBase64 ?? null,
          timingMs: data?.timingMs ?? 0,
          proxyUsed: data?.proxyUsed,
          error: data ? undefined : 'No response data',
        });
      }
      loadHistory();
    } catch (err: any) {
      setResponse({ status: 0, headers: {}, body: null, timingMs: 0, error: err?.message || 'Network error' });
    } finally {
      setSending(false);
    }
  }, [url, method, headers, body, buildProxyPayload, ws, loadHistory]);

  // ---- Diff data (original captured vs new replay) ------------------------

  const origStatus = entry?.responseStatus ?? null;
  const newStatus = response && !response.error ? response.status : null;
  const statusChanged = newStatus != null && origStatus != null && newStatus !== origStatus;

  const headerChanges: HeaderChange[] = useMemo(() => {
    if (!response || response.error) return [];
    let origHeaders: Record<string, string> = {};
    try { origHeaders = entry?.responseHeaders ? JSON.parse(entry.responseHeaders) : {}; } catch { /* ignore */ }
    return diffHeaders(origHeaders, response.headers);
  }, [entry?.responseHeaders, response]);

  const bodyDiff: DiffLine[] = useMemo(() => {
    if (!response || response.error) return [];
    const origBody = prettyForDiff(entry?.responseBody ?? '');
    const newBody = prettyForDiff(response.body ?? (response.bodyBase64 ? '[binary response]' : ''));
    return diffLines(origBody, newBody);
  }, [entry?.responseBody, response]);

  const changedHeaderCount = headerChanges.filter((c) => c.kind !== 'unchanged').length;
  const bodyChanged = hasLineChanges(bodyDiff);

  if (!entry) return null;

  const canSendCaptureSession = !!deviceId;

  return (
    <div className="replay-drawer-overlay" data-testid="replay-drawer-overlay" onClick={onClose}>
      <div
        className="replay-drawer"
        data-testid="replay-drawer"
        role="dialog"
        aria-label="Repeater"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="replay-drawer-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Repeat size={16} />
            <strong>Repeater</strong>
            <span className="replay-drawer-host">{host}</span>
          </div>
          <button
            className="replay-drawer-close"
            data-testid="replay-drawer-close"
            onClick={onClose}
            aria-label="Close repeater"
          >
            <X size={16} />
          </button>
        </div>

        <div className="replay-drawer-body">
          {/* ---- Request editor ---- */}
          <div className="replay-panel">
            <div className="replay-url-row">
              <select
                className="form-input"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                data-testid="replay-method"
                style={{ width: 96, fontWeight: 600 }}
              >
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                className="form-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                data-testid="replay-url"
                style={{ flex: 1 }}
                placeholder="https://api.example.com/endpoint"
              />
              <button
                className="btn btn-primary"
                onClick={handleSend}
                disabled={sending || !url.trim()}
                data-testid="replay-send"
                style={{ minWidth: 76 }}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>

            <div className="replay-sendvia-row">
              <label style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>Send via</label>
              <select
                className="form-input"
                value={sendVia}
                onChange={(e) => setSendVia(e.target.value)}
                data-testid="replay-send-via"
                style={{ fontSize: 12, maxWidth: 320 }}
              >
                {canSendCaptureSession && (
                  <option value="captureSession">
                    Capture session (device egress + TLS){deviceCapturing ? '' : ' — not capturing'}
                  </option>
                )}
                <option value="direct">Direct (no proxy)</option>
                {proxies.length > 0 && (
                  <optgroup label="Saved Proxies">
                    {proxies.map((p) => <option key={p.id} value={`proxy:${p.id}`}>{p.url}</option>)}
                  </optgroup>
                )}
                <optgroup label="NordVPN SOCKS5">
                  {NORDVPN_COUNTRIES.map(([code, name]) => (
                    <option key={code} value={`nordvpn:${code}`}>{name}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            {/* Headers */}
            <div className="replay-section">
              <div className="replay-section-head">
                <span>Headers</span>
                <button className="btn btn-sm" onClick={addHeader} data-testid="replay-add-header" style={{ fontSize: 11, padding: '1px 8px' }}>
                  + Add
                </button>
              </div>
              {headers.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>No headers</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {headers.map((h, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={h.enabled}
                        onChange={(e) => updateHeader(i, 'enabled', e.target.checked)}
                        data-testid={`replay-header-enabled-${i}`}
                        style={{ flexShrink: 0 }}
                      />
                      <input
                        className="form-input"
                        value={h.key}
                        onChange={(e) => updateHeader(i, 'key', e.target.value)}
                        placeholder="Header"
                        data-testid={`replay-header-key-${i}`}
                        style={{ flex: 1, fontSize: 12, padding: '3px 6px', opacity: h.enabled ? 1 : 0.4 }}
                      />
                      <input
                        className="form-input"
                        value={h.value}
                        onChange={(e) => updateHeader(i, 'value', e.target.value)}
                        placeholder="Value"
                        data-testid={`replay-header-value-${i}`}
                        style={{ flex: 2, fontSize: 12, padding: '3px 6px', opacity: h.enabled ? 1 : 0.4 }}
                      />
                      <button
                        className="btn btn-sm"
                        onClick={() => removeHeader(i)}
                        style={{ fontSize: 11, padding: '1px 6px', color: 'var(--status-error, #ef4444)' }}
                        aria-label={`Remove header ${i}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Body */}
            {!['GET', 'HEAD'].includes(method) && (
              <div className="replay-section">
                <div className="replay-section-head"><span>Body</span></div>
                <textarea
                  className="form-input"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Request body…"
                  data-testid="replay-body"
                  style={{ width: '100%', minHeight: 90, fontSize: 12, fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }}
                />
              </div>
            )}

            {/* Replay history for this host */}
            <div className="replay-section" data-testid="replay-history">
              <div className="replay-section-head"><span>Recent replays · {host}</span></div>
              {history.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>No replays yet</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {history.map((h) => (
                    <div key={h.id} className="replay-history-row" data-testid="replay-history-row">
                      <span style={{ fontWeight: 600, minWidth: 44 }}>{h.method}</span>
                      <span style={{ color: statusColor(h.responseStatus), fontWeight: 600, minWidth: 30 }}>
                        {h.status === 'failed' ? 'ERR' : h.responseStatus ?? '—'}
                      </span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted, #888)' }}>
                        {h.proxyLabel}
                      </span>
                      <span style={{ color: 'var(--text-muted, #888)' }}>{h.timingMs != null ? `${h.timingMs}ms` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ---- Response comparison ---- */}
          <div className="replay-panel replay-panel-response">
            {!response ? (
              <div className="replay-empty" data-testid="replay-response-empty">
                {sending ? 'Sending…' : 'Send to compare against the captured response'}
              </div>
            ) : response.error ? (
              <div className="replay-error" data-testid="replay-error">{response.error}</div>
            ) : (
              <>
                {/* Status + routing */}
                <div className="replay-section">
                  <div className="replay-status-row">
                    <span className="replay-status-label">Status</span>
                    <span data-testid="replay-orig-status" style={{ color: statusColor(origStatus), fontWeight: 700 }}>
                      {origStatus ?? '—'}
                    </span>
                    <ArrowRight size={13} style={{ opacity: 0.6 }} />
                    <span data-testid="replay-new-status" style={{ color: statusColor(newStatus), fontWeight: 700 }}>
                      {newStatus ?? '—'}
                    </span>
                    {statusChanged && (
                      <span className="replay-badge replay-badge-changed" data-testid="replay-status-diff">changed</span>
                    )}
                    {!statusChanged && (
                      <span className="replay-badge" data-testid="replay-status-same">unchanged</span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted, #888)' }}>
                      {response.timingMs}ms
                    </span>
                  </div>
                  {response.proxyUsed && (
                    <div className="replay-routed" data-testid="replay-routed-via">
                      Routed via: <code>{response.proxyUsed}</code>
                    </div>
                  )}
                </div>

                {/* Header diff */}
                <div className="replay-section" data-testid="replay-header-diff">
                  <div className="replay-section-head">
                    <span>Response headers</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>
                      {changedHeaderCount} change{changedHeaderCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="replay-diff-box">
                    {headerChanges.map((c) => (
                      <div key={c.key} className={`replay-hdr replay-hdr-${c.kind}`} data-testid={`replay-hdr-${c.key}`}>
                        <span className="replay-hdr-mark">
                          {c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : c.kind === 'changed' ? '~' : ' '}
                        </span>
                        <span className="replay-hdr-key">{c.key}</span>
                        <span className="replay-hdr-val">
                          {c.kind === 'changed'
                            ? `${c.oldValue} → ${c.newValue}`
                            : c.kind === 'removed' ? c.oldValue : c.newValue}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Body diff (unified, colour-marked) */}
                <div className="replay-section" data-testid="replay-body-diff">
                  <div className="replay-section-head">
                    <span>Response body</span>
                    <span style={{ fontSize: 11, color: bodyChanged ? '#ffb95f' : 'var(--text-muted, #888)' }}>
                      {bodyChanged ? 'differs from captured' : 'identical to captured'}
                    </span>
                  </div>
                  <div className="replay-diff-box replay-body-diff-box">
                    {bodyDiff.length === 0 ? (
                      <div style={{ color: 'var(--text-muted, #888)', padding: 4 }}>(empty)</div>
                    ) : (
                      bodyDiff.map((line, i) => (
                        <div key={i} className={`replay-diff-line replay-diff-${line.op}`}>
                          <span className="replay-diff-gutter">
                            {line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}
                          </span>
                          <span className="replay-diff-text">{line.text || ' '}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
