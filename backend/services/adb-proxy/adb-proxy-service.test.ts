import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyDevices, adbProxyKeys, deviceInstances, devices, settings, users } from '../../db/schema';
import { AdbProxyService } from './adb-proxy-service';
import { HostClient } from './host-client';
import { KeyStore } from './key-store';
import { DeviceListener } from './listener';
import { A_AUTH, A_CLSE, A_CNXN, AUTH_RSAPUBLICKEY } from './packet';
import type { PendingOptions } from './pending';
import { PendingRegistry } from './pending';
import { PortAllocator } from './port-allocator';
import { Session } from './session';
import { SettingsError, saveSettings } from './settings';
import { FakeAdbServer } from './testing/fake-adb-server';
import { freePortBase } from './testing/free-port';
import { StubDirectory } from './testing/stub-directory';
import { makeTestAdbKey, type TestAdbKey } from './testing/test-keys';
import { WireClient } from './testing/wire-client';

// The adb-proxy logger is destructured at import, so its functions are swapped at module level.
const { logSpy, errorSpy } = vi.hoisted(() => ({ logSpy: vi.fn(), errorSpy: vi.fn() }));
vi.mock('../../logs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logs')>();
  return {
    ...actual,
    createLoggers: (id: string, options?: { colour?: string }) => {
      const logger = actual.createLoggers(id, options);
      return id === 'adb-proxy' ? { ...logger, log: logSpy, error: errorSpy } : logger;
    },
  };
});

const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  logSpy.mockClear();
  errorSpy.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SetupOptions {
  enabled?: boolean;
  portCount?: number;
  online?: string[];
  pending?: PendingOptions;
  blockFirstPort?: boolean;
  reconcileMs?: number;
  bindHost?: string;
  logWindowMs?: number;
  logMaxDetail?: number;
  /** Replaces the callback that records each broadcast. */
  broadcast?: (message: Record<string, unknown>) => void;
  /** False leaves the service unstarted. */
  start?: boolean;
  /** Runs against the database before the service starts. */
  seed?: (db: ReturnType<typeof createTestDb>, base: number) => void;
}

