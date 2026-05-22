import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocket, useToast } from '@darkrideapp/plugin-sdk/react';
import { StatusBadge } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { SkeletonCard } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Smartphone, Apple, RefreshCw, Server, AlertTriangle } from 'lucide-react';
import { CURRENT_SETUP_VERSION } from '../../shared/types/api';
import type { Device } from '../../shared/types/api';
import { SetupWizardModal } from '../components/devices/SetupWizardModal';
import { CreateEmulatorModal } from '../components/devices/CreateEmulatorModal';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

/**
 * Managed instance row as returned by `/v1/devices/providers/:id/instances`.
 * `serial` is set after `startInstance` resolves; null while still spawning.
 */
interface ManagedInstance {
  id: number;
  providerId: string;
  runtimeId: string;
  displayName: string | null;
  serial: string | null;
  state: 'created' | 'starting' | 'running' | 'stopped' | 'error';
  spawnMetadata: { image?: string; androidVersion?: string; arch?: string; ramMb?: number } | null;
  lastError: string | null;
  createdAt: string | number | Date;
  /** Updated on every state transition — best timestamp for "how long has this been in its current state". */
  lastStateAt?: string | number | Date;
}

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
  const toast = useToast();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [instances, setInstances] = useState<ManagedInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupDevice, setSetupDevice] = useState<Device | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

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

  /**
   * Fetch managed instances across every registered provider so the grid
   * can show emulators that are still booting (state=created/starting) and
   * therefore not yet visible to the adb-device tracker. Providers without
   * `canCreate` (e.g. adb-device) have no managed instances and are skipped.
   */
  const fetchInstances = useCallback(async () => {
    try {
      const provs = await ws.sendRestApi('GET', '/v1/devices/providers');
      const list = (provs.body?.data?.providers ?? []) as Array<{ id: string; capabilities: { canCreate: boolean }; available: boolean }>;
      const creatable = list.filter((p) => p.capabilities.canCreate && p.available);
      const all: ManagedInstance[] = [];
      await Promise.all(creatable.map(async (p) => {
        const r = await ws.sendRestApi('GET', `/v1/devices/providers/${p.id}/instances`);
        const rows = (r.body?.data?.instances ?? []) as ManagedInstance[];
        for (const row of rows) all.push(row);
      }));
      setInstances(all);
    } catch {
      // ignore — partial failure shouldn't blank the page
    }
  }, [ws]);

  useEffect(() => {
    if (!ws.connected) return;
    void fetchDevices();
    void fetchInstances();
  }, [ws.connected, fetchDevices, fetchInstances]);

  // Live state: backend broadcasts provider-instance-updated on every state
  // transition (created → starting → running → error). Refetch on each
  // event so the grid reflects the boot progress without polling.
  useEffect(() => {
    const unsub = ws.subscribe('provider-instance-updated', () => {
      void fetchInstances();
      void fetchDevices();
    });
    return unsub;
  }, [ws, fetchInstances, fetchDevices]);

  // Deletes don't fit the "updated" event shape (the row is gone) — the
  // backend emits a dedicated provider-instance-deleted with the row id.
  // Remove the matching card from local state directly to avoid a full
  // refetch round-trip.
  useEffect(() => {
    const unsub = ws.subscribe('provider-instance-deleted', (msg: any) => {
      const deletedId = msg?.id as number | undefined;
      if (typeof deletedId === 'number') {
        setInstances((prev) => prev.filter((i) => i.id !== deletedId));
      }
    });
    return unsub;
  }, [ws]);

  if (auth && !auth.hasScope('core.devices:read')) return <AccessDenied scope="core.devices:read" />;

  const handleSetupComplete = () => {
    setSetupDevice(null);
    fetchDevices();
  };

  async function startInstance(inst: ManagedInstance) {
    try {
      const r = await ws.sendRestApi('POST', `/v1/devices/providers/${inst.providerId}/instances/${inst.id}/start`);
      if (!r.body?.success) toast.error(r.body?.error ?? 'Failed to start');
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to start');
    }
  }
  async function stopInstance(inst: ManagedInstance) {
    try {
      const r = await ws.sendRestApi('POST', `/v1/devices/providers/${inst.providerId}/instances/${inst.id}/stop`);
      if (!r.body?.success) toast.error(r.body?.error ?? 'Failed to stop');
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to stop');
    }
  }
  async function deleteInstance(inst: ManagedInstance) {
    if (!window.confirm(`Delete "${inst.displayName ?? inst.runtimeId}"? This removes the container as well.`)) return;
    // Optimistically drop the card so the click feels instant. The
    // broadcast (`provider-instance-deleted`) handler will agree once the
    // backend confirms; if the request fails we restore.
    const snapshot = instances;
    setInstances((prev) => prev.filter((i) => i.id !== inst.id));
    try {
      const r = await ws.sendRestApi('DELETE', `/v1/devices/providers/${inst.providerId}/instances/${inst.id}`);
      if (!r.body?.success) {
        setInstances(snapshot);
        toast.error(r.body?.error ?? 'Failed to delete');
      }
    } catch (e: any) {
      setInstances(snapshot);
      toast.error(e?.message ?? 'Failed to delete');
    }
  }

  if (loading) return <div className="skeleton-grid"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>;

  const onlineCount = devices.filter(isOnline).length;
  const offlineCount = devices.length - onlineCount;
  // Show every managed instance EXCEPT ones whose serial already appears
  // as an adb-tracked device. Once the emulator's adbd binds, the device
  // tracker picks it up and the device card supersedes the instance card.
  const deviceSerials = new Set(devices.map((d) => d.id));
  const visibleInstances = instances.filter((i) => !i.serial || !deviceSerials.has(i.serial));
  const bootingCount = visibleInstances.filter((i) => i.state === 'created' || i.state === 'starting').length;
  const errorCount = visibleInstances.filter((i) => i.state === 'error').length;
  const subtitle = [
    `${onlineCount} online`,
    `${offlineCount} offline`,
    bootingCount > 0 ? `${bootingCount} booting` : null,
    errorCount > 0 ? `${errorCount} error` : null,
  ].filter(Boolean).join(' · ');

  const hasAnything = devices.length > 0 || visibleInstances.length > 0;

  return (
    <div data-testid="devices-page">
      <PageHeader
        title="Devices"
        subtitle={subtitle}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => { void fetchDevices(); void fetchInstances(); }}>
              <RefreshCw size={14} style={{ marginRight: 6 }} />
              Sync All
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => setShowCreateModal(true)}
            >
              + New emulator
            </button>
          </div>
        }
      />
      {!hasAnything ? (
        <div className="empty-state">
          <div className="empty-icon" aria-hidden><Smartphone size={32} /></div>
          <div>No devices connected</div>
          <div style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.7 }}>
            Connect an Android device via USB and enable USB debugging, pair
            an iOS device, or click <strong>+ New emulator</strong> to spin
            up a virtual device.
          </div>
        </div>
      ) : (
        <div className="card-grid">
          {visibleInstances.map((inst) => (
            <InstanceCard
              key={`inst-${inst.id}`}
              instance={inst}
              onStart={() => startInstance(inst)}
              onStop={() => stopInstance(inst)}
              onDelete={() => deleteInstance(inst)}
            />
          ))}
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
      {showCreateModal && (
        <CreateEmulatorModal
          onCancel={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            fetchDevices();
          }}
        />
      )}
    </div>
  );
}

