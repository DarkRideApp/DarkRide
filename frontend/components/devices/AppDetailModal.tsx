import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket, useToast } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';

/** Known installer packages → friendly labels for the install-source UI. */
const KNOWN_INSTALLERS: Array<{ value: string; label: string }> = [
  { value: 'com.android.vending', label: 'Play Store' },
  { value: 'com.amazon.venezia', label: 'Amazon Appstore' },
  { value: 'com.sec.android.app.samsungapps', label: 'Galaxy Store' },
  { value: 'org.fdroid.fdroid', label: 'F-Droid' },
];

const CUSTOM_OPTION = '__custom__';

/** Map an installer package to a friendly label, falling back to the raw value. */
function installerLabel(pkg: string | null): string {
  if (!pkg) return 'None / sideloaded';
  return KNOWN_INSTALLERS.find(i => i.value === pkg)?.label ?? pkg;
}

export interface InstalledApp {
  packageName: string;
  appName: string | null;
  versionCode: number | null;
  versionName: string | null;
  isTracked: boolean;
  trackedAppId: number | null;
}

interface AppDetailModalProps {
  deviceId: string;
  app: InstalledApp;
  onClose: () => void;
  onAppUpdated: (updatedApp: InstalledApp) => void;
}

export function AppDetailModal({ deviceId, app, onClose, onAppUpdated }: AppDetailModalProps) {
  const ws = useWebSocket();
  const toast = useToast();
  const [current, setCurrent] = useState<InstalledApp>(app);
  const [pullingApk, setPullingApk] = useState(false);
  const [togglingTrack, setTogglingTrack] = useState(false);
  const [copied, setCopied] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  // Install source (OS-recorded installer package).
  const [installSource, setInstallSource] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(true);
  const [selected, setSelected] = useState<string>(KNOWN_INSTALLERS[0].value);
  const [customValue, setCustomValue] = useState('');
  const [applying, setApplying] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  // Load the current install source on mount (and when the target app changes).
  useEffect(() => {
    let cancelled = false;
    setLoadingSource(true);
    (async () => {
      try {
        const res = await ws.sendRestApi(
          'GET',
          `/v1/device/apps/${encodeURIComponent(deviceId)}/install-source/${encodeURIComponent(app.packageName)}`,
        );
        if (cancelled) return;
        if (res.body?.success) {
          const value: string | null = res.body.data?.installerPackageName ?? null;
          setInstallSource(value);
          // Preselect the matching preset when the current installer is known.
          if (value && KNOWN_INSTALLERS.some(i => i.value === value)) {
            setSelected(value);
          }
        }
      } catch {
        // Leave installSource null; the row still renders "None / sideloaded".
      } finally {
        if (!cancelled) setLoadingSource(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ws, deviceId, app.packageName]);

  const handleApplyInstallSource = useCallback(async () => {
    if (applying) return;
    const installer = (selected === CUSTOM_OPTION ? customValue : selected).trim();
    // Require a non-empty value that looks like a package name (must contain a dot).
    if (!installer || !installer.includes('.')) {
      setSourceError('Enter a valid installer package name');
      return;
    }
    setSourceError(null);
    setApplying(true);
    try {
      const res = await ws.sendRestApi(
        'PUT',
        `/v1/device/apps/${encodeURIComponent(deviceId)}/install-source/${encodeURIComponent(current.packageName)}`,
        { installer },
      );
      if (res.body?.success) {
        const value: string | null = res.body.data?.installerPackageName ?? installer;
        setInstallSource(value);
        toast.success(`Install source set to ${installerLabel(value)}`);
      } else {
        const msg = res.body?.error || 'Failed to set install source';
        setSourceError(msg);
        toast.error(msg);
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to set install source';
      setSourceError(msg);
      toast.error(msg);
    } finally {
      setApplying(false);
    }
  }, [ws, deviceId, current.packageName, selected, customValue, applying, toast]);

  // Keep parent in sync whenever current changes
  useEffect(() => {
    onAppUpdated(current);
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(current.packageName).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [current.packageName]);

  const handlePullApk = useCallback(async () => {
    if (pullingApk) return;
    setPullingApk(true);
    try {
      const res = await ws.sendRestApi('POST', `/v1/device/pull-apk/${encodeURIComponent(deviceId)}`, {
        packageName: current.packageName,
      });
      if (res.body?.success) {
        const updated: InstalledApp = { ...current, isTracked: true, trackedAppId: res.body.data.trackedAppId };
        setCurrent(updated);
      }
    } catch {
      // ignore
    } finally {
      setPullingApk(false);
    }
  }, [ws, deviceId, current, pullingApk]);

  const handleToggleTrack = useCallback(async () => {
    if (togglingTrack) return;
    setTogglingTrack(true);
    try {
      if (current.isTracked && current.trackedAppId) {
        await ws.sendRestApi('DELETE', `/v1/apps/track/${current.trackedAppId}`);
        setCurrent(prev => ({ ...prev, isTracked: false, trackedAppId: null }));
      } else {
        const res = await ws.sendRestApi('POST', '/v1/apps/track', {
          packageName: current.packageName,
          appName: current.appName,
        });
        if (res.body?.success) {
          setCurrent(prev => ({ ...prev, isTracked: true, trackedAppId: res.body.data.id }));
        }
      }
    } catch {
      // ignore
    } finally {
      setTogglingTrack(false);
    }
  }, [ws, current, togglingTrack]);

  return (
    <Modal title={current.appName || current.packageName} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Icon + identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 96,
            height: 96,
            flexShrink: 0,
            borderRadius: 18,
            overflow: 'hidden',
            background: 'var(--bg-secondary, #1e1e2e)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 40,
          }}>
            {iconFailed ? (
              <span style={{ opacity: 0.3 }}>?</span>
            ) : (
              <img
                src={`/v1/apps/icon/${encodeURIComponent(current.packageName)}`}
                alt=""
                style={{ width: 96, height: 96 }}
                onError={() => setIconFailed(true)}
              />
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 4 }}>
              {current.appName || current.packageName}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', wordBreak: 'break-all' }}>
              {current.packageName}
            </div>
          </div>
        </div>

        {/* Metadata rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {current.versionName && (
            <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted, #888)', minWidth: 100 }}>Version</span>
              <span>{current.versionName}{current.versionCode ? ` (${current.versionCode})` : ''}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
            <span style={{ color: 'var(--text-muted, #888)', minWidth: 100 }}>Tracked</span>
            <span>
              {current.isTracked ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  color: 'var(--color-success, #22c55e)',
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: 'var(--color-success, #22c55e)',
                    display: 'inline-block',
                  }} />
                  Yes
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted, #888)' }}>No</span>
              )}
            </span>
          </div>
        </div>

        {/* Install source (OS-recorded installer package) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
            <span style={{ color: 'var(--text-muted, #888)', minWidth: 100 }}>Install source</span>
            <span data-testid="app-detail-install-source-current">
              {loadingSource ? (
                <span style={{ color: 'var(--text-muted, #888)' }}>Loading…</span>
              ) : (
                installerLabel(installSource)
              )}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="input"
              data-testid="app-detail-install-source-select"
              value={selected}
              onChange={(e) => { setSelected(e.target.value); setSourceError(null); }}
              disabled={applying || loadingSource}
              style={{ maxWidth: 200 }}
            >
              {KNOWN_INSTALLERS.map(i => (
                <option key={i.value} value={i.value}>{i.label}</option>
              ))}
              <option value={CUSTOM_OPTION}>Custom…</option>
            </select>

            {selected === CUSTOM_OPTION && (
              <input
                className="input"
                type="text"
                data-testid="app-detail-install-source-custom-input"
                placeholder="com.example.installer"
                value={customValue}
                onChange={(e) => { setCustomValue(e.target.value); setSourceError(null); }}
                disabled={applying}
                style={{ maxWidth: 220 }}
              />
            )}

            <button
              className="btn btn-secondary"
              onClick={handleApplyInstallSource}
              disabled={applying || loadingSource}
              data-testid="app-detail-install-source-apply"
            >
              {applying ? 'Applying…' : 'Apply'}
            </button>
          </div>

          {sourceError && (
            <div
              data-testid="app-detail-install-source-error"
              style={{ fontSize: 12, color: 'var(--color-error, #ef4444)', wordBreak: 'break-word' }}
            >
              {sourceError}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary"
            onClick={handleCopy}
            data-testid="app-detail-copy"
          >
            {copied ? 'Copied!' : 'Copy Package Name'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handlePullApk}
            disabled={pullingApk}
            data-testid="app-detail-pull-apk"
          >
            {pullingApk ? 'Pulling APK...' : 'Pull APK'}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleToggleTrack}
            disabled={togglingTrack}
            data-testid="app-detail-track"
            style={current.isTracked ? {
              background: 'var(--color-success, #22c55e)',
              borderColor: 'var(--color-success, #22c55e)',
              color: '#fff',
            } : undefined}
          >
            {togglingTrack ? '...' : current.isTracked ? 'Untrack' : 'Track'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
