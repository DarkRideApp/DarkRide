import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Package, Upload } from 'lucide-react';
import {
  PageHeader, Modal, ConfirmDialog, SkeletonCard, SearchInput, ActionMenu,
  useWebSocket, useToast, useDocumentTitle, useAuthOptional,
  ExtensionSlot, pluginRegistry,
} from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { AppIcon } from '../components/apks/AppIcon';
import { ActivityChip } from '../components/apks/ActivityChip';
import { ActivityPanel } from '../components/apks/ActivityPanel';
import { UploadApkModal } from '../components/apks/UploadApkModal';
import { formatBytes, formatDateRelative, toMs } from '../utils/format';

/**
 * Options plugins can add to the Add App modal.
 *
 * Unlike every other slot, a contribution here can ACT when the app is created,
 * not just render: it calls `registerOnCreated(fn)` and core invokes each fn
 * with the created app after the POST succeeds. That is what lets a plugin
 * apply a per-app setting of its own at add time instead of making the operator
 * add the app, find it, and toggle something else.
 *
 * The id and prop names are API surface — a plugin breaks if either changes.
 */
pluginRegistry.registerUiSlots('core', [
  {
    id: 'add-app:options',
    kind: 'container',
    description: 'Extra options in the Add App modal. Receives { packageName, registerOnCreated }. '
      + 'packageName is the live value of the input, so it updates as it is typed. '
      + 'registerOnCreated(fn) registers a callback invoked as fn({ id, packageName, appName }) '
      + 'after the app is successfully tracked; it may be async. A callback that throws is logged '
      + 'and skipped — it never fails the add or blocks the other callbacks.',
  },
]);

interface LatestVersion {
  id: number; trackedAppId: number; versionCode: number; versionName: string | null;
  filename: string; fileSize: number | null; deviceId: string | null; source?: string | null;
  downloadedAt: string | number;
}

interface TrackedAppRow {
  id: number;
  packageName: string;
  appName: string | null;
  createdAt: string | number;
  versionCount: number;
  latestVersion: LatestVersion | null;
  latestAnalysis: { status: string; stage: string | null; error: string | null } | null;
}

type SortKey = 'recent' | 'name' | 'versions';

const STAGE_LABELS: Record<string, string> = {
  metadata: 'Metadata', decompiling: 'Decompiling', storing: 'Storing', scanning: 'Scanning',
};

function analysisBadge(app: TrackedAppRow): React.ReactNode {
  const a = app.latestAnalysis;
  if (!a) return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>;
  if (a.status === 'failed') return <span className="badge badge-failed" title={a.error || ''} style={{ fontSize: 11 }}>Failed</span>;
  if (a.status === 'completed') return <span className="badge badge-success" style={{ fontSize: 11 }}>Ready</span>;
  const label = a.status === 'pending' ? 'Pending' : (STAGE_LABELS[a.stage || ''] || 'Running');
  return <span className="badge badge-running" style={{ fontSize: 11, animation: a.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : undefined }}>{label}</span>;
}

