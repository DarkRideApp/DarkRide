import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { FileTree } from './FileTree';
import type { TreeNode } from './FileTree';
import { buildTree } from './CodeBrowser';
import { AssetSearchPanel } from './AssetSearchPanel';

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

interface AssetEntry {
  path: string;
  size: number;
}

interface ArscResourceEntry {
  type: string;
  name: string;
  value: string;
  resourceId: string;
  config: string;
}

interface FileContent {
  isText: boolean;
  isImage: boolean;
  size: number;
  content?: string;
  dataUrl?: string;
  imageUrl?: string;
  extension?: string;
  downloadUrl?: string;
  isResourceTable?: boolean;
  resourceTypes?: string[];
  resources?: Record<string, ArscResourceEntry[]>;
  totalCount?: number;
}

interface AssetsBrowserProps {
  versionId: string;
}

export function AssetsBrowser({ versionId }: AssetsBrowserProps) {
  const ws = useWebSocket();
  const [entries, setEntries] = useState<AssetEntry[]>([]);
  const [apkNames, setApkNames] = useState<string[]>([]);
  const [isSplit, setIsSplit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [tryTextMode, setTryTextMode] = useState(false);
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree');
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);

  // Resource table state
  const [selectedResType, setSelectedResType] = useState<string | null>(null);
  const [resFilter, setResFilter] = useState('');

  // Build size lookup from entries
  const sizeMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) {
      map.set(e.path, e.size);
    }
    return map;
  }, [entries]);

  // Build tree from flat paths
  const tree = useMemo(() => {
    return buildTree(entries.map(e => e.path));
  }, [entries]);

  // Flat list sorted by size descending
  const sortedEntries = useMemo(() => {
    let filtered = entries;
    if (fileFilter) {
      const lower = fileFilter.toLowerCase();
      filtered = entries.filter(e => e.path.toLowerCase().includes(lower));
    }
    return [...filtered].sort((a, b) => b.size - a.size);
  }, [entries, fileFilter]);

  // Fetch the asset tree
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/assets/tree`)
      .then(res => {
        if (cancelled) return;
        if (res.status === 200 && res.body?.success) {
          setEntries(res.body.data.tree);
          setApkNames(res.body.data.apkNames);
          setIsSplit(res.body.data.isSplit);
        } else {
          setError(res.body?.error || 'Failed to load assets');
        }
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Failed to load assets');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [versionId, ws]);

  // Load file content when selecting a file
  const loadFile = useCallback((filePath: string, forceText?: boolean) => {
    setFileLoading(true);
    setFileError(null);
    setTryTextMode(false);
    setSelectedResType(null);
    setResFilter('');

    // Determine apkName for split APKs
    let apkName: string | undefined;
    let innerPath = filePath;
    if (isSplit) {
      const slashIdx = filePath.indexOf('/');
      if (slashIdx > 0) {
        apkName = filePath.substring(0, slashIdx);
        innerPath = filePath.substring(slashIdx + 1);
      }
    }

    let url = `/v1/apps/analysis/${versionId}/assets/file?path=${encodeURIComponent(innerPath)}`;
    if (apkName) url += `&apkName=${encodeURIComponent(apkName)}`;

    ws.sendRestApi('GET', url)
      .then(res => {
        if (res.status === 200 && res.body?.success) {
          const data = res.body.data as FileContent;
          if (forceText && !data.isText && !data.isImage && !data.isResourceTable && data.downloadUrl) {
            setTryTextMode(true);
            fetchRawAsText(filePath, apkName, innerPath);
            return;
          }
          setFileContent(data);
          // Auto-select first resource type for resource tables
          if (data.isResourceTable && data.resourceTypes && data.resourceTypes.length > 0) {
            setSelectedResType(data.resourceTypes[0]);
          }
        } else {
          setFileError(res.body?.error || 'Failed to load file');
          setFileContent(null);
        }
      })
      .catch(err => {
        setFileError(err?.message || 'Failed to load file');
        setFileContent(null);
      })
      .finally(() => {
        if (!forceText) setFileLoading(false);
      });
  }, [versionId, ws, isSplit]);

  // Fetch raw binary and display as text
  const fetchRawAsText = useCallback((filePath: string, apkName: string | undefined, innerPath: string) => {
    let url = `/v1/apps/analysis/${versionId}/assets/file?path=${encodeURIComponent(innerPath)}&raw=true`;
    if (apkName) url += `&apkName=${encodeURIComponent(apkName)}`;

    fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error('Failed to fetch');
        const buf = await r.arrayBuffer();
        const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        setFileContent({
          isText: true,
          isImage: false,
          size: buf.byteLength,
          content: text.substring(0, 2 * 1024 * 1024), // cap at 2MB
        });
      })
      .catch(() => {
        setFileError('Failed to load as text');
      })
      .finally(() => {
        setFileLoading(false);
      });
  }, [versionId]);

  const handleFileSelect = useCallback((filePath: string) => {
    setSelectedPath(filePath);
    loadFile(filePath);
  }, [loadFile]);

  const handleTryAsText = useCallback(() => {
    if (selectedPath) {
      setFileLoading(true);
      loadFile(selectedPath, true);
    }
  }, [selectedPath, loadFile]);

  const handleSearchNavigate = useCallback((filePath: string) => {
    handleFileSelect(filePath);
  }, [handleFileSelect]);

  // Filtered resources for the selected type
  const filteredResources = useMemo(() => {
    if (!fileContent?.isResourceTable || !fileContent.resources || !selectedResType) return [];
    const list = fileContent.resources[selectedResType] || [];
    if (!resFilter) return list;
    const lower = resFilter.toLowerCase();
    return list.filter(r =>
      r.name.toLowerCase().includes(lower) ||
      r.value.toLowerCase().includes(lower) ||
      r.resourceId.toLowerCase().includes(lower) ||
      r.config.toLowerCase().includes(lower)
    );
  }, [fileContent, selectedResType, resFilter]);

  // Get filename from path
  const selectedFilename = selectedPath ? selectedPath.split('/').pop() || selectedPath : null;

  if (loading) {
    return (
      <div className="code-browser" data-testid="assets-browser">
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', width: '100%' }}>
          Loading APK contents...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="code-browser" data-testid="assets-browser">
        <div className="empty-state" style={{ width: '100%' }}>
          <div className="empty-message">Failed to load assets</div>
          <div className="empty-description">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="code-browser" data-testid="assets-browser">
      {/* Sidebar */}
      <div className="code-browser-sidebar" data-testid="assets-sidebar">
        <div style={{ padding: '8px 8px 0' }}>
          {/* File count + view toggle + search button */}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{entries.length} files{isSplit ? ` in ${apkNames.length} APKs` : ''}</span>
            <span style={{ display: 'inline-flex', gap: 2 }}>
              <button
                className={`btn${viewMode === 'tree' ? ' btn-primary' : ''}`}
                onClick={() => setViewMode('tree')}
                style={{ fontSize: 10, padding: '1px 6px', lineHeight: '16px', minWidth: 0 }}
                data-testid="assets-view-tree"
              >
                Tree
              </button>
              <button
                className={`btn${viewMode === 'list' ? ' btn-primary' : ''}`}
                onClick={() => setViewMode('list')}
                style={{ fontSize: 10, padding: '1px 6px', lineHeight: '16px', minWidth: 0 }}
                data-testid="assets-view-list"
              >
                Size
              </button>
              <button
                className="btn btn-sm"
                data-testid="assets-search-toggle-btn"
                onClick={() => {
                  setSearchPanelOpen(v => {
                    if (!v) { setSelectedPath(null); setFileContent(null); }
                    return !v;
                  });
                }}
                title="Search Assets"
                style={{ fontSize: 14, padding: '1px 6px', lineHeight: '16px', minWidth: 0 }}
              >
                &#x1F50D;
              </button>
            </span>
          </div>
          <input
            className="form-input"
            data-testid="assets-filter-input"
            placeholder="Filter files..."
            value={fileFilter}
            onChange={e => setFileFilter(e.target.value)}
            style={{ fontSize: 12, padding: '5px 8px', marginBottom: 8 }}
          />
        </div>

        {viewMode === 'tree' ? (
          <FileTree
            tree={tree}
            selectedPath={selectedPath}
            onSelect={handleFileSelect}
            filter={fileFilter}
          />
        ) : (
          <div className="file-tree" data-testid="assets-flat-list" role="list" style={{ overflow: 'auto', flex: 1 }}>
            {sortedEntries.length === 0 && fileFilter && (
              <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                No files matching "{fileFilter}"
              </div>
            )}
            {sortedEntries.map(entry => (
              <div
                key={entry.path}
                className={`file-tree-item${selectedPath === entry.path ? ' file-tree-item-selected' : ''}`}
                style={{ paddingLeft: 8, paddingRight: 8, display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={() => handleFileSelect(entry.path)}
                role="listitem"
              >
                <span style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  direction: 'rtl',
                  textAlign: 'left',
                }}>
                  {entry.path}
                </span>
                <span style={{
                  flexShrink: 0,
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                  minWidth: 52,
                  textAlign: 'right',
                }}>
                  {formatBytes(entry.size)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Main content area */}
      <div className="code-browser-editor" data-testid="assets-content">
        {selectedPath && (
          <div style={{
            padding: '6px 12px',
            borderBottom: '1px solid var(--border-color)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--bg-secondary)',
          }}>
            <span style={{ fontFamily: 'var(--font-mono)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedPath}
            </span>
            {fileContent && (
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                {formatBytes(fileContent.size)}
              </span>
            )}
          </div>
        )}

        {fileLoading && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading...
          </div>
        )}

        {fileError && !fileLoading && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--status-error, #ef4444)' }}>
            {fileError}
          </div>
        )}

        {!selectedPath && !fileLoading && !searchPanelOpen && (
          <div className="empty-state" data-testid="assets-empty">
            <div className="empty-message">Select a file to view</div>
            <div className="empty-description">
              Browse the APK contents in the file tree on the left.
            </div>
          </div>
        )}
        {searchPanelOpen && (
          <div style={{ display: selectedPath ? 'none' : undefined, flex: 1, minHeight: 0 }}>
            <AssetSearchPanel
              versionId={versionId}
              onNavigate={handleSearchNavigate}
              onClose={() => setSearchPanelOpen(false)}
            />
          </div>
        )}

        {fileContent && !fileLoading && !fileError && (
          <div style={{ flex: 1, overflow: 'auto' }}>
            {/* Text content */}
            {fileContent.isText && fileContent.content != null && (
              <pre
                data-testid="assets-text-content"
                style={{
                  margin: 0,
                  padding: 12,
                  fontSize: 13,
                  lineHeight: 1.5,
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  overflow: 'auto',
                  flex: 1,
                }}
              >
                {fileContent.content}
              </pre>
            )}

            {/* Image content */}
            {fileContent.isImage && (fileContent.imageUrl || fileContent.dataUrl) && (
              <div
                data-testid="assets-image-content"
                style={{
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <img
                  src={fileContent.imageUrl || fileContent.dataUrl}
                  alt={selectedFilename || ''}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '70vh',
                    objectFit: 'contain',
                    border: '1px solid var(--border-color)',
                    borderRadius: 4,
                    background: 'repeating-conic-gradient(#80808020 0% 25%, transparent 0% 50%) 50% / 16px 16px',
                  }}
                />
                <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{selectedFilename} ({formatBytes(fileContent.size)})</span>
                  {fileContent.downloadUrl && (
                    <a
                      href={fileContent.downloadUrl}
                      download
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '2px 8px',
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 4,
                        textDecoration: 'none',
                        cursor: 'pointer',
                      }}
                      title="Download image"
                    >
                      Download
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Resource table (resources.arsc) */}
            {fileContent.isResourceTable && fileContent.resources && fileContent.resourceTypes && (
              <div
                data-testid="assets-resource-table"
                style={{ display: 'flex', flex: 1, height: '100%' }}
              >
                {/* Resource type list */}
                <div style={{
                  width: 180,
                  flexShrink: 0,
                  borderRight: '1px solid var(--border-color)',
                  overflow: 'auto',
                  background: 'var(--bg-secondary)',
                }}>
                  <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
                    {fileContent.totalCount} resources
                  </div>
                  {fileContent.resourceTypes.map(type => {
                    const count = fileContent.resources![type]?.length || 0;
                    return (
                      <div
                        key={type}
                        className={`file-tree-item${selectedResType === type ? ' file-tree-item-selected' : ''}`}
                        style={{ paddingLeft: 8, paddingRight: 8, display: 'flex', alignItems: 'center' }}
                        onClick={() => { setSelectedResType(type); setResFilter(''); }}
                      >
                        <span className="file-tree-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {type}
                        </span>
                        <span className="file-tree-count" style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, marginLeft: 4 }}>
                          {count}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Resource entries table */}
                <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                  {selectedResType && (
                    <>
                      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
                        <input
                          className="form-input"
                          placeholder={`Filter ${selectedResType} resources...`}
                          value={resFilter}
                          onChange={e => setResFilter(e.target.value)}
                          style={{ fontSize: 12, padding: '4px 8px', width: '100%' }}
                          data-testid="assets-resource-filter"
                        />
                      </div>
                      <div style={{ flex: 1, overflow: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                              <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--text-secondary)' }}>Name</th>
                              <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--text-secondary)' }}>Value</th>
                              <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--text-secondary)', width: 80 }}>Config</th>
                              <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--text-secondary)', width: 100 }}>ID</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredResources.map((r, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{r.name}</td>
                                <td style={{ padding: '4px 8px', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.value}</td>
                                <td style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11 }}>{r.config}</td>
                                <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{r.resourceId}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {filteredResources.length === 0 && resFilter && (
                          <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                            No resources matching "{resFilter}"
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {!selectedResType && (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                      Select a resource type from the list
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Binary content */}
            {!fileContent.isText && !fileContent.isImage && !fileContent.isResourceTable && (
              <div
                data-testid="assets-binary-content"
                style={{
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div style={{
                  padding: '16px 24px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: 8,
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                    {selectedFilename}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
                    Binary file ({formatBytes(fileContent.size)})
                  </div>
                  {fileContent.extension && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Type: {fileContent.extension}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {fileContent.downloadUrl && (
                    <a
                      className="btn btn-primary"
                      href={fileContent.downloadUrl}
                      download={selectedFilename}
                      style={{ textDecoration: 'none' }}
                      data-testid="assets-download-btn"
                    >
                      Download
                    </a>
                  )}
                  <button
                    className="btn"
                    onClick={handleTryAsText}
                    data-testid="assets-try-text-btn"
                  >
                    Try loading as text
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
