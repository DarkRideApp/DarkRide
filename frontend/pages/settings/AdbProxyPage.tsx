import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog, EmptyState, LoadingSpinner, useAuthOptional, useDocumentTitle, useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../../components/auth/AccessDenied';
import { FieldRow, SaveButton, SectionCard, SectionHeading } from '../../components/settings/SettingsShared';
import { useAdbProxyStatus } from '../../hooks/useAdbProxyStatus';
import type { DeviceProxyState, DeviceStatusView, KeyView, PendingView } from '../../../shared/types/adb-proxy';

const API_ERRORS = new Map<string, string>([
  ['not-found', 'That item no longer exists. The list has been refreshed.'],
  ['not-approved', 'Only approved machines can be revoked.'],
  ['in-use', 'That port is used by another device.'],
  ['out-of-range', 'That port is outside the configured range.'],
  ['range-full', 'There is no free port left in the range.'],
  ['unknown-device', 'DarkRide does not know that device.'],
  ['invalid', 'That value is not valid.'],
]);

const STATE_BADGES: Record<DeviceProxyState, { label: string; className: string }> = {
  listening: { label: 'Listening', className: 'badge badge-success' },
  'device-offline': { label: 'Device offline', className: 'badge badge-offline' },
  disabled: { label: 'Disabled', className: 'badge badge-offline' },
  off: { label: 'Off', className: 'badge badge-offline' },
  'port-in-use': { label: 'Port in use', className: 'badge badge-error' },
  'range-full': { label: 'No free port', className: 'badge badge-error' },
  error: { label: 'Error', className: 'badge badge-error' },
};

// Values from the network can be long and unbroken, so they wrap instead of widening the table.
const WRAP: React.CSSProperties = { overflowWrap: 'anywhere' };

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

const machine = (comment: string | null) => comment || '(no name)';

const isWhole = (text: string) => /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text));

type NetDraft = { bindHost?: string; portStart?: string; portEnd?: string };
type Confirmation = { action: 'revoke' | 'forget'; key: KeyView };

export function AdbProxyPage() {
  useDocumentTitle('ADB Proxy');
  const auth = useAuthOptional();
  if (auth && !auth.hasScope('core.adb-proxy:read')) return <AccessDenied scope="core.adb-proxy:read" />;
  return <AdbProxyContent canManage={auth?.hasScope('core.adb-proxy:manage') ?? true} />;
}