async function setup(opts: SetupOptions = {}) {
  const fake = new FakeAdbServer([{ serial: 'DEV1' }, { serial: 'DEV2' }]);
  const backend = new HostClient(await fake.start(), 2000);
  const db = createTestDb([users, deviceInstances, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
  db.insert(users).values({ username: 'admin', providerId: 'local', createdAt: new Date(), updatedAt: new Date() }).run();
  db.insert(devices).values([{ id: 'DEV1', name: 'Phone 1' }, { id: 'DEV2', model: 'Pixel' }]).run();
  const base = await freePortBase();
  saveSettings(db, {
    enabled: opts.enabled ?? true,
    bindHost: opts.bindHost ?? '127.0.0.1',
    portStart: base,
    portEnd: base + (opts.portCount ?? 10) - 1,
  });
  if (opts.blockFirstPort) {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(base, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  }
  opts.seed?.(db, base);
  const directory = new StubDirectory(opts.online ?? ['DEV1', 'DEV2']);
  const broadcasts: Array<Record<string, any>> = [];
  const service = new AdbProxyService({
    db, directory, backend, broadcast: opts.broadcast ?? ((m) => broadcasts.push(m)), advertisedHost: () => '192.168.1.10', pending: opts.pending,
    reconcileMs: opts.reconcileMs, logWindowMs: opts.logWindowMs, logMaxDetail: opts.logMaxDetail,
  });
  if (opts.start !== false) await service.start();
  const clients: WireClient[] = [];
  const portOf = (deviceId: string) => service.snapshot().devices.find((d) => d.deviceId === deviceId)!.port!;
  const connect = async (deviceId = 'DEV1') => {
    const c = await WireClient.connect(portOf(deviceId));
    clients.push(c);
    return c;
  };
  cleanups.push(() => fake.stop(), () => service.stop(), () => clients.forEach((c) => c.close()));
  return { fake, db, base, backend, directory, service, broadcasts, connect, portOf };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function requestApproval(h: Harness, key: TestAdbKey, deviceId = 'DEV1') {
  const client = await h.connect(deviceId);
  await client.offerKey(key);
  await vi.waitFor(() =>
    expect(h.service.snapshot().pending.some((p) => p.keyId === key.keyId && p.deviceId === deviceId)).toBe(true),
  );
  return client;
}

async function approveKey(h: Harness, key: TestAdbKey, deviceId = 'DEV1') {
  const client = await requestApproval(h, key, deviceId);
  const req = h.service.snapshot().pending.find((p) => p.keyId === key.keyId)!;
  expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
  expect((await client.next()).command).toBe(A_CNXN);
  client.close();
}

async function expectPortFree(port: number) {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const stateOf = (h: Harness, id: string) => h.service.snapshot().devices.find((d) => d.deviceId === id)?.state;
const logged = () => logSpy.mock.calls.map((c) => String(c[0]));
const refusalLines = () => logged().filter((line) => line.includes('refused service "'));
const closeLines = () => logged().filter((line) => /^session \d+ closed/.test(line));
/** The lines a peer without an approved key can provoke, which share one budget. */
const peerLines = () =>
  logged().filter(
    (line) =>
      /^session \d+ closed/.test(line) || line.includes('is waiting for approval') || line.startsWith('blocked key ') || line.startsWith('dropped an approval request'),
  );
const summaryLines = () => logged().filter((line) => / more events suppressed \(/.test(line));

describe('AdbProxyService startup', () => {
  it('listens on nothing while disabled', async () => {
    const h = await setup({ enabled: false });
    const snap = h.service.snapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.devices.map((d) => [d.deviceId, d.state, d.port])).toEqual([['DEV1', 'off', null], ['DEV2', 'off', null]]);
  });

  it('binds nothing and allocates no port under the shipped defaults, with no settings stored', async () => {
    const deviceListen = vi.spyOn(DeviceListener.prototype, 'listen');
    const serverListen = vi.spyOn(net.Server.prototype, 'listen');
    const db = createTestDb([users, deviceInstances, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
    db.insert(devices).values({ id: 'DEV1', name: 'Phone 1' }).run();
    const service = new AdbProxyService({
      db, directory: new StubDirectory(['DEV1']), backend: new HostClient({ host: '127.0.0.1', port: 1 }, 100),
    });
    cleanups.push(() => service.stop());

    await service.start();

    const snap = service.snapshot();
    expect(snap).toMatchObject({ enabled: false, bindHost: '0.0.0.0', portStart: 6500, portEnd: 6599 });
    expect(snap.devices.map((d) => [d.deviceId, d.state, d.port])).toEqual([['DEV1', 'off', null]]);
    expect(deviceListen).not.toHaveBeenCalled();
    expect(serverListen).not.toHaveBeenCalled();
    expect(db.select().from(adbProxyDevices).all()).toEqual([]);
  });

  it('allocates the lowest free ports and listens for every online device once enabled', async () => {
    const h = await setup();
    const snap = h.service.snapshot();
    expect(snap.devices.map((d) => [d.deviceId, d.state, d.port])).toEqual([
      ['DEV1', 'listening', h.base], ['DEV2', 'listening', h.base + 1],
    ]);
    expect(snap.devices[0].name).toBe('Phone 1');
    expect(snap.advertisedHost).toBe('192.168.1.10');
  });

  it('reports a port held by another process without disturbing the other devices', async () => {
    const h = await setup({ blockFirstPort: true });
    expect(stateOf(h, 'DEV1')).toBe('port-in-use');
    expect(stateOf(h, 'DEV2')).toBe('listening');
  });

  it('reports range-full for a device that cannot get a port', async () => {
    const h = await setup({ portCount: 1 });
    expect(stateOf(h, 'DEV1')).toBe('listening');
    expect(stateOf(h, 'DEV2')).toBe('range-full');
  });

  it('shows a device with a stored port that is offline at startup as device-offline, not off', async () => {
    const h = await setup({
      online: ['DEV1'],
      seed: (db, base) => db.insert(adbProxyDevices).values({ deviceId: 'DEV2', port: base + 3, enabled: true, createdAt: new Date() }).run(),
    });
    expect(h.service.snapshot().devices.map((d) => [d.deviceId, d.state, d.online, d.port])).toEqual([
      ['DEV1', 'listening', true, h.base], ['DEV2', 'device-offline', false, h.base + 3],
    ]);
  });

  it('gives a second start() the in-flight promise, which settles only once the listeners are up', async () => {
    const h = await setup({ start: false });
    const listen = vi.spyOn(DeviceListener.prototype, 'listen');

    const first = h.service.start();
    const second = h.service.start();
    expect(second).toBe(first);
    await second;

    expect(h.service.snapshot().devices.map((d) => d.state)).toEqual(['listening', 'listening']);
    expect(listen).toHaveBeenCalledTimes(2);
  });
});

describe('AdbProxyService approval flow', () => {
  it('holds an unknown key, approves it, then accepts the key by signature and proxies a shell', async () => {
    const h = await setup();
    const key = makeTestAdbKey('ci@runner');
    const waiting = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    expect(req).toMatchObject({ comment: 'ci@runner', deviceId: 'DEV1', peerIp: '127.0.0.1' });
    expect(req.fingerprint).toMatch(/^([0-9A-F]{2}:){15}[0-9A-F]{2}$/);
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
    expect((await waiting.next()).command).toBe(A_CNXN);

    const again = await h.connect();
    expect((await again.authenticate(key)).command).toBe(A_CNXN);
    const { localId } = await again.open('shell:echo hi', 1);
    expect((await again.collectStream(1, localId, 'close')).toString()).toBe('ran: echo hi\n');

    const snap = h.service.snapshot();
    expect(snap.counters).toMatchObject({ approvals: 1, connections: 2 });
    expect(snap.keys).toHaveLength(1);
    expect(snap.keys[0]).toMatchObject({ status: 'approved', comment: 'ci@runner' });
    expect(snap.connections.filter((c) => c.state === 'ready')).toHaveLength(2);
  });

  it('names a connection after its stored key when the client proved itself by signature, and leaves a keyless one unnamed', async () => {
    const h = await setup();
    const key = makeTestAdbKey('ci@runner');
    await approveKey(h, key);
    await vi.waitFor(() => expect(h.service.snapshot().connections).toEqual([]));

    const returning = await h.connect();
    expect((await returning.authenticate(key)).command).toBe(A_CNXN);
    await h.connect();
    await vi.waitFor(() => expect(h.service.snapshot().connections).toHaveLength(2));

    const { connections } = h.service.snapshot();
    expect(connections.find((c) => c.state === 'ready')).toMatchObject({ keyId: key.keyId, comment: 'ci@runner' });
    expect(connections.find((c) => c.keyId === null)).toMatchObject({ comment: null });
  });

  it('denies a request, closes the client, and then ignores the key without a new request', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const client = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    expect(h.service.denyRequest(req.requestId, 1)).toEqual({ ok: true });
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.snapshot().keys[0].status).toBe('denied');
    const again = await h.connect();
    await again.offerKey(key);
    expect(await again.waitClosed()).toBe(true);
    expect(h.service.snapshot().pending).toEqual([]);
    expect(h.service.snapshot().counters.denials).toBe(1);
  });

  it('revokes an approved key: live sessions close and the key is refused afterwards', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    const rec = h.service.listKeys()[0];
    expect(h.service.revokeKey(rec.id, 1)).toEqual({ ok: true });
    expect(await live.waitClosed()).toBe(true);
    const again = await h.connect();
    await again.offerKey(key);
    expect(await again.waitClosed()).toBe(true);
    expect(h.service.revokeKey(rec.id, 1)).toEqual({ ok: false, error: 'not-approved' });
    expect(h.service.revokeKey(9999, 1)).toEqual({ ok: false, error: 'not-found' });
  });

  it('forgets a key: live sessions close and the machine can ask again', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    expect(h.service.forgetKey(h.service.listKeys()[0].id)).toEqual({ ok: true });
    expect(await live.waitClosed()).toBe(true);
    expect(h.service.listKeys()).toEqual([]);
    await requestApproval(h, key);
    expect(h.service.forgetKey(9999)).toEqual({ ok: false, error: 'not-found' });
  });

  it('one approval resolves the same key waiting on two devices', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const a = await requestApproval(h, key, 'DEV1');
    const b = await requestApproval(h, key, 'DEV2');
    expect(h.service.snapshot().pending).toHaveLength(2);
    h.service.approveRequest(h.service.snapshot().pending[0].requestId, 1);
    expect((await a.next()).command).toBe(A_CNXN);
    expect((await b.next()).command).toBe(A_CNXN);
    expect(h.service.listKeys()).toHaveLength(1);
  });

  it('answers not-found when approving a request whose client already left', async () => {
    const h = await setup();
    const client = await requestApproval(h, makeTestAdbKey());
    const [req] = h.service.snapshot().pending;
    client.close();
    await vi.waitFor(() => expect(h.service.snapshot().pending).toEqual([]));
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: false, error: 'not-found' });
    expect(h.service.denyRequest(req.requestId, 1)).toEqual({ ok: false, error: 'not-found' });
    expect(h.service.listKeys()).toEqual([]);
  });

  it('counts a failed signature as an auth failure', async () => {
    const h = await setup();
    await requestApproval(h, makeTestAdbKey());
    expect(h.service.snapshot().counters.authFailures).toBe(1);
  });

  it('creates no pending request for a key the client cannot prove it holds', async () => {
    const h = await setup();
    const client = await h.connect();
    await client.offerKeyWithoutProof(makeTestAdbKey('thief@elsewhere'));
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.snapshot().pending).toEqual([]);
  });

  it('refuses a stranger who copies an approved key public blob', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const stranger = await h.connect();
    await stranger.offerKeyWithoutProof(key);
    expect(await stranger.waitClosed()).toBe(true);
    expect(stranger.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.service.snapshot().connections.filter((c) => c.state === 'ready')).toHaveLength(0);
  });

  it('does not let a stranger take over a waiting request by presenting its public blob', async () => {
    const h = await setup();
    const key = makeTestAdbKey('legit@runner');
    const legit = await requestApproval(h, key);
    const stranger = await h.connect();
    await stranger.offerKeyWithoutProof(key);
    expect(await stranger.waitClosed()).toBe(true);
    const [req] = h.service.snapshot().pending;
    expect(req.comment).toBe('legit@runner');
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
    expect((await legit.next()).command).toBe(A_CNXN);
  });
});

