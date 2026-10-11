import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { parseAdbPublicKey } from './adb-key';
import {
  A_AUTH, A_CNXN, A_OPEN, A_VERSION, A_WRTE, AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN, MAX_DATA, PROXY_MAX_PAYLOAD, encodePacket,
} from './packet';
import { Session, type SessionEvent } from './session';
import { makeTestAdbKey } from './testing/test-keys';
import { StubGate } from './testing/stub-gate';
import { startSessionServer, type SessionServer } from './testing/session-server';
import { WireClient } from './testing/wire-client';

const { logErrorSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn() }));
vi.mock('../../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: logErrorSpy }) }));

const BANNER = 'device::ro.product.name=t;features=cmd';
const open: Array<{ close(): void | Promise<unknown> }> = [];
const escapes: unknown[] = [];
const recordEscape = (e: unknown) => { escapes.push(e); };

interface SetupOptions {
  preAuthTimeoutMs?: number;
  deviceOnline?: boolean;
  banner?: () => Promise<string>;
  /** Replaces the online check. */
  isDeviceOnline?: () => boolean;
  /** Runs after the harness's own bookkeeping, so it can throw. */
  onLeavePreAuth?: () => void;
  onClose?: () => void;
  admit?: (s: Session) => boolean;
}

async function setup(opts: SetupOptions = {}) {
  const gate = new StubGate();
  const key = makeTestAdbKey();
  gate.approved = [{ keyId: key.keyId, key: parseAdbPublicKey(key.publicKeyText).key }];
  const events: SessionEvent[] = [];
  const closed: Session[] = [];
  const state = { online: opts.deviceOnline ?? true, leaves: 0 };
  const backend = { openService: vi.fn(), deviceBanner: vi.fn(opts.banner ?? (async () => BANNER)) };
  const server: SessionServer = await startSessionServer((socket) =>
    new Session({
      socket, deviceId: 'DEV1', peerIp: '10.0.0.5', gate, backend,
      isDeviceOnline: opts.isDeviceOnline ?? (() => state.online),
      onEvent: (e) => events.push(e),
      onClose: (s) => { closed.push(s); opts.onClose?.(); },
      onLeavePreAuth: () => { state.leaves++; opts.onLeavePreAuth?.(); },
      preAuthTimeoutMs: opts.preAuthTimeoutMs ?? 5000,
      admit: opts.admit,
    }),
  );
  open.push(server);
  const connect = async () => {
    const c = await WireClient.connect(server.port);
    open.push(c);
    return c;
  };
  return { gate, key, events, closed, state, backend, server, connect };
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
  for (const o of open.splice(0)) await o.close();
  process.off('unhandledRejection', recordEscape);
  process.off('uncaughtException', recordEscape);
});