function AdbProxyContent({ canManage }: { canManage: boolean }) {
  const ws = useWebSocket();
  const { status, error: loadError, refresh } = useAdbProxyStatus();
  const [actionError, setActionError] = useState<string | null>(null);
  const [netDraft, setNetDraft] = useState<NetDraft>({});
  const [netSaving, setNetSaving] = useState(false);
  const [netSaved, setNetSaved] = useState(false);
  const [portDrafts, setPortDrafts] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const call = useCallback(
    async (method: string, path: string, body?: unknown): Promise<boolean> => {
      setActionError(null);
      try {
        const res = await ws.sendRestApi(method, path, body);
        if (res.body?.success) {
          await refresh();
          return true;
        }
        const code = typeof res.body?.error === 'string' ? res.body.error : undefined;
        setActionError((code && API_ERRORS.get(code)) || code || 'The request failed.');
      } catch {
        setActionError('The request failed.');
      }
      await refresh();
      return false;
    },
    [ws, refresh],
  );

  const copy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), 2000);
      },
      () => {},
    );
  };

  const approved = (status?.keys ?? []).filter((k) => k.status === 'approved');
  const blocked = (status?.keys ?? []).filter((k) => k.status !== 'approved');
  const live = (status?.connections ?? []).filter((c) => c.state === 'ready');
  const deviceName = (id: string) => status?.devices.find((d) => d.deviceId === id)?.name ?? id;
  const canCopy = !!navigator.clipboard?.writeText;

  const net = status && {
    bindHost: netDraft.bindHost ?? status.bindHost,
    portStart: netDraft.portStart ?? String(status.portStart),
    portEnd: netDraft.portEnd ?? String(status.portEnd),
  };
  const netDirty = !!status && !!net && (
    net.bindHost !== status.bindHost || net.portStart !== String(status.portStart) || net.portEnd !== String(status.portEnd)
  );
  const netValid = !!net && net.bindHost.trim() !== '' && isWhole(net.portStart) && isWhole(net.portEnd);

  const editNet = (patch: NetDraft) => {
    setNetDraft((draft) => ({ ...draft, ...patch }));
    setNetSaved(false);
  };

  const saveNetwork = async () => {
    if (!net || !netValid) return;
    setNetSaving(true);
    const ok = await call('PUT', '/v1/adb-proxy/settings', {
      bindHost: net.bindHost.trim(),
      portStart: Number(net.portStart),
      portEnd: Number(net.portEnd),
    });
    setNetSaving(false);
    if (ok) {
      setNetDraft({});
      setNetSaved(true);
    }
  };

  const savePort = async (deviceId: string, draft: string) => {
    const ok = await call('PATCH', `/v1/adb-proxy/devices/${encodeURIComponent(deviceId)}`, { port: Number(draft) });
    if (ok) {
      setPortDrafts(({ [deviceId]: _saved, ...rest }) => rest);
    }
  };

  const runConfirmed = () => {
    if (!confirmation) return;
    const { action, key } = confirmation;
    setConfirmation(null);
    if (action === 'revoke') void call('POST', `/v1/adb-proxy/keys/${key.id}/revoke`);
    else void call('DELETE', `/v1/adb-proxy/keys/${key.id}`);
  };

  const actionsHeader = canManage ? <th>Actions</th> : null;

  const renderPending = (p: PendingView) => (
    <tr key={p.requestId} data-testid="adb-proxy-request">
      <td style={WRAP}>{machine(p.comment)}</td>
      <td><code style={WRAP}>{p.fingerprint}</code></td>
      <td style={WRAP}>{p.peerIp}</td>
      <td style={WRAP}>{deviceName(p.deviceId)}</td>
      <td>{ago(p.createdAt)}</td>
      {canManage && (
        <td>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn btn-sm btn-primary" onClick={() => void call('POST', `/v1/adb-proxy/requests/${encodeURIComponent(p.requestId)}/approve`)}>Approve</button>
            <button className="btn btn-sm btn-danger" onClick={() => void call('POST', `/v1/adb-proxy/requests/${encodeURIComponent(p.requestId)}/deny`)}>Deny</button>
          </div>
        </td>
      )}
    </tr>
  );

  const renderApproved = (k: KeyView) => (
    <tr key={k.id}>
      <td style={WRAP}>{machine(k.comment)}</td>
      <td><code style={WRAP}>{k.fingerprint}</code></td>
      <td style={WRAP}>{ago(k.lastSeenAt)}{k.lastSeenIp ? ` from ${k.lastSeenIp}` : ''}</td>
      {canManage && (
        <td>
          <button className="btn btn-sm btn-danger" onClick={() => setConfirmation({ action: 'revoke', key: k })}>Revoke</button>
        </td>
      )}
    </tr>
  );

  const renderBlocked = (k: KeyView) => (
    <tr key={k.id}>
      <td style={WRAP}>{machine(k.comment)}</td>
      <td><code style={WRAP}>{k.fingerprint}</code></td>
      <td><span className="badge badge-error">{k.status === 'denied' ? 'Denied' : 'Revoked'}</span></td>
      {canManage && (
        <td>
          <button className="btn btn-sm" onClick={() => setConfirmation({ action: 'forget', key: k })}>Forget</button>
        </td>
      )}
    </tr>
  );

  const renderDevice = (d: DeviceStatusView) => {
    const label = d.name ?? d.deviceId;
    const serverPort = d.port === null ? '' : String(d.port);
    const draft = portDrafts[d.deviceId] ?? serverPort;
    const command = d.port === null ? null : `adb connect ${status?.advertisedHost}:${d.port}`;
    const badge = STATE_BADGES[d.state];
    return (
      <tr key={d.deviceId} data-testid={`adb-proxy-device-${d.deviceId}`}>
        <td style={WRAP}>{label}{d.name ? <div className="form-hint">{d.deviceId}</div> : null}</td>
        <td>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              className="form-input"
              type="number"
              style={{ width: 90 }}
              aria-label={`Port for ${label}`}
              value={draft}
              disabled={!canManage}
              onChange={(e) => setPortDrafts({ ...portDrafts, [d.deviceId]: e.target.value })}
            />
            {canManage && draft !== serverPort && (
              <button className="btn btn-sm" disabled={!isWhole(draft)} onClick={() => void savePort(d.deviceId, draft)}>
                Save port
              </button>
            )}
          </div>
        </td>
        <td><span className={badge.className}>{badge.label}</span></td>
        <td>
          <input
            type="checkbox"
            aria-label={`Proxy ${label}`}
            checked={d.enabled}
            disabled={!canManage}
            onChange={(e) => void call('PATCH', `/v1/adb-proxy/devices/${encodeURIComponent(d.deviceId)}`, { enabled: e.target.checked })}
          />
        </td>
        <td>
          {command && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={WRAP}>{command}</code>
              {canCopy && (
                <button className="btn btn-sm" onClick={() => copy(d.deviceId, command)}>
                  {copied === d.deviceId ? 'Copied!' : 'Copy'}
                </button>
              )}
            </div>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div data-testid="adb-proxy-page">
      <header className="settings-page-header">
        <h1>ADB Proxy</h1>
      </header>
      <p className="form-hint">
        Let other machines use <code>adb</code> with the devices attached to this server. A machine can only connect after you
        approve it here.
      </p>
      <div className="mcp-note" style={{ marginTop: 0, marginBottom: 16 }}>
        Traffic between <code>adb</code> and this server is not encrypted. On an untrusted network, put the port range behind a VPN.
      </div>

      {loadError && <div className="status-strip status-strip-error" role="alert"><span className="status-strip-label">{loadError}</span></div>}
      {actionError && <div className="status-strip status-strip-error" role="alert"><span className="status-strip-label">{actionError}</span></div>}
      {!status && !loadError && <LoadingSpinner center />}

      {status && net && (
        <>
          <div className="mcp-toggle-card">
            <div className="mcp-toggle-info">
              <h3>Remote access</h3>
              <p>Nothing listens until you turn this on.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className={`mcp-status ${status.enabled ? 'mcp-status-active' : 'mcp-status-disabled'}`}>
                {status.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {canManage && (
                <button
                  data-testid="adb-proxy-toggle"
                  className={`toggle-switch ${status.enabled ? 'toggle-on' : ''}`}
                  role="switch"
                  aria-checked={status.enabled}
                  aria-label={status.enabled ? 'Disable ADB proxy' : 'Enable ADB proxy'}
                  onClick={() => void call('PUT', '/v1/adb-proxy/settings', { enabled: !status.enabled })}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: status.enabled ? 'var(--accent)' : 'var(--border-color)',
                    position: 'relative', transition: 'background 0.2s',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: status.enabled ? 22 : 2,
                    width: 20, height: 20, borderRadius: 10,
                    background: '#fff', transition: 'left 0.2s',
                  }} />
                </button>
              )}
            </div>
          </div>

          <SectionCard
            id="adb-proxy-network"
            title="Network"
            description="Open this port range on the host firewall. A new range only applies to devices that get a port afterwards."
          >
            <FieldRow style={{ marginBottom: 8 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="adb-proxy-bind">Bind address</label>
                <input
                  id="adb-proxy-bind"
                  className="form-input"
                  style={{ width: 200 }}
                  value={net.bindHost}
                  disabled={!canManage}
                  onChange={(e) => editNet({ bindHost: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="adb-proxy-first">First port</label>
                <input
                  id="adb-proxy-first"
                  className="form-input"
                  style={{ width: 110 }}
                  type="number"
                  value={net.portStart}
                  disabled={!canManage}
                  onChange={(e) => editNet({ portStart: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="adb-proxy-last">Last port</label>
                <input
                  id="adb-proxy-last"
                  className="form-input"
                  style={{ width: 110 }}
                  type="number"
                  value={net.portEnd}
                  disabled={!canManage}
                  onChange={(e) => editNet({ portEnd: e.target.value })}
                />
              </div>
              {canManage && (
                <SaveButton
                  saving={netSaving}
                  saved={netSaved && !netDirty}
                  disabled={!netDirty || !netValid}
                  onClick={() => void saveNetwork()}
                  testId="adb-proxy-save-network"
                />
              )}
            </FieldRow>
            <div className="form-hint">0.0.0.0 listens on every interface.</div>
          </SectionCard>

          <SectionHeading>Waiting for approval ({status.pending.length})</SectionHeading>
          <div className="table-card" data-testid="adb-proxy-pending">
            {status.pending.length === 0 ? (
              <EmptyState message="No machines are waiting for approval." />
            ) : (
              <table className="data-table">
                <thead><tr><th>Machine</th><th>Key fingerprint</th><th>From</th><th>Device</th><th>Waiting</th>{actionsHeader}</tr></thead>
                <tbody>{status.pending.map(renderPending)}</tbody>
              </table>
            )}
          </div>
          <p className="form-hint" style={{ marginBottom: 24 }}>
            Approve only machines you recognise by name and address. The machine runs <code>adb connect host:port</code>; until you
            approve it, its <code>adb devices</code> output shows <code>unauthorized</code>.
          </p>

          <SectionHeading>Approved machines</SectionHeading>
          <div className="table-card" data-testid="adb-proxy-approved">
            {approved.length === 0 ? (
              <EmptyState message="No machines have been approved yet." />
            ) : (
              <table className="data-table">
                <thead><tr><th>Machine</th><th>Key fingerprint</th><th>Last seen</th>{actionsHeader}</tr></thead>
                <tbody>{approved.map(renderApproved)}</tbody>
              </table>
            )}
          </div>
          {blocked.length > 0 && (
            <details data-testid="adb-proxy-blocked" style={{ marginTop: 12 }}>
              <summary>Denied and revoked ({blocked.length})</summary>
              <div className="table-card" style={{ marginTop: 8 }}>
                <table className="data-table">
                  <thead><tr><th>Machine</th><th>Key fingerprint</th><th>State</th>{actionsHeader}</tr></thead>
                  <tbody>{blocked.map(renderBlocked)}</tbody>
                </table>
              </div>
            </details>
          )}

          <div style={{ marginTop: 24 }}>
            <SectionHeading>Devices</SectionHeading>
          </div>
          <div className="table-card">
            {status.devices.length === 0 ? (
              <EmptyState message="No Android devices are attached." />
            ) : (
              <table className="data-table">
                <thead><tr><th>Device</th><th>Port</th><th>Status</th><th>Proxy</th><th>Connect command</th></tr></thead>
                <tbody>{status.devices.map(renderDevice)}</tbody>
              </table>
            )}
          </div>

          <div style={{ marginTop: 24 }}>
            <SectionHeading>Live connections</SectionHeading>
          </div>
          <div className="table-card" data-testid="adb-proxy-connections">
            {live.length === 0 ? (
              <EmptyState message="No machines are connected." />
            ) : (
              <table className="data-table">
                <thead><tr><th>Machine</th><th>From</th><th>Device</th><th>Connected for</th><th>Streams</th></tr></thead>
                <tbody>
                  {live.map((c) => (
                    <tr key={c.id}>
                      <td style={WRAP}>{machine(c.comment)}</td>
                      <td style={WRAP}>{c.peerIp}</td>
                      <td style={WRAP}>{deviceName(c.deviceId)}</td>
                      <td>{duration(c.since)}</td>
                      <td>{c.streams}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {confirmation && (
        <ConfirmDialog
          title={confirmation.action === 'revoke' ? 'Revoke Machine' : 'Forget Machine'}
          message={
            confirmation.action === 'revoke'
              ? `Revoke access for "${machine(confirmation.key.comment)}"? Its open connections close now and it can no longer connect.`
              : `Forget "${machine(confirmation.key.comment)}"? It is removed from this list. If it connects again, it waits for approval like a new machine.`
          }
          confirmLabel={confirmation.action === 'revoke' ? 'Revoke' : 'Forget'}
          onConfirm={runConfirmed}
          onCancel={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}
