import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, Check, Upload, Syringe } from 'lucide-react';
import {
  Breadcrumbs, ConfirmDialog, SkeletonCard, SortableHeader, ActionMenu,
  useSortableTable, useWebSocket, useToast, useDocumentTitle, useAuthOptional,
} from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { AppIcon } from '../components/apks/AppIcon';
import { ActivityChip } from '../components/apks/ActivityChip';
import { ActivityPanel } from '../components/apks/ActivityPanel';
import { UploadApkModal } from '../components/apks/UploadApkModal';
import { InstallDeviceModal, type OnlineDevice } from '../components/apks/InstallDeviceModal';
import { InjectGadgetConfirm } from '../components/apks/InjectGadgetConfirm';
import { AvailabilityBadge, type AvailabilityState } from '../components/apks/AvailabilityBadge';
import { formatBytes, formatDate, formatDateRelative } from '../utils/format';

interface ApkVersionRow {
  id: number; trackedAppId: number; versionCode: number; versionName: string | null;
  filename: string; fileSize: number | null; deviceId: string | null; source?: string | null;
  downloadedAt: string | number; availability?: AvailabilityState;
  analysis?: { status: string; stage: string | null; error: string | null; aiRunning?: boolean } | null;
}
interface TrackedApp {
  id: number; packageName: string; appName: string | null; autoFetchPlayStore?: boolean | null;
  createdAt: string | number; versionCount: number; latestVersion: ApkVersionRow | null;
}
interface InjectedApk { id: number; packageName: string; versionCode: number; fridaVersion: string; createdAt: string | number; }
interface VersionAnalysis { status: string; stage?: string | null; error?: string | null; aiRunning?: boolean; }

const STAGE_LABELS: Record<string, string> = {
  metadata: 'Metadata', decompiling: 'Decompiling', storing: 'Storing', scanning: 'Scanning',
};

function isOnline(d: { lastSeen: string | null }): boolean {
  if (!d.lastSeen) return false;
  return Date.now() - new Date(d.lastSeen).getTime() < 120000;
}

