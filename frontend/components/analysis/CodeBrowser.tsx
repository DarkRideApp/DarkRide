import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { FileTree } from './FileTree';
import type { TreeNode } from './FileTree';
import { SearchPanel } from './SearchPanel';
import type { PendingSearch } from './SearchPanel';

// Configure Monaco web workers for Vite before any monaco import
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
        { type: 'module' },
      );
    }
    if (label === 'json') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        { type: 'module' },
      );
    }
    if (label === 'css') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url),
        { type: 'module' },
      );
    }
    if (label === 'html') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url),
        { type: 'module' },
      );
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    );
  },
};

const SOURCE_LABELS: Record<string, string> = {
  'jadx': 'Java',
  'apktool': 'Smali',
  'hermes-dec': 'React Native',
};

/** Build a nested tree from a flat array of file paths */
export function buildTree(flatPaths: string[]): TreeNode[] {
  const root: Map<string, any> = new Map();

  for (const filePath of flatPaths) {
    const parts = filePath.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.has(part)) {
        current.set(part, new Map());
      }
      current = current.get(part);
    }
  }

  function mapToNodes(map: Map<string, any>, prefix: string): TreeNode[] {
    const dirs: TreeNode[] = [];
    const files: TreeNode[] = [];

    for (const [name, children] of map.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (children.size === 0) {
        files.push({ name, path, type: 'file' });
      } else {
        dirs.push({
          name,
          path,
          type: 'dir',
          children: mapToNodes(children, path),
        });
      }
    }

    // Sort: directories first (alphabetical), then files (alphabetical)
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  return mapToNodes(root, '');
}

/** Map file extension to Monaco language identifier */
function getLanguage(path: string): string {
  if (path.endsWith('.java')) return 'java';
  if (path.endsWith('.kt')) return 'kotlin';
  if (path.endsWith('.smali')) return 'plaintext';
  if (path.endsWith('.xml')) return 'xml';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  if (path.endsWith('.properties')) return 'ini';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.html')) return 'html';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.txt') || path.endsWith('.md')) return 'plaintext';
  if (path.endsWith('.hasm')) return 'plaintext';
  return 'plaintext';
}

/** Extract just the filename from a path */
function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.substring(i + 1) : path;
}

interface Tab {
  path: string;
  pinned: boolean;
}

interface CodeBrowserProps {
  versionId: string;
  /** Navigate to this file on mount or when changed */
  navigateTo?: { filePath: string; lineNumber: number; source: string } | null;
}

