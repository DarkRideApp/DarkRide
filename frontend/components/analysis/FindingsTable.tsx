import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { Base64DecodeModal } from './Base64DecodeModal';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';

export interface Finding {
  id: number;
  filePath: string;
  fileSource: string;
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  lineNumber: number | null;
  matchedText: string | null;
  category: string;
}

type Severity = 'all' | 'critical' | 'high' | 'medium' | 'low' | 'info';
type Category = 'all' | 'secret' | 'url' | 'certificate' | 'crypto' | 'network' | 'permission';

const SEVERITIES: Severity[] = ['all', 'critical', 'high', 'medium', 'low', 'info'];
const CATEGORIES: Category[] = ['all', 'secret', 'url', 'certificate', 'crypto', 'network', 'permission'];

const SEVERITY_STYLES: Record<string, { background: string; color: string; border: string }> = {
  critical: { background: '#dc354515', color: '#dc3545', border: '#dc354540' },
  high:     { background: '#fd7e1415', color: '#fd7e14', border: '#fd7e1440' },
  medium:   { background: '#ffc10715', color: '#ffc107', border: '#ffc10740' },
  low:      { background: '#0d6efd15', color: '#0d6efd', border: '#0d6efd40' },
  info:     { background: '#6c757d15', color: '#6c757d', border: '#6c757d40' },
};

interface FindingsTableProps {
  versionId: string;
  onNavigate: (filePath: string, lineNumber: number, source: string) => void;
  excludedPaths?: string[];
  showLibrary?: boolean;
}

const PAGE_SIZE = 200;

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

const EMPTY_PATHS: string[] = [];