export function AppDetail() {
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const toast = useToast();
  const navigate = useNavigate();
  const { trackedAppId } = useParams<{ trackedAppId: string }>();
  const appId = Number(trackedAppId);

  const [app, setApp] = useState<TrackedApp | null>(null);
  const [loading, setLoading] = useState(true);
  const [versions, setVersions] = useState<ApkVersionRow[]>([]);
  const [injected, setInjected] = useState<InjectedApk[]>([]);
  const [analysisStatus, setAnalysisStatus] = useState<Record<number, VersionAnalysis>>({});
  const [devices, setDevices] = useState<OnlineDevice[]>([]);
  const [pkgCopied, setPkgCopied] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [installFor, setInstallFor] = useState<ApkVersionRow | null>(null);
  const [injectFor, setInjectFor] = useState<ApkVersionRow | null>(null);
  const [untrackOpen, setUntrackOpen] = useState(false);
  const [deleteVersion, setDeleteVersion] = useState<ApkVersionRow | null>(null);
  const [deleteInjected, setDeleteInjected] = useState<InjectedApk | null>(null);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);

  useDocumentTitle(app ? (app.appName || app.packageName) : 'App');

  const fetchApp = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/apps/tracked').then(res => {
      if (res.body?.success) {
        setApp(res.body.data.find((a: TrackedApp) => a.id === appId) ?? null);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [ws, appId]);

  const fetchVersions = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', `/v1/apps/versions/${appId}`).then(res => {
      if (!res.body?.success) return;
      const rows = res.body.data as ApkVersionRow[];
      setVersions(rows);
      // The versions endpoint now embeds each version's latest analysis, so we
      // seed the status map directly instead of an N+1 of analysis-status calls.
      setAnalysisStatus(prev => {
        const next = { ...prev };
        for (const v of rows) {
          if (v.analysis) {
            next[v.id] = { status: v.analysis.status, stage: v.analysis.stage ?? null, error: v.analysis.error, aiRunning: !!v.analysis.aiRunning };
          }
        }
        return next;
      });
    }).catch(() => {});
  }, [ws, appId]);

  const fetchInjected = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/frida/gadget/injected').then(res => {
      if (res.body?.data) setInjected(res.body.data);
    }).catch(() => {});
  }, [ws]);

  useEffect(() => { fetchApp(); fetchVersions(); fetchInjected(); }, [fetchApp, fetchVersions, fetchInjected]);

  useEffect(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/device/list').then(res => {
      setDevices(((res.body?.data || []) as OnlineDevice[]).filter(isOnline));
    }).catch(() => {});
  }, [ws]);

  useEffect(() => {
    const unsubs = [
      ws.subscribe('apk:version-pulled', (msg: any) => {
        if (msg.trackedAppId === appId) { fetchApp(); fetchVersions(); }
      }),
      ws.subscribe('apk:analysis-update', (msg: any) => {
        // Update unconditionally so a version that started unanalysed (e.g.
        // analysis triggered from the Activity panel) reflects live, not just
        // versions already in the map. Entries for off-page versions are
        // harmless — never rendered, cleared on unmount.
        setAnalysisStatus(prev => ({
          ...prev,
          [msg.apkVersionId]: { status: msg.status, stage: msg.stage ?? null, error: msg.error, aiRunning: prev[msg.apkVersionId]?.aiRunning },
        }));
      }),
      ws.subscribe('apk:ai-agent-update', (msg: { versionId: number; status: string }) => {
        setAnalysisStatus(prev => (prev[msg.versionId]
          ? { ...prev, [msg.versionId]: { ...prev[msg.versionId], aiRunning: msg.status === 'running' } }
          : prev));
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [ws, appId, fetchApp, fetchVersions]);

  const { sorted: sortedVersions, sortKey, sortDir, onSort } = useSortableTable(versions, 'versionCode', 'desc');

  const injectedByCode = useMemo(() => {
    const map = new Map<number, InjectedApk[]>();
    for (const i of injected.filter(i => app && i.packageName === app.packageName)) {
      map.set(i.versionCode, [...(map.get(i.versionCode) || []), i]);
    }
    return map;
  }, [injected, app]);
  const orphanedInjected = useMemo(() =>
    (app ? injected.filter(i => i.packageName === app.packageName && !versions.some(v => v.versionCode === i.versionCode)) : []),
  [injected, app, versions]);

  const totalBytes = versions.reduce((sum, v) => sum + (v.fileSize || 0), 0);
  const latestId = app?.latestVersion?.id ?? null;

  const download = useCallback((v: ApkVersionRow) => {
    if (!app) return;
    const a = document.createElement('a');
    a.href = `/v1/apps/download/${v.id}`;
    a.download = `${app.packageName}_${v.filename}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [app]);

  const analyze = useCallback(async (versionId: number) => {
    setBusyVersion(versionId);
    try {
      await ws.sendRestApi('POST', `/v1/apps/analyze/${versionId}`);
      setAnalysisStatus(prev => ({ ...prev, [versionId]: { status: 'pending' } }));
      toast.success('Analysis started');
    } catch { toast.error('Failed to start analysis'); }
    finally { setBusyVersion(null); }
  }, [ws, toast]);

  const inject = useCallback(async (v: ApkVersionRow) => {
    if (!app) return;
    setBusyVersion(v.id);
    try {
      await ws.sendRestApi('POST', '/v1/frida/gadget/inject', { packageName: app.packageName, versionCode: v.versionCode });
      fetchInjected();
      toast.success('Frida gadget injected');
    } catch { toast.error('Failed to inject Frida gadget'); }
    finally { setBusyVersion(null); }
  }, [ws, app, fetchInjected, toast]);

  const doDeleteVersion = useCallback(async (versionId: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/apps/version/${versionId}`);
      setVersions(prev => prev.filter(v => v.id !== versionId));
      fetchApp();
      toast.success('Version deleted');
    } catch { toast.error('Failed to delete version'); }
  }, [ws, fetchApp, toast]);

  const doDeleteInjected = useCallback(async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/frida/gadget/injected/${id}`);
      setInjected(prev => prev.filter(i => i.id !== id));
      toast.success('Injected APK deleted');
    } catch { toast.error('Failed to delete injected APK'); }
  }, [ws, toast]);

  const togglePlayStore = useCallback(async () => {
    if (!app) return;
    const newValue = !(app.autoFetchPlayStore !== false);
    try {
      await ws.sendRestApi('PATCH', `/v1/apps/track/${app.id}`, { autoFetchPlayStore: newValue });
      setApp(prev => prev ? { ...prev, autoFetchPlayStore: newValue } : prev);
      toast.success(`Play Store auto-fetch ${newValue ? 'enabled' : 'disabled'}`);
    } catch { toast.error('Failed to update Play Store setting'); }
  }, [ws, app, toast]);

  const untrack = useCallback(async () => {
    if (!app) return;
    try {
      await ws.sendRestApi('DELETE', `/v1/apps/track/${app.id}`);
      toast.success('App untracked');
      navigate('/ui/apks');
    } catch { toast.error('Failed to untrack app'); }
  }, [ws, app, toast, navigate]);

  if (auth && !auth.hasScope('core.apk:read')) return <AccessDenied scope="core.apk:read" />;
  const canManage = !auth || auth.hasScope('core.apk:manage');

  if (loading) return <div><SkeletonCard /><SkeletonCard /></div>;
  if (!app) {
    return (
      <div className="empty-state" data-testid="app-not-found">
        <div className="empty-message">App not found</div>
        <div className="empty-description">It may have been untracked.</div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => navigate('/ui/apks')}>Back to APKs</button>
      </div>
    );
  }

  const psEnabled = app.autoFetchPlayStore !== false;

  const primaryAction = (v: ApkVersionRow) => {
    const s = analysisStatus[v.id];
    if (s?.status === 'completed') {
      return <button className="btn btn-sm btn-primary" onClick={() => navigate(`/ui/apps/${app.id}/analysis/${v.id}`)} data-testid={`open-analysis-${v.id}`}>Open Analysis</button>;
    }
    if (s?.status === 'pending' || s?.status === 'running') {
      const label = s.status === 'pending' ? 'Queued…' : `${STAGE_LABELS[s.stage || ''] || 'Analysing'}…`;
      return <button className="btn btn-sm" disabled>{label}</button>;
    }
    return (
      <button className="btn btn-sm" onClick={() => analyze(v.id)} disabled={busyVersion === v.id} data-testid={`analyze-${v.id}`}>
        {busyVersion === v.id ? '…' : 'Analyze'}
      </button>
    );
  };

  const analysisBadge = (v: ApkVersionRow) => {
    const s = analysisStatus[v.id];
    if (!s) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>;
    if (s.status === 'failed') return <span className="badge badge-failed" style={{ fontSize: 10 }} title={s.error || ''}>Failed</span>;
    if (s.status === 'completed') {
      return s.aiRunning
        ? <span className="badge badge-running" style={{ fontSize: 10, animation: 'pulse 1.5s ease-in-out infinite' }}>AI Analysing</span>
        : <span className="badge badge-success" style={{ fontSize: 10 }}>Ready</span>;
    }
    const label = s.status === 'pending' ? 'Pending' : (STAGE_LABELS[s.stage || ''] || 'Running');
    return <span className="badge badge-running" style={{ fontSize: 10, animation: s.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : undefined }}>{label}</span>;
  };

  const injectedSubRow = (i: InjectedApk) => (
    <tr key={`inj-${i.id}`} data-testid={`injected-row-${i.id}`} style={{ background: 'var(--bg-secondary)' }}>
      <td colSpan={6} style={{ paddingLeft: 40, fontSize: 12 }}>
        <span style={{ color: '#a78bfa', marginRight: 8 }}><Syringe size={12} style={{ verticalAlign: -2 }} /> Frida gadget build</span>
        <span style={{ color: 'var(--text-muted)' }}>frida {i.fridaVersion} · built {formatDate(i.createdAt)}</span>
      </td>
      <td colSpan={2}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn btn-sm btn-danger" onClick={() => setDeleteInjected(i)} data-testid={`delete-injected-${i.id}`}>Delete</button>
        </div>
      </td>
    </tr>
  );

  return (
    <div data-testid="app-detail">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Breadcrumbs items={[{ label: 'APKs', to: '/ui/apks' }, { label: app.appName || app.packageName }]} />
        <ActivityChip onClick={() => setPanelOpen(true)} />
      </div>

      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px', marginBottom: 16 }}>
        <AppIcon packageName={app.packageName} appName={app.appName} size={56} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }} data-testid="app-detail-name">{app.appName || app.packageName}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 4 }}>
            {app.packageName}
            <button
              title="Copy package ID"
              aria-label="Copy package ID"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: pkgCopied ? 'var(--accent)' : 'var(--text-muted)', lineHeight: 1 }}
              onClick={() => navigator.clipboard.writeText(app.packageName).then(() => { setPkgCopied(true); setTimeout(() => setPkgCopied(false), 2000); }).catch(() => {})}
            >
              {pkgCopied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, color: 'var(--text-secondary)', fontSize: 12 }}>
            <span>{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
            <span>·</span>
            <span>{formatBytes(totalBytes)} on disk</span>
            {app.latestVersion && <><span>·</span><span>updated {formatDateRelative(app.latestVersion.downloadedAt)}</span></>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            Auto-fetch from Play Store
            <button
              role="switch"
              aria-checked={psEnabled}
              aria-label="Auto-fetch from Play Store"
              data-testid="ps-toggle"
              onClick={togglePlayStore}
              className={`btn btn-sm${psEnabled ? ' btn-primary' : ''}`}
              style={{ minWidth: 44 }}
            >
              {psEnabled ? 'On' : 'Off'}
            </button>
          </label>
          {canManage && (
            <button className="btn" onClick={() => setUploadOpen(true)} data-testid="upload-version-btn">
              <Upload size={13} /> Upload version
            </button>
          )}
          <ActionMenu label="App settings" items={[{ key: 'untrack', label: 'Untrack app…', danger: true, onSelect: () => setUntrackOpen(true) }]} />
        </div>
      </div>

      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader label="Version" sortKey="versionName" currentSort={sortKey} dir={sortDir} onSort={onSort} />
              <SortableHeader label="Code" sortKey="versionCode" currentSort={sortKey} dir={sortDir} onSort={onSort} />
              <SortableHeader label="Size" sortKey="fileSize" currentSort={sortKey} dir={sortDir} onSort={onSort} />
              <th>Source</th>
              <SortableHeader label="Downloaded" sortKey="downloadedAt" currentSort={sortKey} dir={sortDir} onSort={onSort} />
              <th>Storage</th>
              <th>Analysis</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedVersions.map(v => (
              <React.Fragment key={v.id}>
                <tr data-testid={`version-row-${v.id}`}>
                  <td style={{ fontWeight: 500 }}>
                    {v.versionName || '—'}
                    {v.id === latestId && <span className="badge badge-running" style={{ fontSize: 9, marginLeft: 6 }}>Latest</span>}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{v.versionCode}</td>
                  <td>{formatBytes(v.fileSize)}</td>
                  <td style={{ fontSize: 12 }}>
                    {v.source === 'playstore' ? <span className="badge badge-running" style={{ fontSize: 10 }}>Play Store</span>
                      : v.source === 'upload' ? <span className="badge" style={{ fontSize: 10, background: 'var(--bg-tertiary)' }}>Upload</span>
                      : <span style={{ color: 'var(--text-muted)' }}>{v.deviceId || '—'}</span>}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{v.downloadedAt ? formatDate(v.downloadedAt) : '—'}</td>
                  <td>{v.availability ? <AvailabilityBadge state={v.availability} /> : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}</td>
                  <td>{analysisBadge(v)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                      {primaryAction(v)}
                      <ActionMenu
                        label="Version actions"
                        items={[
                          ...(canManage ? [{ key: 'download', label: 'Download APK', onSelect: () => download(v) }] : []),
                          ...(devices.length > 0 ? [{ key: 'install', label: 'Install on device…', onSelect: () => setInstallFor(v) }] : []),
                          { key: 'inject', label: 'Inject Frida gadget…', onSelect: () => setInjectFor(v) },
                          {
                            key: 'diff', label: 'Diff vs previous version',
                            disabled: analysisStatus[v.id]?.status !== 'completed' || !versions.some(o => o.versionCode < v.versionCode),
                            onSelect: () => navigate(`/ui/apps/${app.id}/analysis/${v.id}?tab=diff`),
                          },
                          ...(canManage ? [{ key: 'reanalyze', label: 'Re-analyze', onSelect: () => analyze(v.id) }] : []),
                          'divider' as const,
                          { key: 'delete', label: 'Delete version…', danger: true, onSelect: () => setDeleteVersion(v) },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
                {(injectedByCode.get(v.versionCode) || []).map(injectedSubRow)}
              </React.Fragment>
            ))}
            {versions.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)' }}>
                No versions stored yet. Pull from a device, wait for Play Store auto-fetch, or upload an APK.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {orphanedInjected.length > 0 && (
        <div className="card" style={{ marginTop: 16 }} data-testid="orphaned-injected">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Orphaned injected builds</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Their source APK versions have been deleted.</div>
          <table className="data-table">
            <tbody>{orphanedInjected.map(injectedSubRow)}</tbody>
          </table>
        </div>
      )}

      {panelOpen && <ActivityPanel onClose={() => setPanelOpen(false)} />}
      {uploadOpen && (
        <UploadApkModal
          expectedPackage={app.packageName}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => { setUploadOpen(false); fetchApp(); fetchVersions(); toast.success('APK uploaded — analysis started'); }}
        />
      )}
      {installFor && (
        <InstallDeviceModal
          versionId={installFor.id} packageName={app.packageName}
          versionName={installFor.versionName} versionCode={installFor.versionCode}
          devices={devices} onClose={() => setInstallFor(null)}
        />
      )}
      {injectFor && (
        <InjectGadgetConfirm
          packageName={app.packageName} versionCode={injectFor.versionCode}
          onConfirm={() => { inject(injectFor); setInjectFor(null); }}
          onCancel={() => setInjectFor(null)}
        />
      )}
      {untrackOpen && (
        <ConfirmDialog
          title="Untrack App"
          confirmLabel="Untrack"
          message={`Stop tracking "${app.appName || app.packageName}"? Its stored versions and analyses will no longer be reachable from the library.`}
          onConfirm={() => { setUntrackOpen(false); untrack(); }}
          onCancel={() => setUntrackOpen(false)}
        />
      )}
      {deleteVersion && (
        <ConfirmDialog
          title="Delete APK Version"
          message={`Delete v${deleteVersion.versionName || deleteVersion.versionCode}? This removes the APK file from disk.`}
          onConfirm={() => { doDeleteVersion(deleteVersion.id); setDeleteVersion(null); }}
          onCancel={() => setDeleteVersion(null)}
        />
      )}
      {deleteInjected && (
        <ConfirmDialog
          title="Delete Injected APK"
          message={`Delete the Frida build of ${deleteInjected.packageName} (code ${deleteInjected.versionCode})? This cannot be undone.`}
          onConfirm={() => { doDeleteInjected(deleteInjected.id); setDeleteInjected(null); }}
          onCancel={() => setDeleteInjected(null)}
        />
      )}
    </div>
  );
}
