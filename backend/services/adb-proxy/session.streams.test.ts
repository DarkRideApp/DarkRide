import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAdbPublicKey } from './adb-key';
import {
  A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_VERSION, A_WRTE, AUTH_SIGNATURE, MAX_DATA, PROXY_MAX_PAYLOAD,
  PacketParser, encodePacket, type Packet,
} from './packet';
import { HostClient } from './host-client';
import { Session, checkService, type BackendConnector, type SessionEvent } from './session';
import { FakeAdbServer } from './testing/fake-adb-server';
import { StubGate } from './testing/stub-gate';
import { makeTestAdbKey } from './testing/test-keys';
import { startSessionServer } from './testing/session-server';
import { WireClient } from './testing/wire-client';

const { logErrorSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn() }));
vi.mock('../../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: logErrorSpy }) }));

const cleanups: Array<() => unknown> = [];
const escapes: unknown[] = [];
const recordEscape = (e: unknown) => { escapes.push(e); };

interface SetupOptions {
  maxStreams?: number;
  /** The max data the client advertises in its CNXN. */
  clientMaxData?: number;
  shell?: (serial: string, command: string) => string;
  /** Wraps the real backend so a test can inject faults. */
  backend?: (real: HostClient) => BackendConnector;
}

async function setup(opts: SetupOptions = {}) {
  const fake = new FakeAdbServer([{ serial: 'DEV1' }], { shell: opts.shell });
  const real = new HostClient(await fake.start(), 2000);
  const backend = opts.backend ? opts.backend(real) : real;
  const key = makeTestAdbKey();
  const gate = new StubGate();
  gate.approved = [{ keyId: key.keyId, key: parseAdbPublicKey(key.publicKeyText).key }];
  const events: SessionEvent[] = [];
  const closed: Session[] = [];
  const server = await startSessionServer((socket) =>
    new Session({
      socket, deviceId: 'DEV1', peerIp: '10.0.0.5', gate, backend,
      isDeviceOnline: () => true, maxStreams: opts.maxStreams,
      onEvent: (e) => events.push(e), onClose: (s) => closed.push(s),
    }),
  );
  const client = await WireClient.connect(server.port);
  cleanups.push(() => client.close(), () => server.close(), () => fake.stop());
  await client.authenticate(key, opts.clientMaxData);
  return { fake, server, client, events, closed, baseline: [...fake.requests] };
}

type Fault = 'pause' | 'resume' | 'write' | 'destroy' | 'on';

/** A stand-in for the backend socket whose methods can be made to throw. */
class FakeBackendSocket extends EventEmitter {
  destroyed = false;
  readableEnded = false;
  destroyCalls = 0;
  writeError: Error | null = null;
  /** Hold every write callback until the test calls the entries of `pendingWrites`. */
  deferWrites = false;
  readonly faults = new Set<Fault>();
  readonly written: Buffer[] = [];
  readonly pendingWrites: Array<() => void> = [];

  private maybeThrow(fault: Fault): void {
    if (this.faults.has(fault)) throw new Error(`${fault} boom`);
  }

  pause(): this { this.maybeThrow('pause'); return this; }
  resume(): this { this.maybeThrow('resume'); return this; }
  write(data: Buffer, cb?: (err?: Error | null) => void): boolean {
    this.maybeThrow('write');
    this.written.push(data);
    if (this.deferWrites) this.pendingWrites.push(() => cb?.(this.writeError));
    else cb?.(this.writeError);
    return true;
  }
  destroy(): this {
    this.destroyCalls++;
    this.destroyed = true;
    this.maybeThrow('destroy');
    return this;
  }
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    this.maybeThrow('on');
    return super.on(event, listener);
  }
  asSocket(): net.Socket { return this as unknown as net.Socket; }
}

/** The real backend, except that `pick` may hand back a fake socket (or an Error to throw) for a service. */
function fakeBackend(pick: (service: string) => FakeBackendSocket | Error | undefined) {
  return (real: HostClient): BackendConnector => ({
    openService: (serial, service) => {
      const hit = pick(service);
      if (hit instanceof Error) throw hit;
      return hit ? Promise.resolve(hit.asSocket()) : real.openService(serial, service);
    },
    deviceBanner: (serial) => real.deviceBanner(serial),
  });
}