describe('AdbProxyService settled decisions', () => {
  const longAgo = new Date('2026-01-01T00:00:00Z');
  const seedRecord = (h: Harness, key: TestAdbKey, status: 'approved' | 'denied' | 'revoked', deviceIds: string[] | null = ['DEV2']) =>
    h.db.insert(adbProxyKeys).values({
      keyId: key.keyId, publicKey: key.blob.toString('base64'), comment: 'earlier decision', status, deviceIds,
      firstSeenAt: longAgo, lastSeenAt: longAgo, lastSeenIp: '10.9.9.9', lastDeviceId: 'DEV2', decidedBy: null, decidedAt: longAgo,
    }).run();

  it.each([
    ['revoked', 'approve'], ['revoked', 'deny'], ['denied', 'approve'], ['denied', 'deny'],
  ] as const)('does not rewrite a %s record when a stale request is asked to %s', async (status, action) => {
    const h = await setup();
    const key = makeTestAdbKey('late@runner');
    const client = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    seedRecord(h, key, status);
    const before = h.db.select().from(adbProxyKeys).all();

    const result = action === 'approve' ? h.service.approveRequest(req.requestId, 1) : h.service.denyRequest(req.requestId, 1);

    expect(result).toEqual({ ok: false, error: 'not-found' });
    expect(h.db.select().from(adbProxyKeys).all()).toEqual(before);
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.service.snapshot().pending).toEqual([]);
    expect(h.service.snapshot().counters).toMatchObject({ approvals: 0, denials: 0 });
  });

  it('settles every pending entry of the key, on every device, when it refuses a stale decision', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const a = await requestApproval(h, key, 'DEV1');
    const b = await requestApproval(h, key, 'DEV2');
    const [req] = h.service.snapshot().pending;
    seedRecord(h, key, 'revoked');
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: false, error: 'not-found' });
    expect(await a.waitClosed()).toBe(true);
    expect(await b.waitClosed()).toBe(true);
  });

  it('approves a waiting request again for a record that is already approved', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const client = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    seedRecord(h, key, 'approved', null);
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
    expect((await client.next()).command).toBe(A_CNXN);
    expect(h.service.listKeys()).toHaveLength(1);
    expect(h.service.listKeys()[0].status).toBe('approved');
  });

  it('lets a deny through for a record that is approved', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const client = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    seedRecord(h, key, 'approved', null);
    expect(h.service.denyRequest(req.requestId, 1)).toEqual({ ok: true });
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.listKeys()[0].status).toBe('denied');
  });

  it('closes the live sessions of an approved key when a deny goes through for it', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const waiting = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    seedRecord(h, key, 'approved', null);
    const live = await h.connect('DEV2');
    expect((await live.authenticate(key)).command).toBe(A_CNXN);

    expect(h.service.denyRequest(req.requestId, 1)).toEqual({ ok: true });

    expect(await waiting.waitClosed()).toBe(true);
    expect(await live.waitClosed()).toBe(true);
    expect(h.service.listKeys()[0].status).toBe('denied');
  });

  it('releases only the waiting entries inside the allow-list of an approved record and denies the rest', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const inside = await requestApproval(h, key, 'DEV1');
    const outside = await requestApproval(h, key, 'DEV2');
    seedRecord(h, key, 'approved', ['DEV1']);
    const req = h.service.snapshot().pending.find((p) => p.deviceId === 'DEV1')!;

    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });

    expect((await inside.next()).command).toBe(A_CNXN);
    expect(await outside.waitClosed()).toBe(true);
    expect(outside.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.service.snapshot().pending).toEqual([]);
  });

  it('refuses to approve an entry outside the allow-list of an approved record, and still releases the one inside', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const inside = await requestApproval(h, key, 'DEV1');
    const outside = await requestApproval(h, key, 'DEV2');
    seedRecord(h, key, 'approved', ['DEV1']);
    const req = h.service.snapshot().pending.find((p) => p.deviceId === 'DEV2')!;

    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: false, error: 'not-found' });

    expect(await outside.waitClosed()).toBe(true);
    expect(outside.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect((await inside.next()).command).toBe(A_CNXN);
    expect(h.service.listKeys()[0]).toMatchObject({ status: 'approved', comment: 'earlier decision', deviceIds: ['DEV1'] });
    expect(h.service.snapshot().counters.approvals).toBe(0);
  });
});

