import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { Base64DecodeModal } from './Base64DecodeModal';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';

export interface UrlEntry {
  url: string;
  domain: string;
  filePath: string;
  fileSource: string;
  lineNumber: number;
}

export interface StringEntry {
  value: string;
  type: string;
  filePath: string;
  fileSource: string;
  lineNumber: number;
}

export interface StringsData {
  urls: UrlEntry[];
  strings: StringEntry[];
}

interface StringsViewProps {
  versionId: string;
  onNavigate: (filePath: string, lineNumber: number, source: string) => void;
  excludedPaths?: string[];
  showLibrary?: boolean;
}

const TYPE_STYLES: Record<string, { background: string; color: string; border: string }> = {
  'api-key':     { background: '#dc354515', color: '#dc3545', border: '#dc354540' },
  'secret':      { background: '#dc354515', color: '#dc3545', border: '#dc354540' },
  'private-key': { background: '#fd7e1415', color: '#fd7e14', border: '#fd7e1440' },
  'certificate': { background: '#fd7e1415', color: '#fd7e14', border: '#fd7e1440' },
  'ip-address':  { background: '#ffc10715', color: '#ffc107', border: '#ffc10740' },
  'token':       { background: '#0d6efd15', color: '#0d6efd', border: '#0d6efd40' },
};

const DEFAULT_TYPE_STYLE = { background: '#6c757d15', color: '#6c757d', border: '#6c757d40' };

const CERT_TYPES = new Set(['private-key', 'certificate']);

function dotToSlashPrefix(dotPath: string): string {
  return '/' + dotPath.replace(/\./g, '/') + '/';
}

