import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog, EmptyState, LoadingSpinner, useAuthOptional, useDocumentTitle, useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../../components/auth/AccessDenied';
import { FieldRow, SaveButton, SectionCard, SectionHeading } from '../../components/settings/SettingsShared';
import { useAdbProxyStatus } from '../../hooks/useAdbProxyStatus';
import { useNow } from '../../hooks/useNow';
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

const STATE_BADGES = new Map<DeviceProxyState, { label: string; className: string }>([
  ['listening', { label: 'Listening', className: 'badge badge-success' }],
  ['device-offline', { label: 'Device offline', className: 'badge badge-offline' }],
  ['disabled', { label: 'Disabled', className: 'badge badge-offline' }],
  ['off', { label: 'Off', className: 'badge badge-offline' }],
  ['port-in-use', { label: 'Port in use', className: 'badge badge-error' }],
  ['range-full', { label: 'No free port', className: 'badge badge-error' }],
  ['error', { label: 'Error', className: 'badge badge-error' }],
]);
const UNKNOWN_STATE = { label: 'Unknown', className: 'badge badge-offline' };

const ENABLE_TARGET = 'settings:enabled';
const NETWORK_TARGET = 'settings:network';
const requestTarget = (requestId: string) => `request:${requestId}`;
const keyTarget = (id: number) => `key:${id}`;
const devicePortTarget = (deviceId: string) => `device-port:${deviceId}`;
const deviceEnabledTarget = (deviceId: string) => `device-enabled:${deviceId}`;

// Values from the network can be long and unbroken, so they wrap instead of widening the table.
const WRAP: React.CSSProperties = { overflowWrap: 'anywhere' };

// On narrow screens a table keeps a minimum width inside a card that clips, so each card scrolls sideways instead.
const SCROLL_X: React.CSSProperties = { overflowX: 'auto' };

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function duration(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

// Each cell reads the shared clock itself, so a tick re-renders these cells and not the whole page.
const Ago = ({ ms }: { ms: number }) => <>{ago(ms, useNow())}</>;
const Elapsed = ({ ms }: { ms: number }) => <>{duration(ms, useNow())}</>;

const machine = (comment: string | null) => comment || '(no name)';

// The name is chosen by the connecting machine, so it comes last, after the address and fingerprint it could imitate.
const describeKey = (k: KeyView) =>
  `the machine ${k.lastSeenIp ? `at ${k.lastSeenIp} ` : ''}with fingerprint starting ${k.fingerprint.slice(0, 11)}, named "${machine(k.comment)}"`;

const isWhole = (text: string) => /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text));

const shellGrant = (devices: number) => {
  if (devices === 0) return 'a shell on every proxied device, including devices plugged in later; none is proxied now';
  if (devices === 1) return 'a shell on the 1 proxied device, including devices plugged in later';
  return `a shell on all ${devices} proxied devices, including devices plugged in later`;
};

// adb needs brackets around an IPv6 literal before the port.
const hostForConnect = (host: string) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

type NetDraft = { bindHost?: string; portStart?: string; portEnd?: string };
type Confirmation = { action: 'revoke' | 'forget'; key: KeyView } | { action: 'approve'; request: PendingView };

const CONFIRM_LABELS = { approve: 'Approve', revoke: 'Revoke', forget: 'Forget' } as const;

const MANAGE_SCOPE = 'core.adb-proxy:manage';
const SHELL_SCOPE = 'core.devices:shell';

export function AdbProxyPage() {
  useDocumentTitle('ADB Proxy');
  const auth = useAuthOptional();
  if (auth && !auth.hasScope('core.adb-proxy:read')) return <AccessDenied scope="core.adb-proxy:read" />;
  const canManage = auth?.hasScope(MANAGE_SCOPE) ?? true;
  return <AdbProxyContent canManage={canManage} canApprove={canManage && (auth?.hasScope(SHELL_SCOPE) ?? true)} />;
}