describe('AdbProxyService device lifecycle', () => {
  it('closes sessions when a device goes offline, keeps its port, and accepts clients again after replug', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const port = h.portOf('DEV1');
    const live = await h.connect();
    await live.authenticate(key);

    h.directory.goOffline('DEV1');
    expect(await live.waitClosed()).toBe(true);
    expect(h.service.snapshot().devices.find((d) => d.deviceId === 'DEV1')).toMatchObject({ state: 'device-offline', port, online: false });
    const refused = await WireClient.connect(port);
    expect(await refused.waitClosed()).toBe(true);

    h.directory.goOnline('DEV1');
    await vi.waitFor(() => expect(stateOf(h, 'DEV1')).toBe('listening'));
    expect(h.portOf('DEV1')).toBe(port);
    const back = await h.connect();
    expect((await back.authenticate(key)).command).toBe(A_CNXN);
  });

  it('allocates a port when a new device comes online', async () => {
    const h = await setup({ online: ['DEV1'] });
    expect(h.service.snapshot().devices.map((d) => d.deviceId)).toEqual(['DEV1']);
    h.directory.goOnline('DEV2');
    await vi.waitFor(() => expect(stateOf(h, 'DEV2')).toBe('listening'));
  });

  it('refuses streams but keeps the session when the host ADB server goes away', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    await h.fake.stop();
    errorSpy.mockClear();
    expect((await live.openRaw('shell:id', 1)).command).toBe(A_CLSE);
    expect((await live.openRaw('shell:id', 2)).command).toBe(A_CLSE);
    expect(live.closed).toBe(false);
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes('ADB server request failed'))).toHaveLength(1);
  });

  it('treats an online event for a listening device and a repeated offline event as no-ops that change nothing and broadcast nothing', async () => {
    const h = await setup();
    const port = h.portOf('DEV1');
    const client = await h.connect();
    h.directory.goOffline('DEV2');
    await sleep(120);
    const settled = h.broadcasts.length;
    expect(stateOf(h, 'DEV2')).toBe('device-offline');

    h.directory.goOnline('DEV1');
    h.directory.goOffline('DEV2');
    await sleep(120);

    expect(h.broadcasts.length).toBe(settled);
    expect(stateOf(h, 'DEV1')).toBe('listening');
    expect(h.portOf('DEV1')).toBe(port);
    expect(stateOf(h, 'DEV2')).toBe('device-offline');
    expect(await client.waitClosed(100)).toBe(false);
  });
});

describe('AdbProxyService device presence reconciliation', () => {
  it('notices a device that vanished without an offline event, closes its sessions and reports it offline', async () => {
    const h = await setup({ reconcileMs: 20 });
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);

    h.directory.online.delete('DEV1');

    expect(await live.waitClosed()).toBe(true);
    await vi.waitFor(() => expect(stateOf(h, 'DEV1')).toBe('device-offline'), { timeout: 3000 });
    expect(stateOf(h, 'DEV2')).toBe('listening');
  });

  it('notices a device that appeared without an online event and starts listening for it', async () => {
    const h = await setup({ online: ['DEV1'], reconcileMs: 20 });
    expect(h.service.snapshot().devices.map((d) => d.deviceId)).toEqual(['DEV1']);

    h.directory.online.add('DEV2');

    await vi.waitFor(() => expect(stateOf(h, 'DEV2')).toBe('listening'), { timeout: 3000 });
  });

  it('keeps reconciling after the directory fails, logging the failure once', async () => {
    const h = await setup({ reconcileMs: 20 });
    const failing = vi.spyOn(h.directory, 'listOnlineAndroid').mockImplementation(() => {
      throw new Error('database is closed');
    });
    await vi.waitFor(() => expect(failing.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    expect(stateOf(h, 'DEV1')).toBe('listening');
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes('presence check failed'))).toHaveLength(1);
    failing.mockRestore();

    h.directory.online.delete('DEV2');
    await vi.waitFor(() => expect(stateOf(h, 'DEV2')).toBe('device-offline'), { timeout: 3000 });
  });

  it('stops polling the directory once the service has stopped', async () => {
    const h = await setup({ online: ['DEV1'], reconcileMs: 20 });
    await h.service.stop();
    const polled = vi.spyOn(h.directory, 'listOnlineAndroid');
    h.directory.online.add('DEV2');
    await sleep(120);
    expect(polled).not.toHaveBeenCalled();
    expect(h.service.snapshot().devices.map((d) => d.deviceId)).toEqual(['DEV1']);
    expect(h.db.select().from(adbProxyDevices).all().map((r) => r.deviceId)).toEqual(['DEV1']);
  });
});

