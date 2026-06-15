import React, { useEffect, useState, useCallback } from 'react';
import { Smartphone } from 'lucide-react';
import { Modal, useWebSocket, useToast } from '@darkrideapp/plugin-sdk/react';

export interface OnlineDevice { id: string; name: string | null; lastSeen: string | null; }
interface DeviceInstalledInfo { installed: boolean; versionCode: number | null; versionName: string | null; }

interface InstallDeviceModalProps {
  versionId: number;
  packageName: string;
  versionName: string | null;
  versionCode: number;
  devices: OnlineDevice[];
  onClose: () => void;
}

/** Device picker for installing a stored APK, with installed-version comparison. */
export function InstallDeviceModal({ versionId, packageName, versionName, versionCode, devices, onClose }: InstallDeviceModalProps) {
  const ws = useWebSocket();
  const toast = useToast();
  const [deviceVersions, setDeviceVersions] = useState<Record<string, DeviceInstalledInfo>>({});
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    for (const d of devices) {
      ws.sendRestApi('GET', `/v1/device/package-version/${encodeURIComponent(d.id)}/${encodeURIComponent(packageName)}`).then(res => {
        if (res.body?.success) setDeviceVersions(prev => ({ ...prev, [d.id]: res.body.data }));
      }).catch(() => {});
    }
  }, [ws, devices, packageName]);

  const install = useCallback(async (deviceId: string) => {
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await ws.sendRestApi('POST', `/v1/apps/install/${encodeURIComponent(deviceId)}`, { apkVersionId: versionId });
      if (res.status !== 200 || !res.body?.success) {
        const msg = res.body?.error || 'Install failed';
        setInstallError(msg);
        toast.error(msg);
        return;
      }
      toast.success('APK installed successfully');
      onClose();
    } catch (err: any) {
      const msg = err?.message || 'Install failed';
      setInstallError(msg);
      toast.error(msg);
    } finally {
      setInstalling(false);
    }
  }, [ws, versionId, toast, onClose]);

  return (
    <Modal title="Install APK" onClose={onClose}>
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        Installing <strong>{packageName}</strong> v{versionName || versionCode}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {devices.map(d => {
          const info = deviceVersions[d.id];
          return (
            <button
              key={d.id}
              className="btn"
              onClick={() => install(d.id)}
              disabled={installing}
              data-testid={`install-device-${d.id}`}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', textAlign: 'left', width: '100%' }}
            >
              <Smartphone size={18} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{d.name || d.id}</div>
                {d.name && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{d.id}</div>}
              </div>
              <div style={{ flexShrink: 0, textAlign: 'right', fontSize: 12 }}>
                {!info ? (
                  <span style={{ color: 'var(--text-muted)' }}>Checking...</span>
                ) : !info.installed ? (
                  <span style={{ color: 'var(--text-muted)' }}>Not installed</span>
                ) : (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Installed: v{info.versionName || info.versionCode}
                    {info.versionCode !== null && info.versionCode < versionCode && <span style={{ color: 'var(--accent)', marginLeft: 4 }}>&#x2191; upgrade</span>}
                    {info.versionCode !== null && info.versionCode > versionCode && <span style={{ color: 'var(--warning, orange)', marginLeft: 4 }}>&#x2193; downgrade</span>}
                    {info.versionCode !== null && info.versionCode === versionCode && <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>(same)</span>}
                  </span>
                )}
              </div>
            </button>
          );
        })}
        {devices.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No devices online</div>
        )}
        {installError && (
          <div className="status-strip status-strip-error" data-testid="install-error" style={{ marginBottom: 0 }}>
            <span className="status-strip-label">{installError}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
