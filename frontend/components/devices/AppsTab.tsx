import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { AppDetailModal } from './AppDetailModal';
import type { InstalledApp } from './AppDetailModal';

type ViewMode = 'list' | 'grid';

function storageKey(deviceId: string) {
  return `darkride:device-viewer:apps-view:${deviceId}`;
}

function readViewMode(deviceId: string): ViewMode {
  try {
    const v = localStorage.getItem(storageKey(deviceId));
    if (v === 'grid' || v === 'list') return v;
  } catch {
    // localStorage unavailable
  }
  return 'list';
}

function saveViewMode(deviceId: string, mode: ViewMode) {
  try {
    localStorage.setItem(storageKey(deviceId), mode);
  } catch {
    // ignore
  }
}

interface AppsTabProps {
  deviceId: string;
}

export function AppsTab({ deviceId }: AppsTabProps) {
  const ws = useWebSocket();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Tracks which packages have failed to load an icon, so we render the
  // fallback glyph instead of a broken-image placeholder.
  const [iconFailed, setIconFailed] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode(deviceId));
  const [selectedApp, setSelectedApp] = useState<InstalledApp | null>(null);

  const fetchApps = useCallback((force: boolean) => {
    if (!ws.connected) return;
    const url = `/v1/device/apps/${encodeURIComponent(deviceId)}${force ? '?force=true' : ''}`;
    if (force) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    ws.sendRestApi('GET', url).then(res => {
      if (res.body?.success) {
        setApps(res.body.data);
      } else {
        setError(res.body?.error || 'Failed to load apps');
      }
    }).catch(() => {
      setError('Failed to load apps');
    }).finally(() => {
      setLoading(false);
      setRefreshing(false);
    });
  }, [ws, deviceId]);

  useEffect(() => {
    fetchApps(false);
  }, [fetchApps]);

  const handleRefresh = useCallback(() => {
    fetchApps(true);
  }, [fetchApps]);

  const handleViewModeToggle = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    saveViewMode(deviceId, mode);
  }, [deviceId]);

  const handleAppUpdated = useCallback((updatedApp: InstalledApp) => {
    setApps(prev => prev.map(a => a.packageName === updatedApp.packageName ? updatedApp : a));
    if (selectedApp?.packageName === updatedApp.packageName) {
      setSelectedApp(updatedApp);
    }
  }, [selectedApp]);

  const filtered = apps.filter(app => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      app.packageName.toLowerCase().includes(q) ||
      (app.appName && app.appName.toLowerCase().includes(q))
    );
  });

  const handleIconError = useCallback((packageName: string) => {
    setIconFailed(prev => prev[packageName] ? prev : { ...prev, [packageName]: true });
  }, []);

  const iconUrl = (packageName: string) => `/v1/apps/icon/${encodeURIComponent(packageName)}`;

  const trackedDot = (
    <span
      title="Tracked"
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'var(--color-success, #22c55e)',
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }} data-testid="apps-tab">
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        marginBottom: 12,
        flexWrap: 'wrap',
      }}>
        <input
          type="text"
          className="form-input"
          placeholder="Search apps..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          data-testid="apps-search"
          style={{ flex: 1, minWidth: 160 }}
        />
        <button
          className="btn btn-secondary"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          data-testid="refresh-apps"
          title="Force refresh app list from device"
          style={{ flexShrink: 0 }}
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
        {/* View toggle */}
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-color, #333)', flexShrink: 0 }}>
          <button
            onClick={() => handleViewModeToggle('list')}
            data-testid="view-toggle-list"
            title="List view"
            style={{
              padding: '4px 10px',
              border: 'none',
              background: viewMode === 'list' ? 'var(--accent-color, #4a9eff)' : 'transparent',
              color: viewMode === 'list' ? '#fff' : 'var(--text-muted, #888)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ☰
          </button>
          <button
            onClick={() => handleViewModeToggle('grid')}
            data-testid="view-toggle-grid"
            title="Grid view"
            style={{
              padding: '4px 10px',
              border: 'none',
              borderLeft: '1px solid var(--border-color, #333)',
              background: viewMode === 'grid' ? 'var(--accent-color, #4a9eff)' : 'transparent',
              color: viewMode === 'grid' ? '#fff' : 'var(--text-muted, #888)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ⊞
          </button>
        </div>
      </div>

      {loading && <LoadingSpinner center />}
      {error && (
        <div className="empty-state" style={{ color: 'var(--color-danger, #ef4444)' }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {filtered.length === 0 ? (
            <div className="empty-state">No apps found</div>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.5, marginBottom: 8 }}>
              {filtered.length} app{filtered.length !== 1 ? 's' : ''}
            </div>
          )}

          {viewMode === 'list' && (
            <div>
              {filtered.map(app => (
                <div
                  key={app.packageName}
                  data-testid={`app-row-${app.packageName}`}
                  onClick={() => setSelectedApp(app)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 6px',
                    borderBottom: '1px solid var(--border-color, #333)',
                    cursor: 'pointer',
                    borderRadius: 4,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary, #1e1e2e)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Icon */}
                  <div style={{
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: 'var(--bg-secondary, #1e1e2e)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                  }}>
                    {iconFailed[app.packageName] ? (
                      <span style={{ opacity: 0.3 }}>?</span>
                    ) : (
                      <img
                        src={iconUrl(app.packageName)}
                        alt=""
                        style={{ width: 32, height: 32 }}
                        onError={() => handleIconError(app.packageName)}
                      />
                    )}
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontWeight: 600,
                      fontSize: 13,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      color: 'var(--text-primary, inherit)',
                    }}>
                      {app.appName || app.packageName}
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--text-muted, #888)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {app.packageName}
                      {app.versionName && ` · v${app.versionName}`}
                    </div>
                  </div>

                  {/* Tracked badge */}
                  {app.isTracked && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {trackedDot}
                      <span style={{ fontSize: 11, color: 'var(--color-success, #22c55e)' }}>Tracked</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {viewMode === 'grid' && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))',
              gap: 12,
            }}>
              {filtered.map(app => (
                <div
                  key={app.packageName}
                  data-testid={`app-tile-${app.packageName}`}
                  onClick={() => setSelectedApp(app)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    padding: '14px 8px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: '1px solid transparent',
                    background: 'var(--bg-secondary, #1e1e2e)',
                    gap: 6,
                    position: 'relative',
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-color, #555)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'transparent')}
                >
                  {/* Tracked dot in top-right corner */}
                  {app.isTracked && (
                    <span style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--color-success, #22c55e)',
                    }} title="Tracked" />
                  )}

                  {/* Icon */}
                  <div style={{
                    width: 64,
                    height: 64,
                    borderRadius: 12,
                    overflow: 'hidden',
                    background: 'var(--bg-primary, #111)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 28,
                    flexShrink: 0,
                  }}>
                    {iconFailed[app.packageName] ? (
                      <span style={{ opacity: 0.3 }}>?</span>
                    ) : (
                      <img
                        src={iconUrl(app.packageName)}
                        alt=""
                        style={{ width: 64, height: 64 }}
                        onError={() => handleIconError(app.packageName)}
                      />
                    )}
                  </div>

                  {/* App name */}
                  <div style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: 'center',
                    color: 'var(--text-primary, inherit)',
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    lineHeight: '1.3',
                    maxHeight: '2.6em',
                    width: '100%',
                  }}>
                    {app.appName || app.packageName}
                  </div>

                  {/* Package name */}
                  <div style={{
                    fontSize: 10,
                    color: 'var(--text-muted, #888)',
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    width: '100%',
                  }}>
                    {app.packageName.split('.').slice(-1)[0]}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {selectedApp && (
        <AppDetailModal
          deviceId={deviceId}
          app={selectedApp}
          onClose={() => setSelectedApp(null)}
          onAppUpdated={handleAppUpdated}
        />
      )}
    </div>
  );
}