describe('AdbProxyService key allow-lists', () => {
  it('refuses an approved key on a device outside its list without a pending request', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const rec = h.service.listKeys()[0];
    expect(h.service.setKeyDevices(rec.id, ['DEV2'])).toEqual({ ok: true });

    const outside = await h.connect('DEV1');
    expect((await outside.authenticate(key)).command).toBe(A_AUTH);
    outside.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, key.publicKeyText);
    expect(await outside.waitClosed()).toBe(true);
    expect(h.service.snapshot().pending).toEqual([]);

    const inside = await h.connect('DEV2');
    expect((await inside.authenticate(key)).command).toBe(A_CNXN);
  });

  it('closes live sessions on devices a restriction removes', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect('DEV1');
    await live.authenticate(key);
    h.service.setKeyDevices(h.service.listKeys()[0].id, ['DEV2']);
    expect(await live.waitClosed()).toBe(true);
  });

  it('normalises an empty list to unrestricted and rejects malformed input', async () => {
    const h = await setup();
    await approveKey(h, makeTestAdbKey());
    const id = h.service.listKeys()[0].id;
    expect(h.service.setKeyDevices(id, ['DEV1'])).toEqual({ ok: true });
    expect(h.service.setKeyDevices(id, [])).toEqual({ ok: true });
    expect(h.service.listKeys()[0].deviceIds).toBeNull();
    expect(h.service.setKeyDevices(id, [5 as unknown as string])).toEqual({ ok: false, error: 'invalid' });
    expect(h.service.setKeyDevices(9999, null)).toEqual({ ok: false, error: 'not-found' });
  });
});

describe('AdbProxyService settings and device options', () => {
  it('starts listeners when enabled at runtime and closes everything when disabled', async () => {
    const h = await setup({ enabled: false });
    await h.service.updateSettings({ enabled: true });
    expect(h.service.snapshot().devices.map((d) => d.state)).toEqual(['listening', 'listening']);
    const client = await h.connect();
    await h.service.updateSettings({ enabled: false });
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.snapshot().devices.map((d) => d.state)).toEqual(['off', 'off']);
  });

  it('rejects invalid settings and leaves the running state alone', async () => {
    const h = await setup();
    await expect(h.service.updateSettings({ bindHost: 'nope' })).rejects.toBeInstanceOf(SettingsError);
    expect(h.service.snapshot().enabled).toBe(true);
    expect(stateOf(h, 'DEV1')).toBe('listening');
  });

  it('gives a device that was out of ports another try when the range grows', async () => {
    const h = await setup({ portCount: 1 });
    expect(stateOf(h, 'DEV2')).toBe('range-full');
    await h.service.updateSettings({ portEnd: h.base + 3 });
    expect(h.service.snapshot().devices.find((d) => d.deviceId === 'DEV2')).toMatchObject({ state: 'listening', port: h.base + 1 });
  });

  it('moves a device to a new port and rejects bad ports', async () => {
    const h = await setup();
    const old = h.portOf('DEV1');
    expect(await h.service.setDevice('DEV1', { port: old + 5 })).toEqual({ ok: true });
    expect(h.portOf('DEV1')).toBe(old + 5);
    await expect(WireClient.connect(old)).rejects.toBeTruthy();
    const moved = await WireClient.connect(old + 5);
    moved.close();
    expect(await h.service.setDevice('DEV1', { port: 80 })).toEqual({ ok: false, error: 'out-of-range' });
    expect(await h.service.setDevice('DEV1', { port: h.portOf('DEV2') })).toEqual({ ok: false, error: 'in-use' });
    expect(await h.service.setDevice('NOPE', {})).toEqual({ ok: false, error: 'unknown-device' });
  });

  it('disables and re-enables a single device', async () => {
    const h = await setup();
    expect(await h.service.setDevice('DEV2', { enabled: false })).toEqual({ ok: true });
    expect(stateOf(h, 'DEV2')).toBe('disabled');
    expect(stateOf(h, 'DEV1')).toBe('listening');
    expect(await h.service.setDevice('DEV2', { enabled: true })).toEqual({ ok: true });
    expect(stateOf(h, 'DEV2')).toBe('listening');
  });

  it('answers range-full for a device that cannot be given a port', async () => {
    const h = await setup({ portCount: 1 });
    expect(await h.service.setDevice('DEV2', { enabled: true })).toEqual({ ok: false, error: 'range-full' });
  });

  it('answers unknown-device when the allocator has no row to move', async () => {
    const h = await setup();
    const old = h.portOf('DEV1');
    vi.spyOn(PortAllocator.prototype, 'setPort').mockReturnValueOnce(undefined);
    expect(await h.service.setDevice('DEV1', { port: old + 5 })).toEqual({ ok: false, error: 'unknown-device' });
    expect(h.portOf('DEV1')).toBe(old);
  });

  it('moves a device that is still binding to its new port instead of leaving the old listener', async () => {
    const h = await setup({ enabled: false });
    const enabling = h.service.updateSettings({ enabled: true });
    expect(await h.service.setDevice('DEV1', { port: h.base + 5 })).toEqual({ ok: true });
    await enabling;
    expect(h.portOf('DEV1')).toBe(h.base + 5);
    const moved = await WireClient.connect(h.base + 5);
    moved.close();
    await expectPortFree(h.base);
  });

  it('applies a disable and an enable fired back to back in order, ending on the original ports', async () => {
    const h = await setup();
    const ports = [h.portOf('DEV1'), h.portOf('DEV2')];

    const off = h.service.updateSettings({ enabled: false });
    const on = h.service.updateSettings({ enabled: true });
    await Promise.all([off, on]);

    expect(h.service.snapshot().devices.map((d) => [d.deviceId, d.state, d.port])).toEqual([
      ['DEV1', 'listening', ports[0]], ['DEV2', 'listening', ports[1]],
    ]);
    const client = await WireClient.connect(ports[0]);
    client.close();
  });

  it('runs later changes after an earlier one failed', async () => {
    const h = await setup();
    const bad = h.service.updateSettings({ bindHost: 'nope' });
    const good = h.service.updateSettings({ enabled: false });
    await expect(bad).rejects.toBeInstanceOf(SettingsError);
    await good;
    expect(h.service.snapshot().devices.map((d) => d.state)).toEqual(['off', 'off']);
  });

  it('stops without waiting for queued changes and leaves no port bound once they have run', async () => {
    const h = await setup({ enabled: false });
    const queued = [
      h.service.updateSettings({ enabled: true }),
      h.service.updateSettings({ enabled: false }),
      h.service.updateSettings({ enabled: true }),
    ];
    await h.service.stop();
    await Promise.allSettled(queued);
    await expectPortFree(h.base);
    await expectPortFree(h.base + 1);
  });
});