function tryDecodeBase64Preview(value: string): string {
  try {
    const clean = value.replace(/^["']|["']$/g, '');
    const decoded = atob(clean);
    if (decoded.length > 100) return decoded.slice(0, 100) + '...';
    return decoded;
  } catch {
    return '(invalid base64)';
  }
}

export function StringsView({ versionId, onNavigate, excludedPaths = [], showLibrary = true }: StringsViewProps) {
  const ws = useWebSocket();
  const [data, setData] = useState<StringsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDomains, setExpandedDomains] = useState<Record<string, boolean>>({});
  const [decodingEntry, setDecodingEntry] = useState<StringEntry | null>(null);
  const [tooltipEntry, setTooltipEntry] = useState<{ value: string; rect: DOMRect } | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStrings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/strings`);
      if (res.status === 200 && res.body?.data) {
        setData(res.body.data);
      } else {
        setError(res.body?.error || 'Failed to load strings data');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load strings data');
    } finally {
      setLoading(false);
    }
  }, [ws, versionId]);

  useEffect(() => {
    if (ws.connected) fetchStrings();
  }, [ws.connected, fetchStrings]);

  const excludedPrefixes = useMemo(
    () => excludedPaths.map(dotToSlashPrefix),
    [excludedPaths],
  );

  const isExcluded = useCallback((filePath: string) => {
    if (showLibrary || excludedPrefixes.length === 0) return false;
    const normalized = '/' + filePath;
    return excludedPrefixes.some(prefix => normalized.includes(prefix));
  }, [showLibrary, excludedPrefixes]);

  const filteredUrls = useMemo(() => {
    if (!data?.urls) return [];
    if (showLibrary || excludedPrefixes.length === 0) return data.urls;
    return data.urls.filter(u => !isExcluded(u.filePath));
  }, [data?.urls, isExcluded, showLibrary, excludedPrefixes]);

  const urlsHiddenCount = (data?.urls?.length ?? 0) - filteredUrls.length;

  const urlsByDomain = useMemo(() => {
    const grouped = new Map<string, UrlEntry[]>();
    for (const entry of filteredUrls) {
      const existing = grouped.get(entry.domain) || [];
      existing.push(entry);
      grouped.set(entry.domain, existing);
    }
    // Sort domains alphabetically
    return new Map([...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }, [filteredUrls]);

  const filteredStrings = useMemo(() => {
    if (!data?.strings) return [];
    if (showLibrary || excludedPrefixes.length === 0) return data.strings;
    return data.strings.filter(s => !isExcluded(s.filePath));
  }, [data?.strings, isExcluded, showLibrary, excludedPrefixes]);

  const stringsHiddenCount = (data?.strings?.length ?? 0) - filteredStrings.length;

  const interestingStrings = useMemo(() => {
    return filteredStrings.filter(s => !CERT_TYPES.has(s.type));
  }, [filteredStrings]);

  const certificates = useMemo(() => {
    return filteredStrings.filter(s => CERT_TYPES.has(s.type));
  }, [filteredStrings]);

  const { sorted: sortedStrings, sortKey: strSortKey, sortDir: strSortDir, onSort: strOnSort } = useSortableTable(interestingStrings);
  const { sorted: sortedCerts, sortKey: certSortKey, sortDir: certSortDir, onSort: certOnSort } = useSortableTable(certificates);

  const toggleDomain = useCallback((domain: string) => {
    setExpandedDomains(prev => ({ ...prev, [domain]: !prev[domain] }));
  }, []);

  const handleNavigate = useCallback((filePath: string, lineNumber: number, source: string) => {
    onNavigate(filePath, lineNumber, source);
  }, [onNavigate]);

  const handleDecodeHover = useCallback((value: string, target: HTMLElement) => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => {
      setTooltipEntry({ value, rect: target.getBoundingClientRect() });
    }, 300);
  }, []);

  const handleDecodeLeave = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = null;
    setTooltipEntry(null);
  }, []);

  if (loading) {
    return (
      <div data-testid="strings-loading" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading strings data...
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="strings-error" className="empty-state">
        <div className="empty-message">Error</div>
        <div className="empty-description">{error}</div>
      </div>
    );
  }

  const hasUrls = urlsByDomain.size > 0;
  const hasStrings = interestingStrings.length > 0;
  const hasCerts = certificates.length > 0;
  const totalUrls = filteredUrls.length;
  const totalHidden = urlsHiddenCount + stringsHiddenCount;

  if (!hasUrls && !hasStrings && !hasCerts) {
    return (
      <div data-testid="strings-empty" className="empty-state">
        <div className="empty-message">No strings found</div>
        <div className="empty-description">No URLs, interesting strings, or certificates were found in this analysis.</div>
      </div>
    );
  }

  return (
    <div data-testid="strings-view">
      {totalHidden > 0 && (
        <div data-testid="strings-hidden-count" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          {totalHidden} library item{totalHidden !== 1 ? 's' : ''} hidden
        </div>
      )}
      {/* Section 1: URLs by Domain */}
      {hasUrls && (
        <div className="card" data-testid="urls-section" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            URLs by Domain
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
              ({totalUrls} URL{totalUrls !== 1 ? 's' : ''} across {urlsByDomain.size} domain{urlsByDomain.size !== 1 ? 's' : ''})
            </span>
          </h3>
          {[...urlsByDomain.entries()].map(([domain, urls]) => {
            const expanded = expandedDomains[domain] ?? false;
            return (
              <div key={domain} data-testid={`domain-group-${domain}`} style={{ marginBottom: 4 }}>
                <button
                  data-testid={`domain-toggle-${domain}`}
                  onClick={() => toggleDomain(domain)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                    padding: '6px 0', border: 'none', background: 'none', cursor: 'pointer',
                    color: 'var(--text-primary)', fontSize: 13, fontWeight: 500, textAlign: 'left',
                  }}
                >
                  <span style={{
                    display: 'inline-block', fontSize: 10, transition: 'transform 0.15s',
                    transform: expanded ? 'rotate(90deg)' : undefined,
                  }}>
                    &#9654;
                  </span>
                  {domain}
                  <span data-testid={`domain-count-${domain}`} style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 20, height: 18, padding: '0 6px', borderRadius: 9,
                    background: 'var(--accent)', color: '#fff',
                    fontSize: 11, fontWeight: 600,
                  }}>
                    {urls.length}
                  </span>
                </button>
                {expanded && (
                  <div data-testid={`domain-urls-${domain}`} style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {urls.map((entry, i) => (
                      <div
                        key={`${entry.url}-${entry.filePath}-${entry.lineNumber}-${i}`}
                        data-testid={`url-entry-${i}`}
                        onClick={() => handleNavigate(entry.filePath, entry.lineNumber, entry.fileSource)}
                        style={{
                          display: 'flex', alignItems: 'baseline', gap: 8,
                          padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
                          fontSize: 12, fontFamily: 'var(--font-mono)',
                        }}
                        className="clickable-row"
                      >
                        <span style={{ color: 'var(--accent)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.url}>
                          {entry.url}
                        </span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }} title={entry.filePath}>
                          {entry.filePath}:{entry.lineNumber}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Section 2: Interesting Strings */}
      {hasStrings && (
        <div className="card" data-testid="strings-section" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            Interesting Strings
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
              ({interestingStrings.length})
            </span>
          </h3>
          <div className="table-card">
            <table className="data-table" data-testid="strings-data-table">
              <thead>
                <tr>
                  <SortableHeader label="Type" sortKey="type" currentSort={strSortKey} dir={strSortDir} onSort={strOnSort} />
                  <SortableHeader label="Value" sortKey="value" currentSort={strSortKey} dir={strSortDir} onSort={strOnSort} />
                  <SortableHeader label="File" sortKey="filePath" currentSort={strSortKey} dir={strSortDir} onSort={strOnSort} />
                  <SortableHeader label="Line" sortKey="lineNumber" currentSort={strSortKey} dir={strSortDir} onSort={strOnSort} />
                </tr>
              </thead>
              <tbody>
                {sortedStrings.map((s, i) => {
                  const styles = TYPE_STYLES[s.type] || DEFAULT_TYPE_STYLE;
                  return (
                    <tr
                      key={`${s.value}-${s.filePath}-${s.lineNumber}-${i}`}
                      data-testid={`string-row-${i}`}
                      className="clickable-row"
                      onClick={() => handleNavigate(s.filePath, s.lineNumber, s.fileSource)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <span
                          data-testid={`type-badge-${i}`}
                          style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                            fontSize: 11, fontWeight: 600,
                            background: styles.background, color: styles.color,
                            border: `1px solid ${styles.border}`,
                          }}
                        >
                          {s.type}
                        </span>
                      </td>
                      <td style={{
                        fontSize: 12, fontFamily: 'var(--font-mono)',
                        maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={s.value}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.value}</span>
                          {s.type === 'base64-secret' && (
                            <button
                              data-testid={`decode-btn-${i}`}
                              className="btn btn-sm"
                              style={{ fontSize: 10, padding: '1px 6px', flexShrink: 0 }}
                              onClick={(e) => { e.stopPropagation(); setDecodingEntry(s); }}
                              onMouseEnter={(e) => handleDecodeHover(s.value, e.currentTarget)}
                              onMouseLeave={handleDecodeLeave}
                            >
                              Decode
                            </button>
                          )}
                        </span>
                      </td>
                      <td style={{
                        fontSize: 12, fontFamily: 'var(--font-mono)',
                        maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={s.filePath}>
                        {s.filePath}
                      </td>
                      <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                        {s.lineNumber}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 3: Certificates */}
      {hasCerts && (
        <div className="card" data-testid="certs-section" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            Certificates & Keys
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
              ({certificates.length})
            </span>
          </h3>
          <div className="table-card">
            <table className="data-table" data-testid="certs-data-table">
              <thead>
                <tr>
                  <SortableHeader label="Type" sortKey="type" currentSort={certSortKey} dir={certSortDir} onSort={certOnSort} />
                  <SortableHeader label="Value" sortKey="value" currentSort={certSortKey} dir={certSortDir} onSort={certOnSort} />
                  <SortableHeader label="File" sortKey="filePath" currentSort={certSortKey} dir={certSortDir} onSort={certOnSort} />
                  <SortableHeader label="Line" sortKey="lineNumber" currentSort={certSortKey} dir={certSortDir} onSort={certOnSort} />
                </tr>
              </thead>
              <tbody>
                {sortedCerts.map((c, i) => {
                  const styles = TYPE_STYLES[c.type] || DEFAULT_TYPE_STYLE;
                  return (
                    <tr
                      key={`${c.value}-${c.filePath}-${c.lineNumber}-${i}`}
                      data-testid={`cert-row-${i}`}
                      className="clickable-row"
                      onClick={() => handleNavigate(c.filePath, c.lineNumber, c.fileSource)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <span
                          data-testid={`cert-type-badge-${i}`}
                          style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                            fontSize: 11, fontWeight: 600,
                            background: styles.background, color: styles.color,
                            border: `1px solid ${styles.border}`,
                          }}
                        >
                          {c.type}
                        </span>
                      </td>
                      <td style={{
                        fontSize: 12, fontFamily: 'var(--font-mono)',
                        maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={c.value}>
                        {c.value}
                      </td>
                      <td style={{
                        fontSize: 12, fontFamily: 'var(--font-mono)',
                        maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={c.filePath}>
                        {c.filePath}
                      </td>
                      <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                        {c.lineNumber}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Decode tooltip */}
      {tooltipEntry && (
        <div
          data-testid="decode-tooltip"
          style={{
            position: 'fixed',
            left: tooltipEntry.rect.left,
            top: tooltipEntry.rect.bottom + 4,
            zIndex: 999,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            maxWidth: 350,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            color: 'var(--text-secondary)',
            pointerEvents: 'none',
          }}
        >
          {tryDecodeBase64Preview(tooltipEntry.value)}
        </div>
      )}

      {/* Decode modal */}
      {decodingEntry && (
        <Base64DecodeModal
          encoded={decodingEntry.value}
          onClose={() => setDecodingEntry(null)}
        />
      )}
    </div>
  );
}
