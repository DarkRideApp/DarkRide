import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AuthContext, WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type { KeyView, PendingView, StatusSnapshot } from '../../../shared/types/adb-proxy';
import { AdbProxyPage } from './AdbProxyPage';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as any).clipboard;
});

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    enabled: true, bindHost: '0.0.0.0', portStart: 6500, portEnd: 6599, advertisedHost: '192.168.1.10',
    devices: [{ deviceId: 'DEV1', name: 'Phone 1', port: 6500, enabled: true, online: true, state: 'listening' }],
    connections: [], pending: [], keys: [],
    counters: { connections: 0, approvals: 0, denials: 0, authFailures: 0, floodDrops: 0 },
    ...over,
  };
}
const pendingReq = (over: Partial<PendingView> = {}): PendingView => ({
  requestId: 'r1', keyId: 'k1', fingerprint: FP, comment: 'ci@runner', deviceId: 'DEV1', peerIp: '10.0.0.5', createdAt: Date.now() - 120_000, ...over,
});
const keyRow = (over: Partial<KeyView> = {}): KeyView => ({
  id: 1, keyId: 'k1', fingerprint: FP, comment: 'dev@laptop', status: 'approved', deviceIds: null,
  firstSeenAt: 1, lastSeenAt: Date.now() - 60_000, lastSeenIp: '10.0.0.7', lastDeviceId: 'DEV1', decidedAt: 1, ...over,
});

const MANAGE = ['core.adb-proxy:read', 'core.adb-proxy:manage'];

// `hold` keeps every write pending until `release()`, so a test can click again while a call is in flight.
function mount(opts: { snapshot?: StatusSnapshot; scopes?: string[]; failWith?: string; hold?: boolean } = {}) {
  const current = opts.snapshot ?? snapshot();
  const handlers = new Map<string, (m: any) => void>();
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ws: WebSocketContextValue = {
    connected: true, serverReady: true, startupMessage: '', sendMessage: vi.fn(),
    sendRestApi: vi.fn(async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (method !== 'GET' && opts.hold) await gate;
      if (method !== 'GET' && opts.failWith) {
        return { type: 'restapi' as const, id: '1', status: 409, body: { success: false, error: opts.failWith } };
      }
      return { type: 'restapi' as const, id: '1', status: 200, body: { success: true, data: current } };
    }),
    subscribe: vi.fn((type: string, cb: (m: any) => void) => { handlers.set(type, cb); return () => { handlers.delete(type); }; }),
    subscribeBinary: vi.fn(() => () => {}),
  };
  const scopes = opts.scopes ?? MANAGE;
  const auth = { hasScope: (s: string) => scopes.includes(s) } as any;
  render(
    <AuthContext.Provider value={auth}>
      <WebSocketContext.Provider value={ws}>
        <AdbProxyPage />
      </WebSocketContext.Provider>
    </AuthContext.Provider>,
  );
  return { calls, release: () => release(), push: (s: StatusSnapshot) => act(() => handlers.get('adb-proxy')!({ type: 'adb-proxy', ...s })) };
}

const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== 'GET');
const confirm = () => fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

