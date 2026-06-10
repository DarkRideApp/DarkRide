import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { Breadcrumbs } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { ActionMenu, StatusStrip, Tabs, SearchInput } from '@darkrideapp/plugin-sdk/react';
import { formatBytes, formatDuration } from '../utils/format';
import { CodeBrowser } from '../components/analysis/CodeBrowser';
import { FindingsTable } from '../components/analysis/FindingsTable';
import { StringsView } from '../components/analysis/StringsView';
import { AssetsBrowser } from '../components/analysis/AssetsBrowser';
import { ReactNativeTab } from '../components/analysis/ReactNativeTab';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { AvailabilityBadge, type AvailabilityState } from '../components/apks/AvailabilityBadge';
import { NonLocalEmptyState } from '../components/apks/NonLocalEmptyState';
import { RestoreButton } from '../components/apks/RestoreButton';
import { useToast } from '@darkrideapp/plugin-sdk/react';

type Tab = 'overview' | 'code' | 'assets' | 'findings' | 'strings' | 'reactnative' | 'diff' | 'notes';

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  code: 'Code',
  assets: 'Assets',
  findings: 'Findings',
  strings: 'Strings',
  reactnative: 'React Native',
  diff: 'Diff',
  notes: 'Notes',
};

const ALL_TABS: Tab[] = ['overview', 'code', 'assets', 'findings', 'strings', 'reactnative', 'diff', 'notes'];

interface ApkDiffResult {
  newVersionName: string | null;
  oldVersionName: string | null;
  newFileSize: number | null;
  oldFileSize: number | null;
  minSdk: { old: number | null; new: number | null };
  targetSdk: { old: number | null; new: number | null };
  permissions: { added: string[]; removed: string[] };
  activities: { added: string[]; removed: string[] };
  services: { added: string[]; removed: string[] };
  receivers: { added: string[]; removed: string[] };
  providers: { added: string[]; removed: string[] };
  libraries: { added: string[]; removed: string[] };
  frameworkChanges: string | null;
  findings: {
    newCount: number;
    resolvedCount: number;
    persistentCount: number;
    bySeverity: Array<{ severity: string; newCount: number; resolvedCount: number }>;
  };
  files: {
    added: number;
    removed: number;
    modified: number | null;
    totalNew: number;
    totalOld: number;
    hasContentHash: boolean;
  };
}

