import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { StatCard } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { SkeletonCard, SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import type { Device, Automation, AutomationSession, Proxy } from '../../shared/types/api';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';

interface TrackedApp {
  id: number;
  packageName: string;
  appName: string | null;
  versionCount: number;
  latestVersion: { versionCode: number; versionName: string | null; downloadedAt: string | number } | null;
}

interface ApkVersionRecent {
  id: number;
  trackedAppId: number;
  versionCode: number;
  versionName: string | null;
  filename: string;
  fileSize: number | null;
  deviceId: string | null;
  downloadedAt: string | number;
  packageName: string;
  appName: string | null;
}

interface AnalysisJobRecent {
  id: number;
  status: string;
  stage: string | null;
  packageName: string;
  appName: string | null;
  versionName: string | null;
  completedAt: string | null;
  createdAt: string | number;
  trackedAppId: number | null;
  apkVersionId: number;
}

interface DashboardData {
  devices: Device[];
  automations: Automation[];
  sessions: AutomationSession[];
  proxies: Proxy[];
  trackedApps: TrackedApp[];
  recentApks: ApkVersionRecent[];
  analysisJobs: AnalysisJobRecent[];
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

function timeAgo(dateInput: string | number): string {
  const ts = typeof dateInput === 'number'
    ? (dateInput < 1e12 ? dateInput * 1000 : dateInput)
    : new Date(dateInput).getTime();
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function Dashboard() {
  useDocumentTitle('Dashboard');
  const ws = useWebSocket();
  const navigate = useNavigate();
  const auth = useAuthOptional();
  const hasScope = auth?.hasScope ?? (() => true); // permissive if no auth context
  const [data, setData] = useState<DashboardData>({
    devices: [],
    automations: [],
    sessions: [],
    proxies: [],
    trackedApps: [],
    recentApks: [],
    analysisJobs: [],
  });
  const [loading, setLoading] = useState(true);
  // MCP integration is one of DarkRide's biggest differentiators (no other
  // mobile-RE tool ships it). Promote it on the Dashboard so a new user
  // discovers it on first load, not after digging into Settings → Advanced.
  // The card is intentionally simple — just a count + "open setup" pointer.
  const [mcpToolCount, setMcpToolCount] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      // Only fetch data the user has scope to see — avoids 403 toasts
      const [devRes, autRes, sesRes, proxRes, appsRes, recentApkRes, jobsRes] = await Promise.all([
        hasScope('core.devices:read')      ? ws.sendRestApi('GET', '/v1/device/list') : null,
        hasScope('core.automations:read')  ? ws.sendRestApi('GET', '/v1/automation/list') : null,
        hasScope('core.automations:read')  ? ws.sendRestApi('GET', '/v1/automation/sessions?limit=10') : null,
        hasScope('core.proxies:manage')    ? ws.sendRestApi('GET', '/v1/proxy/list') : null,
        hasScope('core.apk:read')          ? ws.sendRestApi('GET', '/v1/apps/tracked') : null,
        hasScope('core.apk:read')          ? ws.sendRestApi('GET', '/v1/apps/recent') : null,
        hasScope('core.apk:read')          ? ws.sendRestApi('GET', '/v1/apps/analysis-jobs/recent') : null,
      ]);
      setData({
        devices: devRes?.body?.data || [],
        automations: autRes?.body?.data || [],
        sessions: sesRes?.body?.data?.items || sesRes?.body?.data || [],
        proxies: proxRes?.body?.data || [],
        trackedApps: appsRes?.body?.data || [],
        recentApks: recentApkRes?.body?.data || [],
        analysisJobs: jobsRes?.body?.data || [],
      });
    } catch {
      // Will retry on next render or user action
    } finally {
      setLoading(false);
    }
  }, [ws, hasScope]);

  // Debounced refetch — coalesce rapid WS events into a single fetch
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedFetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      fetchData();
    }, 2000);
  }, [fetchData]);

  useEffect(() => {
    if (ws.connected) fetchData();
  }, [ws.connected, fetchData]);

  // Resolve MCP tool count on mount. /v1/tools enumerates every registered
  // tool (host + plugins) — its length is what we surface on the CTA.
  useEffect(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/tools').then(res => {
      if (Array.isArray(res?.body?.data)) setMcpToolCount(res.body.data.length);
    }).catch(() => { /* silent — promo card hides if we can't count */ });
  }, [ws]);

  useEffect(() => {
    return ws.subscribe('session-status', debouncedFetch);
  }, [ws, debouncedFetch]);

  const onlineDevices = data.devices.filter(d => {
    if (!d.lastSeen) return false;
    const age = Date.now() - new Date(d.lastSeen).getTime();
    return age < 120000;
  });
  const offlineDevices = data.devices.length - onlineDevices.length;
  const enabledProxies = data.proxies.filter(p => p.enabled);
  const failingProxies = data.proxies.filter(p => p.failureCount >= 7);
  const activeSessions = data.sessions.filter(s => s.status === 'running');

  // APK stats
  const totalApkVersions = data.trackedApps.reduce((sum, a) => sum + a.versionCount, 0);

  // Analysis stats
  const failedJobs = data.analysisJobs.filter(j => j.status === 'failed');

  const { sorted: sortedSessions, sortKey: sessionSortKey, sortDir: sessionSortDir, onSort: onSessionSort } = useSortableTable(data.sessions, 'startedAt', 'desc');
  const { sorted: sortedJobs, sortKey: jobSortKey, sortDir: jobSortDir, onSort: onJobSort } = useSortableTable(data.analysisJobs, 'createdAt', 'desc');
  const { sorted: sortedApks, sortKey: apkSortKey, sortDir: apkSortDir, onSort: onApkSort } = useSortableTable(data.recentApks, 'downloadedAt', 'desc');

  if (loading) return (
    <div>
      <div className="card-grid">
        <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SkeletonTable rows={4} columns={3} />
        <SkeletonTable rows={4} columns={3} />
      </div>
    </div>
  );

  return (
    <div data-testid="dashboard">
      <PageHeader title="Dashboard" />

      {/* Core Stats */}
      <div className="card-grid" data-testid="dashboard-stats">
        <StatCard
          value={data.devices.length}
          label="Connected Devices"
          detail={`${onlineDevices.length} online / ${offlineDevices} offline`}
          onClick={() => navigate('/ui/devices')}
        />
        <StatCard
          value={`${enabledProxies.length}/${data.proxies.length}`}
          label="Proxies"
          detail={failingProxies.length > 0 ? `${failingProxies.length} failing` : 'All healthy'}
          onClick={() => navigate('/ui/proxies')}
        />
        <StatCard
          value={data.automations.filter(a => !a.isRule).length}
          label="Automations"
          detail={`${data.automations.filter(a => a.isRule).length} rules`}
          onClick={() => navigate('/ui/automations')}
        />
        <StatCard
          value={activeSessions.length}
          label="Queue / Running"
          detail={activeSessions.length > 0 ? 'Active' : 'Idle'}
          onClick={() => navigate('/ui/sessions')}
        />
        <StatCard
          value={data.trackedApps.length}
          label="Tracked Apps"
          detail={`${totalApkVersions} APK versions`}
          onClick={() => navigate('/ui/apks')}
        />
      </div>

      {/* AI agent integration CTA — DarkRide exposes every operation as an
          MCP tool, which no other named mobile-RE tool ships. Surfacing here
          so a first-run user discovers the capability before page #2. Hidden
          when the user lacks the scope to configure it. */}
      {hasScope('core.settings:write') && (
        <button
          type="button"
          className="card"
          data-testid="dashboard-mcp-cta"
          onClick={() => navigate('/ui/settings/mcp')}
          style={{
            display: 'flex', alignItems: 'center', gap: 14,
            textAlign: 'left', cursor: 'pointer',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            borderLeft: '3px solid var(--accent, #4a9eff)',
            margin: '16px 0', width: '100%',
            color: 'inherit', font: 'inherit',
          }}
        >
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 36, height: 36, borderRadius: 8,
            background: 'color-mix(in srgb, var(--accent, #4a9eff) 14%, transparent)',
            color: 'var(--accent, #4a9eff)', flexShrink: 0,
          }}>
            <Sparkles size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              Drive DarkRide from your AI agent
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {mcpToolCount !== null
                ? `${mcpToolCount} tools exposed via MCP — connect Claude Code, Claude Desktop, or any MCP-compatible client.`
                : 'Connect Claude Code, Claude Desktop, or any MCP-compatible client and let it drive captures, APK analysis, and Frida hooks.'}
            </div>
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: 13, flexShrink: 0 }}>
            Setup →
          </span>
        </button>
      )}

      {/* Two-column layout for activity feeds */}
      <div className="dashboard-feeds-grid">
        {/* Recent Automation Runs */}
        <div className="card">
          <h2 className="section-title">Recent Automation Runs</h2>
          {data.sessions.length === 0 ? (
            <div className="empty-state-sm">No recent sessions</div>
          ) : (
            <table className="data-table" data-testid="recent-sessions">
              <thead>
                <tr>
                  <SortableHeader label="Name" sortKey="name" currentSort={sessionSortKey} dir={sessionSortDir} onSort={onSessionSort} />
                  <SortableHeader label="Status" sortKey="status" currentSort={sessionSortKey} dir={sessionSortDir} onSort={onSessionSort} />
                  <SortableHeader label="Started" sortKey="startedAt" currentSort={sessionSortKey} dir={sessionSortDir} onSort={onSessionSort} />
                </tr>
              </thead>
              <tbody>
                {sortedSessions.slice(0, 6).map(s => (
                  <tr key={s.id} className="clickable-row"
                    onClick={() => navigate(`/ui/automations/session/${s.id}`)}>
                    <td>{s.name || `#${s.id}`}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td>{timeAgo(s.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent Analysis Jobs */}
        <div className="card">
          <h2 className="section-title">Recent Analysis Jobs</h2>
          {data.analysisJobs.length === 0 ? (
            <div className="empty-state-sm">No analysis jobs yet</div>
          ) : (
            <table className="data-table" data-testid="recent-analysis">
              <thead>
                <tr>
                  <SortableHeader label="App" sortKey="appName" currentSort={jobSortKey} dir={jobSortDir} onSort={onJobSort} />
                  <SortableHeader label="Status" sortKey="status" currentSort={jobSortKey} dir={jobSortDir} onSort={onJobSort} />
                  <SortableHeader label="When" sortKey="createdAt" currentSort={jobSortKey} dir={jobSortDir} onSort={onJobSort} />
                </tr>
              </thead>
              <tbody>
                {sortedJobs.slice(0, 6).map(j => (
                  <tr key={j.id} className="clickable-row"
                    onClick={() => j.trackedAppId ? navigate(`/ui/apps/${j.trackedAppId}/analysis/${j.apkVersionId}`) : undefined}>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {j.appName || j.packageName}
                      {j.versionName && <span style={{ color: 'var(--text-muted)', marginLeft: 4, fontSize: 11 }}>v{j.versionName}</span>}
                    </td>
                    <td><StatusBadge status={j.status} /></td>
                    <td>{timeAgo(j.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Recent APK Downloads */}
      <div className="card" style={{ marginBottom: 16 }} data-testid="recent-apk-downloads">
        <h2 className="section-title">Recent APK Downloads</h2>
        {data.recentApks.length === 0 ? (
          <div className="empty-state-sm">No APK downloads yet</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="App" sortKey="appName" currentSort={apkSortKey} dir={apkSortDir} onSort={onApkSort} />
                <SortableHeader label="Version" sortKey="versionName" currentSort={apkSortKey} dir={apkSortDir} onSort={onApkSort} />
                <SortableHeader label="Size" sortKey="fileSize" currentSort={apkSortKey} dir={apkSortDir} onSort={onApkSort} />
                <SortableHeader label="Device" sortKey="deviceId" currentSort={apkSortKey} dir={apkSortDir} onSort={onApkSort} />
                <SortableHeader label="Downloaded" sortKey="downloadedAt" currentSort={apkSortKey} dir={apkSortDir} onSort={onApkSort} />
              </tr>
            </thead>
            <tbody>
              {sortedApks.slice(0, 10).map(v => (
                <tr key={v.id} className="clickable-row"
                  onClick={() => navigate(`/ui/apps/${v.trackedAppId}/analysis/${v.id}`)}>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 500 }}>{v.appName || v.packageName}</span>
                    {v.appName && <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>{v.packageName}</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {v.versionName ? <span>v{v.versionName}</span> : <span style={{ color: 'var(--text-muted)' }}>{v.versionCode}</span>}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {v.fileSize ? formatBytes(v.fileSize) : '—'}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {v.deviceId || '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-muted)' }}>
                    {timeAgo(v.downloadedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Health Alerts */}
      {(failingProxies.length > 0 || failedJobs.length > 0) && (
        <div className="card" data-testid="health-alerts">
          <h2 style={{ fontSize: 16, marginBottom: 12, color: 'var(--error)' }}>Health Alerts</h2>
          {failingProxies.map(p => (
            <div key={`proxy-${p.id}`} style={{ marginBottom: 8 }}>
              Proxy <strong>{p.url}</strong> has {p.failureCount} failures
            </div>
          ))}
          {failedJobs.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {failedJobs.length} analysis job{failedJobs.length !== 1 ? 's' : ''} failed recently
            </div>
          )}
        </div>
      )}
    </div>
  );
}
