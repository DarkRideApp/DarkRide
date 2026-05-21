import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { SkeletonCard } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Smartphone, Apple, RefreshCw } from 'lucide-react';
import { CURRENT_SETUP_VERSION } from '../../shared/types/api';
import type { Device } from '../../shared/types/api';
import { SetupWizardModal } from '../components/devices/SetupWizardModal';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

function isOnline(device: Device): boolean {
  if (!device.lastSeen) return false;
  return Date.now() - new Date(device.lastSeen).getTime() < 120000;
}

function batteryColorClass(level: number | null | undefined): string {
  if (level == null) return '';
  if (level >= 50) return 'battery-good';
  if (level >= 20) return 'battery-warn';
  return 'battery-low';
}

export function Devices() {
  useDocumentTitle('Devices');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupDevice, setSetupDevice] = useState<Device | null>(null);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/device/list');
      setDevices(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) fetchDevices();
  }, [ws.connected, fetchDevices]);

  if (auth && !auth.hasScope('core.devices:read')) return <AccessDenied scope="core.devices:read" />;

  const handleSetupComplete = () => {
    setSetupDevice(null);
    fetchDevices();
  };

  if (loading) return <div className="skeleton-grid"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>;

  const onlineCount = devices.filter(isOnline).length;
  const offlineCount = devices.length - onlineCount;

  return (
    <div data-testid="devices-page">
      <PageHeader
        title="Devices"
        subtitle={`${onlineCount} online · ${offlineCount} offline`}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => fetchDevices()}>
              <RefreshCw size={14} style={{ marginRight: 6 }} />
              Sync All
            </button>
          </div>
        }
      />
      {devices.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon" aria-hidden><Smartphone size={32} /></div>
          <div>No devices connected</div>
          <div style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
            Connect an Android device via USB and enable USB debugging, or pair an iOS device to get started.
          </div>
        </div>
      ) : (
        <div className="card-grid">
          {devices.map(device => {
            const online = isOnline(device);
            return (
              <div
                key={device.id}
                className={`card device-card${online ? ' device-card-online' : ' device-card-offline'}`}
                onClick={() => navigate(`/ui/devices/${encodeURIComponent(device.id)}`)}
                data-testid={`device-card-${device.id}`}
              >
                {/* Header: info on left, icon on right */}
                <div className="device-card-header">
                  <div className="device-card-header-info">
                    <span className="device-card-name">{device.name || device.id}</span>
                    {device.name && device.name !== device.id && (
                      <span className="device-card-id" style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {device.id}
                      </span>
                    )}
                    <div className="device-card-badges">
                      <StatusBadge status={online ? 'online' : 'offline'} />
                      {device.platform !== 'ios' && device.isRooted && (
                        <StatusBadge status="rooted" />
                      )}
                      {device.platform !== 'ios' && !device.isRooted && (
                        <span className="badge badge-sm badge-muted">Factory</span>
                      )}
                    </div>
                  </div>
                  <div className="device-card-icon">
                    {device.platform === 'ios' ? <Apple size={20} /> : <Smartphone size={20} />}
                  </div>
                </div>

                {/* Key-value detail rows */}
                <div className="device-card-details">
                  {device.platform === 'ios' ? (
                    device.iosVersion && (
                      <div className="device-card-detail-row">
                        <span className="detail-label">iOS Version</span>
                        <span className="detail-value">{device.iosVersion}</span>
                      </div>
                    )
                  ) : device.androidVersion ? (
                    <div className="device-card-detail-row">
                      <span className="detail-label">OS Version</span>
                      <span className="detail-value">Android {device.androidVersion}</span>
                    </div>
                  ) : null}
                  {device.batteryLevel != null && (
                    <div className="device-card-detail-row">
                      <span className="detail-label">Battery</span>
                      <span className={`detail-value ${batteryColorClass(device.batteryLevel)}`}>{device.batteryLevel}%</span>
                    </div>
                  )}
                  {device.platform !== 'ios' && device.bootloaderLocked != null && (
                    <div className="device-card-detail-row">
                      <span className="detail-label">Security</span>
                      <span className={`detail-value ${device.bootloaderLocked ? '' : 'security-unlocked'}`}>
                        {device.bootloaderLocked ? 'Locked' : 'Unlocked'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Footer action */}
                <div className="device-card-footer">
                  {device.platform !== 'ios' && device.setupVersion < CURRENT_SETUP_VERSION ? (
                    <button
                      className="device-card-action"
                      onClick={e => { e.stopPropagation(); setSetupDevice(device); }}
                      data-testid={`setup-btn-${device.id}`}
                      style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
                    >
                      Setup Required
                    </button>
                  ) : (
                    <span className="device-card-action">
                      {online ? 'Connect' : 'View Details'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {setupDevice && (
        <SetupWizardModal
          device={setupDevice}
          onClose={() => setSetupDevice(null)}
          onSetupComplete={handleSetupComplete}
        />
      )}
    </div>
  );
}
