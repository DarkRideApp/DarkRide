import React, { useState, useRef, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';

interface AssetSearchResult {
  path: string;
  apkName: string;
  matchType: 'filename' | 'content';
  size: number;
  line?: number;
  content?: string;
  context?: string[];
}

interface AssetSearchTab {
  id: string;
  query: string;
  caseSensitive: boolean;
  isRegex: boolean;
  results: AssetSearchResult[];
  total: number;
  limited: boolean;
  loading: boolean;
}

interface AssetSearchPanelProps {
  versionId: string;
  onNavigate: (filePath: string) => void;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Extract just the filename from a path */
function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.substring(i + 1) : path;
}

let tabCounter = 0;

export function AssetSearchPanel({ versionId, onNavigate, onClose }: AssetSearchPanelProps) {
  const ws = useWebSocket();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [tabs, setTabs] = useState<AssetSearchTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const doSearch = useCallback(() => {
    const q = query.trim();
    if (!q) return;

    const tabId = `asset-search-${++tabCounter}`;
    const newTab: AssetSearchTab = {
      id: tabId,
      query: q,
      caseSensitive,
      isRegex,
      results: [],
      total: 0,
      limited: false,
      loading: true,
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    const params = new URLSearchParams({ q });
    if (!caseSensitive) params.set('caseSensitive', 'false');
    if (isRegex) params.set('regex', 'true');

    ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/assets/search?${params.toString()}`)
      .then(res => {
        const data = res.body?.data;
        if (data) {
          setTabs(prev => prev.map(t =>
            t.id === tabId
              ? { ...t, results: data.results, total: data.total, limited: data.limited, loading: false }
              : t,
          ));
        } else {
          setTabs(prev => prev.map(t =>
            t.id === tabId ? { ...t, loading: false } : t,
          ));
        }
      })
      .catch(() => {
        setTabs(prev => prev.map(t =>
          t.id === tabId ? { ...t, loading: false } : t,
        ));
      });
  }, [query, caseSensitive, isRegex, versionId, ws]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      doSearch();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [doSearch, onClose]);

  const closeTab = useCallback((tabId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      return next;
    });
    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      const remaining = tabs.filter(t => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [tabs]);

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div className="search-panel" data-testid="asset-search-panel">
      <div className="search-panel-header" data-testid="asset-search-panel-header">
        <input
          ref={inputRef}
          className="form-input search-panel-input"
          data-testid="asset-search-input"
          placeholder="Search assets..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <button
          className={`search-panel-toggle${caseSensitive ? ' search-panel-toggle-active' : ''}`}
          data-testid="asset-search-toggle-case"
          onClick={() => setCaseSensitive(v => !v)}
          title="Match Case"
        >
          Aa
        </button>
        <button
          className={`search-panel-toggle${isRegex ? ' search-panel-toggle-active' : ''}`}
          data-testid="asset-search-toggle-regex"
          onClick={() => setIsRegex(v => !v)}
          title="Use Regular Expression"
        >
          .*
        </button>
        <button
          className="btn btn-sm btn-primary"
          data-testid="asset-search-submit"
          onClick={doSearch}
        >
          Search
        </button>
        <button
          className="search-panel-toggle"
          data-testid="asset-search-close"
          onClick={onClose}
          title="Close"
        >
          &times;
        </button>
      </div>

      {tabs.length > 0 && (
        <div className="search-panel-tabs" data-testid="asset-search-panel-tabs">
          {tabs.map(tab => (
            <div
              key={tab.id}
              data-testid={`asset-search-tab-${tab.id}`}
              className={`search-panel-tab${activeTabId === tab.id ? ' search-panel-tab-active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span>{tab.query}</span>
              <button
                className="search-panel-tab-close"
                data-testid={`asset-search-tab-close-${tab.id}`}
                onClick={e => closeTab(tab.id, e)}
                aria-label={`Close search "${tab.query}"`}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="search-panel-results" data-testid="asset-search-panel-results">
        {activeTab?.loading && (
          <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>Searching...</div>
        )}
        {activeTab && !activeTab.loading && activeTab.results.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>No results found</div>
        )}
        {activeTab && !activeTab.loading && activeTab.results.map((result, idx) => (
          <div
            key={`${result.path}:${result.line ?? 'fn'}:${idx}`}
            className="search-result-item"
            data-testid={`asset-search-result-${idx}`}
            onClick={() => onNavigate(result.path)}
          >
            {result.matchType === 'filename' ? (
              <>
                <span className="search-result-file">{result.path}</span>
                <span className="search-result-line" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  {formatBytes(result.size)}
                </span>
              </>
            ) : (
              <>
                <span className="search-result-file">{fileName(result.path)}</span>
                {result.line != null && <span className="search-result-line">:{result.line}</span>}
                {result.content && <span className="search-result-content">{result.content}</span>}
              </>
            )}
          </div>
        ))}
      </div>

      {activeTab && !activeTab.loading && (
        <div className="search-panel-status" data-testid="asset-search-panel-status">
          {activeTab.total} result{activeTab.total !== 1 ? 's' : ''}
          {activeTab.limited ? ' (limited to 200)' : ''}
        </div>
      )}
    </div>
  );
}