interface DiffReportData {
  id: number;
  apkVersionId: number;
  compareVersionId: number;
  status: string;
  diffResult: ApkDiffResult | null;
  aiSummary: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface AnalysisOverview {
  appName: string | null;
  packageName: string;
  versionCode: number;
  versionName: string | null;
  manifest: Record<string, any>;
  findingCounts: Record<string, number>;
  findingsByCategory: Record<string, number>;
  fileCount: number;
  totalSize: number;
  sourceCounts: Record<string, number>;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc3545',
  high: '#fd7e14',
  medium: '#ffc107',
  low: '#0d6efd',
  info: '#6c757d',
};

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const DANGEROUS_PERMISSIONS = new Set([
  'android.permission.CAMERA', 'android.permission.RECORD_AUDIO',
  'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS', 'android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR',
  'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO', 'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_PHONE_STATE', 'android.permission.CALL_PHONE', 'android.permission.READ_CALL_LOG',
  'android.permission.READ_SMS', 'android.permission.SEND_SMS', 'android.permission.RECEIVE_SMS',
  'android.permission.BODY_SENSORS', 'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT', 'android.permission.POST_NOTIFICATIONS',
]);
function permissionGroup(perm: string): 'dangerous' | 'normal' | 'other' {
  if (DANGEROUS_PERMISSIONS.has(perm)) return 'dangerous';
  if (perm.startsWith('android.permission.')) return 'normal';
  return 'other';
}

const STAGE_LABELS: Record<string, string> = {
  metadata: 'Metadata',
  flutter: 'Flutter Decompile',
  decompiling: 'Decompiling',
  hermes: 'Hermes Decompile',
  beautifying: 'JS Beautify',
  storing: 'Storing',
  scanning: 'Scanning',
  maps: 'Map Tiles',
};

export function ApkAnalysis() {
  const auth = useAuthOptional();
  const { trackedAppId, versionId } = useParams<{ trackedAppId: string; versionId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const ws = useWebSocket();

  const tabParam = searchParams.get('tab') as Tab | null;
  const [navigateTo, setNavigateTo] = useState<{ filePath: string; lineNumber: number; source: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<AnalysisOverview | null>(null);

  const isReactNative = !!(overview?.manifest?.frameworks?.reactNative);
  const TABS = useMemo(() =>
    ALL_TABS.filter(t => t !== 'reactnative' || isReactNative),
    [isReactNative],
  );
  const activeTab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'overview';
  const setActiveTab = useCallback((tab: Tab) => {
    setSearchParams(tab === 'overview' ? {} : { tab }, { replace: false });
  }, [setSearchParams]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    activities: false,
    services: false,
    receivers: false,
    providers: false,
  });
  const [excludedPaths, setExcludedPaths] = useState<string[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [notes, setNotes] = useState('');
  const [savedNotes, setSavedNotes] = useState('');
  const [notesLoading, setNotesLoading] = useState(true);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaveFlash, setNotesSaveFlash] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const notesEditingRef = useRef(false);
  const [reanalyzing, setReanalyzing] = useState<string | null>(null); // null | 'pending' | 'running' | stage name
  const [reanalyzingProgress, setReanalyzingProgress] = useState<number | null>(null);
  const [aiAgentStatus, setAiAgentStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');
  const [aiContextPercent, setAiContextPercent] = useState<number | null>(null);
  const [aiTokenUsage, setAiTokenUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);
  const [captureLaunching, setCaptureLaunching] = useState(false);
  const [captureLaunchError, setCaptureLaunchError] = useState<string | null>(null);
  const [pkgIdCopied, setPkgIdCopied] = useState(false);
  const [diffReport, setDiffReport] = useState<DiffReportData | null | undefined>(undefined); // undefined = not fetched yet
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffRunning, setDiffRunning] = useState(false);
  const [availability, setAvailability] = useState<{ state: AvailabilityState } | null>(null);
  const [oldAvail, setOldAvail] = useState<{ state: AvailabilityState } | null>(null);
  const [versionSource, setVersionSource] = useState<'device' | 'playstore' | 'upload'>('device');
  const [isLatest, setIsLatest] = useState(false);
  const [severityDeepLink, setSeverityDeepLink] = useState<string | null>(null);
  const [permFilter, setPermFilter] = useState('');
  const toast = useToast();

  // A severity pill deep-link is a one-shot: once the user leaves the Findings
  // tab, forget it so returning to Findings doesn't clobber a manual filter change.
  useEffect(() => {
    if (activeTab !== 'findings') setSeverityDeepLink(null);
  }, [activeTab]);

  const displayName = overview?.appName || overview?.packageName || 'APK Analysis';
  useDocumentTitle(overview ? `Analysis - ${displayName}` : 'APK Analysis');

  const fetchOverview = useCallback(async () => {
    if (!versionId) return;
    try {
      const res = await ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/overview`);
      if (res.status === 200 && res.body?.success) {
        setOverview(res.body.data);
      } else {
        setError(res.body?.error || 'Failed to load analysis data');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load analysis data');
    } finally {
      setLoading(false);
    }
  }, [ws, versionId]);

  const fetchNotes = useCallback(async () => {
    if (!versionId) return;
    try {
      const res = await ws.sendRestApi('GET', `/v1/apps/analysis/${versionId}/notes`);
      if (res.status === 200 && res.body?.success) {
        setNotes(res.body.notes);
        setSavedNotes(res.body.notes);
      }
    } catch {
      // ignore — notes may not exist yet
    } finally {
      setNotesLoading(false);
    }
  }, [ws, versionId]);

  const fetchExcludedPaths = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/settings/analysis_excluded_paths');
      if (res.status === 200 && res.body?.data?.value) {
        const parsed = JSON.parse(res.body.data.value);
        if (Array.isArray(parsed)) setExcludedPaths(parsed);
      }
    } catch {
      // ignore — setting may not exist yet
    }
  }, [ws]);

  const fetchDiffReport = useCallback(async () => {
    if (!versionId) return;
    setDiffLoading(true);
    try {
      const res = await ws.sendRestApi('GET', `/v1/apps/diff/${versionId}`);
      if (res.status === 200 && res.body?.success) {
        setDiffReport(res.body.report ?? null);
        if (res.body.report?.status === 'in_progress') setDiffRunning(true);
        else setDiffRunning(false);
      }
    } catch {
      // ignore
    } finally {
      setDiffLoading(false);
    }
  }, [ws, versionId]);

  const fetchAvailability = useCallback(async () => {
    if (!versionId || !overview) return;
    try {
      const res = await ws.sendRestApi('GET', `/v1/apks/${encodeURIComponent(overview.packageName)}/${versionId}/availability`);
      if (res.status === 200 && res.body?.state) {
        setAvailability({ state: res.body.state as AvailabilityState });
      }
    } catch {
      // ignore — badge is non-critical
    }
  }, [ws, versionId, overview]);

  const fetchOldAvail = useCallback(async (compareVersionId: number) => {
    if (!overview) return;
    try {
      const res = await ws.sendRestApi('GET', `/v1/apks/${encodeURIComponent(overview.packageName)}/${compareVersionId}/availability`);
      if (res.status === 200 && res.body?.state) {
        setOldAvail({ state: res.body.state as AvailabilityState });
      }
    } catch {
      // ignore — badge is non-critical
    }
  }, [ws, overview]);

  const fetchVersionSource = useCallback(async () => {
    if (!versionId || !overview) return;
    try {
      const res = await ws.sendRestApi('GET', `/v1/apps/versions/${overview.manifest.trackedAppId ?? trackedAppId}`);
      if (res.status === 200 && res.body?.success && Array.isArray(res.body.data)) {
        const vid = Number(versionId);
        const match = res.body.data.find((v: any) => v.id === vid);
        if (match?.source) setVersionSource(match.source as 'device' | 'playstore' | 'upload');
        const maxRow = res.body.data.reduce((a: any, b: any) => (a.versionCode > b.versionCode ? a : b), res.body.data[0]);
        setIsLatest(!!maxRow && maxRow.id === Number(versionId));
      }
    } catch {
      // ignore — source is best-effort; defaults to 'device'
    }
  }, [ws, versionId, overview, trackedAppId]);

  const handleRestore = useCallback(async () => {
    if (!versionId || !overview) return;
    try {
      const res = await ws.sendRestApi('POST', `/v1/apks/${encodeURIComponent(overview.packageName)}/${versionId}/restore`);
      if (res.status !== 200 || !res.body) {
        toast.error(res.body?.error ?? `Restore failed: ${res.status}`);
        return;
      }
      toast.success(`Restore: ${res.body.kind ?? 'done'}`);
      await fetchAvailability();
    } catch (e: any) {
      toast.error(String(e?.message ?? 'Restore failed'));
    }
  }, [ws, versionId, overview, toast, fetchAvailability]);

  useEffect(() => {
    if (ws.connected) {
      fetchOverview();
      fetchExcludedPaths();
      fetchNotes();
      fetchDiffReport();
    }
  }, [ws.connected, fetchOverview, fetchExcludedPaths, fetchNotes, fetchDiffReport]);

  // Fetch availability and version source once overview is loaded (needs packageName)
  useEffect(() => {
    if (overview) {
      fetchAvailability();
      fetchVersionSource();
    }
  }, [overview, fetchAvailability, fetchVersionSource]);

  // Fetch compare-version availability when a diff report with compareVersionId is available
  useEffect(() => {
    if (diffReport?.compareVersionId && overview) {
      fetchOldAvail(diffReport.compareVersionId);
    }
  }, [diffReport?.compareVersionId, overview, fetchOldAvail]);

  // Subscribe to live notes updates from AI agent or other tabs
  useEffect(() => {
    if (!versionId) return;
    const vid = parseInt(versionId, 10);
    const unsub = ws.subscribe('apk:notes-updated', (msg: { versionId: number; notes: string }) => {
      if (msg.versionId === vid && !notesEditingRef.current) {
        setNotes(msg.notes);
        setSavedNotes(msg.notes);
      }
    });
    return unsub;
  }, [ws, versionId]);

  // Subscribe to analysis updates for re-analyze progress
  useEffect(() => {
    if (!versionId) return;
    const vid = parseInt(versionId, 10);
    const unsub = ws.subscribe('apk:analysis-update', (msg: any) => {
      if (msg.apkVersionId !== vid) return;
      if (msg.status === 'running') {
        setReanalyzing(msg.stage || 'running');
        setReanalyzingProgress(typeof msg.progress === 'number' ? msg.progress : null);
      } else if (msg.status === 'completed') {
        setReanalyzing(null);
        setReanalyzingProgress(null);
        fetchOverview();
      } else if (msg.status === 'failed') {
        setReanalyzing(null);
        setReanalyzingProgress(null);
      }
    });
    return unsub;
  }, [ws, versionId, fetchOverview]);

  // Subscribe to AI agent status updates
  useEffect(() => {
    if (!versionId) return;
    const vid = parseInt(versionId, 10);
    const unsub = ws.subscribe('apk:ai-agent-update', (msg: { versionId: number; status: string; error?: string; contextPercent?: number; usage?: { inputTokens: number; outputTokens: number } }) => {
      if (msg.versionId !== vid) return;
      setAiAgentStatus(msg.status as 'running' | 'completed' | 'failed');
      if (typeof msg.contextPercent === 'number') {
        setAiContextPercent(msg.contextPercent);
      }
      if (msg.status === 'completed' || msg.status === 'failed') {
        setAiContextPercent(null);
      }
      if (msg.usage) {
        setAiTokenUsage(msg.usage);
      }
    });
    return unsub;
  }, [ws, versionId]);

  // Subscribe to diff analysis updates
  useEffect(() => {
    if (!versionId) return;
    const vid = parseInt(versionId, 10);
    const unsub = ws.subscribe('apk:diff-update', (msg: { versionId: number; status: string; error?: string }) => {
      if (msg.versionId !== vid) return;
      if (msg.status === 'running') {
        setDiffRunning(true);
      } else if (msg.status === 'completed' || msg.status === 'failed') {
        setDiffRunning(false);
        fetchDiffReport();
      }
    });
    return unsub;
  }, [ws, versionId, fetchDiffReport]);

  const handleReanalyze = useCallback(async () => {
    if (!versionId || reanalyzing) return;
    setReanalyzing('pending');
    setReanalyzingProgress(null);
    try {
      await ws.sendRestApi('POST', `/v1/apps/analyze/${versionId}`);
    } catch {
      setReanalyzing(null);
      setReanalyzingProgress(null);
    }
  }, [ws, versionId, reanalyzing]);

  const refreshDiff = useCallback(async () => {
    await Promise.all([
      fetchDiffReport(),
      fetchAvailability(),
      ...(diffReport?.compareVersionId ? [fetchOldAvail(diffReport.compareVersionId)] : []),
    ]);
  }, [fetchDiffReport, fetchAvailability, fetchOldAvail, diffReport?.compareVersionId]);

  const handleRunDiff = useCallback(async () => {
    if (!versionId || diffRunning) return;
    setDiffRunning(true);
    try {
      await ws.sendRestApi('POST', `/v1/apps/diff/${versionId}/run`);
    } catch {
      setDiffRunning(false);
    }
  }, [ws, versionId, diffRunning]);

  const handleAiReview = useCallback(async () => {
    if (!versionId || aiAgentStatus === 'running') return;
    setAiAgentStatus('running');
    try {
      const res = await ws.sendRestApi('POST', `/v1/apps/analysis/${versionId}/ai-review`);
      if (res.status !== 200 || !res.body?.success) {
        setAiAgentStatus('failed');
      }
    } catch {
      setAiAgentStatus('failed');
    }
  }, [ws, versionId, aiAgentStatus]);

  const handleCaptureLaunch = useCallback(async () => {
    if (!versionId || captureLaunching) return;
    setCaptureLaunching(true);
    setCaptureLaunchError(null);
    try {
      const res = await ws.sendRestApi('POST', `/v1/apps/analysis/${versionId}/capture-launch`);
      if (res.status === 200 && res.body?.success) {
        navigate(`/ui/devices/${res.body.data.deviceId}`);
      } else {
        setCaptureLaunchError(res.body?.error || 'Failed to launch capture');
      }
    } catch {
      setCaptureLaunchError('Failed to launch capture');
    } finally {
      setCaptureLaunching(false);
    }
  }, [ws, versionId, captureLaunching, navigate]);

  const toggleSection = useCallback((section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  }, []);

  const saveNotes = useCallback(async () => {
    if (!versionId || notesSaving) return;
    setNotesSaving(true);
    try {
      const res = await ws.sendRestApi('PUT', `/v1/apps/analysis/${versionId}/notes`, { notes });
      if (res.status === 200 && res.body?.success) {
        setSavedNotes(notes);
        setNotesEditing(false);
        notesEditingRef.current = false;
        setNotesSaveFlash(true);
        setTimeout(() => setNotesSaveFlash(false), 1500);
      }
    } catch {
      // ignore
    } finally {
      setNotesSaving(false);
    }
  }, [ws, versionId, notes, notesSaving]);

  const cancelNotesEdit = useCallback(() => {
    setNotes(savedNotes);
    setNotesEditing(false);
    notesEditingRef.current = false;
  }, [savedNotes]);

  if (auth && !auth.hasScope('core.apk:read')) return <AccessDenied scope="core.apk:read" />;
  if (loading) return <LoadingSpinner large center />;

  const canManageApk = !auth || auth.hasScope('core.apk:manage');

  if (error) {
    return (
      <div data-testid="analysis-error" className="empty-state">
        <div className="empty-message">Analysis Error</div>
        <div className="empty-description">{error}</div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => navigate(-1)}>
          Go Back
        </button>
      </div>
    );
  }

  if (!overview) return null;

  const manifest = overview.manifest;
  const permissions: string[] = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const activities: string[] = Array.isArray(manifest.activities) ? manifest.activities : [];
  const services: string[] = Array.isArray(manifest.services) ? manifest.services : [];
  const receivers: string[] = Array.isArray(manifest.receivers) ? manifest.receivers : [];
  const providers: string[] = Array.isArray(manifest.providers) ? manifest.providers : [];
  const findingsTotal = Object.values(overview.findingCounts).reduce((a, b) => a + b, 0);

  return (
    <div data-testid="apk-analysis-page">
      <Breadcrumbs items={[
        { label: 'APKs', to: '/ui/apks' },
        { label: overview.appName || overview.packageName, to: `/ui/apps/${trackedAppId}` },
        { label: `v${overview.versionName || overview.versionCode}` },
      ]} />
      <PageHeader
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img
              src={`/v1/apps/icon/${overview.packageName}`}
              alt=""
              style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span>
              {overview.appName || overview.packageName}
              {overview.appName && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
                  {overview.packageName}
                </span>
              )}
              {availability && (
                <span style={{ marginLeft: 10, verticalAlign: 'middle' }} data-testid="availability-badge">
                  <AvailabilityBadge state={availability.state} />
                </span>
              )}
              {isLatest && (
                <span className="badge badge-running" data-testid="latest-badge" style={{ marginLeft: 8, verticalAlign: 'middle' }}>Latest</span>
              )}
              <button
                title="Copy package ID"
                style={{
                  marginLeft: 8,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  borderRadius: 4,
                  color: pkgIdCopied ? 'var(--accent)' : 'var(--text-muted)',
                  verticalAlign: 'middle',
                  lineHeight: 1,
                }}
                onClick={() => {
                  navigator.clipboard.writeText(overview.packageName).then(() => {
                    setPkgIdCopied(true);
                    setTimeout(() => setPkgIdCopied(false), 2000);
                  }).catch(() => {});
                }}
              >
                {pkgIdCopied ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
                    <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
                  </svg>
                )}
              </button>
            </span>
          </span>
        }
        subtitle={`v${overview.versionName || overview.versionCode} · code ${overview.versionCode} · ${formatBytes(overview.totalSize)}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" data-testid="capture-launch-btn" onClick={handleCaptureLaunch} disabled={captureLaunching}>
              {captureLaunching ? 'Starting...' : 'Capture on Device'}
            </button>
            <button className="btn" data-testid="ai-review-btn" onClick={handleAiReview} disabled={aiAgentStatus === 'running'}>
              AI Review
            </button>
            <ActionMenu
              label="More actions"
              items={[
                ...(canManageApk ? [{ key: 'reanalyze', label: 'Re-analyze', disabled: !!reanalyzing, onSelect: handleReanalyze }] : []),
                { key: 'download', label: 'Download APK', onSelect: () => { window.location.href = `/v1/apps/download/${versionId}`; } },
                { key: 'diff', label: 'Diff vs previous', onSelect: () => setActiveTab('diff') },
              ]}
            />
          </div>
        }
      />

      {reanalyzing && (
        <StatusStrip
          data-testid="reanalyze-strip"
          label={reanalyzing === 'pending' ? 'Re-analysis queued…' : `${STAGE_LABELS[reanalyzing] || reanalyzing}…`}
          progress={reanalyzingProgress}
        />
      )}
      {aiAgentStatus === 'running' && (
        <StatusStrip
          data-testid="ai-strip"
          label="AI Review running"
          progress={aiContextPercent}
          detail={aiTokenUsage ? `${formatTokenCount(aiTokenUsage.inputTokens)} in / ${formatTokenCount(aiTokenUsage.outputTokens)} out` : undefined}
        />
      )}
      {aiAgentStatus !== 'running' && aiTokenUsage && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }} data-testid="ai-last-run">
          Last AI review: {formatTokenCount(aiTokenUsage.inputTokens)} in / {formatTokenCount(aiTokenUsage.outputTokens)} out
        </div>
      )}

      {captureLaunchError && (
        <div
          data-testid="capture-launch-error"
          className="card"
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--status-error, #ef4444)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{captureLaunchError}</span>
          <button
            className="btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => setCaptureLaunchError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tab bar */}
      <Tabs
        items={TABS.map(tab => ({
          key: tab,
          label: TAB_LABELS[tab],
          count: tab === 'findings' && findingsTotal > 0 ? findingsTotal : undefined,
          dot: tab === 'notes' && savedNotes.length > 0,
        }))}
        active={activeTab}
        onChange={key => setActiveTab(key as Tab)}
      />

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div data-testid="tab-content-overview">
          {/* App info & stats cards */}
          <div className="card-grid" style={{ marginBottom: 16 }}>
            <div className="card stat-card" data-testid="stat-card">
              <div className="stat-value">{overview.fileCount}</div>
              <div className="stat-label">Files</div>
              <div className="stat-detail">
                {Object.entries(overview.sourceCounts).map(([source, count]) => (
                  <span key={source} style={{ marginRight: 8, fontSize: 11 }}>
                    {source}: {count}
                  </span>
                ))}
              </div>
            </div>
            <div className="card stat-card" data-testid="stat-card">
              <div className="stat-value">{formatBytes(overview.totalSize)}</div>
              <div className="stat-label">Total Size</div>
            </div>
            <div className="card stat-card" data-testid="stat-card">
              <div className="stat-value">{manifest.min_sdk ?? '—'}</div>
              <div className="stat-label">Min SDK</div>
            </div>
            <div className="card stat-card" data-testid="stat-card">
              <div className="stat-value">{manifest.target_sdk ?? '—'}</div>
              <div className="stat-label">Target SDK</div>
            </div>
          </div>

          {/* Frameworks / Libraries / Build Info */}
          {manifest.frameworks && (manifest.frameworks.detected?.length > 0 || manifest.frameworks.libraries?.length > 0 || (manifest.frameworks.buildInfo && (manifest.frameworks.buildInfo.compiler?.length > 0 || manifest.frameworks.buildInfo.packer?.length > 0 || manifest.frameworks.buildInfo.obfuscator?.length > 0 || manifest.frameworks.buildInfo.anti_analysis?.length > 0))) && (
            <div className="card" data-testid="frameworks-card" style={{ marginBottom: 16, padding: 12 }}>
              {/* Frameworks */}
              {manifest.frameworks.detected?.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
                    Frameworks ({manifest.frameworks.detected.length})
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {manifest.frameworks.detected.map((fw: any) => (
                      <span key={fw.name} className="badge badge-info" style={{ fontSize: 12 }}>{fw.name}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Libraries */}
              {manifest.frameworks.libraries?.length > 0 && (
                <div data-testid="libraries-section" style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
                    Libraries ({manifest.frameworks.libraries.length})
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {manifest.frameworks.libraries.map((lib: any) => (
                      <span key={lib.name} style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 10,
                        background: 'var(--accent-bg, rgba(13, 110, 253, 0.1))',
                        color: 'var(--accent, #0d6efd)',
                        border: '1px solid var(--accent-border, rgba(13, 110, 253, 0.25))',
                      }}>{lib.name}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Build Info */}
              {manifest.frameworks.buildInfo && (() => {
                const bi = manifest.frameworks.buildInfo;
                const items: { label: string; values: string[]; color: string }[] = [];
                if (bi.compiler?.length) items.push({ label: 'Compiler', values: bi.compiler, color: '#198754' });
                if (bi.packer?.length) items.push({ label: 'Packer', values: bi.packer, color: '#fd7e14' });
                if (bi.obfuscator?.length) items.push({ label: 'Obfuscator', values: bi.obfuscator, color: '#dc3545' });
                if (bi.anti_analysis?.length) items.push({ label: 'Anti-Analysis', values: bi.anti_analysis, color: '#6f42c1' });
                if (items.length === 0) return null;
                return (
                  <div data-testid="build-info-section">
                    <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Build Info</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {items.map(item => item.values.map(v => (
                        <span key={`${item.label}-${v}`} style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 10,
                          background: `${item.color}15`, color: item.color,
                          border: `1px solid ${item.color}40`,
                        }}>{v}</span>
                      )))}
                    </div>
                  </div>
                );
              })()}

              {/* Flutter analysis result */}
              {manifest.frameworks.flutterAnalysis && (() => {
                const fa = manifest.frameworks.flutterAnalysis;
                if (fa.error) {
                  return (
                    <div data-testid="flutter-analysis-error" style={{ fontSize: 12, color: '#dc3545', marginTop: 8 }}>
                      Flutter decompile error: {fa.error}
                    </div>
                  );
                }
                const tool = fa.blutter?.success ? 'blutter' : fa.stringsFallback ? 'string extraction' : 'blutter';
                const failReason = !fa.dumpGenerated
                  ? (fa.blutter?.error || 'No tool available')
                  : null;
                return (
                  <div data-testid="flutter-analysis" style={{ marginTop: 8, fontSize: 12 }}>
                    {fa.dumpGenerated ? (
                      <span style={{ color: '#198754' }}>
                        Flutter dump generated via {tool}{fa.arch ? ` (${fa.arch})` : ''} — dump.dart available in Code tab
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>
                        Flutter dump not generated{failReason ? `: ${failReason}` : ''}
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Backward compat: Hermes error/note messages */}
              {manifest.frameworks.hermesError && (
                <div data-testid="hermes-error" style={{ fontSize: 12, color: '#dc3545', marginTop: 8 }}>
                  Hermes decompile error: {manifest.frameworks.hermesError}
                </div>
              )}
              {manifest.frameworks.hermesNote && (
                <div data-testid="hermes-note" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  {manifest.frameworks.hermesNote}
                </div>
              )}
            </div>
          )}

          {/* Analysis Timing */}
          {manifest.stage_timings && (() => {
            let timings: Record<string, { start: number; end: number }>;
            try { timings = typeof manifest.stage_timings === 'string' ? JSON.parse(manifest.stage_timings) : manifest.stage_timings; } catch { return null; }
            const totalMs = manifest.total_duration_ms ? Number(manifest.total_duration_ms) : null;
            return (
              <div className="card" data-testid="analysis-timing" style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Analysis Timing</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {Object.entries(timings).map(([stage, t]) => (
                      <tr key={stage}>
                        <td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>
                          {STAGE_LABELS[stage] || stage}
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                          {formatDuration(t.end - t.start)}
                        </td>
                      </tr>
                    ))}
                    {totalMs != null && (
                      <tr style={{ borderTop: '1px solid var(--border-color)', fontWeight: 600 }}>
                        <td style={{ padding: '6px 8px 4px' }}>Total</td>
                        <td style={{ padding: '6px 8px 4px', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                          {formatDuration(totalMs)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {/* Security findings summary */}
          <div className="card" data-testid="findings-summary" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Security Findings</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {SEVERITY_ORDER.map(severity => {
                const count = overview.findingCounts[severity] || 0;
                return (
                  <button
                    key={severity}
                    data-testid={`severity-${severity}`}
                    onClick={() => { if (count > 0) { setSeverityDeepLink(severity); setActiveTab('findings'); } }}
                    disabled={count === 0}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 12px', borderRadius: 6,
                      background: count > 0 ? `${SEVERITY_COLORS[severity]}15` : 'var(--bg-tertiary)',
                      border: `1px solid ${count > 0 ? `${SEVERITY_COLORS[severity]}40` : 'var(--border-color)'}`,
                      cursor: count > 0 ? 'pointer' : 'default',
                    }}
                  >
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 24, height: 24, borderRadius: '50%',
                      background: count > 0 ? SEVERITY_COLORS[severity] : 'var(--text-muted)',
                      color: '#fff', fontSize: 12, fontWeight: 700,
                    }}>
                      {count}
                    </span>
                    <span style={{
                      fontSize: 12, fontWeight: 500, textTransform: 'capitalize',
                      color: count > 0 ? SEVERITY_COLORS[severity] : 'var(--text-muted)',
                    }}>
                      {severity}
                    </span>
                    {count > 0 && <span aria-hidden="true" style={{ color: SEVERITY_COLORS[severity] }}>→</span>}
                  </button>
                );
              })}
            </div>
            {Object.keys(overview.findingsByCategory).length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(overview.findingsByCategory).map(([category, count]) => (
                  <span key={category} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10,
                    background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                  }}>
                    {category}: {count}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Permissions */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
              Permissions ({permissions.length})
            </h3>
            {(() => {
              const groups: Record<'dangerous' | 'normal' | 'other', string[]> = { dangerous: [], normal: [], other: [] };
              for (const p of permissions) groups[permissionGroup(p)].push(p);
              const q = permFilter.toLowerCase();
              const labelFor = { dangerous: 'Dangerous', normal: 'Normal', other: 'Other' } as const;
              return (
                <>
                  <SearchInput value={permFilter} onChange={setPermFilter} placeholder="Filter permissions…" data-testid="permission-filter" />
                  {(['dangerous', 'normal', 'other'] as const).map(g => {
                    const all = groups[g];
                    const matching = q ? all.filter(p => p.toLowerCase().includes(q)) : all;
                    if (all.length === 0 || matching.length === 0) return null;
                    return (
                      <div key={g} style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: g === 'dangerous' ? 'var(--danger)' : 'var(--text-secondary)' }}>
                          {labelFor[g]} ({all.length})
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {matching.map(perm => (
                            <div key={perm} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', padding: '4px 8px', borderRadius: 4, background: 'var(--bg-tertiary)' }}>{perm}</div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {permissions.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No permissions declared</div>}
                </>
              );
            })()}
          </div>

          {/* Manifest components */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Manifest Components</h3>
            {renderComponentSection('activities', 'Activities', activities)}
            {renderComponentSection('services', 'Services', services)}
            {renderComponentSection('receivers', 'Receivers', receivers)}
            {renderComponentSection('providers', 'Providers', providers)}
          </div>
        </div>
      )}

      {/* Code tab uses display:none to keep Monaco editor alive across tab switches */}
      <div data-testid="tab-content-code" style={{ display: activeTab === 'code' ? undefined : 'none' }}>
        {availability && availability.state !== 'local' ? (
          <NonLocalEmptyState
            state={availability.state}
            source={versionSource}
            onRestore={handleRestore}
          />
        ) : versionId ? (
          <CodeBrowser versionId={versionId} navigateTo={navigateTo} />
        ) : (
          <div className="empty-state">
            <div className="empty-message">Code Browser</div>
            <div className="empty-description">No version selected.</div>
          </div>
        )}
      </div>

      {activeTab === 'assets' && (
        <div data-testid="tab-content-assets">
          {availability && availability.state !== 'local' ? (
            <NonLocalEmptyState
              state={availability.state}
              source={versionSource}
              onRestore={handleRestore}
            />
          ) : versionId ? (
            <AssetsBrowser versionId={versionId} />
          ) : (
            <div className="empty-state">
              <div className="empty-message">Assets Browser</div>
              <div className="empty-description">No version selected.</div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'findings' && (
        <div data-testid="tab-content-findings">
          {versionId ? (
            <FindingsTable
              versionId={versionId}
              onNavigate={(filePath, lineNumber, source) => {
                setNavigateTo({ filePath, lineNumber, source });
                setActiveTab('code');
              }}
              excludedPaths={excludedPaths}
              showLibrary={showLibrary}
              onToggleLibrary={excludedPaths.length > 0 ? () => setShowLibrary(p => !p) : undefined}
              initialSeverity={severityDeepLink}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-message">Security Findings</div>
              <div className="empty-description">No version selected.</div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'strings' && (
        <div data-testid="tab-content-strings">
          {availability && availability.state !== 'local' ? (
            <NonLocalEmptyState
              state={availability.state}
              source={versionSource}
              onRestore={handleRestore}
            />
          ) : versionId ? (
            <StringsView
              versionId={versionId}
              onNavigate={(filePath, lineNumber, source) => {
                setNavigateTo({ filePath, lineNumber, source });
                setActiveTab('code');
              }}
              excludedPaths={excludedPaths}
              showLibrary={showLibrary}
              onToggleLibrary={excludedPaths.length > 0 ? () => setShowLibrary(p => !p) : undefined}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-message">Strings & URLs</div>
              <div className="empty-description">No version selected.</div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'reactnative' && overview && (
        availability && availability.state !== 'local' ? (
          <NonLocalEmptyState
            state={availability.state}
            source={versionSource}
            onRestore={handleRestore}
          />
        ) : (
          <ReactNativeTab
            versionId={versionId!}
            manifest={overview.manifest}
            sourceCounts={overview.sourceCounts}
            onNavigate={(filePath, lineNumber, source) => {
              setNavigateTo({ filePath, lineNumber, source });
              setActiveTab('code');
            }}
          />
        )
      )}

      {activeTab === 'diff' && (
        <div data-testid="tab-content-diff">
          {renderDiffTab()}
        </div>
      )}

      {activeTab === 'notes' && (
        <div data-testid="tab-content-notes">
          {notesLoading ? (
            <LoadingSpinner />
          ) : notesEditing ? (
            /* Edit mode: side-by-side editor + preview */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  data-testid="save-notes-btn"
                  className={`btn btn-primary${notesSaveFlash ? ' save-flash' : ''}`}
                  disabled={notes === savedNotes || notesSaving}
                  onClick={saveNotes}
                >
                  {notesSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  data-testid="cancel-notes-btn"
                  className="btn"
                  onClick={cancelNotesEdit}
                >
                  Cancel
                </button>
                {notes !== savedNotes && (
                  <span data-testid="unsaved-indicator" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Unsaved changes</span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, minHeight: 400 }}>
                <textarea
                  data-testid="notes-textarea"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Write analysis notes here... (Markdown supported)"
                  style={{
                    width: '100%',
                    height: '100%',
                    minHeight: 400,
                    padding: 12,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    lineHeight: 1.5,
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    resize: 'vertical',
                  }}
                />
                <div
                  data-testid="notes-preview"
                  className="notes-markdown-preview"
                  style={{
                    padding: 16,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    overflowY: 'auto',
                    minHeight: 400,
                  }}
                >
                  {notes ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {notes}
                    </ReactMarkdown>
                  ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Preview will appear here...</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* View mode: rendered markdown */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <button
                  data-testid="edit-notes-btn"
                  className="btn"
                  onClick={() => { setNotesEditing(true); notesEditingRef.current = true; }}
                >
                  Edit
                </button>
              </div>
              {savedNotes ? (
                <div
                  data-testid="notes-rendered"
                  className="notes-markdown-preview"
                  style={{
                    padding: 16,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    minHeight: 200,
                  }}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {savedNotes}
                  </ReactMarkdown>
                </div>
              ) : (
                <div data-testid="notes-empty" className="empty-state">
                  <div className="empty-message">No notes yet</div>
                  <div className="empty-description">Click Edit to start writing.</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  function renderDiffTab() {
    if (diffLoading || diffReport === undefined) return <LoadingSpinner />;

    const bothLocal = availability?.state === 'local' && oldAvail?.state === 'local';
    const notLocalTitle = !bothLocal
      ? 'Restore both versions to local before running a new diff'
      : undefined;
    const canRun = !diffRunning && bothLocal;

    const rerunBtn = diffReport && (
      <button
        className="btn btn-sm"
        disabled={!canRun}
        onClick={handleRunDiff}
        title={diffRunning ? undefined : notLocalTitle}
        style={{ fontSize: 12 }}
      >
        {diffRunning ? 'Running...' : 'Rerun Diff Analysis'}
      </button>
    );

    if (!diffReport) {
      // No report yet — only the new version's availability is known; disable if not local
      const newVersionLocal = availability?.state === 'local';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
          <div className="empty-state">
            <div className="empty-message">No diff report yet</div>
            <div className="empty-description">A diff will be generated automatically when a new APK version is analyzed.</div>
          </div>
          <button
            className="btn"
            disabled={diffRunning || !newVersionLocal}
            onClick={handleRunDiff}
            title={!newVersionLocal ? 'Restore this version to local before running a diff' : undefined}
          >
            {diffRunning ? 'Running...' : 'Run Diff Analysis'}
          </button>
        </div>
      );
    }

    const { status, diffResult, aiSummary, error: diffError, compareVersionId } = diffReport;

    if (status === 'skipped') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="diff-blocked" style={{ padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 13 }}>
            <p style={{ marginTop: 0, marginBottom: 8 }}><strong>Diff skipped.</strong> {diffError}</p>
            {oldAvail && oldAvail.state !== 'local' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span>Old version:</span>
                <AvailabilityBadge state={oldAvail.state} />
                <RestoreButton
                  packageName={overview!.packageName}
                  versionId={compareVersionId}
                  label="Restore old version"
                  onComplete={refreshDiff}
                />
              </div>
            )}
            {availability && availability.state !== 'local' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>New version:</span>
                <AvailabilityBadge state={availability.state} />
                <RestoreButton
                  packageName={overview!.packageName}
                  versionId={Number(versionId)}
                  label="Restore new version"
                  onComplete={refreshDiff}
                />
              </div>
            )}
          </div>
          {rerunBtn}
        </div>
      );
    }

    if (status === 'failed') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 13 }}>
            Diff analysis failed: {diffError || 'Unknown error'}
          </div>
          {rerunBtn}
        </div>
      );
    }

    if (status === 'in_progress' && !diffResult) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
            <LoadingSpinner />
            <span>Computing diff...</span>
          </div>
        </div>
      );
    }

    const chipStyle = (added: boolean): React.CSSProperties => ({
      display: 'inline-block', padding: '1px 8px', borderRadius: 12, fontSize: 11, fontFamily: 'var(--font-mono)',
      background: added ? 'rgba(25,135,84,0.15)' : 'rgba(220,53,69,0.15)',
      color: added ? '#198754' : '#dc3545',
      border: `1px solid ${added ? 'rgba(25,135,84,0.3)' : 'rgba(220,53,69,0.3)'}`,
    });

    const sectionStyle: React.CSSProperties = {
      marginBottom: 20, padding: 16,
      background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8,
    };
    const sectionTitle: React.CSSProperties = {
      fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)',
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          {rerunBtn}
          {diffRunning && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <LoadingSpinner /> AI summary running...
            </span>
          )}
          {compareVersionId && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              Comparing against version {diffResult?.oldVersionName ?? `#${compareVersionId}`}
            </span>
          )}
        </div>

        {/* AI Summary */}
        {aiSummary && (
          <div style={sectionStyle}>
            <div style={sectionTitle}>AI Summary</div>
            <div className="notes-markdown-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {aiSummary}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {!aiSummary && status === 'completed' && (
          <div style={{ ...sectionStyle, color: 'var(--text-muted)', fontSize: 12 }}>
            AI summary not yet available. {diffRunning ? 'Running...' : 'Rerun to generate.'}
          </div>
        )}

        {diffResult && (
          <>
            {/* Overview */}
            <div style={sectionStyle}>
              <div style={sectionTitle}>Version Overview</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                {[
                  ['Previous', diffResult.oldVersionName ?? '—'],
                  ['New', diffResult.newVersionName ?? '—'],
                  ['APK Size', diffResult.newFileSize != null && diffResult.oldFileSize != null
                    ? (() => { const d = (diffResult.newFileSize! - diffResult.oldFileSize!) / 1024; return `${d > 0 ? '+' : ''}${Math.round(d)} KB`; })()
                    : '—'],
                  ['Min SDK', diffResult.minSdk.old !== diffResult.minSdk.new
                    ? `${diffResult.minSdk.old ?? '?'} → ${diffResult.minSdk.new ?? '?'}`
                    : String(diffResult.minSdk.new ?? '—')],
                  ['Target SDK', diffResult.targetSdk.old !== diffResult.targetSdk.new
                    ? `${diffResult.targetSdk.old ?? '?'} → ${diffResult.targetSdk.new ?? '?'}`
                    : String(diffResult.targetSdk.new ?? '—')],
                ].map(([label, value]) => (
                  <div key={label} style={{ padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{value}</div>
                  </div>
                ))}
              </div>
              {diffResult.frameworkChanges && (
                <div style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(13,110,253,0.08)', borderRadius: 6, fontSize: 12, color: 'var(--text-primary)' }}>
                  Framework: {diffResult.frameworkChanges}
                </div>
              )}
            </div>

            {/* Permissions */}
            {(diffResult.permissions.added.length > 0 || diffResult.permissions.removed.length > 0) && (
              <div style={sectionStyle}>
                <div style={sectionTitle}>
                  Permissions
                  <span style={{ fontWeight: 400, fontSize: 12, marginLeft: 8, color: 'var(--text-muted)' }}>
                    {diffResult.permissions.added.length > 0 && `+${diffResult.permissions.added.length} added`}
                    {diffResult.permissions.added.length > 0 && diffResult.permissions.removed.length > 0 && ' · '}
                    {diffResult.permissions.removed.length > 0 && `-${diffResult.permissions.removed.length} removed`}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {diffResult.permissions.added.map(p => <span key={`+${p}`} style={chipStyle(true)}>+{p}</span>)}
                  {diffResult.permissions.removed.map(p => <span key={`-${p}`} style={chipStyle(false)}>−{p}</span>)}
                </div>
              </div>
            )}

            {/* Security Findings */}
            <div style={sectionStyle}>
              <div style={sectionTitle}>Security Findings</div>
              <div style={{ display: 'flex', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>
                  <span style={{ color: '#dc3545', fontWeight: 600 }}>+{diffResult.findings.newCount}</span> new
                </span>
                <span style={{ fontSize: 13 }}>
                  <span style={{ color: '#198754', fontWeight: 600 }}>−{diffResult.findings.resolvedCount}</span> resolved
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {diffResult.findings.persistentCount} persistent
                </span>
              </div>
              {diffResult.findings.bySeverity.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {diffResult.findings.bySeverity.map(s => (
                    <div key={s.severity} style={{ fontSize: 12, padding: '3px 8px', borderRadius: 4, background: 'var(--bg-secondary)', display: 'flex', gap: 6 }}>
                      <span style={{ color: SEVERITY_COLORS[s.severity] ?? 'var(--text-muted)', textTransform: 'capitalize' }}>{s.severity}</span>
                      {s.newCount > 0 && <span style={{ color: '#dc3545' }}>+{s.newCount}</span>}
                      {s.resolvedCount > 0 && <span style={{ color: '#198754' }}>−{s.resolvedCount}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Libraries */}
            {(diffResult.libraries.added.length > 0 || diffResult.libraries.removed.length > 0) && (
              <div style={sectionStyle}>
                <div style={sectionTitle}>
                  Libraries
                  <span style={{ fontWeight: 400, fontSize: 12, marginLeft: 8, color: 'var(--text-muted)' }}>
                    {diffResult.libraries.added.length > 0 && `+${diffResult.libraries.added.length} added`}
                    {diffResult.libraries.added.length > 0 && diffResult.libraries.removed.length > 0 && ' · '}
                    {diffResult.libraries.removed.length > 0 && `-${diffResult.libraries.removed.length} removed`}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {diffResult.libraries.added.map(l => <span key={`+${l}`} style={chipStyle(true)}>+{l}</span>)}
                  {diffResult.libraries.removed.map(l => <span key={`-${l}`} style={chipStyle(false)}>−{l}</span>)}
                </div>
              </div>
            )}

            {/* Manifest Changes */}
            {(['activities', 'services', 'receivers', 'providers'] as const).some(k =>
              diffResult[k].added.length > 0 || diffResult[k].removed.length > 0
            ) && (
              <div style={sectionStyle}>
                <div style={sectionTitle}>Manifest Changes</div>
                {(['activities', 'services', 'receivers', 'providers'] as const).map(key => {
                  const diff = diffResult[key];
                  if (diff.added.length === 0 && diff.removed.length === 0) return null;
                  const label = key.charAt(0).toUpperCase() + key.slice(1);
                  return (
                    <div key={key} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                        {diff.added.map(s => <span key={`+${s}`} style={chipStyle(true)}>+{s.split('.').pop()}</span>)}
                        {diff.removed.map(s => <span key={`-${s}`} style={chipStyle(false)}>−{s.split('.').pop()}</span>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* File Stats */}
            <div style={sectionStyle}>
              <div style={sectionTitle}>Source File Changes</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
                <span><span style={{ color: '#198754', fontWeight: 600 }}>+{diffResult.files.added}</span> added</span>
                <span><span style={{ color: '#dc3545', fontWeight: 600 }}>−{diffResult.files.removed}</span> removed</span>
                {diffResult.files.modified !== null && (
                  <span><span style={{ color: '#fd7e14', fontWeight: 600 }}>~{diffResult.files.modified}</span> modified</span>
                )}
                <span style={{ color: 'var(--text-muted)' }}>{diffResult.files.totalNew} total files</span>
              </div>
              {!diffResult.files.hasContentHash && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  Modified count unavailable — re-analyze both versions to enable.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  function renderComponentSection(key: string, label: string, items: string[]) {
    const expanded = expandedSections[key];
    return (
      <div data-testid={`manifest-${key}`} style={{ marginBottom: 8 }}>
        <button
          onClick={() => toggleSection(key)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%',
            padding: '6px 0', border: 'none', background: 'none', cursor: 'pointer',
            color: 'var(--text-primary)', fontSize: 13, fontWeight: 500, textAlign: 'left',
          }}
        >
          <span style={{
            display: 'inline-block', fontSize: 10, transition: 'transform 0.15s',
            transform: expanded ? 'rotate(90deg)' : undefined,
          }}>
            &#9654;
          </span>
          {label}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
            ({items.length})
          </span>
        </button>
        {expanded && items.length > 0 && (
          <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {items.map(item => (
              <div key={item} style={{
                fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
                padding: '2px 0',
              }} title={item}>
                {item}
              </div>
            ))}
          </div>
        )}
        {expanded && items.length === 0 && (
          <div style={{ paddingLeft: 20, fontSize: 12, color: 'var(--text-muted)' }}>
            None declared
          </div>
        )}
      </div>
    );
  }
}