async function setupWithFake(prepare: (sock: FakeBackendSocket) => void = () => {}, extra: SetupOptions = {}) {
  const sock = new FakeBackendSocket();
  prepare(sock);
  const h = await setup({ ...extra, backend: fakeBackend((s) => (s === 'fake:' ? sock : undefined)) });
  return { h, sock };
}

/** A client-side socket whose writes can be stalled, so the bytes queued for the client stay in the writable buffer. */
class StallableSocket extends Duplex {
  readonly sent: Packet[] = [];
  stalled = false;
  private held: Array<() => void> = [];
  private readonly parser = new PacketParser(MAX_DATA);

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.sent.push(...this.parser.push(chunk));
    if (this.stalled) this.held.push(() => cb());
    else cb();
  }

  release(): void {
    this.stalled = false;
    for (const flush of this.held.splice(0)) flush();
  }
}

/** A session on a StallableSocket, taken through the whole handshake to the ready state. */
async function readySessionOnStallableSocket() {
  const sock = new StallableSocket();
  const key = makeTestAdbKey();
  const gate = new StubGate();
  gate.approved = [{ keyId: key.keyId, key: parseAdbPublicKey(key.publicKeyText).key }];
  const backend: BackendConnector = { openService: vi.fn(), deviceBanner: async () => 'device::features=cmd' };
  const session = new Session({
    socket: sock as unknown as net.Socket, deviceId: 'DEV1', peerIp: '10.0.0.5', gate, backend, isDeviceOnline: () => true,
  });
  cleanups.push(() => session.destroy('test over'));
  sock.push(encodePacket({ command: A_CNXN, arg0: A_VERSION, arg1: MAX_DATA, data: Buffer.from('host::features=cmd\0') }));
  await vi.waitFor(() => expect(sock.sent.some((p) => p.command === A_AUTH)).toBe(true));
  const token = sock.sent.find((p) => p.command === A_AUTH)!;
  sock.push(encodePacket({ command: A_AUTH, arg0: AUTH_SIGNATURE, arg1: 0, data: key.sign(token.data) }));
  await vi.waitFor(() => expect(session.state).toBe('ready'));
  return { sock, session };
}

/** Fails the test if an uncaught exception or unhandled rejection reached the process. */
async function expectNothingEscaped(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  expect(escapes).toEqual([]);
}

beforeEach(() => {
  escapes.length = 0;
  logErrorSpy.mockClear();
  process.on('unhandledRejection', recordEscape);
  process.on('uncaughtException', recordEscape);
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  process.off('unhandledRejection', recordEscape);
  process.off('uncaughtException', recordEscape);
});

describe('checkService', () => {
  it.each([
    'shell:ls', 'shell,v2,raw:ls', 'sync:', 'exec:cat', 'tcp:5555', 'localabstract:x', 'jdwp:12', 'abb_exec:x', 'framebuffer:', 'root:', 'reboot:',
    'abb_exec:package\0install\0-S\x00300000', 'abb_exec:settings\0get\0global\0enable_adb_incremental_install_default', 'abb:package\0list\0packages',
  ])(
    'allows %j', (s) => { expect(checkService(s)).toEqual({ allowed: true }); },
  );
  it.each([
    'host:kill', 'host:connect:1.2.3.4:5555', 'host-serial:X:features', 'host-usb:version', 'hostfoo', 'reverse:forward:tcp:1', 'tcpip:5555', 'usb:', '',
    'a\0b', 'shell:a\0b', 'exec:a\0b', 'sync:\0', 'host:x\0', 'host:kill\0abb_exec:x', '\0abb_exec:x', '\0shell:id', ' abb_exec:x\0y', 'ABB_EXEC:x\0y', 'abb_exec\0:x',
  ])(
    'refuses %j', (s) => { expect(checkService(s).allowed).toBe(false); },
  );
  it('names the NUL as the reason for a NUL in any other service', () => {
    expect(checkService('shell:a\0b')).toEqual({ allowed: false, reason: 'NUL in service' });
  });
  it('refuses an oversize service', () => {
    expect(checkService('shell:' + 'x'.repeat(5000)).allowed).toBe(false);
  });
});

