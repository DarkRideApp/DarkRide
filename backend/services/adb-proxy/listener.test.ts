import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { DeviceListener, ListenError } from './listener';

const logError = vi.hoisted(() => vi.fn());
vi.mock('../../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: logError }) }));

const open: DeviceListener[] = [];
beforeEach(() => { logError.mockClear(); });
afterEach(async () => {
  vi.useRealTimers();
  for (const l of open.splice(0)) await l.close();
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const emitServerError = (l: DeviceListener, err: NodeJS.ErrnoException) => (l as any).server.emit('error', err);

describe('DeviceListener', () => {
  it('hands each accepted socket to the callback and reports its bound port', async () => {
    const accepted: net.Socket[] = [];
    const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: (s) => accepted.push(s) });
    open.push(l);
    await l.listen();
    expect(l.port).toBeGreaterThan(0);
    const client = net.connect(l.port, '127.0.0.1');
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    client.destroy();
  });

  it('fails with a ListenError carrying the code when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    const l = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
    await expect(l.listen()).rejects.toMatchObject({ name: 'ListenError', code: 'EADDRINUSE' });
    await new Promise<void>((r) => blocker.close(() => r()));
    expect(new ListenError('X', 'y').code).toBe('X');
  });

  it('can listen again after a failed bind', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    const l = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
    open.push(l);
    await expect(l.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((r) => blocker.close(() => r()));
    await l.listen();
    expect(l.port).toBe(port);
  });

  it('destroys a socket whose accept callback throws', async () => {
    const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => { throw new Error('nope'); } });
    open.push(l);
    await l.listen();
    const client = net.connect(l.port, '127.0.0.1');
    await new Promise<void>((r) => client.on('close', () => r()));
  });

  it('close() drops open connections and frees the port', async () => {
    const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} });
    await l.listen();
    const port = l.port;
    const client = net.connect(port, '127.0.0.1');
    await new Promise<void>((r) => client.on('connect', () => r()));
    const closed = new Promise<void>((r) => client.on('close', () => r()));
    await l.close();
    await closed;
    const again = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
    open.push(again);
    await again.listen();
  });

  it('close() before listen() is harmless', async () => {
    await new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} }).close();
  });

  it('close() can be called twice and both calls settle', async () => {
    const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} });
    await l.listen();
    await Promise.all([l.close(), l.close()]);
    await l.close();
  });

  describe('lifecycle', () => {
    it('close() during an in-flight listen() rejects it and leaves the port free', async () => {
      const port = await freePort();
      const l = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
      const bind = l.listen();
      const rejected = expect(bind).rejects.toMatchObject({ name: 'ListenError', code: 'ECLOSED' });
      await l.close();
      await rejected;
      const again = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
      open.push(again);
      await again.listen();
    });

    it('a second listen() rejects with ELISTENING and the first server keeps serving', async () => {
      const accepted: net.Socket[] = [];
      const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: (s) => accepted.push(s) });
      open.push(l);
      await l.listen();
      const port = l.port;
      await expect(l.listen()).rejects.toMatchObject({ name: 'ListenError', code: 'ELISTENING' });
      expect(l.port).toBe(port);
      const client = net.connect(port, '127.0.0.1');
      await vi.waitFor(() => expect(accepted).toHaveLength(1));
      client.destroy();
    });

    it('a listen() while the first bind is in flight rejects with ELISTENING and does not leak a server', async () => {
      const port = await freePort();
      const l = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
      open.push(l);
      const first = l.listen();
      await expect(l.listen()).rejects.toMatchObject({ code: 'ELISTENING' });
      await first;
      await l.close();
      const again = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
      open.push(again);
      await again.listen();
    });

    it('listen() after close() rejects with ECLOSED', async () => {
      const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} });
      await l.close();
      await expect(l.listen()).rejects.toMatchObject({ name: 'ListenError', code: 'ECLOSED' });
    });
  });

  describe('runtime server errors', () => {
    const emfile = () => Object.assign(new Error('accept EMFILE: too many open files'), { code: 'EMFILE' });

    it('logs the error code through the adb-proxy logger', async () => {
      const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} });
      open.push(l);
      await l.listen();
      emitServerError(l, emfile());
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0][0]).toContain('EMFILE');
    });

    it('logs at most once per second', async () => {
      const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} });
      open.push(l);
      await l.listen();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
      for (let i = 0; i < 50; i++) emitServerError(l, emfile());
      expect(logError).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-11T10:00:00.999Z'));
      emitServerError(l, emfile());
      expect(logError).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-11T10:00:01Z'));
      emitServerError(l, emfile());
      expect(logError).toHaveBeenCalledTimes(2);
    });

    it('keeps the message short and free of error text and unexpected codes', async () => {
      const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} });
      open.push(l);
      await l.listen();
      const hostile = Object.assign(new Error('203.0.113.9 sent ' + 'A'.repeat(10_000)), { code: 'X'.repeat(10_000) });
      emitServerError(l, hostile);
      const line = String(logError.mock.calls[0][0]);
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line).not.toContain('203.0.113.9');
      expect(line).not.toContain('XXXX');
    });

    it('keeps the listener alive after a runtime error', async () => {
      const accepted: net.Socket[] = [];
      const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: (s) => accepted.push(s) });
      open.push(l);
      await l.listen();
      expect(() => emitServerError(l, emfile())).not.toThrow();
      const client = net.connect(l.port, '127.0.0.1');
      await vi.waitFor(() => expect(accepted).toHaveLength(1));
      client.destroy();
    });
  });
});