const STATE_LABEL: Record<ManagedInstance['state'], string> = {
  created: 'Created',
  starting: 'Booting',
  running: 'Connecting',  // running per backend, not yet visible to adb tracker
  stopped: 'Stopped',
  error: 'Error',
};

function relativeTime(input: string | number | Date): string {
  const t = typeof input === 'object' ? input.getTime() : new Date(input).getTime();
  const delta = Math.max(0, Date.now() - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

interface InstanceCardProps {
  instance: ManagedInstance;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}

/**
 * Card for a managed emulator instance. Shows boot/error state with the
 * right affordance for each:
 *   - created/stopped → Start button
 *   - starting/running-pre-tracker → spinner + "Booting" / "Connecting"
 *   - error → red badge + lastError message + Retry / Delete
 *
 * Distinct visual treatment (instance-card class) so users can tell at a
 * glance which cards are managed by DarkRide vs adb-discovered devices.
 */
function InstanceCard({ instance: inst, onStart, onStop, onDelete }: InstanceCardProps) {
  const isBooting = inst.state === 'starting' || inst.state === 'running';
  const isError = inst.state === 'error';
  const isStartable = inst.state === 'created' || inst.state === 'stopped';
  const meta = inst.spawnMetadata ?? {};
  const subtitle: string[] = [];
  if (meta.image) subtitle.push(meta.image.split(':').pop() ?? meta.image);
  if (meta.arch) subtitle.push(meta.arch);
  if (meta.ramMb) subtitle.push(`${meta.ramMb} MB RAM`);

  return (
    <div
      className={`card instance-card instance-card-${inst.state}`}
      data-testid={`instance-card-${inst.id}`}
    >
      <div className="device-card-header">
        <div className="device-card-header-info">
          <span className="device-card-name">
            {inst.displayName || `Instance #${inst.id}`}
          </span>
          {inst.serial && (
            <span className="device-card-id" style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {inst.serial}
            </span>
          )}
          <div className="device-card-badges">
            <span className={`badge badge-sm instance-state-${inst.state}`}>
              {isBooting && <span className="spin" aria-hidden style={{ display: 'inline-block', marginRight: 4 }}>⟳</span>}
              {STATE_LABEL[inst.state]}
            </span>
            <span className="badge badge-sm badge-muted">{inst.providerId}</span>
          </div>
        </div>
        <div className="device-card-icon">
          {isError ? <AlertTriangle size={20} color="var(--danger)" /> : <Server size={20} />}
        </div>
      </div>

      <div className="device-card-details">
        {subtitle.length > 0 && (
          <div className="device-card-detail-row">
            <span className="detail-label">Spec</span>
            <span className="detail-value">{subtitle.join(' · ')}</span>
          </div>
        )}
        <div className="device-card-detail-row">
          <span className="detail-label">Created</span>
          <span className="detail-value">{relativeTime(inst.createdAt)}</span>
        </div>
        {isError && inst.lastError && (
          <div className="instance-card-error" data-testid="instance-error">
            {inst.lastError}
          </div>
        )}
        {isBooting && <InstanceBootProgress inst={inst} />}
      </div>

      <div className="device-card-footer instance-card-footer">
        {isStartable && (
          <button className="btn btn-sm btn-primary" onClick={onStart} data-testid={`start-instance-${inst.id}`}>
            Start
          </button>
        )}
        {inst.state === 'running' && (
          <button className="btn btn-sm" onClick={onStop} data-testid={`stop-instance-${inst.id}`}>
            Stop
          </button>
        )}
        {isError && (
          <button className="btn btn-sm" onClick={onStart} data-testid={`retry-instance-${inst.id}`}>
            Retry
          </button>
        )}
        {(inst.state === 'stopped' || inst.state === 'error' || inst.state === 'created') && (
          <button
            className="btn btn-sm btn-danger-ghost"
            onClick={onDelete}
            data-testid={`delete-instance-${inst.id}`}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Live elapsed-time + escalating helpfulness during boot. Ticks every
 * second so the displayed counter updates without waiting for another
 * provider-instance-updated event (boots between events are silent).
 */
function InstanceBootProgress({ inst }: { inst: ManagedInstance }) {
  const since = (inst.lastStateAt ?? inst.createdAt) as string | number | Date;
  const startMs = typeof since === 'object' ? since.getTime() : new Date(since).getTime();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  // 0-90s: normal boot expected
  // 90-180s: still booting, fine
  // 180-240s: getting slow
  // 240s+: probably stuck (server-side bootTimeoutMs default)
  let tone: 'normal' | 'warn' | 'stuck' = 'normal';
  let msg = 'Cold boot takes ~90 seconds on KVM. The device will appear in your list once adbd binds.';
  if (elapsed >= 240) {
    tone = 'stuck';
    msg = "This is taking longer than expected (~240s) — the in-container emulator may have crashed. Try Delete + create a fresh one, or check the docker container logs.";
  } else if (elapsed >= 90) {
    tone = 'warn';
    msg = 'Still booting. Cold-boot of the Android emulator inside the container can take 1–3 minutes on slower hosts.';
  }
  return (
    <div className={`instance-card-progress-hint instance-card-progress-${tone}`}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
        elapsed: {elapsed}s
      </div>
      {msg}
    </div>
  );
}
