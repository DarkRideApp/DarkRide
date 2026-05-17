import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';

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
  const [current, setCurrent] = useState<InstalledApp>(app);
  const [pullingApk, setPullingApk] = useState(false);
  const [togglingTrack, setTogglingTrack] = useState(false);
  const [copied, setCopied] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

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
