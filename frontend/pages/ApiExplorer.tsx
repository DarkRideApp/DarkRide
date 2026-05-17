import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { TrafficTable } from '../components/traffic/TrafficTable';
import type { TrafficEntry } from '../components/traffic/TrafficEntryRow';
import { EmptyState } from '@darkrideapp/plugin-sdk/react';
import { ExternalLink } from 'lucide-react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';

interface EndpointGroup {
  id: number;
  name: string;
  description: string | null;
  notes: string | null;
  endpointCount: number;
}

interface EndpointRow {
  id: number;
  method: string;
  hostname: string;
  pathPattern: string;
  requestCount: number;
  sampleResponseStatus: number | null;
  groupId: number | null;
  groupName: string | null;
  firstSeen: string;
  lastSeen: string;
}

interface QueryParam {
  name: string;
  sampleValues: string[];
  occurrenceCount: number;
}

interface InferredField {
  type: string | string[];
  required: boolean;
  examples?: any[];
  min?: number;
  max?: number;
  properties?: Record<string, InferredField>;
  items?: InferredField;
}

interface EndpointDetail extends EndpointRow {
  sampleRequestHeaders: string | null;
  sampleRequestBody: string | null;
  sampleResponseHeaders: string | null;
  sampleResponseBody: string | null;
  responseSpec: InferredField | null;
  queryParams: QueryParam[];
}

interface ParamState {
  enabled: boolean;
  value: string;
}