describe('Session handshake', () => {
  it('accepts a client whose signature matches an approved key and answers with the device banner', async () => {
    const h = await setup();
    const client = await h.connect();
    const reply = await client.authenticate(h.key);
    expect(reply.command).toBe(A_CNXN);
    expect(reply.arg0).toBe(A_VERSION);
    expect(reply.arg1).toBe(256 * 1024);
    expect(PROXY_MAX_PAYLOAD).toBe(256 * 1024);
    expect(reply.data.toString()).toBe(BANNER);
    expect(h.gate.authenticatedCalls).toEqual([{ deviceId: 'DEV1', keyId: h.key.keyId, peerIp: '10.0.0.5' }]);
    expect(h.server.sessions[0].state).toBe('ready');
    expect(h.server.sessions[0].keyId).toBe(h.key.keyId);
    expect(h.state.leaves).toBe(1);
    expect(h.events.map((e) => e.kind)).toContain('authenticated');
  });

  it('sends the banner without a trailing NUL, so the last feature of a multi-feature list stays intact', async () => {
    const banner = 'device::ro.product.name=t;ro.product.model=m;ro.product.device=d;features=cmd,stat_v2,shell_v2';
    const h = await setup({ banner: async () => banner });
    const client = await h.connect();
    const reply = await client.authenticate(h.key);
    expect(reply.command).toBe(A_CNXN);
    expect(reply.data.length).toBe(Buffer.byteLength(banner));
    expect(reply.data[reply.data.length - 1]).not.toBe(0);
    expect(reply.data.toString().split('features=')[1].split(',')).toEqual(['cmd', 'stat_v2', 'shell_v2']);
  });

  it('closes without a banner when the device is offline', async () => {
    const h = await setup({ deviceOnline: false });
    const client = await h.connect();
    client.sendHostCnxn();
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets).toHaveLength(0);
  });

  it('sends a fresh token after each unknown signature and drops the ninth attempt', async () => {
    const h = await setup();
    const client = await h.connect();
    client.sendHostCnxn();
    const tokens = [await client.next()];
    for (let i = 0; i < 8; i++) {
      client.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
      tokens.push(await client.next());
    }
    expect(tokens.every((t) => t.command === A_AUTH && t.arg0 === AUTH_TOKEN)).toBe(true);
    expect(new Set(tokens.map((t) => t.data.toString('hex'))).size).toBe(9);
    client.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.filter((e) => e.kind === 'auth-failed')).toHaveLength(8);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'too many signatures' });
  });

  it('lets a client that holds five keys sign with each, then offer its first key, and reach the gate', async () => {
    const h = await setup();
    const keys = Array.from({ length: 5 }, (_, i) => makeTestAdbKey(`key${i}@client`));
    const client = await h.connect();
    client.sendHostCnxn();
    let token = await client.next();
    for (const key of keys) {
      client.send(A_AUTH, AUTH_SIGNATURE, 0, key.sign(token.data));
      token = await client.next();
      expect(token.arg0).toBe(AUTH_TOKEN);
    }
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, keys[0].publicKeyText);
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    expect(h.gate.offers[0].keyId).toBe(keys[0].keyId);
    expect(h.events.filter((e) => e.kind === 'auth-failed')).toHaveLength(5);
  });

  it('still requires possession after eight failed signatures', async () => {
    const h = await setup();
    const client = await h.connect();
    client.sendHostCnxn();
    await client.next();
    for (let i = 0; i < 8; i++) {
      client.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
      await client.next();
    }
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, makeTestAdbKey().publicKeyText);
    expect(await client.waitClosed()).toBe(true);
    expect(h.gate.offers).toHaveLength(0);
  });

  it('holds an unknown key as pending and sends CNXN on the same connection once approved', async () => {
    const h = await setup();
    let approve!: (d: 'approved' | 'denied') => void;
    const decision = new Promise<'approved' | 'denied'>((r) => { approve = r; });
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision, cancel: vi.fn() };
    const other = makeTestAdbKey('someone@else');
    const client = await h.connect();
    await client.offerKey(other);
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    expect(h.gate.offers[0]).toEqual({ deviceId: 'DEV1', keyId: other.keyId, peerIp: '10.0.0.5' });
    expect(await client.quiet(100)).toBe(true);
    expect(h.server.sessions[0].state).toBe('pending');
    expect(h.server.sessions[0].keyComment).toBe('someone@else');
    expect(h.state.leaves).toBe(1);
    approve('approved');
    const reply = await client.next();
    expect(reply.command).toBe(A_CNXN);
    expect(h.server.sessions[0].state).toBe('ready');
    expect(h.gate.authenticatedCalls[0].keyId).toBe(other.keyId);
  });

  it('closes a pending connection that is denied', async () => {
    const h = await setup();
    let decide!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { decide = r; }), cancel: vi.fn() };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    decide('denied');
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes when the gate blocks the key', async () => {
    const h = await setup();
    h.gate.outcome = { kind: 'blocked' };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.map((e) => e.kind)).toContain('blocked');
  });

  it('continues straight to CNXN when the gate reports the key as already approved', async () => {
    const h = await setup();
    h.gate.outcome = { kind: 'approved' };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    expect((await client.next()).command).toBe(A_CNXN);
  });

  it('refuses an offered key the client never signed with, without asking the gate', async () => {
    const h = await setup();
    const client = await h.connect();
    await client.offerKeyWithoutProof(makeTestAdbKey());
    expect(await client.waitClosed()).toBe(true);
    expect(h.gate.offers).toHaveLength(0);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
  });

  it('does not let a copied approved public key through (no authentication by public key alone)', async () => {
    const h = await setup();
    h.gate.outcome = { kind: 'approved' };
    const client = await h.connect();
    await client.offerKeyWithoutProof(h.key);
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.gate.authenticatedCalls).toEqual([]);
  });

  it('refuses a key whose signature was made by a different key', async () => {
    const h = await setup();
    const offered = makeTestAdbKey();
    const other = makeTestAdbKey();
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, other.sign(token.data));
    await client.next();
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, offered.publicKeyText);
    expect(await client.waitClosed()).toBe(true);
    expect(h.gate.offers).toHaveLength(0);
  });

  it('refuses a signature made over a token this connection never issued', async () => {
    const h = await setup();
    const offered = makeTestAdbKey();
    const client = await h.connect();
    client.sendHostCnxn();
    await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, offered.sign(randomBytes(20)));
    await client.next();
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, offered.publicKeyText);
    expect(await client.waitClosed()).toBe(true);
    expect(h.gate.offers).toHaveLength(0);
  });

  it('accepts the offer when one of several signatures came from the offered key', async () => {
    const h = await setup();
    const offered = makeTestAdbKey();
    const other = makeTestAdbKey();
    const client = await h.connect();
    client.sendHostCnxn();
    const first = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, other.sign(first.data));
    const second = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, offered.sign(second.data));
    await client.next();
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, offered.publicKeyText);
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    expect(h.gate.offers[0].keyId).toBe(offered.keyId);
  });

  it('cancels the pending request when the client disconnects', async () => {
    const h = await setup();
    const cancel = vi.fn();
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise(() => {}), cancel };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    client.close();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('calls cancel() on the outcome object, so a method that uses this works', async () => {
    const h = await setup();
    const outcome = {
      kind: 'pending' as const, requestId: 'r1', decision: new Promise<'approved' | 'denied'>(() => {}), cancels: 0,
      cancel() { this.cancels++; },
    };
    h.gate.outcome = outcome;
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    client.close();
    await vi.waitFor(() => expect(outcome.cancels).toBe(1));
    await expectNothingEscaped();
  });

  it('drops a client that connects and sends nothing, and gives its pre-auth slot back', async () => {
    const h = await setup({ preAuthTimeoutMs: 50 });
    const client = await h.connect();
    expect(await client.waitClosed(1000)).toBe(true);
    expect(h.closed).toHaveLength(1);
    expect(h.state.leaves).toBe(1);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'pre-auth timeout' });
  });

  it('drops a client that stalls after the first packet', async () => {
    const h = await setup({ preAuthTimeoutMs: 200 });
    const client = await h.connect();
    client.sendHostCnxn();
    await client.next();
    expect(await client.waitClosed(1500)).toBe(true);
    expect(h.state.leaves).toBe(1);
  });

  it('does not apply the pre-auth timeout to a held pending connection', async () => {
    // The budget must cover connect, CNXN, token, the RSA signature and the offer, so a slow runner needs a wide one.
    const h = await setup({ preAuthTimeoutMs: 1000 });
    let approve!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { approve = r; }), cancel: vi.fn() };
    // Key generation can take longer than the budget on a busy machine, so it happens before the clock starts.
    const key = makeTestAdbKey();
    const client = await h.connect();
    await client.offerKey(key);
    await new Promise((r) => setTimeout(r, 2000));
    expect(client.closed).toBe(false);
    approve('approved');
    expect((await client.next()).command).toBe(A_CNXN);
  });

  it('ignores packets that arrive while pending', async () => {
    const h = await setup();
    let approve!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { approve = r; }), cancel: vi.fn() };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    client.send(A_OPEN, 1, 0, 'shell:id\0');
    expect(await client.quiet(100)).toBe(true);
    expect(client.closed).toBe(false);
    approve('approved');
    expect((await client.next()).command).toBe(A_CNXN);
  });

  it('closes on a payload larger than the pre-auth cap', async () => {
    const h = await setup();
    const client = await h.connect();
    client.socket.write(encodePacket({ command: A_CNXN, arg0: A_VERSION, arg1: MAX_DATA, data: Buffer.alloc(5000) }));
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes on a bad magic', async () => {
    const h = await setup();
    const client = await h.connect();
    client.socket.write(Buffer.alloc(24));
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes when the first packet is not CNXN', async () => {
    const h = await setup();
    const client = await h.connect();
    client.send(A_OPEN, 1, 0, 'shell:id\0');
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes without CNXN when the banner cannot be fetched', async () => {
    const h = await setup({ banner: async () => { throw new Error('backend down'); } });
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('banner failed: backend down'));
  });

  it('destroy() closes the connection and reports the reason once', async () => {
    const h = await setup();
    const client = await h.connect();
    await client.authenticate(h.key);
    h.server.sessions[0].destroy('revoked');
    h.server.sessions[0].destroy('again');
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.filter((e) => e.kind === 'closed')).toHaveLength(1);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'revoked' });
    expect(h.closed).toHaveLength(1);
  });

  it('keeps the pre-auth payload cap while the banner is still being fetched', async () => {
    const h = await setup({ banner: () => new Promise<string>(() => {}) });
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
    await vi.waitFor(() => expect(h.server.sessions[0].state).toBe('finishing'));
    client.socket.write(encodePacket({ command: A_OPEN, arg0: 1, arg1: 0, data: Buffer.alloc(5000) }).subarray(0, 24));
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'payload too large: 5000' });
  });

  it('allows payloads up to the advertised maximum once the CNXN reply has gone out', async () => {
    const h = await setup();
    const client = await h.connect();
    expect((await client.authenticate(h.key)).command).toBe(A_CNXN);
    client.socket.write(encodePacket({ command: A_OPEN, arg0: 1, arg1: 0, data: Buffer.alloc(5000) }).subarray(0, 24));
    expect(await client.quiet(150)).toBe(true);
    expect(client.closed).toBe(false);
    expect(h.server.sessions[0].isClosed).toBe(false);
  });

  it('takes a packet of exactly the advertised maximum from a client that advertised 1 MiB, and closes on one byte more', async () => {
    const h = await setup();
    const client = await h.connect();
    expect((await client.authenticate(h.key, MAX_DATA)).command).toBe(A_CNXN);
    client.socket.write(encodePacket({ command: A_WRTE, arg0: 1, arg1: 99, data: Buffer.alloc(PROXY_MAX_PAYLOAD) }));
    expect(await client.quiet(150)).toBe(true);
    expect(client.closed).toBe(false);

    client.socket.write(encodePacket({ command: A_WRTE, arg0: 1, arg1: 99, data: Buffer.alloc(PROXY_MAX_PAYLOAD + 1) }).subarray(0, 24));

    expect(await client.waitClosed()).toBe(true);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: `payload too large: ${PROXY_MAX_PAYLOAD + 1}` });
  });

  it('closes when the gate fails to record an authentication straight after a signature', async () => {
    const h = await setup();
    h.gate.authenticated = () => { throw new Error('store down'); };
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'handler error' });
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('handler error: store down'));
  });

  it('closes a pending connection when the gate fails to record its approval', async () => {
    const h = await setup();
    let approve!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { approve = r; }), cancel: vi.fn() };
    h.gate.authenticated = () => { throw new Error('store down'); };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    approve('approved');
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'handler error' });
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('handler error: store down'));
    await expectNothingEscaped();
  });

  it('ignores a further signature and key offer while pending', async () => {
    const h = await setup();
    let approve!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { approve = r; }), cancel: vi.fn() };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    client.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, makeTestAdbKey().publicKeyText);
    expect(await client.quiet(150)).toBe(true);
    expect(client.closed).toBe(false);
    expect(h.gate.offers).toHaveLength(1);
    expect(h.server.sessions[0].state).toBe('pending');
    approve('approved');
    expect((await client.next()).command).toBe(A_CNXN);
  });

  it('closes when a packet arrives while the banner is still being fetched', async () => {
    let release!: (banner: string) => void;
    const h = await setup({ banner: () => new Promise<string>((r) => { release = r; }) });
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
    await vi.waitFor(() => expect(h.server.sessions[0].state).toBe('finishing'));
    client.send(A_OPEN, 1, 0, 'shell:id\0');
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'unexpected OPEN while finishing' });
    release(BANNER);
    expect(await client.quiet(50)).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
  });

  describe('the handshake stage', () => {
    const signIn = async (h: Awaited<ReturnType<typeof setup>>) => {
      const client = await h.connect();
      client.sendHostCnxn();
      const token = await client.next();
      client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
      return client;
    };

    it('keeps the pre-auth slot while the banner is fetched and gives it back once CNXN is written', async () => {
      let release!: (banner: string) => void;
      const h = await setup({ banner: () => new Promise<string>((r) => { release = r; }) });
      const client = await signIn(h);
      await vi.waitFor(() => expect(h.server.sessions[0].state).toBe('finishing'));
      expect(h.state.leaves).toBe(0);
      release(BANNER);
      expect((await client.next()).command).toBe(A_CNXN);
      expect(h.state.leaves).toBe(1);
    });

    it('applies the pre-auth timeout to a session whose banner never arrives', async () => {
      const h = await setup({ preAuthTimeoutMs: 300, banner: () => new Promise<string>(() => {}) });
      const client = await signIn(h);
      await vi.waitFor(() => expect(h.server.sessions[0].state).toBe('finishing'));
      expect(await client.waitClosed(2000)).toBe(true);
      expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'pre-auth timeout' });
      expect(h.state.leaves).toBe(1);
    });

    it('asks admit() before the banner and closes a session it refuses without fetching one', async () => {
      const seen: string[] = [];
      const h = await setup({ admit: (s) => { seen.push(s.state); return false; } });
      const client = await signIn(h);
      expect(await client.waitClosed()).toBe(true);
      expect(seen).toEqual(['finishing']);
      expect(h.backend.deviceBanner).not.toHaveBeenCalled();
      expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
      expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'not admitted' });
      expect(h.state.leaves).toBe(1);
    });

    it('asks admit() for a waiting connection once it is approved', async () => {
      const admit = vi.fn(() => false);
      const h = await setup({ admit });
      let approve!: (d: 'approved' | 'denied') => void;
      h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { approve = r; }), cancel: vi.fn() };
      const client = await h.connect();
      await client.offerKey(makeTestAdbKey());
      await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
      expect(admit).not.toHaveBeenCalled();
      approve('approved');
      expect(await client.waitClosed()).toBe(true);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(h.backend.deviceBanner).not.toHaveBeenCalled();
    });

    it('goes on to the banner when admit() accepts', async () => {
      const h = await setup({ admit: () => true });
      const client = await signIn(h);
      expect((await client.next()).command).toBe(A_CNXN);
      expect(h.backend.deviceBanner).toHaveBeenCalledTimes(1);
    });
  });

  it('closes without a banner when the device goes offline between CNXN and a valid signature', async () => {
    const h = await setup();
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    h.state.online = false;
    client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
    expect(await client.waitClosed()).toBe(true);
    expect(h.backend.deviceBanner).not.toHaveBeenCalled();
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'device offline' });
  });

  it('closes a pending connection whose decision promise rejects', async () => {
    const h = await setup();
    let fail!: (e: Error) => void;
    const decision = new Promise<'approved' | 'denied'>((_, reject) => { fail = reject; });
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision, cancel: vi.fn() };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    fail(new Error('registry gone'));
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'decision error' });
    await expectNothingEscaped();
  });

  describe('callbacks that throw', () => {
    it('onLeavePreAuth throwing on the pre-auth timeout still closes the socket', async () => {
      const h = await setup({ preAuthTimeoutMs: 50, onLeavePreAuth: () => { throw new Error('leave hook down'); } });
      const client = await h.connect();
      expect(await client.waitClosed(1000)).toBe(true);
      expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'pre-auth timeout' });
      expect(h.closed).toHaveLength(1);
      expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('leave hook down'));
      await expectNothingEscaped();
    });

    it('onLeavePreAuth throwing while the session becomes ready closes it instead of leaking a rejection', async () => {
      const h = await setup({ onLeavePreAuth: () => { throw new Error('leave hook down'); } });
      const client = await h.connect();
      client.sendHostCnxn();
      const token = await client.next();
      client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
      expect(await client.waitClosed()).toBe(true);
      expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
      expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'handler error' });
      expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('leave hook down'));
      await expectNothingEscaped();
    });

    it('onLeavePreAuth throwing when the key goes pending still cancels the pending request', async () => {
      const h = await setup({ onLeavePreAuth: () => { throw new Error('leave hook down'); } });
      const cancel = vi.fn();
      h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise(() => {}), cancel };
      const key = makeTestAdbKey();
      const client = await h.connect();
      await client.offerKey(key);
      expect(await client.waitClosed()).toBe(true);
      expect(h.gate.offers).toHaveLength(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'handler error' });
      await expectNothingEscaped();
    });

    it('isDeviceOnline throwing after the signature closes the session instead of leaking a rejection', async () => {
      let calls = 0;
      const h = await setup({ isDeviceOnline: () => { if (++calls === 2) throw new Error('registry down'); return true; } });
      const client = await h.connect();
      client.sendHostCnxn();
      const token = await client.next();
      client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
      expect(await client.waitClosed()).toBe(true);
      expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
      expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'handler error' });
      expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('registry down'));
      await expectNothingEscaped();
    });

    it('cancel() throwing when a pending client disconnects still finishes closing', async () => {
      const h = await setup();
      const cancel = vi.fn(() => { throw new Error('cancel down'); });
      h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise(() => {}), cancel };
      const client = await h.connect();
      await client.offerKey(makeTestAdbKey());
      await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
      client.close();
      await vi.waitFor(() => expect(h.closed).toHaveLength(1));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('cancel down'));
      await expectNothingEscaped();
    });

    it('cancel() throwing during destroy() neither reaches the caller nor keeps the socket open', async () => {
      const h = await setup();
      h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise(() => {}), cancel: () => { throw new Error('cancel down'); } };
      const client = await h.connect();
      await client.offerKey(makeTestAdbKey());
      await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
      expect(() => h.server.sessions[0].destroy('revoked')).not.toThrow();
      expect(await client.waitClosed()).toBe(true);
      expect(h.closed).toHaveLength(1);
      await expectNothingEscaped();
    });

    it('onClose throwing after a client disconnects does not escape', async () => {
      const h = await setup({ onClose: () => { throw new Error('close hook down'); } });
      const client = await h.connect();
      await client.authenticate(h.key);
      client.close();
      await vi.waitFor(() => expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('close hook down')));
      expect(h.closed).toHaveLength(1);
      await expectNothingEscaped();
    });

    it('onClose throwing during destroy() does not reach the caller', async () => {
      const h = await setup({ onClose: () => { throw new Error('close hook down'); } });
      const client = await h.connect();
      await client.authenticate(h.key);
      expect(() => h.server.sessions[0].destroy('revoked')).not.toThrow();
      expect(await client.waitClosed()).toBe(true);
      expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('close hook down'));
      await expectNothingEscaped();
    });
  });
});
