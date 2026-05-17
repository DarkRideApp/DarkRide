import React, { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { SettingsNav } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Folder, File, Download, Trash2, RefreshCw, Search } from 'lucide-react';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';

interface CloudStatus {
  configured: boolean;
  localCacheUsageMb: number;
  localCacheBudgetMb: number;
  filesTracked: number;
  filesCloudOnly: number;
  pendingUploads: number;
  errors: { cloudKey: string; error: string }[];
}

interface CloudFile {
  key: string;
  size: number;
  lastModified: string;
}

interface BrowseData {
  prefixes: string[];
  files: CloudFile[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return '< 1 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatCacheMb(mb: number): string {
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function getFileName(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
}

function getFolderName(prefix: string): string {
  // prefix ends with '/', strip trailing slash and get last segment
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || prefix;
}

function parseBreadcrumbs(prefix: string): { label: string; prefix: string }[] {
  const crumbs: { label: string; prefix: string }[] = [{ label: '/', prefix: '' }];
  if (!prefix) return crumbs;

  const parts = prefix.split('/').filter(Boolean);
  let accumulated = '';
  for (const part of parts) {
    accumulated += part + '/';
    crumbs.push({ label: part, prefix: accumulated });
  }
  return crumbs;
}

export function CloudBrowser() {
  useDocumentTitle('Cloud Storage');

  const [prefix, setPrefix] = useState('');
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [browseData, setBrowseData] = useState<BrowseData | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<CloudFile | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/v1/cloud/status');
      const json = await res.json();
      if (json.success) {
        setStatus(json.data);
      }
    } catch {
      // Status fetch failure is non-critical
    }
  }, []);

  const fetchBrowse = useCallback(async (currentPrefix: string) => {
    try {
      const params = new URLSearchParams({ prefix: currentPrefix, delimiter: '/' });
      const res = await fetch(`/v1/cloud/browse?${params}`);
      const json = await res.json();
      if (json.success) {
        setBrowseData(json.data);
      } else {
        setError(json.error || 'Failed to browse cloud storage');
      }
    } catch (e: any) {
      setError(e.message || 'Failed to fetch cloud storage data');
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchStatus(), fetchBrowse(prefix)]);
    } finally {
      setLoading(false);
    }
  }, [fetchStatus, fetchBrowse, prefix]);

  useEffect(() => {
    refresh();
  }, [prefix]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDownload = async (key: string) => {
    try {
      const res = await fetch(`/v1/cloud/download/${encodeURIComponent(key)}`);
      const json = await res.json();
      if (json.success && json.data?.url) {
        window.open(json.data.url, '_blank');
      }
    } catch {
      // ignore
    }
  };

  const handleDelete = async (key: string) => {
    setDeleting(key);
    try {
      await fetch(`/v1/cloud/delete/${encodeURIComponent(key)}`, { method: 'POST' });
      await fetchBrowse(prefix);
    } catch {
      // ignore
    } finally {
      setDeleting(null);
    }
  };

  const navigateToFolder = (folderPrefix: string) => {
    setFilter('');
    setPrefix(folderPrefix);
  };

  // Filter logic
  const filteredPrefixes = browseData?.prefixes.filter(p =>
    getFolderName(p).toLowerCase().includes(filter.toLowerCase())
  ) || [];

  const filteredFiles = browseData?.files.filter(f =>
    getFileName(f.key).toLowerCase().includes(filter.toLowerCase())
  ) || [];

  const { sorted: sortedFiles, sortKey: fileSortKey, sortDir: fileSortDir, onSort: onFileSort } = useSortableTable(filteredFiles, 'key');

  const breadcrumbs = parseBreadcrumbs(prefix);

  const isNotConfigured = status && !status.configured;

  return (
    <div data-testid="cloud-browser-page">
      <SettingsNav actions={
        <button className="btn" onClick={refresh} disabled={loading} data-testid="refresh-btn">
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      } />

      {/* Status bar */}
      {status && (
        <div className="cloud-status-bar" data-testid="cloud-status-bar">
          {isNotConfigured ? (
            <span className="cloud-status-unconfigured" data-testid="cloud-not-configured">
              Cloud storage is not configured. Go to Settings to set up a cloud provider.
            </span>
          ) : (
            <div className="cloud-status-stats">
              <span data-testid="cache-usage">
                Cache: {formatCacheMb(status.localCacheUsageMb)} / {formatCacheMb(status.localCacheBudgetMb)}
              </span>
              <span>Files tracked: {status.filesTracked}</span>
              <span>Cloud-only: {status.filesCloudOnly}</span>
              {status.pendingUploads > 0 && (
                <span data-testid="pending-uploads">Pending uploads: {status.pendingUploads}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error banner */}
      {status && status.errors && status.errors.length > 0 && (
        <div className="cloud-error-banner" data-testid="cloud-error-banner">
          <strong>Errors ({status.errors.length}):</strong>
          <ul>
            {status.errors.map((e, i) => (
              <li key={i}>{e.cloudKey}: {e.error}</li>
            ))}
          </ul>
        </div>
      )}

      {/* API-level error */}
      {error && (
        <div className="cloud-error-banner" data-testid="cloud-fetch-error">
          {error}
        </div>
      )}

      {/* Breadcrumbs */}
      <div className="cloud-breadcrumbs" data-testid="cloud-breadcrumbs">
        {breadcrumbs.map((crumb, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="cloud-breadcrumb-sep">&gt;</span>}
            <button
              className={`cloud-breadcrumb-item ${i === breadcrumbs.length - 1 ? 'active' : ''}`}
              onClick={() => navigateToFolder(crumb.prefix)}
              data-testid={`breadcrumb-${i}`}
            >
              {crumb.label}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Filter */}
      <div className="cloud-filter" style={{ marginBottom: 12 }}>
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)' }} />
          <input
            className="form-input"
            type="text"
            placeholder="Filter files and folders..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            data-testid="filter-input"
            style={{ paddingLeft: 32, width: 280 }}
          />
        </div>
      </div>

      {/* Loading */}
      {loading && <LoadingSpinner large center />}

      {/* Table */}
      {!loading && browseData && (
        <table className="data-table cloud-browser-table" data-testid="cloud-browser-table">
          <thead>
            <tr>
              <SortableHeader label="Name" sortKey="key" currentSort={fileSortKey} dir={fileSortDir} onSort={onFileSort} />
              <SortableHeader label="Size" sortKey="size" currentSort={fileSortKey} dir={fileSortDir} onSort={onFileSort} />
              <SortableHeader label="Last Modified" sortKey="lastModified" currentSort={fileSortKey} dir={fileSortDir} onSort={onFileSort} />
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredPrefixes.map(p => (
              <tr key={p} className="clickable-row" onClick={() => navigateToFolder(p)} data-testid={`folder-${getFolderName(p)}`}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Folder size={16} style={{ color: 'var(--warning)' }} />
                    {getFolderName(p)}
                  </span>
                </td>
                <td>--</td>
                <td className="hide-mobile">--</td>
                <td></td>
              </tr>
            ))}
            {sortedFiles.map(f => (
              <tr key={f.key} data-testid={`file-${getFileName(f.key)}`}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <File size={16} style={{ color: 'var(--text-muted)' }} />
                    {getFileName(f.key)}
                  </span>
                </td>
                <td>{formatSize(f.size)}</td>
                <td className="hide-mobile">{formatDate(f.lastModified)}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => handleDownload(f.key)}
                      title="Download"
                      data-testid={`download-${getFileName(f.key)}`}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteConfirm(f)}
                      disabled={deleting === f.key}
                      title="Delete"
                      data-testid={`delete-${getFileName(f.key)}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredPrefixes.length === 0 && sortedFiles.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>
                  {filter ? 'No matches found' : 'This folder is empty'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete File"
          message={`Are you sure you want to delete "${getFileName(deleteConfirm.key)}"?`}
          onConfirm={() => { handleDelete(deleteConfirm.key); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
