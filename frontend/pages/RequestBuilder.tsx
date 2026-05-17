import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { popReplayRequest } from '../components/traffic/TrafficEntryRow';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

interface HeaderEntry {
  key: string;
  value: string;
  enabled: boolean;
}

interface ProxyOption {
  id: number;
  url: string;
  enabled: boolean;
}

interface ResponseData {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  bodyBase64?: string | null;
  timingMs: number;
  error?: string;
}

function parseHeadersJson(json: string | null): HeaderEntry[] {
  if (!json) return [];
  try {
    const obj = JSON.parse(json);
    return Object.entries(obj).map(([key, value]) => ({
      key,
      value: String(value),
      enabled: true,
    }));
  } catch {
    return [];
  }
}

function headersToRecord(headers: HeaderEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers) {
    if (h.enabled && h.key.trim()) {
      result[h.key.trim()] = h.value;
    }
  }
  return result;
}

function generateCurl(method: string, url: string, headers: Record<string, string>, body: string): string {
  const parts = [`curl -X ${method} '${url}'`];
  for (const [key, val] of Object.entries(headers)) {
    parts.push(`-H '${key}: ${val}'`);
  }
  if (body && !['GET', 'HEAD'].includes(method)) {
    parts.push(`-d '${body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n  ');
}

function generateFetch(method: string, url: string, headers: Record<string, string>, body: string): string {
  const opts: string[] = [`  method: '${method}'`];
  if (Object.keys(headers).length > 0) {
    opts.push(`  headers: ${JSON.stringify(headers, null, 4)}`);
  }
  if (body && !['GET', 'HEAD'].includes(method)) {
    opts.push(`  body: ${JSON.stringify(body)}`);
  }
  return `fetch('${url}', {\n${opts.join(',\n')}\n})`;
}

function prettyJson(str: string | null): string {
  if (!str) return '';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

export function RequestBuilder() {
  useDocumentTitle('Request Builder');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const [searchParams] = useSearchParams();

  // Form state
  const [method, setMethod] = useState<string>('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderEntry[]>([
    { key: 'Content-Type', value: 'application/json', enabled: true },
  ]);
  const [body, setBody] = useState('');
  const [proxyMode, setProxyMode] = useState<'direct' | 'proxy' | 'nordvpn'>('direct');
  const [proxyId, setProxyId] = useState<number | null>(null);
  const [nordvpnCountry, setNordvpnCountry] = useState('us');
  const [followRedirects, setFollowRedirects] = useState(true);

  // State
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ResponseData | null>(null);
  const [proxies, setProxies] = useState<ProxyOption[]>([]);
  const [history, setHistory] = useState<Array<{ method: string; url: string; status: number | null; timingMs: number }>>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const hasScope = auth?.hasScope ?? (() => true);

  // Load proxies
  useEffect(() => {
    if (!hasScope('core.proxies:manage')) return;
    ws.sendRestApi('GET', '/v1/proxy/list').then(res => {
      if (res?.body?.success) {
        setProxies(res.body.data.filter((p: any) => p.enabled));
      }
    }).catch(() => {});
  }, [ws]);

  // Pre-populate from replay (sessionStorage, set by Replay button)
  useEffect(() => {
    if (!searchParams.has('replay')) return;
    const data = popReplayRequest();
    if (!data) return;
    if (data.url) setUrl(data.url);
    if (data.method) setMethod(data.method.toUpperCase());
    if (data.headers) setHeaders(parseHeadersJson(data.headers));
    if (data.body) setBody(data.body);
  }, []);

  // Pre-populate from URL query params (new tab from API Explorer)
  useEffect(() => {
    const urlParam = searchParams.get('url');
    const methodParam = searchParams.get('method');
    if (urlParam) {
      setUrl(decodeURIComponent(urlParam));
    }
    if (methodParam) {
      setMethod(methodParam.toUpperCase());
    }
  }, []);

  // Pre-populate from API Explorer (localStorage prefill)
  useEffect(() => {
    // Skip if URL params were provided (new tab mode)
    if (searchParams.get('url')) return;
    const raw = localStorage.getItem('request-builder-prefill');
    if (!raw) return;
    localStorage.removeItem('request-builder-prefill');
    try {
      const prefill = JSON.parse(raw);
      if (prefill.url) setUrl(prefill.url);
      if (prefill.method) setMethod(prefill.method.toUpperCase());
      if (prefill.headers && typeof prefill.headers === 'object') {
        const entries = Array.isArray(prefill.headers)
          ? prefill.headers
          : Object.entries(prefill.headers as Record<string, string>).map(([key, value]) => ({ key, value: String(value), enabled: true }));
        if (entries.length > 0) {
          setHeaders(entries);
        }
      }
      if (prefill.body) setBody(prefill.body);
    } catch { /* ignore malformed prefill */ }
  }, []);

  const copyToClipboard = useCallback((label: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const activeHeaders = headersToRecord(headers);

  const addHeader = () => {
    setHeaders(prev => [...prev, { key: '', value: '', enabled: true }]);
  };

  const removeHeader = (index: number) => {
    setHeaders(prev => prev.filter((_, i) => i !== index));
  };

  const updateHeader = (index: number, field: 'key' | 'value' | 'enabled', val: string | boolean) => {
    setHeaders(prev => prev.map((h, i) => i === index ? { ...h, [field]: val } : h));
  };

  const handleSend = useCallback(async () => {
    if (!url.trim()) return;
    setSending(true);
    setResponse(null);

    try {
      const payload: any = {
        url: url.trim(),
        method: method,
        headers: headersToRecord(headers),
        followRedirects,
      };

      if (body.trim() && !['GET', 'HEAD'].includes(method)) {
        payload.body = body;
      }

      if (proxyMode === 'proxy' && proxyId) {
        payload.proxy = { type: 'proxyId', proxyId };
      } else if (proxyMode === 'nordvpn') {
        payload.proxy = { type: 'nordvpn', country: nordvpnCountry };
      } else {
        payload.proxy = { type: 'direct' };
      }

      const res = await ws.sendRestApi('POST', '/v1/proxied-request', payload);
      const wrapper = res?.body;

      if (wrapper?.success === false) {
        setResponse({ status: 0, headers: {}, body: null, timingMs: 0, error: wrapper.error || 'Request failed' });
      } else {
        const data = wrapper?.data;
        setResponse({
          status: data?.status ?? 0,
          headers: data?.headers || {},
          body: data?.body || null,
          bodyBase64: data?.bodyBase64 || null,
          timingMs: data?.timingMs || 0,
          error: data ? undefined : 'No response data',
        });
        if (data?.status) {
          setHistory(prev => [{
            method,
            url: url.trim(),
            status: data.status,
            timingMs: data.timingMs || 0,
          }, ...prev].slice(0, 20));
        }
      }
    } catch (err: any) {
      setResponse({ status: 0, headers: {}, body: null, timingMs: 0, error: err.message || 'Network error' });
    } finally {
      setSending(false);
    }
  }, [url, method, headers, body, proxyMode, proxyId, nordvpnCountry, followRedirects, ws]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const statusColor = response
    ? response.error ? '#ef4444'
      : response.status >= 200 && response.status < 300 ? '#22c55e'
      : response.status >= 400 ? '#ef4444'
      : '#f59e0b'
    : undefined;

  const responseHeaderCount = response ? Object.keys(response.headers).length : 0;

  return (
    <div data-testid="request-builder-page" onKeyDown={handleKeyDown}>
      <PageHeader title="Request Builder" />

      <div style={{ display: 'flex', gap: 16, minHeight: 'calc(100vh - 120px)' }}>
        {/* Left: Request form */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* URL bar */}
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                className="form-input"
                value={method}
                onChange={e => setMethod(e.target.value)}
                style={{ width: 110, flexShrink: 0, fontWeight: 600 }}
                data-testid="rb-method"
              >
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                className="form-input"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://api.example.com/endpoint"
                style={{ flex: 1 }}
                data-testid="rb-url"
              />
              <button
                className="btn btn-primary"
                onClick={handleSend}
                disabled={sending || !url.trim()}
                style={{ flexShrink: 0, minWidth: 80 }}
                data-testid="rb-send"
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>

            {/* Options row */}
            <div style={{ display: 'flex', gap: 16, marginTop: 8, alignItems: 'center', fontSize: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={followRedirects} onChange={e => setFollowRedirects(e.target.checked)} />
                Follow redirects
              </label>

              <select
                className="form-input"
                value={proxyMode === 'proxy' ? `proxy:${proxyId}` : proxyMode === 'nordvpn' ? `nordvpn:${nordvpnCountry}` : 'direct'}
                onChange={e => {
                  const val = e.target.value;
                  if (val === 'direct') {
                    setProxyMode('direct');
                    setProxyId(null);
                  } else if (val.startsWith('nordvpn:')) {
                    setProxyMode('nordvpn');
                    setNordvpnCountry(val.split(':')[1]);
                  } else if (val.startsWith('proxy:')) {
                    setProxyMode('proxy');
                    setProxyId(Number(val.split(':')[1]));
                  }
                }}
                style={{ fontSize: 12, padding: '2px 6px', maxWidth: 240 }}
                data-testid="rb-proxy"
              >
                <option value="direct">Direct (no proxy)</option>
                {proxies.length > 0 && <optgroup label="Saved Proxies">
                  {proxies.map(p => <option key={p.id} value={`proxy:${p.id}`}>{p.url}</option>)}
                </optgroup>}
                <optgroup label="NordVPN SOCKS5">
                  {[
                    ['us', 'United States'], ['gb', 'United Kingdom'], ['ca', 'Canada'], ['au', 'Australia'],
                    ['de', 'Germany'], ['fr', 'France'], ['nl', 'Netherlands'], ['se', 'Sweden'],
                    ['ch', 'Switzerland'], ['jp', 'Japan'], ['sg', 'Singapore'], ['hk', 'Hong Kong'],
                    ['br', 'Brazil'], ['mx', 'Mexico'], ['in', 'India'], ['kr', 'South Korea'],
                    ['it', 'Italy'], ['es', 'Spain'], ['at', 'Austria'], ['be', 'Belgium'],
                    ['dk', 'Denmark'], ['fi', 'Finland'], ['no', 'Norway'], ['pl', 'Poland'],
                    ['ie', 'Ireland'], ['nz', 'New Zealand'], ['za', 'South Africa'], ['ar', 'Argentina'],
                  ].map(([code, name]) => (
                    <option key={code} value={`nordvpn:${code}`}>{name}</option>
                  ))}
                </optgroup>
              </select>

              <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
                Ctrl+Enter to send
              </span>
            </div>
          </div>

          {/* Copy actions */}
          {url.trim() && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { label: 'Copy URL', fn: () => copyToClipboard('Copy URL', url.trim()) },
                { label: 'Copy as cURL', fn: () => copyToClipboard('Copy as cURL', generateCurl(method, url.trim(), activeHeaders, body)) },
                { label: 'Copy as Fetch', fn: () => copyToClipboard('Copy as Fetch', generateFetch(method, url.trim(), activeHeaders, body)) },
                ...(response?.body ? [{ label: 'Copy Response', fn: () => copyToClipboard('Copy Response', response.body || '') }] : []),
                ...(body ? [{ label: 'Copy Body', fn: () => copyToClipboard('Copy Body', body) }] : []),
              ].map(btn => (
                <button
                  key={btn.label}
                  className="btn btn-sm"
                  onClick={btn.fn}
                  style={{ fontSize: 11, padding: '3px 10px' }}
                >
                  {copied === btn.label ? 'Copied!' : btn.label}
                </button>
              ))}
            </div>
          )}

          {/* Headers */}
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Headers</h4>
              <button className="btn btn-sm" onClick={addHeader} style={{ fontSize: 11, padding: '1px 8px' }}>
                + Add
              </button>
            </div>
            {headers.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No headers</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {headers.map((h, i) => (
                  <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={h.enabled}
                      onChange={e => updateHeader(i, 'enabled', e.target.checked)}
                      style={{ flexShrink: 0 }}
                    />
                    <input
                      className="form-input"
                      value={h.key}
                      onChange={e => updateHeader(i, 'key', e.target.value)}
                      placeholder="Header name"
                      style={{ flex: 1, fontSize: 12, padding: '3px 6px', opacity: h.enabled ? 1 : 0.4 }}
                    />
                    <input
                      className="form-input"
                      value={h.value}
                      onChange={e => updateHeader(i, 'value', e.target.value)}
                      placeholder="Value"
                      style={{ flex: 2, fontSize: 12, padding: '3px 6px', opacity: h.enabled ? 1 : 0.4 }}
                    />
                    <button
                      className="btn btn-sm"
                      onClick={() => removeHeader(i)}
                      style={{ fontSize: 11, padding: '1px 6px', color: 'var(--status-error, #ef4444)' }}
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Body */}
          {!['GET', 'HEAD'].includes(method) && (
            <div className="card" style={{ padding: 12 }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>Body</h4>
              <textarea
                className="form-input"
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Request body..."
                style={{
                  width: '100%',
                  minHeight: 120,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono, monospace)',
                  resize: 'vertical',
                }}
                data-testid="rb-body"
              />
            </div>
          )}
        </div>

        {/* Right: Response */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: 12, flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Response</h4>
              {response && !response.error && (
                <>
                  <span style={{
                    fontSize: 12, fontWeight: 700,
                    color: statusColor,
                  }}>
                    {response.status}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {response.timingMs}ms
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {responseHeaderCount} header{responseHeaderCount !== 1 ? 's' : ''}
                  </span>
                </>
              )}
            </div>

            {!response && !sending && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Send a request to see the response
              </div>
            )}

            {sending && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Sending...
              </div>
            )}

            {response?.error && (
              <div style={{ padding: 12, background: 'rgba(239,68,68,0.08)', borderRadius: 6, color: '#ef4444', fontSize: 12 }}>
                {response.error}
              </div>
            )}

            {response && !response.error && (
              <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Response Headers */}
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
                    Response Headers ({responseHeaderCount})
                  </summary>
                  <pre style={{
                    margin: '4px 0 0',
                    padding: 8,
                    background: 'var(--bg-secondary, #1e1e2e)',
                    borderRadius: 4,
                    fontSize: 11,
                    overflow: 'auto',
                    maxHeight: 200,
                  }}>
                    {JSON.stringify(response.headers, null, 2)}
                  </pre>
                </details>

                {/* Response Body */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>Body</span>
                    {response.body && (
                      <button
                        className="btn btn-sm"
                        style={{ fontSize: 11, padding: '1px 6px' }}
                        onClick={() => navigator.clipboard.writeText(response.body || '')}
                      >
                        Copy
                      </button>
                    )}
                    {response.bodyBase64 && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        (binary, base64-encoded)
                      </span>
                    )}
                  </div>
                  <pre style={{
                    margin: 0,
                    padding: 8,
                    background: 'var(--bg-secondary, #1e1e2e)',
                    borderRadius: 4,
                    fontSize: 11,
                    overflow: 'auto',
                    flex: 1,
                    maxHeight: 'calc(100vh - 360px)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {response.body ? prettyJson(response.body) : response.bodyBase64 ? `[Binary: ${Math.round(response.bodyBase64.length * 0.75)} bytes]` : '(empty)'}
                  </pre>
                </div>
              </div>
            )}
          </div>

          {/* Request history (in-session) */}
          {history.length > 0 && (
            <div className="card" style={{ padding: 12, maxHeight: 180, overflow: 'auto' }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>History</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {history.map((h, i) => (
                  <div
                    key={i}
                    style={{ display: 'flex', gap: 8, fontSize: 11, cursor: 'pointer', padding: '2px 4px', borderRadius: 3 }}
                    onClick={() => { setMethod(h.method); setUrl(h.url); }}
                    title="Click to load into form"
                  >
                    <span style={{ fontWeight: 600, minWidth: 45 }}>{h.method}</span>
                    <span style={{
                      color: h.status && h.status >= 200 && h.status < 300 ? '#22c55e' : h.status && h.status >= 400 ? '#ef4444' : '#f59e0b',
                      fontWeight: 600, minWidth: 30,
                    }}>
                      {h.status || 'ERR'}
                    </span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {h.url}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{h.timingMs}ms</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
