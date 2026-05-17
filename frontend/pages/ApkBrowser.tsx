import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { SkeletonCard } from '@darkrideapp/plugin-sdk/react';
import { Download, Clock, Package, Syringe, Search, Smartphone, Eye, FlaskConical } from 'lucide-react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { AvailabilityBadge, type AvailabilityState } from '../components/apks/AvailabilityBadge';

interface ApkVersion {
  id: number;
  trackedAppId: number;
  versionCode: number;
  versionName: string | null;
  filename: string;
  fileSize: number | null;
  deviceId: string | null;
  source?: string | null;
  downloadedAt: string | number;
  availability?: AvailabilityState;
}

interface TrackedApp {
  id: number;
  packageName: string;
  appName: string | null;
  autoFetchPlayStore?: boolean | null;
  createdAt: string | number;
  versionCount: number;
  latestVersion: ApkVersion | null;
}

interface RecentDownload extends ApkVersion {
  packageName: string;
  appName: string | null;
}

interface OnlineDevice {
  id: string;
  name: string | null;
  lastSeen: string | null;
  isOnline?: boolean;
}

interface InstallModalState {
  versionId: number;
  packageName: string;
  versionName: string | null;
  versionCode: number;
}

interface DeviceInstalledInfo {
  installed: boolean;
  versionCode: number | null;
  versionName: string | null;
}

interface InjectedApk {
  id: number;
  packageName: string;
  versionCode: number;
  fridaVersion: string;
  createdAt: string | number;
}