export function CodeBrowser({ versionId, navigateTo }: CodeBrowserProps) {
  const ws = useWebSocket();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [availableSources, setAvailableSources] = useState<string[]>([]);
  const [fileFilter, setFileFilter] = useState('');
  const [loading, setLoading] = useState(false);

  // Tab state
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // File content cache: path -> content string
  const contentCacheRef = useRef<Map<string, string>>(new Map());
  const [currentContent, setCurrentContent] = useState<string>('');

  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [pendingSearch, setPendingSearch] = useState<PendingSearch | null>(null);
  const pendingSearchKeyRef = useRef(0);

  // Refs so Monaco action callbacks (created once) can access latest values
  const setPendingSearchRef = useRef(setPendingSearch);
  setPendingSearchRef.current = setPendingSearch;
  const setSearchPanelOpenRef = useRef(setSearchPanelOpen);
  setSearchPanelOpenRef.current = setSearchPanelOpen;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  // Discover available sources on mount, pick the first one with files
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/tree`)
      .then(res => {
        if (cancelled) return;
        const data = res.body?.data;
        if (data?.sources) {
          setAvailableSources(data.sources);
          const preferred = ['jadx', 'apktool'];
          const pick = preferred.find(s => data.sources.includes(s)) || data.sources[0] || 'jadx';
          setSource(pick);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [versionId, ws]);

  // Fetch tree when source changes
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setLoading(true);
    ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/tree?source=${source}`)
      .then(res => {
        if (cancelled) return;
        const data = res.body?.data;
        setTree(data?.tree ? buildTree(data.tree) : []);
      })
      .catch(() => {
        if (!cancelled) setTree([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [versionId, source, ws]);

  // Fetch and cache file content
  const fetchFileContent = useCallback((filePath: string) => {
    const cached = contentCacheRef.current.get(filePath);
    if (cached !== undefined) {
      setCurrentContent(cached);
      return;
    }
    ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/file?path=${encodeURIComponent(filePath)}&source=${source}`)
      .then(res => {
        const content = res.body?.data || '';
        contentCacheRef.current.set(filePath, content);
        setCurrentContent(content);
      })
      .catch(() => {
        const errContent = '// Error loading file';
        contentCacheRef.current.set(filePath, errContent);
        setCurrentContent(errContent);
      });
  }, [versionId, source, ws]);

  // Open a file as preview (single click in tree)
  const handleFileSelect = useCallback((filePath: string) => {
    setTabs(prev => {
      // If already a pinned tab, just activate it
      if (prev.some(t => t.path === filePath && t.pinned)) {
        return prev;
      }
      // Replace any existing preview tab with this one
      const withoutPreview = prev.filter(t => t.pinned);
      return [...withoutPreview, { path: filePath, pinned: false }];
    });
    setActiveTab(filePath);
    fetchFileContent(filePath);
  }, [fetchFileContent]);

  // Pin a file (double click in tree, or double click on preview tab)
  const handleFilePin = useCallback((filePath: string) => {
    setTabs(prev => {
      const existing = prev.find(t => t.path === filePath);
      if (existing) {
        // Pin it if it was preview
        return prev.map(t => t.path === filePath ? { ...t, pinned: true } : t);
      }
      // New pinned tab
      const withoutPreview = prev.filter(t => t.pinned);
      return [...withoutPreview, { path: filePath, pinned: true }];
    });
    setActiveTab(filePath);
    fetchFileContent(filePath);
  }, [fetchFileContent]);

  // Close a tab
  const handleTabClose = useCallback((filePath: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    setTabs(prev => {
      const next = prev.filter(t => t.path !== filePath);
      return next;
    });
    setActiveTab(prev => {
      if (prev !== filePath) return prev;
      // Switch to nearest tab
      const remaining = tabs.filter(t => t.path !== filePath);
      if (remaining.length === 0) return null;
      const idx = tabs.findIndex(t => t.path === filePath);
      const nextTab = remaining[Math.min(idx, remaining.length - 1)];
      return nextTab?.path || null;
    });
  }, [tabs]);

  // Switch active tab
  const handleTabClick = useCallback((filePath: string) => {
    setActiveTab(filePath);
    fetchFileContent(filePath);
  }, [fetchFileContent]);

  // Double-click on tab to pin it
  const handleTabDoubleClick = useCallback((filePath: string) => {
    setTabs(prev => prev.map(t => t.path === filePath ? { ...t, pinned: true } : t));
  }, []);

  // Middle-click to close tab
  const handleTabMouseDown = useCallback((filePath: string, e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      handleTabClose(filePath);
    }
  }, [handleTabClose]);

  // When active tab changes, load content from cache
  useEffect(() => {
    if (!activeTab) {
      setCurrentContent('');
      return;
    }
    const cached = contentCacheRef.current.get(activeTab);
    if (cached !== undefined) {
      setCurrentContent(cached);
    }
  }, [activeTab]);

  // Initialize Monaco editor
  useEffect(() => {
    if (!editorContainerRef.current) return;

    let disposed = false;
    let editor: any = null;

    (async () => {
      try {
        const monaco = await import('monaco-editor');
        if (disposed) return;

        monacoRef.current = monaco;

        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        editor = monaco.editor.create(editorContainerRef.current!, {
          value: '',
          language: 'plaintext',
          theme: isDark ? 'vs-dark' : 'vs-light',
          readOnly: true,
          minimap: { enabled: true },
          fontSize: 13,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        });

        editorInstanceRef.current = editor;

        // Helper: get selected text or word at cursor
        function getSelectedText(): string {
          const sel = editor.getSelection();
          const model = editor.getModel();
          if (sel && !sel.isEmpty()) {
            return model?.getValueInRange(sel) || '';
          }
          const pos = editor.getPosition();
          if (pos && model) {
            const wordInfo = model.getWordAtPosition(pos);
            if (wordInfo) return wordInfo.word;
          }
          return '';
        }

        // Action 1: Find All References
        editor.addAction({
          id: 'find-all-references',
          label: 'Find All References',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 1,
          keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
          run: () => {
            const text = getSelectedText();
            if (!text) return;
            setSearchPanelOpenRef.current(true);
            setPendingSearchRef.current({
              query: text,
              isRegex: false,
              caseSensitive: true,
              autoExecute: true,
              key: ++pendingSearchKeyRef.current,
            });
          },
        });

        // Action 2: Go to Definition
        editor.addAction({
          id: 'go-to-definition',
          label: 'Go to Definition',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 0.5,
          keybindings: [monaco.KeyCode.F12],
          run: () => {
            const word = getSelectedText();
            if (!word) return;
            const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = `(class|interface|enum)\\s+${escaped}\\b|\\w[\\w<>\\[\\]]*\\s+${escaped}\\s*\\(`;
            setSearchPanelOpenRef.current(true);
            setPendingSearchRef.current({
              query: regex,
              isRegex: true,
              caseSensitive: true,
              autoExecute: true,
              key: ++pendingSearchKeyRef.current,
            });
          },
        });

        // Action 3: Search in Files
        editor.addAction({
          id: 'search-in-files',
          label: 'Search in Files...',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 2,
          run: () => {
            const text = getSelectedText();
            setSearchPanelOpenRef.current(true);
            setPendingSearchRef.current({
              query: text,
              isRegex: false,
              caseSensitive: false,
              autoExecute: false,
              key: ++pendingSearchKeyRef.current,
            });
          },
        });
      } catch {
        // Monaco load failed
      }
    })();

    return () => {
      disposed = true;
      if (editor) {
        editor.dispose();
        editor = null;
      }
      editorInstanceRef.current = null;
    };
  }, []);

  // Update editor content and language when active file or content changes
  useEffect(() => {
    const editor = editorInstanceRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (model) {
      const lang = activeTab ? getLanguage(activeTab) : 'plaintext';
      monaco.editor.setModelLanguage(model, lang);
      editor.setValue(currentContent);
    }
  }, [currentContent, activeTab]);

  // Handle external navigation (from findings/strings)
  useEffect(() => {
    if (!navigateTo) return;
    const { filePath, source: navSource } = navigateTo;
    if (navSource && navSource !== source) {
      setSource(navSource);
    }
    // Pin navigated-to files since they come from findings
    handleFilePin(filePath);
  }, [navigateTo]);

  // Scroll to line after editor content loads from navigateTo
  useEffect(() => {
    if (!navigateTo?.lineNumber || !currentContent) return;
    const editor = editorInstanceRef.current;
    if (editor && activeTab === navigateTo.filePath) {
      setTimeout(() => {
        editor.revealLineInCenter(navigateTo.lineNumber);
        editor.setPosition({ lineNumber: navigateTo.lineNumber, column: 1 });
      }, 100);
    }
  }, [currentContent, navigateTo, activeTab]);

  // Keyboard shortcut: Ctrl+Shift+F to toggle search panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setSearchPanelOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Navigate to a file from search results
  const handleSearchNavigate = useCallback((filePath: string, lineNumber: number, fileSource: string) => {
    if (fileSource && fileSource !== source) {
      setSource(fileSource);
    }
    handleFilePin(filePath);
    // After content loads, scroll to line
    setTimeout(() => {
      const editor = editorInstanceRef.current;
      if (editor) {
        editor.revealLineInCenter(lineNumber);
        editor.setPosition({ lineNumber, column: 1 });
      }
    }, 200);
  }, [source, handleFilePin]);

  const handleSourceChange = useCallback((s: string) => {
    setSource(s);
    setTabs([]);
    setActiveTab(null);
    setCurrentContent('');
    setFileFilter('');
    contentCacheRef.current.clear();
  }, []);

  // The file tree highlights the active tab
  const selectedFile = activeTab;

  return (
    <div className="code-browser" data-testid="code-browser">
      <div className="code-browser-sidebar" data-testid="code-browser-sidebar">
        <div className="source-switcher" data-testid="source-switcher" style={{ display: 'flex', gap: 4, padding: 8, alignItems: 'center' }}>
          <select
            data-testid="source-select"
            className="form-input"
            value={source ?? ''}
            onChange={e => handleSourceChange(e.target.value)}
            style={{ flex: 1, fontSize: 12, padding: '4px 6px', minWidth: 0 }}
          >
            {availableSources.map(s => (
              <option key={s} value={s}>{SOURCE_LABELS[s] ?? s} ({s})</option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            data-testid="search-toggle-btn"
            onClick={() => setSearchPanelOpen(v => !v)}
            title="Search in Files (Ctrl+Shift+F)"
            style={{ fontSize: 14, padding: '3px 6px', lineHeight: 1 }}
          >
            &#x1F50D;
          </button>
          <a
            className="btn btn-sm"
            data-testid="download-btn"
            href={`/v1/apps/analysis/${versionId}/download${source ? `?source=${source}` : ''}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 14, padding: '3px 6px', lineHeight: 1, textDecoration: 'none' }}
          >
            &#x2B07;
          </a>
        </div>
        <div style={{ padding: '0 8px 8px' }}>
          <input
            className="form-input"
            data-testid="file-filter-input"
            placeholder="Filter files..."
            value={fileFilter}
            onChange={e => setFileFilter(e.target.value)}
            style={{ fontSize: 12, padding: '5px 8px' }}
          />
        </div>
        {loading ? (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Loading...
          </div>
        ) : (
          <FileTree
            tree={tree}
            selectedPath={selectedFile}
            onSelect={handleFileSelect}
            onDoubleClick={handleFilePin}
            filter={fileFilter}
          />
        )}
      </div>
      <div className="code-browser-editor" data-testid="code-browser-editor">
        {tabs.length > 0 && (
          <div className="code-browser-tabs" data-testid="code-browser-tabs">
            {tabs.map(tab => (
              <div
                key={tab.path}
                data-testid={`tab-${fileName(tab.path)}`}
                className={`code-browser-tab${activeTab === tab.path ? ' code-browser-tab-active' : ''}${!tab.pinned ? ' code-browser-tab-preview' : ''}`}
                onClick={() => handleTabClick(tab.path)}
                onDoubleClick={() => handleTabDoubleClick(tab.path)}
                onMouseDown={e => handleTabMouseDown(tab.path, e)}
                title={tab.path + (tab.pinned ? '' : ' (preview - double-click to keep open)')}
              >
                <span className="code-browser-tab-name">{fileName(tab.path)}</span>
                <button
                  className="code-browser-tab-close"
                  data-testid={`tab-close-${fileName(tab.path)}`}
                  onClick={e => handleTabClose(tab.path, e)}
                  aria-label={`Close ${fileName(tab.path)}`}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          ref={editorContainerRef}
          data-testid="monaco-editor-container"
          style={{ flex: 1, display: activeTab ? undefined : 'none', minHeight: 100 }}
        />
        {!activeTab && !searchPanelOpen && (
          <div className="empty-state" data-testid="code-browser-empty">
            <div className="empty-message">Select a file to view</div>
            <div className="empty-description">
              Browse the file tree on the left to open a source file.
            </div>
          </div>
        )}
        {searchPanelOpen && (
          <SearchPanel
            versionId={versionId}
            source={source}
            onNavigate={handleSearchNavigate}
            onClose={() => setSearchPanelOpen(false)}
            pendingSearch={pendingSearch}
          />
        )}
      </div>
    </div>
  );
}