describe('AdbProxyService limits and reporting', () => {
  it('drops the ninth unauthenticated socket from one IP and counts it', async () => {
    const h = await setup();
    const port = h.portOf('DEV1');
    const open = async () => {
      const s = net.connect(port, '127.0.0.1');
      const closed = new Promise<void>((resolve) => s.once('close', () => resolve()));
      s.on('error', () => {});
      await new Promise<void>((resolve) => s.once('connect', () => resolve()));
      cleanups.push(() => s.destroy());
      return { s, closed };
    };
    const first = await Promise.all(Array.from({ length: 8 }, open));
    const ninth = await open();
    await ninth.closed;
    expect(h.service.snapshot().counters.floodDrops).toBe(1);
    first[0].s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const again = await open();
    await new Promise((r) => setTimeout(r, 100));
    expect(again.s.destroyed).toBe(false);
  });

  it('broadcasts a snapshot message after a change', async () => {
    const h = await setup();
    await requestApproval(h, makeTestAdbKey());
    await vi.waitFor(() => expect(h.broadcasts.some((m) => m.type === 'adb-proxy' && m.pending.length === 1)).toBe(true));
    const last = h.broadcasts.at(-1)!;
    expect(last.advertisedHost).toBe('192.168.1.10');
    expect(last.devices).toHaveLength(2);
  });

  it('logs a broadcast callback that always throws once, however many connect and close cycles re-arm the notify timer', async () => {
    const attempts = vi.fn(() => {
      throw new Error('socket gone');
    });
    const h = await setup({ broadcast: attempts });
    await vi.waitFor(() => expect(attempts).toHaveBeenCalled());
    for (let cycle = 1; cycle <= 4; cycle++) {
      const before = attempts.mock.calls.length;
      (await h.connect()).close();
      await vi.waitFor(() => expect(attempts.mock.calls.length).toBeGreaterThan(before));
    }
    const failures = errorSpy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('broadcast failed'));
    expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(failures).toEqual(['broadcast failed: socket gone']);
  });

  it('destroys a socket that has no remote address without giving it a pre-auth slot or counting it', async () => {
    const h = await setup();
    const reset = new net.Socket();

    (h.service as any).accept('DEV1', reset);

    expect(reset.destroyed).toBe(true);
    const snap = h.service.snapshot();
    expect(snap.connections).toEqual([]);
    expect(snap.counters).toMatchObject({ connections: 0, floodDrops: 0 });
  });

  it.skipIf(!Object.values(os.networkInterfaces()).flat().some((i) => i?.address === '::1'))(
    'records the IPv4 address of a peer that reaches a dual-stack listener',
    async () => {
      const h = await setup({ bindHost: '::' });
      await requestApproval(h, makeTestAdbKey());
      expect(h.service.snapshot().pending[0].peerIp).toBe('127.0.0.1');
      expect(h.service.snapshot().connections.map((c) => c.peerIp)).toEqual(['127.0.0.1']);
    },
  );

  it('stop() closes sessions and frees the ports', async () => {
    const h = await setup();
    const port = h.portOf('DEV1');
    const client = await h.connect();
    await h.service.stop();
    expect(await client.waitClosed()).toBe(true);
    await expectPortFree(port);
  });
});

