import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';

interface SearchResult {
  file: string;
  source: string;
  line: number;
  content: string;
  context: string[];
}

interface SearchTab {
  id: string;
  query: string;
  caseSensitive: boolean;
  isRegex: boolean;
  results: SearchResult[];
  total: number;
  limited: boolean;
  loading: boolean;
}

export interface PendingSearch {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  autoExecute: boolean;
  key: number;
}

interface SearchPanelProps {
  versionId: string;
  source: string | null;
  onNavigate: (filePath: string, lineNumber: number, source: string) => void;
  onClose: () => void;
  pendingSearch?: PendingSearch | null;
}

/** Extract just the filename from a path */
function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.substring(i + 1) : path;
}

let tabCounter = 0;

export function SearchPanel({ versionId, source, onNavigate, onClose, pendingSearch }: SearchPanelProps) {
  const ws = useWebSocket();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [tabs, setTabs] = useState<SearchTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const doSearchRef = useRef<() => void>(() => {});

  const doSearch = useCallback(() => {
    const q = query.trim();
    if (!q) return;

    const tabId = `search-${++tabCounter}`;
    const newTab: SearchTab = {
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
    if (source) params.set('source', source);
    if (!caseSensitive) params.set('caseSensitive', 'false');
    if (isRegex) params.set('regex', 'true');

    ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/search?${params.toString()}`)
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
  }, [query, caseSensitive, isRegex, source, versionId, ws]);

  doSearchRef.current = doSearch;

  // Handle pendingSearch from context menu actions
  useEffect(() => {
    if (!pendingSearch) return;
    setQuery(pendingSearch.query);
    setCaseSensitive(pendingSearch.caseSensitive);
    setIsRegex(pendingSearch.isRegex);
    if (pendingSearch.autoExecute) {
      // Defer to next tick so state updates are applied before search executes
      setTimeout(() => doSearchRef.current(), 0);
    } else {
      inputRef.current?.focus();
    }
  }, [pendingSearch?.key]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="search-panel" data-testid="search-panel">
      <div className="search-panel-header" data-testid="search-panel-header">
        <input
          ref={inputRef}
          className="form-input search-panel-input"
          data-testid="search-input"
          placeholder="Search in files..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <button
          className={`search-panel-toggle${caseSensitive ? ' search-panel-toggle-active' : ''}`}
          data-testid="search-toggle-case"
          onClick={() => setCaseSensitive(v => !v)}
          title="Match Case"
        >
          Aa
        </button>
        <button
          className={`search-panel-toggle${isRegex ? ' search-panel-toggle-active' : ''}`}
          data-testid="search-toggle-regex"
          onClick={() => setIsRegex(v => !v)}
          title="Use Regular Expression"
        >
          .*
        </button>
        <button
          className="btn btn-sm btn-primary"
          data-testid="search-submit"
          onClick={doSearch}
        >
          Search
        </button>
        <button
          className="search-panel-toggle"
          data-testid="search-close"
          onClick={onClose}
          title="Close"
        >
          &times;
        </button>
      </div>

      {tabs.length > 0 && (
        <div className="search-panel-tabs" data-testid="search-panel-tabs">
          {tabs.map(tab => (
            <div
              key={tab.id}
              data-testid={`search-tab-${tab.id}`}
              className={`search-panel-tab${activeTabId === tab.id ? ' search-panel-tab-active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span>{tab.query}</span>
              <button
                className="search-panel-tab-close"
                data-testid={`search-tab-close-${tab.id}`}
                onClick={e => closeTab(tab.id, e)}
                aria-label={`Close search "${tab.query}"`}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="search-panel-results" data-testid="search-panel-results">
        {activeTab?.loading && (
          <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>Searching...</div>
        )}
        {activeTab && !activeTab.loading && activeTab.results.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>No results found</div>
        )}
        {activeTab && !activeTab.loading && activeTab.results.map((result, idx) => (
          <div
            key={`${result.file}:${result.line}:${idx}`}
            className="search-result-item"
            data-testid={`search-result-${idx}`}
            onClick={() => onNavigate(result.file, result.line, result.source)}
          >
            <span className="search-result-file">{fileName(result.file)}</span>
            <span className="search-result-line">:{result.line}</span>
            <span className="search-result-content">{result.content}</span>
          </div>
        ))}
      </div>

      {activeTab && !activeTab.loading && (
        <div className="search-panel-status" data-testid="search-panel-status">
          {activeTab.total} result{activeTab.total !== 1 ? 's' : ''}
          {activeTab.limited ? ' (limited to 100)' : ''}
        </div>
      )}
    </div>
  );
}