describe('Session streams', () => {
  it('forwards a shell service through the backend and delivers its output, then closes', async () => {
    const h = await setup();
    const reply = await h.client.openRaw('shell:echo hi', 1);
    expect(reply.command).toBe(A_OKAY);
    expect(reply.arg1).toBe(1);
    const out = await h.client.collectStream(1, reply.arg0, 'close');
    expect(out.toString()).toBe('ran: echo hi\n');
    expect(h.fake.requests).toContain('host:transport:DEV1');
    expect(h.fake.requests).toContain('shell:echo hi');
  });

  it('relays client writes to the backend, acks them, and returns the echo', async () => {
    const h = await setup();
    const { localId } = await h.client.open('echo:', 1);
    h.client.send(A_WRTE, 1, localId, 'abc');
    const echoed = await h.client.collectStream(1, localId, 3);
    expect(echoed.toString()).toBe('abc');
    const acks = h.client.packets.filter((p) => p.command === A_OKAY && p.arg0 === localId && p.arg1 === 1);
    expect(acks).toHaveLength(2);
  });

  it('echoes a 64 KiB write back whole', async () => {
    const h = await setup();
    const { localId } = await h.client.open('echo:', 1);
    h.client.send(A_WRTE, 1, localId, Buffer.alloc(65536, 'z'));
    const got = await h.client.collectStream(1, localId, 65536);
    expect(got.length).toBe(65536);
    expect(got.every((b) => b === 0x7a)).toBe(true);
  });

  it('keeps one WRTE in flight until the client acknowledges it', async () => {
    const h = await setup();
    const { localId } = await h.client.open('flood:300000', 1);
    await new Promise((r) => setTimeout(r, 200));
    const writes = h.client.packets.filter((p) => p.command === A_WRTE && p.arg0 === localId);
    expect(writes).toHaveLength(1);
    expect(writes[0].data.length).toBeLessThanOrEqual(PROXY_MAX_PAYLOAD);
    const all = await h.client.collectStream(1, localId, 'close');
    expect(all.length).toBe(300000);
  });

  it('refuses host, reverse, tcpip and usb services without contacting the backend', async () => {
    const h = await setup();
    const services = ['host:kill', 'host:connect:1.2.3.4:5555', 'host-serial:DEV1:features', 'hostfoo', 'reverse:forward:tcp:1234', 'tcpip:5555', 'usb:'];
    for (const [i, service] of services.entries()) {
      const reply = await h.client.openRaw(service, 10 + i);
      expect(reply.command).toBe(A_CLSE);
      expect(reply.arg0).toBe(0);
      expect(reply.arg1).toBe(10 + i);
    }
    expect(h.fake.requests).toEqual(h.baseline);
    expect(h.events.filter((e) => e.kind === 'refused-service')).toHaveLength(services.length);
    expect(h.fake.requests.some((r) => r.startsWith('host:kill'))).toBe(false);
  });

  it('answers a refusal storm with one CLSE each and no other work', async () => {
    const h = await setup();
    const storm = 2000;
    const burst: Buffer[] = [];
    for (let i = 0; i < storm; i++) {
      burst.push(encodePacket({ command: A_OPEN, arg0: 1000 + i, arg1: 0, data: Buffer.from('host:kill\0') }));
    }
    h.client.socket.write(Buffer.concat(burst));
    await vi.waitFor(() => expect(h.client.packets.filter((p) => p.command === A_CLSE)).toHaveLength(storm), { timeout: 5000 });
    const ids = h.client.packets.filter((p) => p.command === A_CLSE).map((p) => p.arg1);
    expect(ids).toEqual(Array.from({ length: storm }, (_, i) => 1000 + i));
    expect(h.client.packets.every((p) => p.arg0 === 0 || p.command !== A_CLSE)).toBe(true);
    expect(h.fake.requests).toEqual(h.baseline);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(h.events.filter((e) => e.kind === 'refused-service')).toHaveLength(storm);
    expect(logErrorSpy).not.toHaveBeenCalled();
    h.client.send(A_OPEN, 1, 0, 'hold:\0');
    await h.client.waitFor((p) => p.command === A_OKAY && p.arg1 === 1);
    await expectNothingEscaped();
  });

  it('refuses an OPEN whose payload has bytes after the NUL', async () => {
    const h = await setup();
    h.client.send(A_OPEN, 5, 0, Buffer.from('shell:id\0extra'));
    const reply = await h.client.next();
    expect(reply.command).toBe(A_CLSE);
    expect(reply.arg1).toBe(5);
    expect(h.fake.requests).toEqual(h.baseline);
  });

  it('passes NUL separated abb_exec and abb services to the backend unchanged, less the OPEN terminator', async () => {
    const h = await setup();
    const install = 'abb_exec:package\0install\0-S\x00300000';
    const list = 'abb:package\0list\0packages';
    for (const [i, service] of [install, list].entries()) {
      h.client.send(A_OPEN, 20 + i, 0, Buffer.from(service + '\0'));
      await h.client.waitFor((p) => (p.command === A_OKAY || p.command === A_CLSE) && p.arg1 === 20 + i);
    }
    const reached = h.fake.requests.slice(h.baseline.length).filter((r) => r.startsWith('abb'));
    expect(reached.map((r) => Buffer.from(r))).toEqual([Buffer.from(install), Buffer.from(list)]);
    expect(h.events.filter((e) => e.kind === 'refused-service')).toEqual([]);
  });

  it.each([
    ['shell:a\0b'], ['exec:a\0b'], ['host:x\0'], ['\0shell:id'], ['\0abb_exec:package\0install'],
  ])('refuses the OPEN %j and reports it without contacting the backend', async (service) => {
    const h = await setup();
    h.client.send(A_OPEN, 9, 0, Buffer.from(service + '\0'));
    const reply = await h.client.next();
    expect(reply.command).toBe(A_CLSE);
    expect(reply.arg1).toBe(9);
    expect(h.fake.requests).toEqual(h.baseline);
    expect(h.events.filter((e) => e.kind === 'refused-service')).toHaveLength(1);
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0x73, 0x68, 0xff, 0x00])],
    ['an oversize service', Buffer.from('shell:' + 'x'.repeat(5000) + '\0')],
  ])('reports a malformed OPEN (%s) as a refused service with a placeholder', async (_label, payload) => {
    const h = await setup();
    h.client.send(A_OPEN, 11, 0, payload);
    const reply = await h.client.next();
    expect(reply.command).toBe(A_CLSE);
    expect(reply.arg1).toBe(11);
    expect(h.fake.requests).toEqual(h.baseline);
    const refused = h.events.filter((e) => e.kind === 'refused-service');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ service: '<malformed>' });
  });

  it('refuses an OPEN with an oversize service or an id of zero without contacting the backend', async () => {
    const h = await setup();
    const big = await h.client.openRaw('shell:' + 'x'.repeat(200_000), 7);
    expect(big.command).toBe(A_CLSE);
    expect(big.arg1).toBe(7);
    h.client.send(A_OPEN, 0, 0, 'shell:id\0');
    expect(await h.client.quiet(100)).toBe(true);
    expect(h.fake.requests).toEqual(h.baseline);
    expect(h.server.sessions[0].streamCount).toBe(0);
  });

  it('refuses a stream beyond maxStreams and a repeated remote id', async () => {
    const h = await setup({ maxStreams: 2 });
    await h.client.open('hold:', 1);
    await h.client.open('hold:', 2);
    expect((await h.client.openRaw('hold:', 3)).command).toBe(A_CLSE);
    expect((await h.client.openRaw('hold:', 2)).command).toBe(A_CLSE);
    expect(h.server.sessions[0].streamCount).toBe(2);
  });

  it('answers CLSE(0, id) when the backend rejects the service, and stays usable', async () => {
    const h = await setup();
    const refused = await h.client.openRaw('nosuch:', 5);
    expect(refused.command).toBe(A_CLSE);
    expect(refused.arg0).toBe(0);
    expect(refused.arg1).toBe(5);
    expect(h.server.sessions[0].streamCount).toBe(0);
    await h.client.open('hold:', 6);
  });

  it('ignores unknown commands and stray packets', async () => {
    const h = await setup();
    h.client.send(0x12345678, 0, 0);
    h.client.send(A_WRTE, 99, 98, 'x');
    h.client.send(A_OKAY, 99, 98);
    h.client.send(A_CLSE, 99, 98);
    expect(await h.client.quiet(100)).toBe(true);
    expect(h.client.closed).toBe(false);
    await h.client.open('echo:', 1);
  });

  it('closes the backend stream and answers when the client sends CLSE', async () => {
    const h = await setup();
    const { localId } = await h.client.open('hold:', 1);
    expect(h.fake.activeServiceSockets()).toBe(1);
    h.client.send(A_CLSE, 1, localId);
    const reply = await h.client.waitFor((p) => p.command === A_CLSE && p.arg0 === localId);
    expect(reply.arg1).toBe(1);
    await vi.waitFor(() => expect(h.fake.activeServiceSockets()).toBe(0));
    expect(h.server.sessions[0].streamCount).toBe(0);
  });

  it('sends CLSE for open streams when the device goes away', async () => {
    const h = await setup();
    const { localId } = await h.client.open('hold:', 1);
    h.fake.setOnline('DEV1', false);
    const closed = await h.client.waitFor((p) => p.command === A_CLSE && p.arg0 === localId);
    expect(closed.arg1).toBe(1);
  });

  describe('when the device restarts or disappears', () => {
    const transportRequests = (h: Awaited<ReturnType<typeof setup>>) => h.fake.requests.filter((r) => r === 'host:transport:DEV1').length;
    const closeReasons = (h: Awaited<ReturnType<typeof setup>>) =>
      h.events.flatMap((e) => (e.kind === 'closed' ? [e.reason] : []));

    it('closes the whole session once the host reports the device unavailable, instead of refusing one stream', async () => {
      const h = await setup();
      h.fake.setOnline('DEV1', false);
      const before = transportRequests(h);

      h.client.send(A_OPEN, 1, 0, 'shell:id\0');

      expect(await h.client.waitClosed()).toBe(true);
      expect(closeReasons(h)).toEqual(['device unavailable']);
      expect(transportRequests(h)).toBe(before + 1);
    });

    it('costs one dial for a client that retries OPEN as soon as each one is refused', async () => {
      const h = await setup();
      h.fake.setOnline('DEV1', false);
      const before = transportRequests(h);

      for (let i = 1; i <= 1200 && !h.client.closed; i++) {
        h.client.send(A_OPEN, i, 0, 'shell:id\0');
        await h.client.waitFor((p) => p.command === A_CLSE && p.arg1 === i, 2000).catch(() => null);
      }

      expect(h.client.closed).toBe(true);
      expect(transportRequests(h) - before).toBe(1);
      expect(closeReasons(h)).toEqual(['device unavailable']);
    });

    it('keeps the session when the device refuses only the service', async () => {
      const h = await setup();
      expect((await h.client.openRaw('nosuch:', 1)).command).toBe(A_CLSE);
      expect(await h.client.quiet(100)).toBe(true);
      expect(h.client.closed).toBe(false);
    });

    it.each(['root:', 'unroot:', 'reboot:', 'reboot:bootloader'])(
      'closes the session after a %s stream has ended and its CLSE reached the client',
      async (service) => {
        const h = await setup();
        const { localId } = await h.client.open(service, 1);
        const output = await h.client.collectStream(1, localId, 'close');

        expect(await h.client.waitClosed()).toBe(true);
        expect(h.client.packets.some((p) => p.command === A_CLSE && p.arg0 === localId && p.arg1 === 1)).toBe(true);
        expect(closeReasons(h)).toEqual(['device restarting']);
        if (service === 'root:') expect(output.toString()).toBe('restarting adbd as root\n');
      },
    );

    it('keeps the session after an ordinary shell stream ends', async () => {
      const h = await setup();
      const { localId } = await h.client.open('shell:echo hi', 1);
      await h.client.collectStream(1, localId, 'close');
      expect(await h.client.quiet(100)).toBe(true);
      expect(h.client.closed).toBe(false);
      expect((await h.client.open('shell:id', 2)).localId).toBeGreaterThan(0);
    });
  });

  it('destroys every backend stream when the client disappears', async () => {
    const h = await setup();
    await h.client.open('hold:', 1);
    await h.client.open('hold:', 2);
    expect(h.fake.activeServiceSockets()).toBe(2);
    h.client.close();
    await vi.waitFor(() => expect(h.fake.activeServiceSockets()).toBe(0));
  });

  it('reports its streams in info()', async () => {
    const h = await setup();
    await h.client.open('hold:', 1);
    expect(h.server.sessions[0].info()).toMatchObject({
      deviceId: 'DEV1', peerIp: '10.0.0.5', state: 'ready', streams: 1,
    });
  });
});

