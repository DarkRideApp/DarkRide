import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';

interface Finding {
  id: number;
  filePath: string;
  fileSource: string;
  ruleId: string;
  severity: string;
  title: string;
  description: string;
  lineNumber: number | null;
  matchedText: string | null;
  category: string;
}

interface ReactNativeTabProps {
  versionId: string;
  manifest: Record<string, any>;
  sourceCounts: Record<string, number>;
  onNavigate: (filePath: string, lineNumber: number, source: string) => void;
}

const ENDPOINT_CATEGORIES = new Set(['endpoint', 'url', 'network']);
const CONFIG_CATEGORIES = new Set(['config']);

const SEVERITY_STYLES: Record<string, { background: string; color: string; border: string }> = {
  critical: { background: '#dc354515', color: '#dc3545', border: '#dc354540' },
  high:     { background: '#fd7e1415', color: '#fd7e14', border: '#fd7e1440' },
  medium:   { background: '#ffc10715', color: '#ffc107', border: '#ffc10740' },
  low:      { background: '#0d6efd15', color: '#0d6efd', border: '#0d6efd40' },
  info:     { background: '#6c757d15', color: '#6c757d', border: '#6c757d40' },
};

export function ReactNativeTab({ versionId, manifest, sourceCounts, onNavigate }: ReactNativeTabProps) {
  const ws = useWebSocket();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ path: string; source: string; line: number; text: string }>>([]);
  const [searching, setSearching] = useState(false);

  const fetchFindings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/findings?source=hermes-dec&limit=1000`);
      if (res.status === 200 && res.body?.success) {
        setFindings(res.body.data || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws, versionId]);

  useEffect(() => {
    if (ws.connected) fetchFindings();
  }, [ws.connected, fetchFindings]);

  const endpoints = useMemo(() => {
    const seen = new Set<string>();
    return findings
      .filter(f => ENDPOINT_CATEGORIES.has(f.category))
      .filter(f => {
        const key = f.matchedText || '';
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [findings]);

  const configs = useMemo(() => {
    return findings.filter(f => CONFIG_CATEGORIES.has(f.category));
  }, [findings]);

  const secrets = useMemo(() => {
    return findings.filter(f => f.category === 'secret' || f.category === 'certificate');
  }, [findings]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await ws.sendRestApi('GET',
        `/v1/apps/analysis/${versionId}/search?q=${encodeURIComponent(searchQuery)}&source=hermes-dec&limit=50`
      );
      if (res.status === 200 && res.body?.success) {
        setSearchResults(res.body.data || []);
      }
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  }, [ws, versionId, searchQuery]);

  // Bundle info from manifest
  const frameworks = manifest?.frameworks || {};
  const rnDetails = frameworks.detected?.find((fw: any) => fw.name === 'React Native')?.details || {};
  const hermesEngine = rnDetails.hermesEngine || frameworks.hermesEngine;
  const bundlePath = rnDetails.hermesBundlePath || rnDetails.jsBundlePath || null;
  const hermesDecCount = sourceCounts?.['hermes-dec'] || 0;
  const hermesDecErrors = manifest?.hermesDecErrors;

  if (loading) return <LoadingSpinner />;

  return (
    <div data-testid="tab-content-reactnative" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Bundle Info */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Bundle Info</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Engine: </span>
            <span className={`badge ${hermesEngine ? 'badge-info' : 'badge-warning'}`}>
              {hermesEngine ? 'Hermes' : 'JavaScriptCore'}
            </span>
          </div>
          {bundlePath && (
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Bundle: </span>
              <code style={{ fontSize: 12 }}>{bundlePath}</code>
            </div>
          )}
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Decompiled files: </span>
            <strong>{hermesDecCount}</strong>
          </div>
          {hermesDecErrors && (
            <div style={{ color: '#fd7e14' }}>
              <span style={{ color: 'var(--text-muted)' }}>Decompile errors: </span>
              {typeof hermesDecErrors === 'string' ? hermesDecErrors : JSON.stringify(hermesDecErrors)}
            </div>
          )}
        </div>
      </div>

      {/* API Endpoints */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
          API Endpoints ({endpoints.length})
        </div>
        {endpoints.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No endpoints found in React Native bundle</div>
        ) : (
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>Type</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>Value</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>File</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((f) => (
                  <tr
                    key={f.id}
                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                    onClick={() => f.lineNumber && onNavigate(f.filePath, f.lineNumber, f.fileSource)}
                  >
                    <td style={{ padding: '4px 8px' }}>
                      <span className="badge" style={{
                        fontSize: 10,
                        ...SEVERITY_STYLES[f.severity],
                        padding: '1px 6px',
                        borderRadius: 3,
                        border: `1px solid ${SEVERITY_STYLES[f.severity]?.border || 'var(--border-color)'}`,
                      }}>
                        {f.ruleId}
                      </span>
                    </td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all' }}>
                      {f.matchedText}
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {f.filePath?.split('/').pop()}
                      {f.lineNumber ? `:${f.lineNumber}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Configuration & Feature Flags */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
          Configuration & Feature Flags ({configs.length})
        </div>
        {configs.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No config/flag patterns found</div>
        ) : (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>Type</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>Value</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>File</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((f) => (
                  <tr
                    key={f.id}
                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                    onClick={() => f.lineNumber && onNavigate(f.filePath, f.lineNumber, f.fileSource)}
                  >
                    <td style={{ padding: '4px 8px' }}>
                      <span className="badge" style={{ fontSize: 10, padding: '1px 6px' }}>{f.ruleId}</span>
                    </td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      {f.matchedText}
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {f.filePath?.split('/').pop()}
                      {f.lineNumber ? `:${f.lineNumber}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Secrets found in JS */}
      {secrets.length > 0 && (
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
            Secrets in JS Bundle ({secrets.length})
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>Severity</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>Rule</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>Value</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)' }}>File</th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((f) => (
                  <tr
                    key={f.id}
                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                    onClick={() => f.lineNumber && onNavigate(f.filePath, f.lineNumber, f.fileSource)}
                  >
                    <td style={{ padding: '4px 8px' }}>
                      <span className="badge" style={{
                        fontSize: 10,
                        ...SEVERITY_STYLES[f.severity],
                        padding: '1px 6px',
                        borderRadius: 3,
                        border: `1px solid ${SEVERITY_STYLES[f.severity]?.border || 'var(--border-color)'}`,
                      }}>
                        {f.severity}
                      </span>
                    </td>
                    <td style={{ padding: '4px 8px' }}>{f.title}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all' }}>
                      {f.matchedText?.slice(0, 80)}{(f.matchedText?.length || 0) > 80 ? '...' : ''}
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {f.filePath?.split('/').pop()}
                      {f.lineNumber ? `:${f.lineNumber}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Search JS Bundle</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            data-testid="rn-search-input"
            type="text"
            placeholder="Search decompiled JS files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            style={{
              flex: 1, padding: '6px 10px', fontSize: 13,
              background: 'var(--bg-secondary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: 4,
            }}
          />
          <button
            data-testid="rn-search-btn"
            className="btn btn-sm"
            onClick={handleSearch}
            disabled={searching || !searchQuery.trim()}
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
        {searchResults.length > 0 && (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                {searchResults.map((r, i) => (
                  <tr
                    key={i}
                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                    onClick={() => onNavigate(r.path, r.line, r.source)}
                  >
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {r.path.split('/').pop()}:{r.line}
                    </td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      {r.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