describe('AdbProxyPage', () => {
  it('denies access without the read scope', async () => {
    mount({ scopes: [] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText('core.adb-proxy:read')).toBeInTheDocument();
  });

  it('does not call the proxy API for a user without the read scope, even with the manage scope', async () => {
    const { calls } = mount({ scopes: ['core.adb-proxy:manage'] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('explains the feature and the plaintext caveat', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'ADB Proxy' })).toBeInTheDocument();
    expect(screen.getByText(/not encrypted/i)).toBeInTheDocument();
  });

  it('shows the disabled state and enables the proxy', async () => {
    const { calls } = mount({ snapshot: snapshot({ enabled: false }) });
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('adb-proxy-toggle'));
    await waitFor(() => expect(writes(calls)).toEqual([{ method: 'PUT', path: '/v1/adb-proxy/settings', body: { enabled: true } }]));
  });

  it('lists a pending request with its machine, fingerprint, source and device', async () => {
    mount({ snapshot: snapshot({ pending: [pendingReq()] }) });
    const row = await screen.findByTestId('adb-proxy-request');
    expect(within(row).getByText('ci@runner')).toBeInTheDocument();
    expect(within(row).getByText(FP)).toBeInTheDocument();
    expect(within(row).getByText('10.0.0.5')).toBeInTheDocument();
    expect(within(row).getByText('Phone 1')).toBeInTheDocument();
    expect(within(row).getByText('2 min ago')).toBeInTheDocument();
  });

  it('approves and denies a request', async () => {
    const { calls } = mount({ snapshot: snapshot({ pending: [pendingReq(), pendingReq({ requestId: 'r2', keyId: 'k2', comment: 'other@box' })] }) });
    const rows = await screen.findAllByTestId('adb-proxy-request');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'POST', path: '/v1/adb-proxy/requests/r1/approve', body: undefined },
      { method: 'POST', path: '/v1/adb-proxy/requests/r2/deny', body: undefined },
    ]));
  });

  it('renders hostile key comments, device names and peer addresses as plain text', async () => {
    const evil = '<img src=x onerror=alert(1)>@host';
    const evilDevice = '<script>alert(2)</script>';
    const evilIp = '<svg onload=alert(3)>';
    mount({
      snapshot: snapshot({
        devices: [{ deviceId: 'DEV1', name: evilDevice, port: 6500, enabled: true, online: true, state: 'listening' }],
        pending: [pendingReq({ comment: evil, peerIp: evilIp })],
        keys: [keyRow({ comment: evil, lastSeenIp: evilIp })],
        connections: [{ id: 1, deviceId: 'DEV1', peerIp: evilIp, state: 'ready', keyId: 'k1', comment: evil, since: Date.now(), streams: 0 }],
      }),
    });
    const row = await screen.findByTestId('adb-proxy-request');
    expect(screen.getAllByText(evil).length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(evilDevice).length).toBeGreaterThanOrEqual(3);
    expect(within(row).getByText(evilIp)).toBeInTheDocument();
    expect(screen.getByTestId('adb-proxy-approved')).toHaveTextContent(evilIp);
    expect(within(screen.getByTestId('adb-proxy-connections')).getByText(evilIp)).toBeInTheDocument();
    expect(document.querySelector('img, script, svg, [onerror], [onload]')).toBeNull();

    fireEvent.click(within(screen.getByTestId('adb-proxy-approved')).getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByTestId('modal');
    expect(dialog).toHaveTextContent(evil);
    expect(dialog).toHaveTextContent(evilIp);
    expect(document.querySelector('img, script, svg, [onerror], [onload]')).toBeNull();
  });

  it('hides every action from a read-only user', async () => {
    mount({ scopes: ['core.adb-proxy:read'], snapshot: snapshot({ pending: [pendingReq()], keys: [keyRow(), keyRow({ id: 2, keyId: 'k2', status: 'denied' })] }) });
    await screen.findByTestId('adb-proxy-request');
    for (const name of ['Approve', 'Deny', 'Revoke', 'Forget', 'Save', 'Save port']) {
      expect(screen.queryByRole('button', { name, hidden: true })).toBeNull();
    }
    expect(screen.queryByTestId('adb-proxy-toggle')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByLabelText('Proxy Phone 1')).toBeDisabled();
    expect(screen.getByLabelText('Port for Phone 1')).toBeDisabled();
    expect(screen.getByLabelText('Bind address')).toBeDisabled();
  });

  it('revokes an approved machine and forgets a denied one, each after a confirmation', async () => {
    const { calls } = mount({
      snapshot: snapshot({ keys: [keyRow(), keyRow({ id: 2, keyId: 'k2', comment: 'old@box', status: 'denied' }), keyRow({ id: 3, keyId: 'k3', comment: 'gone@box', status: 'revoked' })] }),
    });
    const approved = await screen.findByTestId('adb-proxy-approved');
    expect(within(approved).getByText('dev@laptop')).toBeInTheDocument();
    expect(within(approved).queryByText('old@box')).toBeNull();
    fireEvent.click(within(approved).getByRole('button', { name: 'Revoke' }));
    expect(writes(calls)).toEqual([]);
    confirm();
    const blocked = screen.getByTestId('adb-proxy-blocked');
    expect(within(blocked).getByText('old@box')).toBeInTheDocument();
    expect(within(blocked).getByText('gone@box')).toBeInTheDocument();
    fireEvent.click(within(blocked).getAllByRole('button', { name: 'Forget', hidden: true })[0]);
    expect(writes(calls)).toEqual([{ method: 'POST', path: '/v1/adb-proxy/keys/1/revoke', body: undefined }]);
    confirm();
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'POST', path: '/v1/adb-proxy/keys/1/revoke', body: undefined },
      { method: 'DELETE', path: '/v1/adb-proxy/keys/2', body: undefined },
    ]));
  });

  it('makes no change when a revoke confirmation is cancelled', async () => {
    const { calls } = mount({ snapshot: snapshot({ keys: [keyRow()] }) });
    const approved = await screen.findByTestId('adb-proxy-approved');
    fireEvent.click(within(approved).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it('shows each device with its connect command and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount();
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    expect(within(row).getByText('adb connect 192.168.1.10:6500')).toBeInTheDocument();
    expect(within(row).getByText('Listening')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('adb connect 192.168.1.10:6500');
    expect(await within(row).findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('offers no copy button when the clipboard is unavailable', async () => {
    Object.assign(navigator, { clipboard: undefined });
    mount();
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    expect(within(row).getByText('adb connect 192.168.1.10:6500')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('changes a device port and toggles a device', async () => {
    const { calls } = mount();
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    fireEvent.change(within(row).getByLabelText('Port for Phone 1'), { target: { value: '6510' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save port' }));
    fireEvent.click(within(row).getByLabelText('Proxy Phone 1'));
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'PATCH', path: '/v1/adb-proxy/devices/DEV1', body: { port: 6510 } },
      { method: 'PATCH', path: '/v1/adb-proxy/devices/DEV1', body: { enabled: false } },
    ]));
  });

  it('does not send a device port that is empty or not a whole number', async () => {
    const { calls } = mount();
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    const input = within(row).getByLabelText('Port for Phone 1');
    for (const draft of ['', '6510.5']) {
      fireEvent.change(input, { target: { value: draft } });
      const save = within(row).getByRole('button', { name: 'Save port' });
      expect(save).toBeDisabled();
      fireEvent.click(save);
    }
    expect(writes(calls)).toEqual([]);
  });

  it('shows a readable message when the server refuses a port', async () => {
    mount({ failWith: 'in-use' });
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    fireEvent.change(within(row).getByLabelText('Port for Phone 1'), { target: { value: '6501' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save port' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That port is used by another device.');
  });

  it('reloads the list after a refused change', async () => {
    const { calls } = mount({ failWith: 'not-found', snapshot: snapshot({ pending: [pendingReq()] }) });
    const row = await screen.findByTestId('adb-proxy-request');
    const readsBefore = calls.filter((c) => c.method === 'GET').length;
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That item no longer exists.');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(readsBefore + 1));
  });

  it('saves the bind address and port range as numbers', async () => {
    const { calls } = mount();
    fireEvent.change(await screen.findByLabelText('Bind address'), { target: { value: '192.168.1.10' } });
    fireEvent.change(screen.getByLabelText('First port'), { target: { value: '7000' } });
    fireEvent.change(screen.getByLabelText('Last port'), { target: { value: '7009' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'PUT', path: '/v1/adb-proxy/settings', body: { bindHost: '192.168.1.10', portStart: 7000, portEnd: 7009 } },
    ]));
  });

  it('does not save the network settings while a field is empty or not a whole number', async () => {
    const { calls } = mount();
    const first = await screen.findByLabelText('First port');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(first, { target: { value: '7000' } });
    expect(save).toBeEnabled();
    fireEvent.change(first, { target: { value: '' } });
    expect(save).toBeDisabled();
    fireEvent.change(first, { target: { value: '7000.5' } });
    expect(save).toBeDisabled();
    fireEvent.change(first, { target: { value: '7000' } });
    fireEvent.change(screen.getByLabelText('Bind address'), { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(writes(calls)).toEqual([]);
  });

  it('lists only live connections', async () => {
    mount({
      snapshot: snapshot({
        connections: [
          { id: 1, deviceId: 'DEV1', peerIp: '10.0.0.7', state: 'ready', keyId: 'k1', comment: 'dev@laptop', since: Date.now() - 90_000, streams: 2 },
          { id: 2, deviceId: 'DEV1', peerIp: '10.0.0.8', state: 'pending', keyId: 'k2', comment: 'wait@box', since: Date.now(), streams: 0 },
        ],
      }),
    });
    const live = await screen.findByTestId('adb-proxy-connections');
    expect(within(live).getByText('10.0.0.7')).toBeInTheDocument();
    expect(within(live).queryByText('10.0.0.8')).toBeNull();
  });

  it('shows the name a live connection carries and (no name) when it carries none, without looking the key up', async () => {
    mount({
      snapshot: snapshot({
        keys: [keyRow({ keyId: 'k1', comment: 'dev@laptop' })],
        connections: [
          { id: 1, deviceId: 'DEV1', peerIp: '10.0.0.7', state: 'ready', keyId: 'k2', comment: 'ci@runner', since: Date.now() - 90_000, streams: 0 },
          { id: 2, deviceId: 'DEV1', peerIp: '10.0.0.8', state: 'ready', keyId: 'k1', comment: null, since: Date.now() - 90_000, streams: 0 },
        ],
      }),
    });
    const live = await screen.findByTestId('adb-proxy-connections');
    const rows = within(live).getAllByRole('row');
    expect(within(rows[1]).getByText('ci@runner')).toBeInTheDocument();
    expect(within(rows[2]).getByText('(no name)')).toBeInTheDocument();
  });

  it('lets every table scroll sideways inside its card so no column is out of reach on a narrow screen', async () => {
    mount({
      snapshot: snapshot({
        pending: [pendingReq()],
        keys: [keyRow(), keyRow({ id: 2, keyId: 'k2', status: 'revoked' })],
        connections: [{ id: 1, deviceId: 'DEV1', peerIp: '10.0.0.7', state: 'ready', keyId: 'k1', comment: 'dev@laptop', since: Date.now() - 90_000, streams: 0 }],
      }),
    });
    await screen.findByTestId('adb-proxy-pending');
    const tables = document.querySelectorAll('table');
    expect(tables).toHaveLength(5);
    for (const table of tables) expect(table.closest('.table-card')).toHaveStyle({ overflowX: 'auto' });
  });

  it('shows empty states', async () => {
    mount();
    expect(await screen.findByText('No machines are waiting for approval.')).toBeInTheDocument();
    expect(screen.getByText('No machines have been approved yet.')).toBeInTheDocument();
    expect(screen.getByText('No machines are connected.')).toBeInTheDocument();
  });

  it('updates when the server pushes a snapshot', async () => {
    const { push } = mount();
    await screen.findByText('No machines are waiting for approval.');
    push(snapshot({ pending: [pendingReq({ comment: 'fresh@box' })] }));
    expect(await screen.findByText('fresh@box')).toBeInTheDocument();
  });

  describe('ids that are object prototype keys', () => {
    it('renders, edits and saves devices named constructor, __proto__ and toString', async () => {
      const ids = ['constructor', '__proto__', 'toString'];
      const devices = ids.map((deviceId, i) => ({
        deviceId, name: null, port: 6500 + i, enabled: true, online: true, state: 'listening' as const,
      }));
      const { calls } = mount({ snapshot: snapshot({ devices }) });
      for (const [i, id] of ids.entries()) {
        const row = await screen.findByTestId(`adb-proxy-device-${id}`);
        fireEvent.change(within(row).getByLabelText(`Port for ${id}`), { target: { value: String(6590 + i) } });
        fireEvent.click(within(row).getByRole('button', { name: 'Save port' }));
      }
      await waitFor(() => expect(writes(calls)).toEqual(ids.map((id, i) => ({
        method: 'PATCH', path: `/v1/adb-proxy/devices/${id}`, body: { port: 6590 + i },
      }))));
    });

    it('shows an error code that is a prototype key as plain text', async () => {
      mount({ failWith: 'constructor', snapshot: snapshot({ pending: [pendingReq()] }) });
      fireEvent.click(within(await screen.findByTestId('adb-proxy-request')).getByRole('button', { name: 'Approve' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/^constructor$/);
    });
  });

  describe('repeated clicks while a call is in flight', () => {
    it('sends one Approve for two rapid clicks and locks the whole request until it settles', async () => {
      const { calls, release } = mount({ hold: true, snapshot: snapshot({ pending: [pendingReq()] }) });
      const row = await screen.findByTestId('adb-proxy-request');
      const approve = within(row).getByRole('button', { name: 'Approve' });
      const deny = within(row).getByRole('button', { name: 'Deny' });
      fireEvent.click(approve);
      fireEvent.click(approve);
      fireEvent.click(deny);
      expect(writes(calls)).toEqual([{ method: 'POST', path: '/v1/adb-proxy/requests/r1/approve', body: undefined }]);
      expect(approve).toBeDisabled();
      expect(deny).toBeDisabled();
      release();
      await waitFor(() => expect(approve).toBeEnabled());
      fireEvent.click(approve);
      await waitFor(() => expect(writes(calls)).toHaveLength(2));
    });

    it('sends one Deny for two rapid clicks', async () => {
      const { calls, release } = mount({ hold: true, snapshot: snapshot({ pending: [pendingReq()] }) });
      const deny = within(await screen.findByTestId('adb-proxy-request')).getByRole('button', { name: 'Deny' });
      fireEvent.click(deny);
      fireEvent.click(deny);
      expect(writes(calls)).toEqual([{ method: 'POST', path: '/v1/adb-proxy/requests/r1/deny', body: undefined }]);
      release();
      await waitFor(() => expect(deny).toBeEnabled());
    });

    it('sends one Revoke and one Forget per confirmed machine and disables the row meanwhile', async () => {
      const { calls, release } = mount({
        hold: true,
        snapshot: snapshot({ keys: [keyRow(), keyRow({ id: 2, keyId: 'k2', comment: 'old@box', status: 'denied' })] }),
      });
      const revoke = within(await screen.findByTestId('adb-proxy-approved')).getByRole('button', { name: 'Revoke' });
      fireEvent.click(revoke);
      confirm();
      fireEvent.click(revoke);
      expect(revoke).toBeDisabled();
      const forget = within(screen.getByTestId('adb-proxy-blocked')).getByRole('button', { name: 'Forget', hidden: true });
      fireEvent.click(forget);
      confirm();
      fireEvent.click(forget);
      expect(forget).toBeDisabled();
      expect(writes(calls)).toEqual([
        { method: 'POST', path: '/v1/adb-proxy/keys/1/revoke', body: undefined },
        { method: 'DELETE', path: '/v1/adb-proxy/keys/2', body: undefined },
      ]);
      release();
      await waitFor(() => expect(revoke).toBeEnabled());
      await waitFor(() => expect(forget).toBeEnabled());
    });

    it('sends one change for two rapid clicks on a device port save and a device toggle', async () => {
      const { calls, release } = mount({ hold: true });
      const row = await screen.findByTestId('adb-proxy-device-DEV1');
      fireEvent.change(within(row).getByLabelText('Port for Phone 1'), { target: { value: '6510' } });
      const save = within(row).getByRole('button', { name: 'Save port' });
      fireEvent.click(save);
      fireEvent.click(save);
      const toggle = within(row).getByLabelText('Proxy Phone 1');
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      expect(writes(calls)).toEqual([
        { method: 'PATCH', path: '/v1/adb-proxy/devices/DEV1', body: { port: 6510 } },
        { method: 'PATCH', path: '/v1/adb-proxy/devices/DEV1', body: { enabled: false } },
      ]);
      expect(save).toBeDisabled();
      expect(toggle).toBeDisabled();
      release();
      await waitFor(() => expect(toggle).toBeEnabled());
    });

    it('sends one change for two rapid clicks on the main switch', async () => {
      const { calls, release } = mount({ hold: true, snapshot: snapshot({ enabled: false }) });
      const toggle = await screen.findByTestId('adb-proxy-toggle');
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      expect(writes(calls)).toEqual([{ method: 'PUT', path: '/v1/adb-proxy/settings', body: { enabled: true } }]);
      expect(toggle).toBeDisabled();
      release();
      await waitFor(() => expect(toggle).toBeEnabled());
    });

    it('sends one network save for two rapid clicks', async () => {
      const { calls, release } = mount({ hold: true });
      fireEvent.change(await screen.findByLabelText('First port'), { target: { value: '7000' } });
      const save = screen.getByRole('button', { name: 'Save' });
      fireEvent.click(save);
      fireEvent.click(save);
      expect(writes(calls)).toEqual([
        { method: 'PUT', path: '/v1/adb-proxy/settings', body: { bindHost: '0.0.0.0', portStart: 7000, portEnd: 6599 } },
      ]);
      release();
      expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
    });
  });

  describe('guidance and confirmation text', () => {
    it('says the default bind address listens on every IPv4 interface, not every interface', async () => {
      mount();
      expect(await screen.findByText('0.0.0.0 listens on every IPv4 interface.')).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/listens on every interface/i);
    });

    it('says the machine name is not proof and what the fingerprint is for', async () => {
      mount({ snapshot: snapshot({ pending: [pendingReq()] }) });
      await screen.findByTestId('adb-proxy-request');
      expect(screen.getByText(/machine name is chosen by the connecting machine/i)).toHaveTextContent(
        /rely on the source address and the key fingerprint/i,
      );
      expect(screen.getByText(/machine name is chosen by the connecting machine/i)).toHaveTextContent(
        /fingerprint tells two machines with the same name apart and lets you recognise a key you approved before/i,
      );
      expect(document.body.textContent).not.toMatch(/fingerprint[^.]*\b(shown|printed|displayed) by\b/i);
    });

    it('identifies the machine by name, address and fingerprint start so same-name machines differ', async () => {
      mount({
        snapshot: snapshot({
          keys: [
            keyRow({ id: 1, comment: 'laptop', lastSeenIp: '10.0.0.7' }),
            keyRow({ id: 4, keyId: 'k4', comment: 'laptop', lastSeenIp: '10.0.0.9', fingerprint: '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00' }),
            keyRow({ id: 5, keyId: 'k5', comment: 'old@box', status: 'denied', lastSeenIp: null }),
          ],
        }),
      });
      const approved = await screen.findByTestId('adb-proxy-approved');
      const [first, second] = within(approved).getAllByRole('button', { name: 'Revoke' });

      fireEvent.click(first);
      expect(screen.getByTestId('modal')).toHaveTextContent('Revoke access for the machine at 10.0.0.7 with fingerprint starting AA:BB:CC:DD, named "laptop"?');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      fireEvent.click(second);
      expect(screen.getByTestId('modal')).toHaveTextContent('Revoke access for the machine at 10.0.0.9 with fingerprint starting 11:22:33:44, named "laptop"?');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      fireEvent.click(within(screen.getByTestId('adb-proxy-blocked')).getByRole('button', { name: 'Forget', hidden: true }));
      expect(screen.getByTestId('modal')).toHaveTextContent('Forget the machine with fingerprint starting AA:BB:CC:DD, named "old@box"?');
    });

    it('puts the address and fingerprint before a name that imitates them', async () => {
      const spoof = 'laptop" at 10.0.0.9 with fingerprint starting 11:22:33:44, named "laptop';
      mount({ snapshot: snapshot({ keys: [keyRow({ id: 1, comment: spoof, lastSeenIp: '10.0.0.7' })] }) });
      const approved = await screen.findByTestId('adb-proxy-approved');
      fireEvent.click(within(approved).getByRole('button', { name: 'Revoke' }));
      const text = screen.getByTestId('modal').textContent ?? '';
      const trusted = 'Revoke access for the machine at 10.0.0.7 with fingerprint starting AA:BB:CC:DD, named "';
      expect(text).toContain(`${trusted}${spoof}"?`);
      expect(text.indexOf(trusted)).toBeLessThan(text.indexOf(spoof));
      expect(text.indexOf('11:22:33:44')).toBeGreaterThan(text.indexOf('AA:BB:CC:DD'));
    });
  });

  describe('request paths and form values', () => {
    it('encodes ids that contain slashes, question marks and hashes', async () => {
      const id = 'a/b?c#d';
      const encoded = 'a%2Fb%3Fc%23d';
      const { calls } = mount({
        snapshot: snapshot({
          devices: [{ deviceId: id, name: 'Odd', port: 6500, enabled: true, online: true, state: 'listening' }],
          pending: [pendingReq({ requestId: id, deviceId: id }), pendingReq({ requestId: `${id}2`, keyId: 'k2', deviceId: id })],
        }),
      });
      const device = await screen.findByTestId(`adb-proxy-device-${id}`);
      fireEvent.click(within(device).getByLabelText('Proxy Odd'));
      fireEvent.change(within(device).getByLabelText('Port for Odd'), { target: { value: '6510' } });
      fireEvent.click(within(device).getByRole('button', { name: 'Save port' }));
      const [one, two] = screen.getAllByTestId('adb-proxy-request');
      fireEvent.click(within(one).getByRole('button', { name: 'Approve' }));
      fireEvent.click(within(two).getByRole('button', { name: 'Deny' }));
      await waitFor(() => expect(writes(calls)).toEqual([
        { method: 'PATCH', path: `/v1/adb-proxy/devices/${encoded}`, body: { enabled: false } },
        { method: 'PATCH', path: `/v1/adb-proxy/devices/${encoded}`, body: { port: 6510 } },
        { method: 'POST', path: `/v1/adb-proxy/requests/${encoded}/approve`, body: undefined },
        { method: 'POST', path: `/v1/adb-proxy/requests/${encoded}2/deny`, body: undefined },
      ]));
    });

    it('trims the bind address on save', async () => {
      const { calls } = mount();
      fireEvent.change(await screen.findByLabelText('Bind address'), { target: { value: '  192.168.1.10  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(writes(calls)).toEqual([
        { method: 'PUT', path: '/v1/adb-proxy/settings', body: { bindHost: '192.168.1.10', portStart: 6500, portEnd: 6599 } },
      ]));
    });

    it('keeps a dirty First port draft when a pushed snapshot changes Last port', async () => {
      const { push } = mount();
      const first = await screen.findByLabelText('First port');
      fireEvent.change(first, { target: { value: '7000' } });
      push(snapshot({ portEnd: 6700 }));
      expect(screen.getByLabelText('Last port')).toHaveValue(6700);
      expect(first).toHaveValue(7000);
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('keeps a dirty device port draft when a pushed snapshot changes that device', async () => {
      const { push } = mount();
      const row = await screen.findByTestId('adb-proxy-device-DEV1');
      fireEvent.change(within(row).getByLabelText('Port for Phone 1'), { target: { value: '6510' } });
      push(snapshot({ devices: [{ deviceId: 'DEV1', name: 'Phone 1', port: 6505, enabled: true, online: true, state: 'port-in-use' }] }));
      expect(within(row).getByLabelText('Port for Phone 1')).toHaveValue(6510);
      expect(within(row).getByRole('button', { name: 'Save port' })).toBeEnabled();
      expect(within(row).getByText('Port in use')).toBeInTheDocument();
    });
  });

  describe('server refusals', () => {
    it.each([
      ['an unmapped error code', 'disk-on-fire'],
      ['a settings refusal message', 'bind host must be an IP address'],
    ])('shows %s as it was sent', async (_name, failWith) => {
      mount({ failWith, snapshot: snapshot({ enabled: false }) });
      fireEvent.click(await screen.findByTestId('adb-proxy-toggle'));
      expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(`^${failWith}$`));
    });

    it('renders a hostile error message as text', async () => {
      const evil = '<img src=x onerror=alert(1)>';
      mount({ failWith: evil, snapshot: snapshot({ enabled: false }) });
      fireEvent.click(await screen.findByTestId('adb-proxy-toggle'));
      expect(await screen.findByRole('alert')).toHaveTextContent(evil);
      expect(document.querySelector('img')).toBeNull();
    });
  });

  describe('main switch accessibility', () => {
    it('keeps a fixed name and carries the state in aria-checked', async () => {
      const { push } = mount();
      const toggle = await screen.findByRole('switch', { name: 'ADB proxy' });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      push(snapshot({ enabled: false }));
      const after = await screen.findByRole('switch', { name: 'ADB proxy' });
      expect(after).toHaveAttribute('aria-checked', 'false');
    });
  });
});
