import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { DeviceListener, ListenError } from './listener';

const open: DeviceListener[] = [];
afterEach(async () => { for (const l of open.splice(0)) await l.close(); });

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
});