function AdbProxyContent({ canManage, canApprove }: { canManage: boolean; canApprove: boolean }) {
  const { sendRestApi } = useWebSocket();
  const { status, error: loadError, refresh } = useAdbProxyStatus();
  const [actionError, setActionError] = useState<string | null>(null);
  const [netDraft, setNetDraft] = useState<NetDraft>({});
  const [netSaved, setNetSaved] = useState(false);
  const [portDrafts, setPortDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(new Set<string>());

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // A second request for a target whose first one has not settled is dropped; the ref covers clicks before the next render.
  const call = useCallback(
    async (target: string, method: string, path: string, body?: unknown): Promise<boolean> => {
      if (inFlight.current.has(target)) return false;
      inFlight.current.add(target);
      setBusy(new Set(inFlight.current));
      setActionError(null);
      let ok = false;
      try {
        const res = await sendRestApi(method, path, body);
        if (res.body?.success) {
          ok = true;
        } else {
          const code = typeof res.body?.error === 'string' ? res.body.error : undefined;
          setActionError((code && API_ERRORS.get(code)) || code || 'The request failed.');
        }
      } catch {
        setActionError('The request failed.');
      }
      try {
        await refresh();
      } finally {
        inFlight.current.delete(target);
        setBusy(new Set(inFlight.current));
      }
      return ok;
    },
    [sendRestApi, refresh],
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
    if (!net || !netValid || inFlight.current.has(NETWORK_TARGET)) return;
    const ok = await call(NETWORK_TARGET, 'PUT', '/v1/adb-proxy/settings', {
      bindHost: net.bindHost.trim(),
      portStart: Number(net.portStart),
      portEnd: Number(net.portEnd),
    });
    if (ok) {
      setNetDraft({});
      setNetSaved(true);
    }
  };

  const setPortDraft = (deviceId: string, value: string) => setPortDrafts((drafts) => new Map(drafts).set(deviceId, value));

  const savePort = async (deviceId: string, draft: string) => {
    const ok = await call(devicePortTarget(deviceId), 'PATCH', `/v1/adb-proxy/devices/${encodeURIComponent(deviceId)}`, { port: Number(draft) });
    if (ok) {
      setPortDrafts((drafts) => {
        const next = new Map(drafts);
        next.delete(deviceId);
        return next;
      });
    }
  };

  const runConfirmed = () => {
    if (!confirmation) return;
    setConfirmation(null);
    if (confirmation.action === 'approve') {
      const { requestId } = confirmation.request;
      void call(requestTarget(requestId), 'POST', `/v1/adb-proxy/requests/${encodeURIComponent(requestId)}/approve`);
      return;
    }
    const { action, key } = confirmation;
    if (action === 'revoke') void call(keyTarget(key.id), 'POST', `/v1/adb-proxy/keys/${key.id}/revoke`);
    else void call(keyTarget(key.id), 'DELETE', `/v1/adb-proxy/keys/${key.id}`);
  };

  const proxiedDevices = (status?.devices ?? []).filter((d) => d.enabled).length;

  const confirmMessage = (c: Confirmation) => {
    if (c.action === 'approve') {
      // The name is chosen by the machine, so it comes last, after everything it could imitate, the grant included.
      const r = c.request;
      return `Approve the machine at ${r.peerIp} with fingerprint ${r.fingerprint}, asking to connect to ${deviceName(r.deviceId)}? `
        + `This gives it ${shellGrant(proxiedDevices)}. The machine calls itself "${machine(r.comment)}".`;
    }
    if (c.action === 'revoke') return `Revoke access for ${describeKey(c.key)}? Its open connections close now and it can no longer connect.`;
    return `Forget ${describeKey(c.key)}? It is removed from this list. If it connects again, it waits for approval like a new machine.`;
  };

  const actionsHeader = canManage ? <th>Actions</th> : null;

  const renderPending = (p: PendingView) => {
    const target = requestTarget(p.requestId);
    const base = `/v1/adb-proxy/requests/${encodeURIComponent(p.requestId)}`;
    return (
      <tr key={p.requestId} data-testid="adb-proxy-request">
        <td style={WRAP}>{machine(p.comment)}</td>
        <td><code style={WRAP}>{p.fingerprint}</code></td>
        <td style={WRAP}>{p.peerIp}</td>
        <td style={WRAP}>{deviceName(p.deviceId)}</td>
        <td><Ago ms={p.createdAt} /></td>
        {canManage && (
          <td>
            <div style={{ display: 'flex', gap: 4 }}>
              {canApprove && (
                <button className="btn btn-sm btn-primary" disabled={busy.has(target)} onClick={() => setConfirmation({ action: 'approve', request: p })}>Approve</button>
              )}
              <button className="btn btn-sm btn-danger" disabled={busy.has(target)} onClick={() => void call(target, 'POST', `${base}/deny`)}>Deny</button>
            </div>
          </td>
        )}
      </tr>
    );
  };

  const renderApproved = (k: KeyView) => (
    <tr key={k.id}>
      <td style={WRAP}>{machine(k.comment)}</td>
      <td><code style={WRAP}>{k.fingerprint}</code></td>
      <td style={WRAP}><Ago ms={k.lastSeenAt} />{k.lastSeenIp ? ` from ${k.lastSeenIp}` : ''}</td>
      {canManage && (
        <td>
          <button className="btn btn-sm btn-danger" disabled={busy.has(keyTarget(k.id))} onClick={() => setConfirmation({ action: 'revoke', key: k })}>Revoke</button>
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
          <button className="btn btn-sm" disabled={busy.has(keyTarget(k.id))} onClick={() => setConfirmation({ action: 'forget', key: k })}>Forget</button>
        </td>
      )}
    </tr>
  );

  const renderDevice = (d: DeviceStatusView) => {
    const label = d.name ?? d.deviceId;
    const serverPort = d.port === null ? '' : String(d.port);
    const draft = portDrafts.get(d.deviceId) ?? serverPort;
    const command = d.port === null ? null : `adb connect ${hostForConnect(status?.advertisedHost ?? '')}:${d.port}`;
    const badge = STATE_BADGES.get(d.state) ?? UNKNOWN_STATE;
    const portBusy = busy.has(devicePortTarget(d.deviceId));
    const enabledBusy = busy.has(deviceEnabledTarget(d.deviceId));
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
              disabled={!canManage || portBusy}
              onChange={(e) => setPortDraft(d.deviceId, e.target.value)}
            />
            {canManage && draft !== serverPort && (
              <button className="btn btn-sm" disabled={!isWhole(draft) || portBusy} onClick={() => void savePort(d.deviceId, draft)}>
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
            disabled={!canManage || enabledBusy}
            onChange={(e) => void call(deviceEnabledTarget(d.deviceId), 'PATCH', `/v1/adb-proxy/devices/${encodeURIComponent(d.deviceId)}`, { enabled: e.target.checked })}
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
                  aria-label="ADB proxy"
                  disabled={busy.has(ENABLE_TARGET)}
                  onClick={() => void call(ENABLE_TARGET, 'PUT', '/v1/adb-proxy/settings', { enabled: !status.enabled })}
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
                  saving={busy.has(NETWORK_TARGET)}
                  saved={netSaved && !netDirty}
                  disabled={!netDirty || !netValid}
                  onClick={() => void saveNetwork()}
                  testId="adb-proxy-save-network"
                />
              )}
            </FieldRow>
            <div className="form-hint">0.0.0.0 listens on every IPv4 interface.</div>
          </SectionCard>

          <SectionHeading>Waiting for approval ({status.pending.length})</SectionHeading>
          <div className="table-card" style={SCROLL_X} data-testid="adb-proxy-pending">
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
            Approving a machine gives it a shell on every proxied device, including devices plugged in later. The machine name is
            chosen by the connecting machine, so it proves nothing. Rely on the source address and the key fingerprint, and approve
            only machines you expect. The fingerprint tells two machines with the same name apart and lets you recognise a key you
            approved before. The machine runs <code>adb connect host:port</code>; until you approve it, its{' '}
            <code>adb devices</code> output shows <code>unauthorized</code>.
            {canManage && !canApprove && (
              <span data-testid="adb-proxy-approve-hint" style={{ display: 'block', marginTop: 4 }}>Approving needs Device shell access.</span>
            )}
          </p>

          <SectionHeading>Approved machines</SectionHeading>
          <div className="table-card" style={SCROLL_X} data-testid="adb-proxy-approved">
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
              <div className="table-card" style={{ ...SCROLL_X, marginTop: 8 }}>
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
          <div className="table-card" style={SCROLL_X}>
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
          <div className="table-card" style={SCROLL_X} data-testid="adb-proxy-connections">
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
                      <td><Elapsed ms={c.since} /></td>
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
          title={`${CONFIRM_LABELS[confirmation.action]} Machine`}
          message={confirmMessage(confirmation)}
          confirmLabel={CONFIRM_LABELS[confirmation.action]}
          onConfirm={runConfirmed}
          onCancel={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}