describe('Session streams, services that end at once', () => {
  it('sends OKAY then CLSE for a service that closes right after OKAY with no output', async () => {
    const h = await setup({ shell: (_serial, command) => (command === 'silent' ? '' : `ran: ${command}\n`) });
    for (let i = 1; i <= 20; i++) {
      const reply = await h.client.openRaw('shell:silent', i);
      expect(reply.command).toBe(A_OKAY);
      const close = await h.client.next();
      expect(close.command).toBe(A_CLSE);
      expect(close.arg0).toBe(reply.arg0);
      expect(close.arg1).toBe(i);
    }
    expect(h.server.sessions[0].streamCount).toBe(0);
    await vi.waitFor(() => expect(h.fake.activeServiceSockets()).toBe(0));
  });

  it.each(['destroyed', 'readableEnded'] as const)('still sends CLSE when the backend socket is already %s on arrival', async (flag) => {
    const { h, sock } = await setupWithFake((s) => { s[flag] = true; });
    const reply = await h.client.openRaw('fake:', 1);
    expect(reply.command).toBe(A_OKAY);
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(reply.arg0);
    expect(close.arg1).toBe(1);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(sock.destroyCalls).toBeGreaterThan(0);
  });
});

describe('Session streams, contained failures', () => {
  it('refuses the stream when the backend connector throws, and the session stays usable', async () => {
    const h = await setup({ backend: fakeBackend((s) => (s === 'boom:' ? new Error('connector boom') : undefined)) });
    const refused = await h.client.openRaw('boom:', 5);
    expect(refused.command).toBe(A_CLSE);
    expect(refused.arg0).toBe(0);
    expect(refused.arg1).toBe(5);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('connector boom'));
    await h.client.open('hold:', 6);
    expect(h.server.sessions[0].state).toBe('ready');
    await expectNothingEscaped();
  });

  it('closes only that stream when a backend data handler throws', async () => {
    const { h, sock } = await setupWithFake();
    const { localId } = await h.client.open('fake:', 1);
    sock.faults.add('pause');
    expect(() => sock.emit('data', Buffer.from('x'))).not.toThrow();
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(localId);
    expect(close.arg1).toBe(1);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(sock.destroyCalls).toBeGreaterThan(0);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('pause boom'));
    await h.client.open('hold:', 2);
    expect(h.server.sessions[0].state).toBe('ready');
    await expectNothingEscaped();
  });

  it.each(['end', 'close'])('closes only that stream when the backend %s handler throws', async (event) => {
    const { h, sock } = await setupWithFake();
    const { localId } = await h.client.open('fake:', 1);
    sock.emit('data', Buffer.from('a'));
    expect((await h.client.next()).command).toBe(A_WRTE);
    sock.emit('data', Buffer.from('b'));
    sock.faults.add('pause');
    expect(() => sock.emit(event)).not.toThrow();
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(localId);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('pause boom'));
    await h.client.open('hold:', 2);
    await expectNothingEscaped();
  });

  it('still tells the client when destroying the backend socket throws on a backend error', async () => {
    const { h, sock } = await setupWithFake();
    const { localId } = await h.client.open('fake:', 1);
    sock.faults.add('destroy');
    expect(() => sock.emit('error', new Error('reset'))).not.toThrow();
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(localId);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('destroy boom'));
    await h.client.open('hold:', 2);
    await expectNothingEscaped();
  });

  it('closes only that stream when a backend write throws', async () => {
    const { h, sock } = await setupWithFake();
    const { localId } = await h.client.open('fake:', 1);
    sock.faults.add('write');
    h.client.send(A_WRTE, 1, localId, 'abc');
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(localId);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('write boom'));
    await h.client.open('hold:', 2);
    expect(h.server.sessions[0].state).toBe('ready');
    await expectNothingEscaped();
  });

  it('closes the stream, without acknowledging, when a backend write reports an error', async () => {
    const { h, sock } = await setupWithFake((s) => { s.writeError = new Error('EPIPE'); });
    const { localId } = await h.client.open('fake:', 1);
    h.client.send(A_WRTE, 1, localId, 'abc');
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(localId);
    expect(h.client.packets.filter((p) => p.command === A_OKAY)).toHaveLength(1);
    expect(sock.written).toHaveLength(1);
    expect(logErrorSpy).not.toHaveBeenCalled();
    await h.client.open('hold:', 2);
    await expectNothingEscaped();
  });

  it('sends OKAY then CLSE when attaching to the backend socket throws', async () => {
    const { h, sock } = await setupWithFake((s) => { s.faults.add('on'); });
    const reply = await h.client.openRaw('fake:', 1);
    expect(reply.command).toBe(A_OKAY);
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(reply.arg0);
    expect(close.arg1).toBe(1);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(sock.destroyCalls).toBeGreaterThan(0);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('on boom'));
    await h.client.open('hold:', 2);
    await expectNothingEscaped();
  });

  it('destroys every other backend stream and finishes closing when one destroy throws', async () => {
    const first = new FakeBackendSocket();
    const second = new FakeBackendSocket();
    const h = await setup({ backend: fakeBackend((s) => (s === 'fake:' ? first : s === 'fake2:' ? second : undefined)) });
    await h.client.open('fake:', 1);
    await h.client.open('fake2:', 2);
    first.faults.add('destroy');
    h.client.close();
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(first.destroyCalls).toBe(1);
    expect(second.destroyCalls).toBe(1);
    expect(h.server.sessions[0].streamCount).toBe(0);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('destroy boom'));
    await expectNothingEscaped();
  });
});