function tryParseJson(str: string | null): Record<string, string> | null {
  if (!str) return null;
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
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

function tryPrettyJson(str: string | null): string {
  if (!str) return '';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

/** Strip trailing ` [operationName]` suffix added by GraphQL catalogue entries. */
function stripGqlOperationSuffix(path: string): string {
  return path.replace(/\s+\[.*\]$/, '');
}

function buildUrl(hostname: string, pathPattern: string, params: Record<string, ParamState>): string {
  const base = `https://${hostname}${stripGqlOperationSuffix(pathPattern)}`;
  const enabledParams = Object.entries(params).filter(([, v]) => v.enabled && v.value.trim() !== '');
  if (enabledParams.length === 0) return base;
  const qs = enabledParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.value)}`).join('&');
  return `${base}?${qs}`;
}

function buildCurl(method: string, url: string, headers?: Record<string, string>, body?: string | null): string {
  let cmd = `curl -X ${method} '${url}'`;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      cmd += ` \\\n  -H '${k}: ${v}'`;
    }
  }
  if (body && !['GET', 'HEAD'].includes(method)) {
    cmd += ` \\\n  -d '${body}'`;
  }
  return cmd;
}

function methodClass(method: string): string {
  return method.toLowerCase();
}

function statusBadgeClass(status: number | null): string {
  if (!status) return '';
  if (status < 300) return 'badge-online';
  if (status < 400) return 'badge-warning';
  return 'badge-failed';
}

interface HeaderTableProps {
  headers: Record<string, string>;
}

function HeaderTable({ headers }: HeaderTableProps) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>None</span>;
  return (
    <table className="header-table">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface SamplePanelProps {
  title: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function SamplePanel({ title, badge, defaultOpen = false, children }: SamplePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sample-panel">
      <div className="sample-panel-header" onClick={() => setOpen(o => !o)}>
        <span>{title} {badge}</span>
        <span>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div className="sample-panel-body">{children}</div>}
    </div>
  );
}

function formatType(type: string | string[]): string {
  if (Array.isArray(type)) return type.join(' | ');
  return type;
}

function formatTypeDisplay(field: InferredField): string {
  if (Array.isArray(field.type)) return field.type.join(' | ');
  if (field.type === 'array' && field.items) {
    const itemType = formatTypeDisplay(field.items);
    return `${itemType}[]`;
  }
  return field.type;
}

interface SpecNodeProps {
  name: string;
  field: InferredField;
  depth?: number;
}

function SpecNode({ name, field, depth = 0 }: SpecNodeProps) {
  const indent = depth * 20;
  const typeStr = formatTypeDisplay(field);
  const isObj = field.type === 'object' || (Array.isArray(field.type) && field.type.includes('object'));
  const isArr = field.type === 'array' || (Array.isArray(field.type) && field.type.includes('array'));

  let meta = '';
  if (field.min !== undefined && field.max !== undefined) {
    meta = `range: ${field.min}–${field.max}`;
  } else if (field.examples && field.examples.length > 0) {
    meta = `e.g. ${field.examples.map(e => JSON.stringify(e)).join(', ')}`;
  } else if (isArr && field.items?.examples) {
    meta = `e.g. ${field.items.examples.map(e => JSON.stringify(e)).join(', ')}`;
  }

  return (
    <>
      <div className="response-spec-row" style={{ paddingLeft: indent }}>
        <span className="response-spec-name">{name}</span>
        <span className="response-spec-type">{typeStr}</span>
        <span className="response-spec-required">{field.required ? 'required' : 'optional'}</span>
        {meta && <span className="response-spec-meta">{meta}</span>}
      </div>
      {isObj && field.properties && Object.entries(field.properties).map(([k, v]) => (
        <SpecNode key={k} name={k} field={v} depth={depth + 1} />
      ))}
      {isArr && field.items && field.items.type === 'object' && field.items.properties && (
        Object.entries(field.items.properties).map(([k, v]) => (
          <SpecNode key={k} name={k} field={v} depth={depth + 1} />
        ))
      )}
    </>
  );
}


interface EndpointCardProps {
  endpoint: EndpointRow;
  detail: EndpointDetail | null;
  loading: boolean;
  onExpand: (id: number) => void;
  expanded: boolean;
  onCopy: (text: string, label: string) => void;
  navigate: (path: string) => void;
  ws: any;
}

function EndpointCard({ endpoint, detail, loading, onExpand, expanded, onCopy, navigate, ws }: EndpointCardProps) {
  const auth = useAuthOptional();
  const hasScope = auth?.hasScope ?? (() => true);

  // Param state: name -> { enabled, value }
  const [paramState, setParamState] = useState<Record<string, ParamState>>({});

  // Captured requests state
  const [capturedRequests, setCapturedRequests] = useState<TrafficEntry[] | null>(null);
  const [capturedLoading, setCapturedLoading] = useState(false);

  // Infer spec state
  const [inferredSpec, setInferredSpec] = useState<InferredField | null | undefined>(undefined); // undefined = not yet loaded
  const [inferLoading, setInferLoading] = useState(false);
  const [inferResponseCount, setInferResponseCount] = useState<number | null>(null);

  const loadCapturedRequests = async () => {
    if (!hasScope('core.traffic:read')) return;
    if (capturedRequests !== null) {
      setCapturedRequests(null); // toggle off
      return;
    }
    setCapturedLoading(true);
    try {
      const params = new URLSearchParams({
        hostname: endpoint.hostname,
        path: endpoint.pathPattern,
        method: endpoint.method,
        limit: '50',
      });
      const res = await ws.sendRestApi('GET', `/v1/traffic/list?${params}`);
      const data = res.body?.data;
      setCapturedRequests(data?.items || []);
    } catch {
      setCapturedRequests([]);
    } finally {
      setCapturedLoading(false);
    }
  };

  const handleInferSpec = async () => {
    setInferLoading(true);
    try {
      const res = await ws.sendRestApi('POST', `/v1/api-catalogue/endpoints/${endpoint.id}/infer-spec`);
      const data = res.body?.data;
      setInferredSpec(data?.spec ?? null);
      setInferResponseCount(data?.responseCount ?? null);
    } catch {
      setInferredSpec(null);
    } finally {
      setInferLoading(false);
    }
  };

  // Re-initialize param state and spec when detail loads
  useEffect(() => {
    if (!detail) return;
    const initial: Record<string, ParamState> = {};
    for (const p of detail.queryParams) {
      initial[p.name] = {
        enabled: true,
        value: p.sampleValues[0] ?? '',
      };
    }
    setParamState(initial);
    // Only initialize from detail if we haven't already triggered an infer
    if (inferredSpec === undefined) {
      setInferredSpec(detail.responseSpec ?? null);
    }
  }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps

  const builtUrl = detail
    ? buildUrl(endpoint.hostname, endpoint.pathPattern, paramState)
    : `https://${endpoint.hostname}${endpoint.pathPattern}`;

  const requestHeaders = detail ? tryParseJson(detail.sampleRequestHeaders) : null;
  const responseHeaders = detail ? tryParseJson(detail.sampleResponseHeaders) : null;

  const isGql = endpoint.method.startsWith('GQL_');
  const isProto = endpoint.method === 'PROTO' || endpoint.method === 'GRPC';

  const handleTryInBuilder = () => {
    const headers = requestHeaders ?? {};
    const prefill: Record<string, unknown> = {
      url: builtUrl,
      method: isGql ? 'POST' : isProto ? 'POST' : endpoint.method,
      headers,
    };
    if (detail?.sampleRequestBody) {
      prefill.body = detail.sampleRequestBody;
    }
    localStorage.setItem('request-builder-prefill', JSON.stringify(prefill));
    navigate('/ui/request-builder');
  };

  return (
    <div className="api-explorer-card">
      {/* Header row — always visible, click to expand */}
      <div
        className="api-explorer-card-header"
        onClick={() => onExpand(endpoint.id)}
        role="button"
        aria-expanded={expanded}
      >
        <span className={`api-explorer-method ${methodClass(endpoint.method)}`}>
          {endpoint.method}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="api-explorer-path">{endpoint.pathPattern}</div>
          <div className="api-explorer-hostname">{endpoint.hostname}</div>
        </div>
        {endpoint.sampleResponseStatus && (
          <span className={`badge badge-sm ${statusBadgeClass(endpoint.sampleResponseStatus)}`} style={{ flexShrink: 0 }}>
            {endpoint.sampleResponseStatus}
          </span>
        )}
        <span className="api-explorer-count">{endpoint.requestCount.toLocaleString()} calls</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 16, marginLeft: 4, userSelect: 'none' }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="api-explorer-body">
          {loading && !detail && (
            <div style={{ padding: '24px 0' }}><LoadingSpinner center /></div>
          )}

          {detail && (
            <>
              {/* Parameters */}
              <div className="api-explorer-section">
                <h4>Parameters</h4>
                {detail.queryParams.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No query parameters observed</div>
                ) : (
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                    {detail.queryParams.map(p => {
                      const state = paramState[p.name] ?? { enabled: true, value: '' };
                      return (
                        <div className="param-row" key={p.name}>
                          <input
                            type="checkbox"
                            checked={state.enabled}
                            onChange={e => setParamState(prev => ({
                              ...prev,
                              [p.name]: { ...prev[p.name], enabled: e.target.checked },
                            }))}
                            style={{ flexShrink: 0 }}
                          />
                          <span className="param-name">{p.name}</span>
                          <input
                            className="form-input param-input"
                            value={state.value}
                            onChange={e => setParamState(prev => ({
                              ...prev,
                              [p.name]: { ...prev[p.name], value: e.target.value },
                            }))}
                            placeholder="value"
                          />
                          {p.sampleValues.length > 0 && (
                            <div className="param-samples">
                              {p.sampleValues.slice(0, 5).map((sv, i) => (
                                <span
                                  key={i}
                                  className="param-sample-chip"
                                  onClick={() => setParamState(prev => ({
                                    ...prev,
                                    [p.name]: { ...prev[p.name], value: sv, enabled: true },
                                  }))}
                                  title={sv}
                                >
                                  {sv.length > 20 ? sv.slice(0, 20) + '…' : sv}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Built URL */}
              <div className="api-explorer-section">
                <h4>Built URL</h4>
                <div className="api-explorer-url-box">
                  <span className="url-text">{builtUrl}</span>
                  <button
                    className="btn btn-sm"
                    style={{ flexShrink: 0, fontSize: 11, padding: '2px 8px' }}
                    onClick={() => onCopy(builtUrl, 'URL')}
                    title="Copy URL"
                  >
                    Copy
                  </button>
                </div>
              </div>

              {/* Action buttons */}
              <div className="api-explorer-actions">
                <button className="btn btn-primary btn-sm" onClick={handleTryInBuilder}>
                  Try in Request Builder
                </button>
                <button
                  className="btn btn-sm"
                  title="Open in new tab"
                  onClick={() => window.open(`/ui/request-builder?url=${encodeURIComponent(builtUrl)}&method=${isGql ? 'POST' : endpoint.method}`, '_blank')}
                >
                  <ExternalLink size={14} />
                </button>
                <button className="btn btn-sm" onClick={() => onCopy(builtUrl, 'URL')}>
                  Copy URL
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => onCopy(
                    buildCurl(isGql ? 'POST' : endpoint.method, builtUrl, requestHeaders ?? undefined, detail.sampleRequestBody),
                    'cURL',
                  )}
                >
                  Copy as cURL
                </button>
              </div>

              {/* Sample Request */}
              {(detail.sampleRequestHeaders || detail.sampleRequestBody) && (
                <div className="api-explorer-section">
                  <h4>Sample Request</h4>
                  <SamplePanel title="Request" defaultOpen={false}>
                    {requestHeaders && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Headers</div>
                        <HeaderTable headers={requestHeaders} />
                      </div>
                    )}
                    {detail.sampleRequestBody && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Body</div>
                        <pre>{tryPrettyJson(detail.sampleRequestBody)}</pre>
                      </div>
                    )}
                  </SamplePanel>
                </div>
              )}

              {/* Sample Response */}
              {(detail.sampleResponseHeaders || detail.sampleResponseBody) && (
                <div className="api-explorer-section">
                  <h4>Sample Response</h4>
                  <SamplePanel
                    title="Response"
                    badge={detail.sampleResponseStatus ? (
                      <span className={`badge badge-sm ${statusBadgeClass(detail.sampleResponseStatus)}`}>
                        {detail.sampleResponseStatus}
                      </span>
                    ) : undefined}
                    defaultOpen={true}
                  >
                    {responseHeaders && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Headers</div>
                        <HeaderTable headers={responseHeaders} />
                      </div>
                    )}
                    {detail.sampleResponseBody && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Body</div>
                        <pre>{tryPrettyJson(detail.sampleResponseBody)}</pre>
                      </div>
                    )}
                  </SamplePanel>
                </div>
              )}

              {/* No sample data at all */}
              {!detail.sampleRequestHeaders && !detail.sampleRequestBody &&
               !detail.sampleResponseHeaders && !detail.sampleResponseBody && (
                <div style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
                  No sample request or response data recorded yet.
                </div>
              )}

              {/* Response Spec */}
              <div className="api-explorer-section">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <h4 style={{ margin: 0 }}>Response Schema</h4>
                  <button
                    className="btn btn-sm"
                    onClick={handleInferSpec}
                    disabled={inferLoading}
                  >
                    {inferLoading
                      ? 'Inferring...'
                      : (inferredSpec !== undefined && inferredSpec !== null)
                        ? 'Re-infer'
                        : 'Infer Spec'}
                  </button>
                </div>
                {inferLoading && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Analysing responses...</div>
                )}
                {!inferLoading && inferredSpec === null && inferResponseCount !== null && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    No JSON responses found to infer schema from.
                  </div>
                )}
                {!inferLoading && inferredSpec && (
                  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', padding: '10px 14px' }}>
                    {inferResponseCount !== null && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                        Inferred from {inferResponseCount} response{inferResponseCount !== 1 ? 's' : ''}
                      </div>
                    )}
                    <div className="response-spec">
                      {inferredSpec.type === 'object' && inferredSpec.properties
                        ? Object.entries(inferredSpec.properties).map(([k, v]) => (
                            <SpecNode key={k} name={k} field={v} depth={0} />
                          ))
                        : <SpecNode name="(root)" field={inferredSpec} depth={0} />
                      }
                    </div>
                  </div>
                )}
                {!inferLoading && inferredSpec === undefined && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Click "Infer Spec" to analyse captured responses and build a schema.
                  </div>
                )}
              </div>

              {/* Captured Requests */}
              <div className="api-explorer-section">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <h4 style={{ margin: 0 }}>Captured Requests</h4>
                  <button className="btn btn-sm" onClick={loadCapturedRequests} disabled={capturedLoading}>
                    {capturedLoading ? 'Loading...' : capturedRequests !== null ? 'Hide' : `View All (${endpoint.requestCount})`}
                  </button>
                </div>
                {capturedRequests !== null && (
                  capturedRequests.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: 8 }}>No captured requests found.</div>
                  ) : (
                    <TrafficTable
                      entries={capturedRequests}
                      showFilterBar={false}
                      emptyMessage="No captured requests found."
                    />
                  )
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ApiExplorer() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const ws = useWebSocket();

  const [group, setGroup] = useState<EndpointGroup | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailCache, setDetailCache] = useState<Record<number, EndpointDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notes editing state
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);

  useDocumentTitle(group ? `API Explorer — ${group.name}` : 'API Explorer');

  const fetchData = useCallback(async () => {
    if (!ws.connected || !groupId) return;
    setLoading(true);
    try {
      const [groupsRes, endpointsRes] = await Promise.all([
        ws.sendRestApi('GET', '/v1/api-catalogue/groups'),
        ws.sendRestApi('GET', `/v1/api-catalogue/endpoints?groupId=${groupId}&limit=200`),
      ]);

      const allGroups: EndpointGroup[] = groupsRes.body?.data || [];
      const found = allGroups.find(g => String(g.id) === groupId) || null;
      setGroup(found);

      const endpointsData = endpointsRes.body?.data;
      setEndpoints(endpointsData?.items || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [ws, groupId]);

  useEffect(() => {
    if (ws.connected) {
      fetchData();
    }
  }, [ws.connected, fetchData]);

  const handleExpand = useCallback(async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);

    // Already cached
    if (detailCache[id]) return;

    setDetailLoading(true);
    try {
      const res = await ws.sendRestApi('GET', `/v1/api-catalogue/endpoints/${id}`);
      const data = res.body?.data;
      if (data) {
        setDetailCache(prev => ({ ...prev, [id]: data }));
      }
    } catch { /* ignore */ } finally {
      setDetailLoading(false);
    }
  }, [expandedId, detailCache, ws]);

  const handleCopy = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedLabel(label);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedLabel(null), 1500);
  }, []);

  const handleSaveNotes = useCallback(async () => {
    if (!group) return;
    setNotesSaving(true);
    try {
      await ws.sendRestApi('PUT', `/v1/api-catalogue/groups/${group.id}`, { notes: notesDraft });
      setGroup(prev => prev ? { ...prev, notes: notesDraft } : prev);
      setNotesEditing(false);
    } catch { /* ignore */ } finally {
      setNotesSaving(false);
    }
  }, [group, notesDraft, ws]);

  const gId = groupId ? parseInt(groupId, 10) : null;

  return (
    <div data-testid="api-explorer-page">
      {/* Breadcrumbs */}
      <nav style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, display: 'flex', gap: 6, alignItems: 'center' }}>
        <a
          href="/ui/api-catalogue"
          onClick={e => { e.preventDefault(); navigate('/ui/api-catalogue'); }}
          style={{ color: 'var(--accent)', textDecoration: 'none' }}
        >
          API Catalogue
        </a>
        <span>/</span>
        <a
          href="/ui/api-catalogue"
          onClick={e => { e.preventDefault(); navigate('/ui/api-catalogue'); }}
          style={{ color: 'var(--accent)', textDecoration: 'none' }}
        >
          Groups
        </a>
        <span>/</span>
        <span style={{ color: 'var(--text-primary)' }}>{group?.name ?? '...'}</span>
      </nav>

      {/* Page heading */}
      <div className="page-header">
        <div>
          <h1>{group?.name ?? 'API Explorer'}</h1>
          {group?.description && <p className="page-subtitle">{group.description}</p>}
          {!loading && (
            <p className="page-subtitle">{endpoints.length} endpoint{endpoints.length !== 1 ? 's' : ''}</p>
          )}
        </div>
        <div className="page-header-actions">
          <button
            className="btn btn-sm"
            onClick={() => navigate('/ui/api-catalogue')}
          >
            Back to Catalogue
          </button>
        </div>
      </div>

      {/* Group notes */}
      {!loading && group && (
        <div className="api-explorer-notes">
          {notesEditing ? (
            <>
              <textarea
                className="api-explorer-notes-textarea"
                value={notesDraft}
                onChange={e => setNotesDraft(e.target.value)}
                placeholder="Add notes about this API group (authentication, quirks, usage examples…)"
                autoFocus
              />
              <div className="api-explorer-notes-actions">
                <button className="btn btn-sm" onClick={() => setNotesEditing(false)} disabled={notesSaving}>
                  Cancel
                </button>
                <button className="btn btn-sm btn-primary" onClick={handleSaveNotes} disabled={notesSaving}>
                  {notesSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          ) : group.notes ? (
            <>
              <button
                className="btn btn-sm"
                style={{ position: 'absolute', top: 10, right: 10 }}
                onClick={() => { setNotesDraft(group.notes || ''); setNotesEditing(true); }}
              >
                Edit
              </button>
              <pre>{group.notes}</pre>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Add notes about this API group...</span>
              <button
                className="btn btn-sm"
                onClick={() => { setNotesDraft(''); setNotesEditing(true); }}
              >
                Add Notes
              </button>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <LoadingSpinner large center />
      ) : endpoints.length === 0 ? (
        <EmptyState
          icon="📡"
          message="No endpoints in this group"
          description="Assign endpoints to this group from the API Catalogue."
        />
      ) : (
        <div style={{ marginTop: 16 }}>
          {endpoints.map(ep => (
            <EndpointCard
              key={ep.id}
              endpoint={ep}
              detail={detailCache[ep.id] ?? null}
              loading={detailLoading && expandedId === ep.id}
              expanded={expandedId === ep.id}
              onExpand={handleExpand}
              onCopy={handleCopy}
              navigate={navigate}
              ws={ws}
            />
          ))}
        </div>
      )}

      {/* Copied toast */}
      {copiedLabel && (
        <div className="copied-toast">
          Copied {copiedLabel}!
        </div>
      )}
    </div>
  );
}