export function FindingsTable({ versionId, onNavigate, excludedPaths = EMPTY_PATHS, showLibrary = true }: FindingsTableProps) {
  const ws = useWebSocket();
  // Stabilize excludedPaths reference to prevent infinite re-renders
  const excludeKey = excludedPaths.join(',');
  const stableExcludedPaths = useMemo(() => excludedPaths, [excludeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<Severity>('all');
  const [categoryFilter, setCategoryFilter] = useState<Category>('all');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [decodingText, setDecodingText] = useState<string | null>(null);
  const [tooltipEntry, setTooltipEntry] = useState<{ value: string; rect: DOMRect } | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchFindings = useCallback(async (pageNum: number, severity: Severity, category: Category) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(pageNum * PAGE_SIZE));
      if (severity !== 'all') params.set('severity', severity);
      if (category !== 'all') params.set('category', category);
      if (!showLibrary && stableExcludedPaths.length > 0) {
        params.set('excludePaths', stableExcludedPaths.join(','));
      }

      const res = await ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/findings?${params}`);
      if (res.status === 200 && res.body?.data) {
        setFindings(res.body.data);
        setTotal(res.body.total ?? res.body.data.length);
      } else {
        setError(res.body?.error || 'Failed to load findings');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load findings');
    } finally {
      setLoading(false);
    }
  }, [ws, versionId, showLibrary, stableExcludedPaths]);

  useEffect(() => {
    if (ws.connected) fetchFindings(page, severityFilter, categoryFilter);
  }, [ws.connected, fetchFindings, page, severityFilter, categoryFilter]);

  // Reset to first page when library filter changes
  useEffect(() => {
    setPage(0);
  }, [showLibrary]);

  // Reset to first page when filters change
  const handleSeverityChange = useCallback((s: Severity) => {
    setSeverityFilter(s);
    setPage(0);
  }, []);

  const handleCategoryChange = useCallback((c: Category) => {
    setCategoryFilter(c);
    setPage(0);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { sorted: sortedFindings, sortKey, sortDir, onSort } = useSortableTable(findings);

  const handleExport = useCallback(() => {
    const json = JSON.stringify(findings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `findings-${versionId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [findings, versionId]);

  const handleRowClick = useCallback((finding: Finding) => {
    onNavigate(finding.filePath, finding.lineNumber ?? 1, finding.fileSource);
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
      <div data-testid="findings-loading" className="table-card">
        <SkeletonTable rows={8} columns={5} />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="findings-error" className="empty-state">
        <div className="empty-message">Error</div>
        <div className="empty-description">{error}</div>
      </div>
    );
  }

  return (
    <div data-testid="findings-table">
      {/* Toolbar: filters, count, export */}
      <div data-testid="findings-toolbar" style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label htmlFor="severity-filter" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Severity:</label>
          <select
            id="severity-filter"
            data-testid="severity-filter"
            className="form-input"
            value={severityFilter}
            onChange={e => handleSeverityChange(e.target.value as Severity)}
            style={{ fontSize: 12, padding: '4px 8px' }}
          >
            {SEVERITIES.map(s => (
              <option key={s} value={s}>{s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label htmlFor="category-filter" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Category:</label>
          <select
            id="category-filter"
            data-testid="category-filter"
            className="form-input"
            value={categoryFilter}
            onChange={e => handleCategoryChange(e.target.value as Category)}
            style={{ fontSize: 12, padding: '4px 8px' }}
          >
            {CATEGORIES.map(c => (
              <option key={c} value={c}>{c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}</option>
            ))}
          </select>
        </div>

        <div data-testid="findings-count" style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {total} finding{total !== 1 ? 's' : ''}
          {!showLibrary && stableExcludedPaths.length > 0 && (
            <span data-testid="findings-hidden-count"> · library findings excluded</span>
          )}
          {totalPages > 1 && ` · Page ${page + 1} of ${totalPages}`}
        </div>

        <button
          data-testid="export-btn"
          className="btn btn-sm"
          onClick={handleExport}
          disabled={findings.length === 0}
          style={{ fontSize: 12 }}
        >
          Export JSON
        </button>
      </div>

      {/* Table or empty state */}
      {findings.length === 0 && total === 0 ? (
        <div data-testid="findings-empty" className="empty-state">
          <div className="empty-message">No findings</div>
          <div className="empty-description">
            {severityFilter === 'all' && categoryFilter === 'all'
              ? 'No security findings were detected in this analysis.'
              : 'No findings match the current filters.'}
          </div>
        </div>
      ) : (
        <div className="table-card">
          <table className="data-table" data-testid="findings-data-table">
            <thead>
              <tr>
                <SortableHeader label="Severity" sortKey="severity" currentSort={sortKey} dir={sortDir} onSort={onSort} />
                <SortableHeader label="Category" sortKey="category" currentSort={sortKey} dir={sortDir} onSort={onSort} />
                <SortableHeader label="Rule" sortKey="title" currentSort={sortKey} dir={sortDir} onSort={onSort} />
                <SortableHeader label="File" sortKey="filePath" currentSort={sortKey} dir={sortDir} onSort={onSort} />
                <SortableHeader label="Line" sortKey="lineNumber" currentSort={sortKey} dir={sortDir} onSort={onSort} />
                <th className="hide-mobile">Match</th>
              </tr>
            </thead>
            <tbody>
              {sortedFindings.map(f => {
                const styles = SEVERITY_STYLES[f.severity] || SEVERITY_STYLES.info;
                return (
                  <tr
                    key={f.id}
                    data-testid={`finding-row-${f.id}`}
                    className="clickable-row"
                    onClick={() => handleRowClick(f)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <span
                        data-testid={`badge-${f.severity}`}
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 10,
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: 'capitalize',
                          background: styles.background,
                          color: styles.color,
                          border: `1px solid ${styles.border}`,
                        }}
                      >
                        {f.severity}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, textTransform: 'capitalize' }}>{f.category}</td>
                    <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }} title={f.description}>
                      {f.title}
                    </td>
                    <td style={{
                      fontSize: 12, fontFamily: 'var(--font-mono)',
                      maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={f.filePath}>
                      {f.filePath}
                    </td>
                    <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                      {f.lineNumber ?? '—'}
                    </td>
                    <td className="hide-mobile" style={{
                      fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                      maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={f.matchedText ?? ''}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.matchedText ?? '—'}</span>
                        {f.ruleId === 'base64-secret' && f.matchedText && (
                          <button
                            className="btn btn-sm"
                            data-testid={`decode-btn-${f.id}`}
                            onClick={(e) => { e.stopPropagation(); setDecodingText(f.matchedText); }}
                            onMouseEnter={(e) => handleDecodeHover(f.matchedText!, e.currentTarget)}
                            onMouseLeave={handleDecodeLeave}
                            style={{ fontSize: 10, padding: '1px 5px', flexShrink: 0 }}
                          >
                            Decode
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Pagination */}
          {totalPages > 1 && (
            <div data-testid="findings-pagination" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 8, padding: '12px 0', borderTop: '1px solid var(--border-color)',
            }}>
              <button
                className="btn btn-sm"
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
                style={{ fontSize: 12 }}
              >
                Previous
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Page {page + 1} of {totalPages}
              </span>
              <button
                className="btn btn-sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(p => p + 1)}
                style={{ fontSize: 12 }}
              >
                Next
              </button>
            </div>
          )}
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
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            maxWidth: 400,
            wordBreak: 'break-all',
            whiteSpace: 'pre-wrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            pointerEvents: 'none',
          }}
        >
          {tryDecodeBase64Preview(tooltipEntry.value)}
        </div>
      )}
      {/* Decode modal */}
      {decodingText && (
        <Base64DecodeModal
          encoded={decodingText}
          onClose={() => setDecodingText(null)}
        />
      )}
    </div>
  );
}