describe('Session streams, bounded buffering', () => {
  it('closes a stream that sends a second WRTE before the first is acknowledged', async () => {
    const { h, sock } = await setupWithFake((s) => { s.deferWrites = true; });
    const { localId } = await h.client.open('fake:', 1);
    h.client.send(A_WRTE, 1, localId, 'one');
    await vi.waitFor(() => expect(sock.written).toHaveLength(1));
    h.client.send(A_WRTE, 1, localId, 'two');
    const close = await h.client.next();
    expect(close.command).toBe(A_CLSE);
    expect(close.arg0).toBe(localId);
    expect(close.arg1).toBe(1);
    expect(sock.written).toHaveLength(1);
    expect(sock.destroyCalls).toBeGreaterThan(0);
    expect(h.server.sessions[0].streamCount).toBe(0);
    for (const flush of sock.pendingWrites.splice(0)) flush();
    expect(await h.client.quiet(100)).toBe(true);
    expect(h.server.sessions[0].state).toBe('ready');
  });

  it('accepts the next WRTE once the previous one has been acknowledged', async () => {
    const { h, sock } = await setupWithFake((s) => { s.deferWrites = true; });
    const { localId } = await h.client.open('fake:', 1);
    h.client.send(A_WRTE, 1, localId, 'one');
    await vi.waitFor(() => expect(sock.pendingWrites).toHaveLength(1));
    sock.pendingWrites.shift()!();
    expect((await h.client.next()).command).toBe(A_OKAY);
    h.client.send(A_WRTE, 1, localId, 'two');
    await vi.waitFor(() => expect(sock.pendingWrites).toHaveLength(1));
    sock.pendingWrites.shift()!();
    expect((await h.client.next()).command).toBe(A_OKAY);
    expect(sock.written.map((b) => b.toString())).toEqual(['one', 'two']);
    expect(h.server.sessions[0].streamCount).toBe(1);
  });

  it('stops reading a client that never reads its replies, and resumes after drain', async () => {
    const { sock, session } = await readySessionOnStallableSocket();
    const refusal = encodePacket({ command: A_OPEN, arg0: 1, arg1: 0, data: Buffer.from('host:kill\0') });
    const perPush = 2730;
    const pushes = 70;
    const burst = Buffer.concat(Array.from({ length: perPush }, () => refusal));
    sock.stalled = true;
    for (let i = 0; i < pushes; i++) sock.push(burst);
    const highWater = 4 * 1024 * 1024;
    const repliesPerPush = perPush * 24;
    expect(sock.writableLength).toBeGreaterThan(highWater);
    expect(sock.writableLength).toBeLessThanOrEqual(highWater + repliesPerPush);
    expect(sock.isPaused()).toBe(true);
    expect(sock.readableLength).toBeGreaterThan(0);
    expect(session.isClosed).toBe(false);

    sock.release();
    const total = perPush * pushes;
    const closes = () => sock.sent.filter((p) => p.command === A_CLSE).length;
    await vi.waitFor(() => expect(closes()).toBe(total), { timeout: 3000 });
    expect(sock.writableLength).toBe(0);
    expect(sock.isPaused()).toBe(false);
    await expectNothingEscaped();
  });
});