describe('AdbProxyService refusal logging', () => {
  const approvedLiveClient = async (h: Harness) => {
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    return live;
  };

  it('writes maxDetail lines for a burst of refused services, counts the rest, and nothing comes from the session', async () => {
    const h = await setup({ logWindowMs: 600_000, logMaxDetail: 3 });
    const live = await approvedLiveClient(h);
    await sleep(100);
    logSpy.mockClear();
    errorSpy.mockClear();
    const broadcastsBefore = h.broadcasts.length;

    for (let i = 1; i <= 20; i++) expect((await live.openRaw(`host:version-${i}`, i)).command).toBe(A_CLSE);

    expect(refusalLines()).toHaveLength(3);
    expect(refusalLines()[0]).toContain('host:version-1"');
    expect(errorSpy).not.toHaveBeenCalled();
    await sleep(100);
    expect(h.broadcasts.length).toBe(broadcastsBefore);
    await h.service.stop();
    expect(summaryLines()).toEqual(['17 more events suppressed (17 refused service)']);
  });

  it('keeps refusals out of the budget shared by peers without an approved key, and gives them one of their own', async () => {
    const h = await setup({ logWindowMs: 600_000, logMaxDetail: 1 });
    const live = await approvedLiveClient(h);
    await requestApproval(h, makeTestAdbKey());
    for (let i = 1; i <= 4; i++) expect((await live.openRaw(`tcpip:${i}`, i)).command).toBe(A_CLSE);

    expect(refusalLines()).toHaveLength(1);
    await h.service.stop();
    expect(summaryLines()).toHaveLength(2);
    expect(summaryLines()).toContain('3 more events suppressed (3 refused service)');
    expect(summaryLines()).toContain('2 more events suppressed (1 approval request, 1 unauthenticated close)');
  });

  it('strips control characters and caps the length of a hostile service string', async () => {
    const h = await setup();
    const live = await approvedLiveClient(h);
    logSpy.mockClear();

    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const hostile = `tcpip:\n\u001b[2Kfake${lineSeparator}tail${'x'.repeat(100)}`;
    expect((await live.openRaw(hostile, 1)).command).toBe(A_CLSE);

    const [line] = refusalLines();
    for (const control of ['\n', '\r', '\u001b', lineSeparator, paragraphSeparator]) expect(line).not.toContain(control);
    const shown = /refused service "([^"]*)"/.exec(line)![1];
    expect(shown).toBe(`tcpip:??[2Kfake?tail${'x'.repeat(40)}`);
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown).toMatch(/^[\x20-\x7e]*$/);
  });
});