export function AppLibrary() {
  useDocumentTitle('APKs');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [apps, setApps] = useState<TrackedAppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [scanning, setScanning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dropFile, setDropFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const [addAppOpen, setAddAppOpen] = useState(false);
  const [addAppPackage, setAddAppPackage] = useState('');
  const [addAppSaving, setAddAppSaving] = useState(false);
  const [addAppError, setAddAppError] = useState<string | null>(null);
  const [storeSources, setStoreSources] = useState<{ source: string; label: string; defaultEnabled: boolean }[]>([]);
  const [selectedSources, setSelectedSources] = useState<Record<string, boolean>>({});
  const [autoAnalyse, setAutoAnalyse] = useState(false);
  // Callbacks registered by slot contributions, kept in a ref so registering
  // one does not re-render the modal (a contribution that registers during
  // render would otherwise loop).
  const onCreatedRef = useRef<Array<(app: TrackedAppRow) => void | Promise<void>>>([]);

  const [untrackConfirm, setUntrackConfirm] = useState<TrackedAppRow | null>(null);

  const fetchApps = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/apps/tracked').then(res => {
      if (res.body?.success) setApps(res.body.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [ws]);

  // ws.connected is explicit so a cold start / reconnect re-runs the initial fetch.
  useEffect(() => { fetchApps(); }, [fetchApps, ws.connected]);

  useEffect(() => {
    const unsubs = [
      ws.subscribe('apk:version-pulled', () => fetchApps()),
      ws.subscribe('apk:analysis-update', () => fetchApps()),
      ws.subscribe('apk:scan-complete', () => { setScanning(false); fetchApps(); }),
    ];
    return () => unsubs.forEach(u => u());
  }, [ws, fetchApps]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (!tab) return;
    if (tab === 'analysis') setPanelOpen(true);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const triggerScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await ws.sendRestApi('POST', '/v1/apps/trigger-scan');
      toast.success('Scan started');
    } catch {
      setScanning(false);
      toast.error('Failed to trigger scan');
    }
  }, [ws, scanning, toast]);

  // Load the available remote stores when the Add App modal opens, defaulting
  // each checkbox to the source's defaultEnabled (Play Store on, QQ opt-in off).
  // Reset per-open state. Without this, callbacks registered by a contribution
  // during a previous add would fire again on the next one, against a different
  // app, and the auto-analyse choice would silently persist.
  useEffect(() => {
    if (!addAppOpen) return;
    onCreatedRef.current = [];
    setAutoAnalyse(false);
  }, [addAppOpen]);

  useEffect(() => {
    if (!addAppOpen || !ws.connected) return;
    ws.sendRestApi('GET', '/v1/apps/sources').then(res => {
      if (res.body?.success) {
        const list = res.body.data as { source: string; label: string; defaultEnabled: boolean }[];
        setStoreSources(list);
        setSelectedSources(Object.fromEntries(list.map(s => [s.source, s.defaultEnabled])));
      }
    }).catch(() => {});
  }, [addAppOpen, ws]);

  const addApp = useCallback(async () => {
    const pkg = addAppPackage.trim();
    if (!pkg) return;
    if (!pkg.includes('.')) {
      setAddAppError('Package name must contain at least one dot (e.g. com.example.app)');
      return;
    }
    setAddAppSaving(true);
    setAddAppError(null);
    const anySelected = Object.values(selectedSources).some(Boolean);
    try {
      const res = await ws.sendRestApi('POST', '/v1/apps/track', {
        packageName: pkg, appName: null, sources: selectedSources, fetch: true, autoAnalyse,
      });
      if (res.body?.success) {
        // Plugin contributions act here, with the created app. Each is isolated:
        // a plugin that throws must not cost the operator the app they just
        // added, so failures are logged and the rest still run.
        for (const fn of onCreatedRef.current) {
          try {
            await fn(res.body.data);
          } catch (err) {
            console.warn('[add-app:options] a plugin callback failed', err);
          }
        }
        setAddAppOpen(false);
        setAddAppPackage('');
        fetchApps();
        toast.success(anySelected ? 'App added — fetching new versions…' : 'App added');
      } else {
        setAddAppError(res.body?.error || 'Failed to add app');
      }
    } catch (err: any) {
      setAddAppError(err?.message || 'Failed to add app');
    } finally {
      setAddAppSaving(false);
    }
  }, [ws, addAppPackage, selectedSources, autoAnalyse, fetchApps, toast]);

  const untrack = useCallback(async (appId: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/apps/track/${appId}`);
      setApps(prev => prev.filter(a => a.id !== appId));
      toast.success('App untracked');
    } catch {
      toast.error('Failed to untrack app');
    }
  }, [ws, toast]);

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
      dragDepth.current += 1;
      setDragActive(true);
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setDropFile(file);
      setUploadOpen(true);
    }
  };

  if (auth && !auth.hasScope('core.apk:read')) return <AccessDenied scope="core.apk:read" />;
  const canManage = !auth || auth.hasScope('core.apk:manage');

  if (loading) return <div><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>;

  const visible = apps
    .filter(app => {
      if (!filter) return true;
      const q = filter.toLowerCase();
      return (app.appName || '').toLowerCase().includes(q) || app.packageName.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (sort === 'name') return (a.appName || a.packageName).localeCompare(b.appName || b.packageName);
      if (sort === 'versions') return b.versionCount - a.versionCount;
      const aT = a.latestVersion ? toMs(a.latestVersion.downloadedAt) : 0;
      const bT = b.latestVersion ? toMs(b.latestVersion.downloadedAt) : 0;
      return bT - aT;
    });

  return (
    <div data-testid="app-library" onDragEnter={onDragEnter} onDragOver={e => e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
      <PageHeader title="APKs" />

      {apps.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Package size={40} strokeWidth={1} /></div>
          <div className="empty-message">No tracked apps</div>
          <div className="empty-description">
            Track an app by package name, upload an APK, or pull one from a connected device.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', marginTop: 12 }}>
            <button className="btn btn-primary" data-testid="add-app-empty-btn" onClick={() => { setAddAppOpen(true); setAddAppPackage(''); setAddAppError(null); }}>+ Add App</button>
            {canManage && <button className="btn" data-testid="upload-empty-btn" onClick={() => { setDropFile(null); setUploadOpen(true); }}><Upload size={13} /> Upload APK</button>}
            {/* Activity stays reachable even with no tracked apps (a job may still be running/failed). */}
            <ActivityChip onClick={() => setPanelOpen(true)} />
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <SearchInput value={filter} onChange={setFilter} placeholder="Search apps…" data-testid="app-filter-input" />
            <select className="form-input" value={sort} onChange={e => setSort(e.target.value as SortKey)} data-testid="app-sort-select" style={{ width: 'auto', fontSize: 13 }}>
              <option value="recent">Recently updated</option>
              <option value="name">Name</option>
              <option value="versions">Version count</option>
            </select>
            {canManage && (
              <button className="btn" onClick={() => { setDropFile(null); setUploadOpen(true); }} data-testid="upload-apk-btn">
                <Upload size={13} /> Upload APK
              </button>
            )}
            <button className="btn" onClick={triggerScan} disabled={scanning} data-testid="btn-trigger-scan" title="Scan all tracked apps on all devices for new versions">
              {scanning ? 'Scanning…' : 'Scan Devices'}
            </button>
            <button className="btn btn-primary" onClick={() => { setAddAppOpen(true); setAddAppPackage(''); setAddAppError(null); }} data-testid="add-app-btn" style={{ whiteSpace: 'nowrap' }}>
              + Add App
            </button>
            <ActivityChip onClick={() => setPanelOpen(true)} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map(app => (
              <div
                key={app.id}
                className="card app-row"
                data-testid={`app-row-${app.id}`}
                onClick={() => navigate(`/ui/apps/${app.id}`)}
                role="link"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') navigate(`/ui/apps/${app.id}`); }}
              >
                <AppIcon packageName={app.packageName} appName={app.appName} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{app.appName || app.packageName}</div>
                  {app.appName && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{app.packageName}</div>}
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>
                  {app.latestVersion ? <>v{app.latestVersion.versionName || app.latestVersion.versionCode}{app.latestVersion.fileSize != null && ` · ${formatBytes(app.latestVersion.fileSize)}`}</> : 'No versions'}
                </div>
                <div style={{ width: 110, display: 'flex', justifyContent: 'center' }}>{analysisBadge(app)}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, width: 80, textAlign: 'right' }}>
                  {app.versionCount} version{app.versionCount !== 1 ? 's' : ''}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, width: 70, textAlign: 'right' }}>
                  {app.latestVersion ? formatDateRelative(app.latestVersion.downloadedAt) : '—'}
                </div>
                <ActionMenu
                  label="App actions"
                  items={[{ key: 'untrack', label: 'Untrack app…', danger: true, onSelect: () => setUntrackConfirm(app) }]}
                />
              </div>
            ))}
            {visible.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No apps match "{filter}"
              </div>
            )}
          </div>
        </>
      )}

      {dragActive && (
        <div className="activity-panel-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }} data-testid="drop-overlay">
          <div className="card" style={{ padding: '24px 40px', fontSize: 15, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Upload size={20} /> Drop APK to upload
          </div>
        </div>
      )}

      {panelOpen && <ActivityPanel onClose={() => setPanelOpen(false)} />}

      {uploadOpen && (
        <UploadApkModal
          initialFile={dropFile}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => { setUploadOpen(false); fetchApps(); toast.success('APK uploaded — analysis started'); }}
        />
      )}

      {addAppOpen && (
        <Modal title="Add App by Package ID" onClose={() => setAddAppOpen(false)}>
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
            Enter an Android package name to start tracking.
          </div>
          <form onSubmit={e => { e.preventDefault(); addApp(); }}>
            <input
              className="form-input"
              type="text"
              placeholder="com.example.app"
              value={addAppPackage}
              onChange={e => { setAddAppPackage(e.target.value); setAddAppError(null); }}
              autoFocus
              data-testid="add-app-package-input"
              style={{ width: '100%', fontFamily: 'var(--font-mono)', marginBottom: 12, boxSizing: 'border-box' }}
            />
            {storeSources.length > 0 && (
              <div style={{ marginBottom: 12 }} data-testid="add-app-sources">
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>Fetch from</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {storeSources.map(s => (
                    <label key={s.source} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!selectedSources[s.source]}
                        onChange={e => setSelectedSources(prev => ({ ...prev, [s.source]: e.target.checked }))}
                        data-testid={`add-app-source-${s.source}`}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  Checked stores are fetched immediately, then on each scan. QQ (应用宝) only carries apps registered in mainland China.
                </div>
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoAnalyse}
                  onChange={e => setAutoAnalyse(e.target.checked)}
                  data-testid="add-app-auto-analyse"
                />
                Download and analyse each new version
              </label>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Off means versions are still tracked — the APK just is not pulled or decompiled.
                Can be changed later from the app&apos;s page.
              </div>
            </div>

            {/* Plugin options. Contributions may also register a callback that
                runs once the app exists — see the slot declaration at the top
                of this file. */}
            <ExtensionSlot
              id="add-app:options"
              props={{
                packageName: addAppPackage.trim(),
                registerOnCreated: (fn: (app: TrackedAppRow) => void | Promise<void>) => {
                  if (!onCreatedRef.current.includes(fn)) onCreatedRef.current.push(fn);
                },
              }}
            />

            {addAppError && (
              <div className="status-strip status-strip-error" data-testid="add-app-error">
                <span className="status-strip-label">{addAppError}</span>
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={addAppSaving || !addAppPackage.trim()} data-testid="add-app-submit-btn">
              {addAppSaving ? 'Adding…' : (Object.values(selectedSources).some(Boolean) ? 'Add + fetch' : 'Track app')}
            </button>
          </form>
        </Modal>
      )}

      {untrackConfirm && (
        <ConfirmDialog
          title="Untrack App"
          confirmLabel="Untrack"
          message={`Stop tracking "${untrackConfirm.appName || untrackConfirm.packageName}"? Its ${untrackConfirm.versionCount} stored version${untrackConfirm.versionCount !== 1 ? 's' : ''} and analyses will no longer be reachable from the library.`}
          onConfirm={() => { untrack(untrackConfirm.id); setUntrackConfirm(null); }}
          onCancel={() => setUntrackConfirm(null)}
        />
      )}
    </div>
  );
}