function isOnline(device: OnlineDevice): boolean {
  if (!device.lastSeen) return false;
  return Date.now() - new Date(device.lastSeen).getTime() < 120000;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(d: string | number): string {
  const date = new Date(typeof d === 'number' ? d * 1000 : d);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateRelative(d: string | number): string {
  const date = new Date(typeof d === 'number' ? d * 1000 : d);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(d);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function toMs(d: string | number): number {
  return typeof d === 'number' ? d * 1000 : new Date(d).getTime();
}

function ElapsedTimer({ since }: { since: string | number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  const elapsed = Date.now() - toMs(since);
  return <>{formatDuration(elapsed)}</>;
}

function getStageLabel(status: string, stage: string | null | undefined, progress?: number | null): string {
  if (status === 'completed') return 'Ready';
  if (status === 'failed') return 'Failed';
  if (status === 'pending') return 'Pending';
  // running with stage info
  const pct = progress != null && progress > 0 ? ` ${progress}%` : '';
  switch (stage) {
    case 'metadata': return 'Metadata';
    case 'decompiling': return `Decompiling${pct}`;
    case 'storing': return `Storing${pct}`;
    case 'scanning': return `Scanning${pct}`;
    case 'done': return 'Ready';
    default: return 'Running';
  }
}

function AppIcon({ packageName, appName, size = 36 }: { packageName: string; appName: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    const letter = (appName || packageName.split('.').pop() || '?').charAt(0).toUpperCase();
    // Generate a consistent color from the package name
    let hash = 0;
    for (let i = 0; i < packageName.length; i++) hash = ((hash << 5) - hash + packageName.charCodeAt(i)) | 0;
    const hue = Math.abs(hash) % 360;
    return (
      <div style={{
        width: size, height: size, borderRadius: size * 0.22,
        background: `hsl(${hue}, 45%, 55%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.42, fontWeight: 700, color: '#fff',
        flexShrink: 0,
      }}>
        {letter}
      </div>
    );
  }

  return (
    <img
      src={`/v1/apps/icon/${encodeURIComponent(packageName)}`}
      onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: size * 0.22, flexShrink: 0, background: 'var(--bg-tertiary)' }}
      alt=""
    />
  );
}

interface RecentAnalysis {
  id: number;
  apkVersionId: number;
  status: string;
  stage: string | null;
  error: string | null;
  createdAt: string | number;
  startedAt: string | number | null;
  completedAt: string | number | null;
  trackedAppId: number | null;
  packageName: string;
  appName: string | null;
  versionCode: number;
  versionName: string | null;
}

type TabKey = 'apps' | 'recent' | 'injected' | 'analysis';
const TAB_KEYS: TabKey[] = ['apps', 'recent', 'injected', 'analysis'];

export function ApkBrowser() {
  useDocumentTitle('APK Browser');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') as TabKey | null;
  const activeTab: TabKey = tabParam && TAB_KEYS.includes(tabParam) ? tabParam : 'apps';
  const setActiveTab = useCallback((tab: TabKey) => {
    setSearchParams(tab === 'apps' ? {} : { tab }, { replace: false });
  }, [setSearchParams]);
  const [apps, setApps] = useState<TrackedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedApp, setExpandedApp] = useState<number | null>(null);
  const [versions, setVersions] = useState<Record<number, ApkVersion[]>>({});
  const [loadingVersions, setLoadingVersions] = useState<number | null>(null);
  const [untracking, setUntracking] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);

  const [recentDownloads, setRecentDownloads] = useState<RecentDownload[]>([]);

  const [devices, setDevices] = useState<OnlineDevice[]>([]);
  const [installingVersion, setInstallingVersion] = useState<number | null>(null);
  const [installModal, setInstallModal] = useState<InstallModalState | null>(null);
  const [deviceVersions, setDeviceVersions] = useState<Record<string, DeviceInstalledInfo>>({});
  const [installError, setInstallError] = useState<string | null>(null);

  const [injectingVersion, setInjectingVersion] = useState<number | null>(null);
  const [injectedApks, setInjectedApks] = useState<InjectedApk[]>([]);
  const [deletingInjected, setDeletingInjected] = useState<number | null>(null);
  const [deleteInjectedConfirm, setDeleteInjectedConfirm] = useState<InjectedApk | null>(null);

  const [deletingVersion, setDeletingVersion] = useState<number | null>(null);
  const [deleteVersionConfirm, setDeleteVersionConfirm] = useState<{ appId: number; versionId: number; label: string } | null>(null);
  const [recentAnalyses, setRecentAnalyses] = useState<RecentAnalysis[]>([]);

  const [appFilter, setAppFilter] = useState('');
  const [addAppModal, setAddAppModal] = useState(false);
  const [addAppPackage, setAddAppPackage] = useState('');
  const [addAppSaving, setAddAppSaving] = useState(false);
  const [addAppError, setAddAppError] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<Record<number, { status: string; stage?: string | null; progress?: number | null; error?: string | null; aiRunning?: boolean }>>({});
  const [analyzingVersion, setAnalyzingVersion] = useState<number | null>(null);

  const { sorted: sortedRecent, sortKey: recentSortKey, sortDir: recentSortDir, onSort: recentOnSort } = useSortableTable(recentDownloads);
  const { sorted: sortedInjected, sortKey: injSortKey, sortDir: injSortDir, onSort: injOnSort } = useSortableTable(injectedApks);
  const { sorted: sortedAnalyses, sortKey: anaSortKey, sortDir: anaSortDir, onSort: anaOnSort } = useSortableTable(recentAnalyses);
  const expandedVersions = expandedApp != null ? (versions[expandedApp] || []) : [];
  const { sorted: sortedVersions, sortKey: verSortKey, sortDir: verSortDir, onSort: verOnSort } = useSortableTable(expandedVersions);

  const fetchApps = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/apps/tracked').then(res => {
      if (res.body?.success) setApps(res.body.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [ws]);

  const fetchRecent = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/apps/recent').then(res => {
      if (res.body?.success) setRecentDownloads(res.body.data);
    }).catch(() => {});
  }, [ws]);

  const fetchInjectedApks = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/frida/gadget/injected').then(res => {
      if (res.body?.data) setInjectedApks(res.body.data);
    }).catch(() => {});
  }, [ws]);

  const fetchAnalyses = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/apps/analysis-jobs/recent').then(res => {
      if (res.body?.success) setRecentAnalyses(res.body.data);
    }).catch(() => {});
  }, [ws]);

  useEffect(() => {
    fetchApps();
    fetchRecent();
    fetchInjectedApks();
    fetchAnalyses();
  }, [fetchApps, fetchRecent, fetchInjectedApks, fetchAnalyses]);

  useEffect(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/device/list').then(res => {
      const all: OnlineDevice[] = res.body?.data || [];
      setDevices(all.filter(isOnline));
    }).catch(() => {});
  }, [ws]);

  useEffect(() => {
    const unsub = ws.subscribe('apk:analysis-update', (msg: any) => {
      setAnalysisStatus(prev => ({
        ...prev,
        [msg.apkVersionId]: { status: msg.status, stage: msg.stage ?? null, progress: msg.progress ?? null, error: msg.error },
      }));
      // Refresh app list when analysis completes (to pick up app name changes)
      if (msg.status === 'completed') {
        fetchApps();
        fetchRecent();
      }
      fetchAnalyses();
    });
    return unsub;
  }, [ws, fetchApps, fetchRecent, fetchAnalyses]);

  // Subscribe to new APK version pulled events (auto-refresh)
  useEffect(() => {
    const unsub = ws.subscribe('apk:version-pulled', (msg: any) => {
      fetchApps();
      fetchRecent();
      // Re-fetch versions and their analysis status so expanded views update in-place
      if (msg.trackedAppId) {
        ws.sendRestApi('GET', `/v1/apps/versions/${msg.trackedAppId}`).then(res => {
          if (res.body?.success) {
            setVersions(prev => ({ ...prev, [msg.trackedAppId]: res.body.data }));
            // Fetch analysis status for all versions (new ones will have pending jobs)
            for (const v of res.body.data) {
              ws.sendRestApi('GET', `/v1/apps/analysis-status/${v.id}`).then(statusRes => {
                if (statusRes.body?.success && statusRes.body.data) {
                  setAnalysisStatus(prev => ({
                    ...prev,
                    [v.id]: { status: statusRes.body.data.status, stage: statusRes.body.data.stage ?? null, progress: null, error: statusRes.body.data.error, aiRunning: !!statusRes.body.data.aiRunning },
                  }));
                }
              }).catch(() => {});
            }
          }
        }).catch(() => {});
      }
    });
    return unsub;
  }, [ws, fetchApps, fetchRecent]);

  // Subscribe to scan complete events (clear scanning state)
  useEffect(() => {
    const unsub = ws.subscribe('apk:scan-complete', () => {
      setScanning(false);
      fetchApps();
      fetchRecent();
    });
    return unsub;
  }, [ws, fetchApps, fetchRecent]);

  // Track AI agent runs so the badge can read "AI Analysing" rather than
  // "Ready" while a post-analysis AI review is in flight.
  useEffect(() => {
    const unsub = ws.subscribe('apk:ai-agent-update', (msg: { versionId: number; status: string }) => {
      setAnalysisStatus(prev => {
        const current = prev[msg.versionId];
        if (!current) return prev;
        return {
          ...prev,
          [msg.versionId]: { ...current, aiRunning: msg.status === 'running' },
        };
      });
    });
    return unsub;
  }, [ws]);

  const handleExpand = useCallback(async (appId: number) => {
    if (expandedApp === appId) {
      setExpandedApp(null);
      return;
    }
    setExpandedApp(appId);
    if (versions[appId]) return;

    setLoadingVersions(appId);
    try {
      const res = await ws.sendRestApi('GET', `/v1/apps/versions/${appId}`);
      if (res.body?.success) {
        setVersions(prev => ({ ...prev, [appId]: res.body.data }));
      }
      // Fetch analysis status for each version
      if (res.body?.success && res.body.data.length > 0) {
        for (const v of res.body.data) {
          ws.sendRestApi('GET', `/v1/apps/analysis-status/${v.id}`).then(statusRes => {
            if (statusRes.body?.success && statusRes.body.data) {
              setAnalysisStatus(prev => ({
                ...prev,
                [v.id]: { status: statusRes.body.data.status, stage: statusRes.body.data.stage ?? null, progress: null, error: statusRes.body.data.error, aiRunning: !!statusRes.body.data.aiRunning },
              }));
            }
          }).catch(() => {});
        }
      }
    } catch {
      // ignore
    } finally {
      setLoadingVersions(null);
    }
  }, [ws, expandedApp, versions]);

  const handleAnalyze = useCallback(async (versionId: number) => {
    setAnalyzingVersion(versionId);
    try {
      await ws.sendRestApi('POST', `/v1/apps/analyze/${versionId}`);
      setAnalysisStatus(prev => ({ ...prev, [versionId]: { status: 'pending' } }));
      toast.success('Analysis started');
    } catch { toast.error('Failed to start analysis'); }
    finally { setAnalyzingVersion(null); }
  }, [ws, toast]);

  const handleCancelJob = useCallback(async (jobId: number) => {
    try {
      await ws.sendRestApi('POST', `/v1/apps/analysis-jobs/${jobId}/cancel`);
      toast.success('Analysis job cancelled');
    } catch { toast.error('Failed to cancel analysis job'); }
  }, [ws, toast]);

  const handleDownload = useCallback((version: ApkVersion, packageName: string) => {
    const a = document.createElement('a');
    a.href = `/v1/apps/download/${version.id}`;
    a.download = `${packageName}_${version.filename}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  const handleTriggerScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await ws.sendRestApi('POST', '/v1/apps/trigger-scan');
      toast.success('Scan started');
      // scanning will be cleared by the apk:scan-complete WebSocket event
    } catch {
      setScanning(false);
      toast.error('Failed to trigger scan');
    }
  }, [ws, scanning, toast]);

  const handleUntrack = useCallback(async (appId: number) => {
    if (untracking) return;
    setUntracking(appId);
    try {
      await ws.sendRestApi('DELETE', `/v1/apps/track/${appId}`);
      setApps(prev => prev.filter(a => a.id !== appId));
      setVersions(prev => {
        const next = { ...prev };
        delete next[appId];
        return next;
      });
      if (expandedApp === appId) setExpandedApp(null);
      toast.success('App untracked');
    } catch {
      toast.error('Failed to untrack app');
    } finally {
      setUntracking(null);
    }
  }, [ws, untracking, expandedApp, toast]);

  const handleAddApp = useCallback(async () => {
    const pkg = addAppPackage.trim();
    if (!pkg) return;
    if (!pkg.includes('.')) {
      setAddAppError('Package name must contain at least one dot (e.g. com.example.app)');
      return;
    }
    setAddAppSaving(true);
    setAddAppError(null);
    try {
      const res = await ws.sendRestApi('POST', '/v1/apps/track', { packageName: pkg, appName: null });
      if (res.body?.success) {
        setAddAppModal(false);
        setAddAppPackage('');
        fetchApps();
        toast.success('App added');
      } else {
        setAddAppError(res.body?.error || 'Failed to add app');
        toast.error(res.body?.error || 'Failed to add app');
      }
    } catch (err: any) {
      setAddAppError(err?.message || 'Failed to add app');
      toast.error(err?.message || 'Failed to add app');
    } finally {
      setAddAppSaving(false);
    }
  }, [ws, addAppPackage, fetchApps, toast]);

  const handleTogglePlayStore = useCallback(async (appId: number, currentValue: boolean) => {
    const newValue = !currentValue;
    try {
      await ws.sendRestApi('PATCH', `/v1/apps/track/${appId}`, { autoFetchPlayStore: newValue });
      setApps(prev => prev.map(a => a.id === appId ? { ...a, autoFetchPlayStore: newValue } : a));
      toast.success(`Play Store auto-fetch ${newValue ? 'enabled' : 'disabled'}`);
    } catch {
      toast.error('Failed to update Play Store setting');
    }
  }, [ws, toast]);

  const handleInstall = useCallback(async (versionId: number, deviceId: string) => {
    setInstallingVersion(versionId);
    setInstallError(null);
    try {
      const res = await ws.sendRestApi('POST', `/v1/apps/install/${encodeURIComponent(deviceId)}`, {
        apkVersionId: versionId,
      });
      if (res.status !== 200 || !res.body?.success) {
        setInstallError(res.body?.error || 'Install failed');
        toast.error(res.body?.error || 'Install failed');
        setInstallingVersion(null);
        return;
      }
      setInstallModal(null);
      toast.success('APK installed successfully');
    } catch (err: any) {
      setInstallError(err?.message || 'Install failed');
      toast.error(err?.message || 'Install failed');
    } finally {
      setInstallingVersion(null);
    }
  }, [ws, toast]);

  const openInstallModal = useCallback((versionId: number, packageName: string, versionName: string | null, versionCode: number) => {
    setInstallModal({ versionId, packageName, versionName, versionCode });
    setDeviceVersions({});
    setInstallError(null);
    // Fetch installed version for each online device
    for (const d of devices) {
      ws.sendRestApi('GET', `/v1/device/package-version/${encodeURIComponent(d.id)}/${encodeURIComponent(packageName)}`).then(res => {
        if (res.body?.success) {
          setDeviceVersions(prev => ({ ...prev, [d.id]: res.body.data }));
        }
      }).catch(() => {});
    }
  }, [ws, devices]);

  const handleInjectGadget = useCallback(async (packageName: string, versionCode: number, versionId: number) => {
    setInjectingVersion(versionId);
    try {
      await ws.sendRestApi('POST', '/v1/frida/gadget/inject', { packageName, versionCode });
      fetchInjectedApks();
      toast.success('Frida gadget injected');
    } catch {
      toast.error('Failed to inject Frida gadget');
    } finally {
      setInjectingVersion(null);
    }
  }, [ws, fetchInjectedApks, toast]);

  const handleDeleteInjected = useCallback(async (id: number) => {
    setDeletingInjected(id);
    try {
      await ws.sendRestApi('DELETE', `/v1/frida/gadget/injected/${id}`);
      setInjectedApks(prev => prev.filter(a => a.id !== id));
      toast.success('Injected APK deleted');
    } catch {
      toast.error('Failed to delete injected APK');
    } finally {
      setDeletingInjected(null);
    }
  }, [ws, toast]);

  const handleDeleteVersion = useCallback(async (appId: number, versionId: number) => {
    setDeletingVersion(versionId);
    try {
      await ws.sendRestApi('DELETE', `/v1/apps/version/${versionId}`);
      setVersions(prev => ({
        ...prev,
        [appId]: (prev[appId] || []).filter(v => v.id !== versionId),
      }));
      fetchApps(); // refresh version counts
      fetchRecent(); // refresh recent downloads
      toast.success('Version deleted');
    } catch {
      toast.error('Failed to delete version');
    } finally {
      setDeletingVersion(null);
    }
  }, [ws, fetchApps, fetchRecent, toast]);

  // --- Install button helper ---
  const renderInstallButton = (versionId: number, packageName: string, versionName: string | null, versionCode: number) => {
    if (devices.length === 0) return null;
    return (
      <button
        className="btn btn-sm btn-primary"
        onClick={() => openInstallModal(versionId, packageName, versionName, versionCode)}
        disabled={installingVersion === versionId}
        data-testid={`install-${versionId}`}
        style={{ fontSize: 11, padding: '2px 8px' }}
      >
        {installingVersion === versionId ? 'Installing...' : 'Install'}
      </button>
    );
  };

  if (auth && !auth.hasScope('core.apk:read')) return <AccessDenied scope="core.apk:read" />;

  const canManageApk = !auth || auth.hasScope('core.apk:manage');

  if (loading) return (
    <div>
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );

  const tabs: { key: TabKey; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'apps', label: 'Tracked Apps', icon: <Package size={14} />, count: apps.length },
    { key: 'recent', label: 'Recent Downloads', icon: <Clock size={14} />, count: recentDownloads.length },
    { key: 'analysis', label: 'Analysis', icon: <FlaskConical size={14} />, count: recentAnalyses.length },
  ];
  if (injectedApks.length > 0) {
    tabs.push({ key: 'injected', label: 'Injected', icon: <Syringe size={14} />, count: injectedApks.length });
  }

  return (
    <div data-testid="apk-browser">
      <PageHeader title="APK Browser" actions={
        <button className="btn" onClick={handleTriggerScan} disabled={scanning} data-testid="btn-trigger-scan" title="Scan all tracked apps on all devices for new versions">
          {scanning ? 'Scanning...' : 'Scan for New Versions'}
        </button>
      } />

      {/* Tab strip */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border-color)' }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
              borderBottom: activeTab === tab.key ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -2,
              color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: activeTab === tab.key ? 600 : 400,
              fontSize: 13, transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {tab.icon}
            {tab.label}
            {tab.count != null && (
              <span style={{
                fontSize: 11, padding: '1px 6px', borderRadius: 10,
                background: activeTab === tab.key ? 'var(--accent-soft)' : 'var(--bg-tertiary)',
                color: activeTab === tab.key ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 600,
              }}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tracked Apps tab */}
      {activeTab === 'apps' && (
        apps.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><Package size={40} strokeWidth={1} /></div>
            <div className="empty-message">No tracked apps</div>
            <div className="empty-description">
              Go to a device's "View Installed Apps" or add an app by package ID.
            </div>
            <button
              className="btn btn-primary"
              onClick={() => { setAddAppModal(true); setAddAppPackage(''); setAddAppError(null); }}
              data-testid="add-app-empty-btn"
              style={{ marginTop: 12, fontSize: 13 }}
            >
              + Add App
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                <input
                  type="text"
                  placeholder="Filter by name or package ID..."
                  value={appFilter}
                  onChange={e => setAppFilter(e.target.value)}
                  data-testid="app-filter-input"
                  style={{
                    width: '100%', padding: '8px 12px 8px 32px', fontSize: 13,
                    border: '1px solid var(--border-color)', borderRadius: 6,
                    background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                    outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => { setAddAppModal(true); setAddAppPackage(''); setAddAppError(null); }}
                data-testid="add-app-btn"
                style={{ fontSize: 12, padding: '6px 12px', whiteSpace: 'nowrap' }}
              >
                + Add App
              </button>
            </div>
            {apps.filter(app => {
              if (!appFilter) return true;
              const q = appFilter.toLowerCase();
              return (app.appName || '').toLowerCase().includes(q) || app.packageName.toLowerCase().includes(q);
            }).map(app => (
              <div key={app.id} className="card" style={{ padding: 0, overflow: 'hidden' }} data-testid={`tracked-app-${app.id}`}>
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
                    cursor: 'pointer', transition: 'background 0.1s',
                  }}
                  onClick={() => handleExpand(app.id)}
                  data-testid={`tracked-app-row-${app.id}`}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <AppIcon packageName={app.packageName} appName={app.appName} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.3 }}>
                      {app.appName || app.packageName}
                    </div>
                    {app.appName && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {app.packageName}
                      </div>
                    )}
                    {app.latestVersion && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                        v{app.latestVersion.versionName || app.latestVersion.versionCode}
                        {app.latestVersion.fileSize != null && ` · ${formatBytes(app.latestVersion.fileSize)}`}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                    <span className="badge badge-running" style={{ fontSize: 11 }}>
                      {app.versionCount} version{app.versionCount !== 1 ? 's' : ''}
                    </span>
                    <button
                      className={`btn btn-sm ${app.autoFetchPlayStore !== false ? '' : 'btn-outline'}`}
                      onClick={e => { e.stopPropagation(); handleTogglePlayStore(app.id, app.autoFetchPlayStore !== false); }}
                      data-testid={`ps-toggle-${app.id}`}
                      style={{ fontSize: 10, padding: '2px 6px', minWidth: 48 }}
                      title={app.autoFetchPlayStore !== false ? 'Play Store auto-fetch enabled' : 'Play Store auto-fetch disabled'}
                    >
                      PS: {app.autoFetchPlayStore !== false ? 'On' : 'Off'}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={e => { e.stopPropagation(); handleUntrack(app.id); }}
                      disabled={untracking === app.id}
                      data-testid={`untrack-${app.id}`}
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      {untracking === app.id ? '...' : 'Untrack'}
                    </button>
                    <span style={{
                      fontSize: 12, transition: 'transform 0.15s', display: 'inline-block',
                      transform: expandedApp === app.id ? 'rotate(90deg)' : undefined,
                      color: 'var(--text-muted)',
                    }}>
                      &#9654;
                    </span>
                  </div>
                </div>

                {expandedApp === app.id && (
                  <div style={{ borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }} data-testid={`versions-${app.id}`}>
                    {loadingVersions === app.id ? (
                      <div style={{ padding: 16 }}><LoadingSpinner /></div>
                    ) : (versions[app.id] || []).length === 0 ? (
                      <div style={{ padding: '16px', fontSize: 13, color: 'var(--text-muted)' }}>
                        No versions downloaded yet. Pull an APK from a device to archive it.
                      </div>
                    ) : (
                      <div className="table-card" style={{ border: 'none', borderRadius: 0, boxShadow: 'none' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <SortableHeader label="Version" sortKey="versionName" currentSort={verSortKey} dir={verSortDir} onSort={verOnSort} />
                              <SortableHeader label="Code" sortKey="versionCode" currentSort={verSortKey} dir={verSortDir} onSort={verOnSort} />
                              <SortableHeader label="Size" sortKey="fileSize" currentSort={verSortKey} dir={verSortDir} onSort={verOnSort} />
                              <th>Source</th>
                              <SortableHeader label="Downloaded" sortKey="downloadedAt" currentSort={verSortKey} dir={verSortDir} onSort={verOnSort} />
                              <th>Storage</th>
                              <th>Analysis</th>
                              <th style={{ textAlign: 'right' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedVersions.map(v => (
                              <tr key={v.id}>
                                <td style={{ fontWeight: 500 }}>{v.versionName || '—'}</td>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{v.versionCode}</td>
                                <td>{formatBytes(v.fileSize)}</td>
                                <td style={{ fontSize: 12 }}>
                                  {v.source === 'playstore' ? (
                                    <span className="badge badge-running" style={{ fontSize: 10 }}>Play Store</span>
                                  ) : v.source === 'upload' ? (
                                    <span className="badge" style={{ fontSize: 10, background: 'var(--bg-tertiary)' }}>Upload</span>
                                  ) : (
                                    <span style={{ color: 'var(--text-muted)' }}>{v.deviceId || '—'}</span>
                                  )}
                                </td>
                                <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                                  {v.downloadedAt ? formatDate(v.downloadedAt) : '—'}
                                </td>
                                <td>
                                  {v.availability
                                    ? <AvailabilityBadge state={v.availability} />
                                    : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
                                  }
                                </td>
                                <td>
                                  {(() => {
                                    const s = analysisStatus[v.id];
                                    if (!s) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>;
                                    const label = getStageLabel(s.status, s.stage, s.progress);
                                    if (s.status === 'failed') {
                                      return <span className="badge badge-failed" style={{ fontSize: 10 }} title={s.error || ''} data-testid={`analysis-badge-${v.id}`}>
                                        Failed
                                      </span>;
                                    }
                                    if (s.status === 'completed') {
                                      if (s.aiRunning) {
                                        return <span className="badge badge-running" style={{ fontSize: 10, animation: 'pulse 1.5s ease-in-out infinite' }} data-testid={`analysis-badge-${v.id}`}>
                                          AI Analysing
                                        </span>;
                                      }
                                      return <span className="badge badge-success" style={{ fontSize: 10 }} data-testid={`analysis-badge-${v.id}`}>
                                        Ready
                                      </span>;
                                    }
                                    if (s.status === 'pending' || s.status === 'running') {
                                      return <span className="badge badge-running" style={{ fontSize: 10, animation: s.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : undefined }} data-testid={`analysis-badge-${v.id}`}>
                                        {label}
                                      </span>;
                                    }
                                    return null;
                                  })()}
                                </td>
                                <td>
                                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                                    {canManageApk && (
                                      <button
                                        className="btn btn-sm"
                                        onClick={() => handleDownload(v, app.packageName)}
                                        data-testid={`download-${v.id}`}
                                        style={{ fontSize: 11, padding: '2px 8px' }}
                                      >
                                        <Download size={11} /> Download
                                      </button>
                                    )}
                                    {renderInstallButton(v.id, app.packageName, v.versionName, v.versionCode)}
                                    {canManageApk && (
                                      <button
                                        className="btn btn-sm"
                                        onClick={() => handleAnalyze(v.id)}
                                        disabled={analyzingVersion === v.id || analysisStatus[v.id]?.status === 'pending' || analysisStatus[v.id]?.status === 'running'}
                                        style={{ fontSize: 11, padding: '2px 8px' }}
                                      >
                                        {analyzingVersion === v.id ? '...' : 'Analyze'}
                                      </button>
                                    )}
                                    {analysisStatus[v.id]?.status === 'completed' && (
                                      <button
                                        className="btn btn-sm btn-primary"
                                        onClick={() => navigate(`/ui/apps/${app.id}/analysis/${v.id}`)}
                                        data-testid={`view-analysis-${v.id}`}
                                        style={{ fontSize: 11, padding: '2px 8px' }}
                                      >
                                        <Eye size={11} /> View Analysis
                                      </button>
                                    )}
                                    <button
                                      className="btn btn-sm"
                                      onClick={() => handleInjectGadget(app.packageName, v.versionCode, v.id)}
                                      disabled={injectingVersion === v.id}
                                      data-testid={`inject-gadget-${v.id}`}
                                      style={{ fontSize: 11, padding: '2px 8px' }}
                                    >
                                      {injectingVersion === v.id ? 'Injecting...' : 'Inject Gadget'}
                                    </button>
                                    <button
                                      className="btn btn-sm btn-danger"
                                      onClick={() => setDeleteVersionConfirm({ appId: app.id, versionId: v.id, label: `v${v.versionName || v.versionCode}` })}
                                      disabled={deletingVersion === v.id}
                                      data-testid={`delete-version-${v.id}`}
                                      style={{ fontSize: 11, padding: '2px 8px' }}
                                    >
                                      {deletingVersion === v.id ? '...' : 'Remove'}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* Recent Downloads tab */}
      {activeTab === 'recent' && (
        recentDownloads.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><Clock size={40} strokeWidth={1} /></div>
            <div className="empty-message">No downloads yet</div>
            <div className="empty-description">
              APK versions pulled from devices will appear here in chronological order.
            </div>
          </div>
        ) : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <SortableHeader label="App" sortKey="appName" currentSort={recentSortKey} dir={recentSortDir} onSort={recentOnSort} />
                  <SortableHeader label="Version" sortKey="versionCode" currentSort={recentSortKey} dir={recentSortDir} onSort={recentOnSort} />
                  <SortableHeader label="Size" sortKey="fileSize" currentSort={recentSortKey} dir={recentSortDir} onSort={recentOnSort} />
                  <th>Source</th>
                  <SortableHeader label="Downloaded" sortKey="downloadedAt" currentSort={recentSortKey} dir={recentSortDir} onSort={recentOnSort} />
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRecent.map(dl => (
                  <tr key={dl.id}>
                    <td style={{ padding: '8px 12px' }}>
                      <AppIcon packageName={dl.packageName} appName={dl.appName} size={28} />
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{dl.appName || dl.packageName}</div>
                      {dl.appName && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {dl.packageName}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{dl.versionName || dl.versionCode}</div>
                      {dl.versionName && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Code: {dl.versionCode}</div>
                      )}
                    </td>
                    <td>{formatBytes(dl.fileSize)}</td>
                    <td style={{ fontSize: 12 }}>
                      {dl.source === 'playstore' ? (
                        <span className="badge badge-running" style={{ fontSize: 10 }}>Play Store</span>
                      ) : dl.source === 'upload' ? (
                        <span className="badge" style={{ fontSize: 10, background: 'var(--bg-tertiary)' }}>Upload</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>{dl.deviceId || '—'}</span>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <span title={formatDate(dl.downloadedAt)}>
                        {formatDateRelative(dl.downloadedAt)}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleDownload(dl, dl.packageName)}
                          data-testid={`recent-download-${dl.id}`}
                          style={{ fontSize: 11, padding: '2px 8px' }}
                        >
                          <Download size={11} /> Download
                        </button>
                        {renderInstallButton(dl.id, dl.packageName, dl.versionName, dl.versionCode)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Injected APKs tab */}
      {activeTab === 'injected' && (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <SortableHeader label="Package" sortKey="packageName" currentSort={injSortKey} dir={injSortDir} onSort={injOnSort} />
                <SortableHeader label="Version Code" sortKey="versionCode" currentSort={injSortKey} dir={injSortDir} onSort={injOnSort} />
                <SortableHeader label="Frida Version" sortKey="fridaVersion" currentSort={injSortKey} dir={injSortDir} onSort={injOnSort} />
                <SortableHeader label="Created" sortKey="createdAt" currentSort={injSortKey} dir={injSortDir} onSort={injOnSort} />
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedInjected.map(apk => (
                <tr key={apk.id} data-testid={`injected-apk-${apk.id}`}>
                  <td style={{ padding: '8px 12px' }}>
                    <AppIcon packageName={apk.packageName} appName={null} size={28} />
                  </td>
                  <td style={{ fontWeight: 500 }}>{apk.packageName}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{apk.versionCode}</td>
                  <td>{apk.fridaVersion}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {apk.createdAt ? formatDate(apk.createdAt) : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setDeleteInjectedConfirm(apk)}
                        disabled={deletingInjected === apk.id}
                        data-testid={`delete-injected-${apk.id}`}
                        style={{ fontSize: 11, padding: '2px 8px' }}
                      >
                        {deletingInjected === apk.id ? '...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Analysis tab */}
      {activeTab === 'analysis' && (
        recentAnalyses.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><FlaskConical size={40} strokeWidth={1} /></div>
            <div className="empty-message">No analysis jobs yet</div>
            <div className="empty-description">
              Analyze an APK version to decompile and scan it for security findings.
            </div>
          </div>
        ) : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <SortableHeader label="App" sortKey="appName" currentSort={anaSortKey} dir={anaSortDir} onSort={anaOnSort} />
                  <SortableHeader label="Version" sortKey="versionCode" currentSort={anaSortKey} dir={anaSortDir} onSort={anaOnSort} />
                  <SortableHeader label="Status" sortKey="status" currentSort={anaSortKey} dir={anaSortDir} onSort={anaOnSort} />
                  <th>Processing Time</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedAnalyses.map(a => {
                  const label = getStageLabel(a.status, a.stage);
                  return (
                    <tr
                      key={a.id}
                      data-testid={`analysis-row-${a.id}`}
                      style={{ cursor: a.status === 'completed' ? 'pointer' : undefined }}
                      onClick={() => { if (a.status === 'completed' && a.trackedAppId) navigate(`/ui/apps/${a.trackedAppId}/analysis/${a.apkVersionId}`); }}
                    >
                      <td style={{ padding: '8px 12px' }}>
                        <AppIcon packageName={a.packageName} appName={a.appName} size={28} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{a.appName || a.packageName}</div>
                        {a.appName && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {a.packageName}
                          </div>
                        )}
                      </td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{a.versionName || a.versionCode}</div>
                        {a.versionName && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Code: {a.versionCode}</div>
                        )}
                      </td>
                      <td>
                        {a.status === 'failed' ? (
                          <span className="badge badge-failed" style={{ fontSize: 10 }} title={a.error || ''}>{label}</span>
                        ) : a.status === 'completed' ? (
                          <span className="badge badge-success" style={{ fontSize: 10 }}>{label}</span>
                        ) : (
                          <span className="badge badge-running" style={{ fontSize: 10, animation: a.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : undefined }}>{label}</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {(a.status === 'completed' || a.status === 'failed') && a.startedAt && a.completedAt ? (
                          <span title={`Started: ${formatDate(a.startedAt)} — Finished: ${formatDate(a.completedAt)}`}>
                            {formatDuration(toMs(a.completedAt) - toMs(a.startedAt))}
                          </span>
                        ) : a.status === 'running' && a.startedAt ? (
                          <span title={`Started: ${formatDate(a.startedAt)}`}>
                            <ElapsedTimer since={a.startedAt} />
                          </span>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                          {a.status === 'completed' && (
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={() => navigate(`/ui/apps/${a.trackedAppId}/analysis/${a.apkVersionId}`)}
                              data-testid={`analysis-view-${a.id}`}
                              style={{ fontSize: 11, padding: '2px 8px' }}
                            >
                              <Eye size={11} /> View
                            </button>
                          )}
                          {(a.status === 'pending' || a.status === 'running') && (
                            <button
                              className="btn btn-sm"
                              onClick={() => handleCancelJob(a.id)}
                              data-testid={`analysis-cancel-${a.id}`}
                              style={{ fontSize: 11, padding: '2px 8px' }}
                            >
                              Cancel
                            </button>
                          )}
                          {a.status === 'failed' && (
                            <button
                              className="btn btn-sm"
                              onClick={() => handleAnalyze(a.apkVersionId)}
                              data-testid={`analysis-retry-${a.id}`}
                              style={{ fontSize: 11, padding: '2px 8px' }}
                            >
                              Analyze
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
      {/* Install device picker modal */}
      {installModal && (
        <Modal title="Install APK" onClose={() => setInstallModal(null)}>
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
            Installing <strong>{installModal.packageName}</strong> v{installModal.versionName || installModal.versionCode}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {devices.map(d => {
              const info = deviceVersions[d.id];
              const isInstalling = installingVersion === installModal.versionId;
              return (
                <button
                  key={d.id}
                  className="btn"
                  onClick={() => handleInstall(installModal.versionId, d.id)}
                  disabled={isInstalling}
                  data-testid={`install-device-${d.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                    textAlign: 'left', width: '100%',
                  }}
                >
                  <Smartphone size={18} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{d.name || d.id}</div>
                    {d.name && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{d.id}</div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, textAlign: 'right', fontSize: 12 }}>
                    {!info ? (
                      <span style={{ color: 'var(--text-muted)' }}>Checking...</span>
                    ) : !info.installed ? (
                      <span style={{ color: 'var(--text-muted)' }}>Not installed</span>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Installed: v{info.versionName || info.versionCode}
                        {info.versionCode !== null && info.versionCode < installModal.versionCode && (
                          <span style={{ color: 'var(--accent)', marginLeft: 4 }}>&#x2191; upgrade</span>
                        )}
                        {info.versionCode !== null && info.versionCode > installModal.versionCode && (
                          <span style={{ color: 'var(--warning, orange)', marginLeft: 4 }}>&#x2193; downgrade</span>
                        )}
                        {info.versionCode !== null && info.versionCode === installModal.versionCode && (
                          <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>(same)</span>
                        )}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
            {devices.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No devices online
              </div>
            )}
            {installError && (
              <div style={{
                padding: '10px 14px', borderRadius: 6, fontSize: 13,
                background: 'var(--bg-danger, rgba(255,59,48,0.1))',
                color: 'var(--text-danger, #ff3b30)',
                border: '1px solid var(--border-danger, rgba(255,59,48,0.2))',
              }}>
                {installError}
              </div>
            )}
          </div>
        </Modal>
      )}
      {/* Add App modal */}
      {addAppModal && (
        <Modal title="Add App by Package ID" onClose={() => setAddAppModal(false)}>
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
            Enter an Android package name to start tracking.
          </div>
          <form onSubmit={e => { e.preventDefault(); handleAddApp(); }}>
            <input
              className="form-input"
              type="text"
              placeholder="com.example.app"
              value={addAppPackage}
              onChange={e => { setAddAppPackage(e.target.value); setAddAppError(null); }}
              autoFocus
              data-testid="add-app-package-input"
              style={{
                width: '100%', padding: '10px 12px', fontSize: 14,
                fontFamily: 'var(--font-mono)', marginBottom: 12,
                border: '1px solid var(--border-color)', borderRadius: 6,
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
            {addAppError && (
              <div style={{
                padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12,
                background: 'var(--bg-danger, rgba(255,59,48,0.1))',
                color: 'var(--text-danger, #ff3b30)',
                border: '1px solid var(--border-danger, rgba(255,59,48,0.2))',
              }}>
                {addAppError}
              </div>
            )}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={addAppSaving || !addAppPackage.trim()}
              data-testid="add-app-submit-btn"
              style={{ fontSize: 13 }}
            >
              {addAppSaving ? 'Adding...' : 'Track App'}
            </button>
          </form>
        </Modal>
      )}

      {deleteInjectedConfirm && (
        <ConfirmDialog
          title="Delete Injected APK"
          message={`Are you sure you want to delete the injected APK "${deleteInjectedConfirm.packageName}"? This action cannot be undone.`}
          onConfirm={() => { handleDeleteInjected(deleteInjectedConfirm.id); setDeleteInjectedConfirm(null); }}
          onCancel={() => setDeleteInjectedConfirm(null)}
        />
      )}

      {deleteVersionConfirm && (
        <ConfirmDialog
          title="Delete APK Version"
          message={`Delete ${deleteVersionConfirm.label}? This removes the APK file from disk.`}
          onConfirm={() => { handleDeleteVersion(deleteVersionConfirm.appId, deleteVersionConfirm.versionId); setDeleteVersionConfirm(null); }}
          onCancel={() => setDeleteVersionConfirm(null)}
        />
      )}
    </div>
  );
}