describe('AdbProxyService log flooding by peers without an approved key', () => {
  /** Opens and drops `total` bare connections in batches that stay under the per-peer pre-auth cap. */
  const bareCycles = async (h: Harness, total: number, perBatch = 5) => {
    const port = h.portOf('DEV1');
    for (let done = 0; done < total; done += perBatch) {
      const size = Math.min(perBatch, total - done);
      const batch = await Promise.all(Array.from({ length: size }, () => WireClient.connect(port)));
      await vi.waitFor(() => expect(h.service.snapshot().counters.connections).toBe(done + size), { interval: 5, timeout: 3000 });
      batch.forEach((c) => c.close());
      await vi.waitFor(() => expect(h.service.snapshot().connections).toEqual([]), { interval: 5, timeout: 3000 });
    }
  };

  // A window this long keeps each test inside one window, so nothing here depends on how fast the machine is.
  const ONE_WINDOW = 600_000;

  it('writes maxDetail lines for 500 bare connection closes and one summary at stop, with exact counters', async () => {
    const h = await setup({ logWindowMs: ONE_WINDOW, logMaxDetail: 5 });

    await bareCycles(h, 500, 8);

    expect(closeLines()).toHaveLength(5);
    expect(peerLines()).toHaveLength(5);
    expect(h.service.snapshot().counters).toEqual({ connections: 500, approvals: 0, denials: 0, authFailures: 0, floodDrops: 0 });
    await h.service.stop();
    expect(summaryLines()).toEqual(['495 more events suppressed (495 unauthenticated close)']);
  }, 30_000);

  it('draws closes, approval requests and blocked offers from one budget', async () => {
    const h = await setup({ logWindowMs: ONE_WINDOW, logMaxDetail: 4 });
    const key = makeTestAdbKey();
    const first = await requestApproval(h, key);
    expect(h.service.denyRequest(h.service.snapshot().pending[0].requestId, 1)).toEqual({ ok: true });
    expect(await first.waitClosed()).toBe(true);

    for (let i = 0; i < 5; i++) {
      const client = await h.connect();
      await client.offerKey(key);
      expect(await client.waitClosed()).toBe(true);
    }

    expect(peerLines()).toHaveLength(4);
    expect(peerLines().map((line) => line.split(' ')[0])).toEqual(['key', 'session', 'blocked', 'session']);
    await h.service.stop();
    expect(summaryLines()).toEqual(['8 more events suppressed (4 blocked key, 4 unauthenticated close)']);
  });

  it('counts the approval requests and the closes of a peer that loops one key, within the same budget', async () => {
    const h = await setup({ logWindowMs: ONE_WINDOW, logMaxDetail: 5 });
    const key = makeTestAdbKey();
    let previous = '';
    for (let i = 0; i < 10; i++) {
      const client = await h.connect();
      await client.offerKey(key);
      await vi.waitFor(() => expect(h.service.snapshot().pending[0]?.requestId ?? previous).not.toBe(previous), { interval: 5, timeout: 3000 });
      previous = h.service.snapshot().pending[0].requestId;
    }

    expect(peerLines()).toHaveLength(5);
    await h.service.stop();
    const [summary] = summaryLines();
    expect(summaryLines()).toHaveLength(1);
    expect(summary).toMatch(/^15 more events suppressed \(/);
    expect(summary).toContain('approval request');
    expect(summary).toContain('unauthenticated close');
  });

  it('counts approval request flood drops in the same budget and keeps the counter exact', async () => {
    const h = await setup({ logWindowMs: ONE_WINDOW, logMaxDetail: 5, pending: { perIpPerMinute: 1 } });
    const first = await requestApproval(h, makeTestAdbKey());

    for (let i = 0; i < 6; i++) {
      const client = await h.connect();
      await client.offerKey(makeTestAdbKey());
      expect(await client.waitClosed()).toBe(true);
    }
    first.close();
    await vi.waitFor(() => expect(h.service.snapshot().connections).toEqual([]), { interval: 5, timeout: 3000 });

    expect(h.service.snapshot().counters.floodDrops).toBe(6);
    expect(peerLines()).toHaveLength(5);
    await h.service.stop();
    expect(summaryLines()).toEqual(['9 more events suppressed (4 approval flood-drop, 5 unauthenticated close)']);
  });

  it('still logs the close of a session that authenticated once the budget is spent', async () => {
    const h = await setup({ logWindowMs: ONE_WINDOW, logMaxDetail: 2 });
    await bareCycles(h, 3);
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    live.close();

    await vi.waitFor(() => expect(closeLines().filter((line) => !line.includes('key=-'))).toHaveLength(2), { interval: 5, timeout: 3000 });
    expect(closeLines().filter((line) => line.includes('key=-'))).toHaveLength(2);
  });

  it('keeps the admin audit lines while the peer lines are suppressed', async () => {
    const h = await setup({ logWindowMs: ONE_WINDOW });
    await bareCycles(h, 10);
    await approveKey(h, makeTestAdbKey());
    const first = h.service.listKeys()[0];
    expect(h.service.revokeKey(first.id, 1)).toEqual({ ok: true });
    const waiting = await requestApproval(h, makeTestAdbKey());
    expect(h.service.denyRequest(h.service.snapshot().pending[0].requestId, 1)).toEqual({ ok: true });
    await waiting.waitClosed();

    for (const prefix of ['approved key ', 'revoked key ', 'denied key ']) {
      expect(logged().some((line) => line.startsWith(prefix))).toBe(true);
    }
  });
});

describe('AdbProxyService stop() and lifetime', () => {
  it('cancels waiting requests and closes their clients', async () => {
    const h = await setup();
    const client = await requestApproval(h, makeTestAdbKey());
    await h.service.stop();
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.snapshot().pending).toEqual([]);
  });

  it('destroys sessions and closes every listener before it stops the pending registry', async () => {
    const h = await setup();
    await requestApproval(h, makeTestAdbKey());
    const destroyed = vi.spyOn(Session.prototype, 'destroy');
    const closedListener = vi.spyOn(DeviceListener.prototype, 'close');
    const stoppedPending = vi.spyOn(PendingRegistry.prototype, 'stop');

    await h.service.stop();

    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(closedListener).toHaveBeenCalledTimes(2);
    expect(stoppedPending).toHaveBeenCalledTimes(1);
    const last = Math.max(...destroyed.mock.invocationCallOrder, ...closedListener.mock.invocationCallOrder);
    expect(last).toBeLessThan(stoppedPending.mock.invocationCallOrder[0]);
  });

  it('settles while a lifecycle change is parked half-way, and the changes queued behind it then bind nothing', async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanups.push(() => release());
    const close = DeviceListener.prototype.close;
    const parkedClose = vi.spyOn(DeviceListener.prototype, 'close').mockImplementationOnce(function (this: DeviceListener) {
      return gate.then(() => close.call(this));
    });
    const parked = h.service.updateSettings({ enabled: false });
    await vi.waitFor(() => expect(parkedClose).toHaveBeenCalled());
    const queued = h.service.updateSettings({ enabled: true });

    expect(await settlesWithin(h.service.stop(), 2000)).toBe(true);

    release();
    await Promise.allSettled([parked, queued]);
    await expectPortFree(h.base);
    await expectPortFree(h.base + 1);
  });

  it('refuses to start again after it was stopped', async () => {
    const h = await setup();
    await h.service.stop();
    await expect(h.service.start()).rejects.toThrow('AdbProxyService was stopped; create a new instance');
  });

  it('lets a new instance take over the ports, with its own pending requests, after the old one stopped', async () => {
    const h = await setup();
    const port = h.portOf('DEV1');
    await h.service.stop();
    const next = new AdbProxyService({ db: h.db, directory: h.directory, backend: h.backend, advertisedHost: () => '192.168.1.10' });
    cleanups.push(() => next.stop());
    await next.start();
    expect(next.snapshot().devices.find((d) => d.deviceId === 'DEV1')).toMatchObject({ state: 'listening', port });

    const client = await WireClient.connect(port);
    cleanups.push(() => client.close());
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(next.snapshot().pending).toHaveLength(1));
    expect(h.service.snapshot().pending).toEqual([]);
  });

  it('has closed every listener, including binds still in flight, by the time stop() resolves', async () => {
    const h = await setup({ enabled: false });
    const created: DeviceListener[] = [];
    const closed: DeviceListener[] = [];
    const listen = DeviceListener.prototype.listen;
    const close = DeviceListener.prototype.close;
    vi.spyOn(DeviceListener.prototype, 'listen').mockImplementation(function (this: DeviceListener) {
      created.push(this);
      return listen.call(this);
    });
    vi.spyOn(DeviceListener.prototype, 'close').mockImplementation(function (this: DeviceListener) {
      const done = close.call(this);
      void done.then(() => closed.push(this));
      return done;
    });

    const enabling = h.service.updateSettings({ enabled: true });
    await h.service.stop();

    expect(created).toHaveLength(2);
    expect(closed).toHaveLength(2);
    await enabling;
    await expectPortFree(h.base);
    await expectPortFree(h.base + 1);
  });
});

describe('AdbProxyService first use of an approved key', () => {
  it('writes the key row before the waiting session is released, so its first use is recorded', async () => {
    const h = await setup();
    const rowExistedAtTouch: boolean[] = [];
    const touch = KeyStore.prototype.touch;
    vi.spyOn(KeyStore.prototype, 'touch').mockImplementation(function (this: KeyStore, keyId, ip, deviceId) {
      rowExistedAtTouch.push(this.findByKeyId(keyId) !== undefined);
      return touch.call(this, keyId, ip, deviceId);
    });
    const key = makeTestAdbKey();
    const client = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;

    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
    expect((await client.next()).command).toBe(A_CNXN);

    expect(rowExistedAtTouch).toEqual([true]);
    expect(h.service.listKeys()[0]).toMatchObject({ lastSeenIp: '127.0.0.1', lastDeviceId: 'DEV1' });
  });
});