describe('Session streams, chunking and limits', () => {
  it('splits backend data into WRTEs of at most the proxy maximum for a client that advertised 1 MiB, and releases the next only after the client OKAY', async () => {
    const { h, sock } = await setupWithFake(() => {}, { clientMaxData: MAX_DATA });
    const { localId } = await h.client.open('fake:', 1);
    sock.emit('data', Buffer.alloc(PROXY_MAX_PAYLOAD + 1, 'a'));
    const first = await h.client.next();
    expect(first.command).toBe(A_WRTE);
    expect(first.data.length).toBe(PROXY_MAX_PAYLOAD);
    expect(await h.client.quiet(100)).toBe(true);
    h.client.send(A_OKAY, 1, localId);
    const second = await h.client.next();
    expect(second.command).toBe(A_WRTE);
    expect(second.data.length).toBe(1);
  });

  it.each([
    [4096, 4096],
    [0, 4096],
    [1000, 4096],
    [8192, 8192],
  ])('splits at the max data the client advertised (%i gives %i)', async (advertised, expected) => {
    const { h, sock } = await setupWithFake(() => {}, { clientMaxData: advertised });
    const { localId } = await h.client.open('fake:', 1);
    sock.emit('data', Buffer.alloc(20000, 'a'));
    const got = await h.client.collectStream(1, localId, 20000);
    expect(got.length).toBe(20000);
    const sizes = h.client.packets.filter((p) => p.command === A_WRTE).map((p) => p.data.length);
    expect(sizes[0]).toBe(expected);
    expect(Math.max(...sizes)).toBe(expected);
  });

  it('ignores CLSE, OKAY and WRTE that name the wrong remote id', async () => {
    const { h, sock } = await setupWithFake();
    const { localId } = await h.client.open('fake:', 1);
    sock.emit('data', Buffer.from('a'));
    sock.emit('data', Buffer.from('b'));
    expect((await h.client.next()).command).toBe(A_WRTE);
    h.client.send(A_OKAY, 99, localId);
    h.client.send(A_WRTE, 99, localId, 'x');
    h.client.send(A_CLSE, 99, localId);
    expect(await h.client.quiet(100)).toBe(true);
    expect(sock.written).toHaveLength(0);
    expect(sock.destroyCalls).toBe(0);
    expect(h.server.sessions[0].streamCount).toBe(1);
    h.client.send(A_OKAY, 1, localId);
    const queued = await h.client.next();
    expect(queued.command).toBe(A_WRTE);
    expect(queued.data.toString()).toBe('b');
  });

  it('caps a session at 128 streams by default', async () => {
    const made: FakeBackendSocket[] = [];
    const h = await setup({ backend: fakeBackend((s) => (s === 'hold:' ? (made[made.push(new FakeBackendSocket()) - 1]) : undefined)) });
    for (let id = 1; id <= 128; id++) h.client.send(A_OPEN, id, 0, 'hold:\0');
    await vi.waitFor(() => expect(h.client.packets.filter((p) => p.command === A_OKAY)).toHaveLength(128));
    h.client.send(A_OPEN, 129, 0, 'hold:\0');
    const refused = await h.client.waitFor((p) => p.command === A_CLSE && p.arg1 === 129);
    expect(refused.arg0).toBe(0);
    expect(h.server.sessions[0].streamCount).toBe(128);
    expect(made).toHaveLength(128);
  });
});
