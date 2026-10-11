import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { FakeAdbServer } from './testing/fake-adb-server';
import { DeviceUnavailableError, HostClient, HostProtocolError, resolveAdbServerAddress } from './host-client';

const frame = (s: string) => Buffer.byteLength(s).toString(16).padStart(4, '0') + s;

function readAll(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
    socket.resume();
  });
}

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A bare server that accepts one connection, answers the transport request with OKAY, then hands control to onService for the service request. */
async function scriptedServer(onService: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let seen = 0;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = parseInt(buf.subarray(0, 4).toString('ascii'), 16);
        if (buf.length < 4 + len) return;
        buf = buf.subarray(4 + len);
        seen++;
        if (seen === 1) socket.write('OKAY');
        else onService(socket);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('resolveAdbServerAddress', () => {
  it('defaults to 127.0.0.1:5037', () => {
    expect(resolveAdbServerAddress({})).toEqual({ host: '127.0.0.1', port: 5037 });
  });

  it('honours ANDROID_ADB_SERVER_ADDRESS and ANDROID_ADB_SERVER_PORT', () => {
    expect(resolveAdbServerAddress({ ANDROID_ADB_SERVER_ADDRESS: '10.0.0.2', ANDROID_ADB_SERVER_PORT: '15037' }))
      .toEqual({ host: '10.0.0.2', port: 15037 });
  });

  it('ignores a non-numeric port', () => {
    expect(resolveAdbServerAddress({ ANDROID_ADB_SERVER_PORT: 'abc' }).port).toBe(5037);
  });
});

describe('HostClient', () => {
  let fake: FakeAdbServer;
  let addr: { host: string; port: number };
  let client: HostClient;

  beforeEach(async () => {
    fake = new FakeAdbServer([{ serial: 'SER1', features: 'cmd,stat_v2' }, { serial: 'OFF1', online: false }], {
      shell: (_serial, command) => {
        if (command.startsWith('getprop')) return 'prod\nmodel\ndev\n';
        if (command === 'big') return 'x'.repeat(200_000);
        if (command === 'true') return '';
        return `ran: ${command}\n`;
      },
    });
    addr = await fake.start();
    client = new HostClient(addr, 2000);
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('queries a host service', async () => {
    expect(await client.query('host:version')).toBe('0029');
  });

  it('returns the device feature list', async () => {
    expect(await client.features('SER1')).toBe('cmd,stat_v2');
  });

  it('rejects a feature query for an unknown device', async () => {
    await expect(client.features('NOPE')).rejects.toThrow(HostProtocolError);
  });

  it('opens a bound service and streams its output', async () => {
    const socket = await client.openService('SER1', 'shell:echo hi');
    expect(await readAll(socket)).toBe('ran: echo hi\n');
  });

  it('does not lose bytes that arrive together with the service OKAY', async () => {
    const socket = await client.openService('SER1', 'shell:big');
    expect((await readAll(socket)).length).toBe(200_000);
  });

  it('relays both ways on an echo service', async () => {
    const socket = await client.openService('SER1', 'echo:');
    socket.write('abc');
    const got = await new Promise<string>((resolve) => {
      socket.once('data', (c) => resolve(c.toString()));
      socket.resume();
    });
    expect(got).toBe('abc');
    socket.destroy();
  });

  it('rejects opening a service on an offline device', async () => {
    await expect(client.openService('OFF1', 'shell:x')).rejects.toThrow(HostProtocolError);
  });

  it.each(['OFF1', 'NOPE'])('names a transport the ADB server refuses for %s as the device being unavailable', async (serial) => {
    const failure = await client.openService(serial, 'shell:x').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DeviceUnavailableError);
    expect(failure).toBeInstanceOf(HostProtocolError);
    expect((failure as Error).message).toBe(`device '${serial}' not found`);
  });

  it('does not call a refused service on an available device unavailable', async () => {
    const failure = await client.openService('SER1', 'nosuch:').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HostProtocolError);
    expect(failure).not.toBeInstanceOf(DeviceUnavailableError);
  });

  it('builds the CNXN banner from properties and features', async () => {
    expect(await client.deviceBanner('SER1')).toBe(
      'device::ro.product.name=prod;ro.product.model=model;ro.product.device=dev;features=cmd,stat_v2',
    );
  });

  it.each([
    ['in the middle', 'shell_v2,delayed_ack,cmd,stat_v2', 'shell_v2,cmd,stat_v2'],
    ['at the start', 'delayed_ack,shell_v2,cmd,stat_v2', 'shell_v2,cmd,stat_v2'],
    ['at the end', 'shell_v2,cmd,stat_v2,delayed_ack', 'shell_v2,cmd,stat_v2'],
    ['on its own', 'delayed_ack', ''],
    ['only as an exact token', 'cmd,delayed_ack2,xdelayed_ack,stat_v2', 'cmd,delayed_ack2,xdelayed_ack,stat_v2'],
    ['when absent', 'shell_v2,cmd,stat_v2', 'shell_v2,cmd,stat_v2'],
  ])('drops delayed_ack from the banner features %s', async (_where, features, expected) => {
    const server = new FakeAdbServer([{ serial: 'D1', features }], { shell: () => 'prod\nmodel\ndev\n' });
    const c = new HostClient(await server.start(), 2000);
    try {
      expect(await c.deviceBanner('D1')).toBe(
        `device::ro.product.name=prod;ro.product.model=model;ro.product.device=dev;features=${expected}`,
      );
    } finally {
      await server.stop();
    }
  });

  it('strips separators and control characters from property values', async () => {
    const dirty = new FakeAdbServer([{ serial: 'D1' }], { shell: () => 'a;b=c\nmo\u0001del\ndev\n' });
    const c = new HostClient(await dirty.start(), 2000);
    expect(await c.deviceBanner('D1')).toContain('ro.product.name=abc;ro.product.model=model;ro.product.device=dev');
    await dirty.stop();
  });

  it('rejects when nothing is listening', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(new HostClient({ host: '127.0.0.1', port }, 500).query('host:version')).rejects.toThrow();
  });

  it('times out against a server that never answers', async () => {
    const silent = net.createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    await expect(new HostClient({ host: '127.0.0.1', port }, 200).query('host:version')).rejects.toThrow(/timeout/);
    silent.close();
  });

  it('collects a service output and rejects one larger than maxBytes', async () => {
    expect(await client.collect('SER1', 'shell:echo hi')).toBe('ran: echo hi\n');
    await expect(client.collect('SER1', 'shell:big', 1000)).rejects.toThrow(/output too large/);
  });

  it('closes the device connection when collect exceeds its size cap', async () => {
    await expect(client.collect('SER1', 'flood:1000000000', 1000)).rejects.toThrow(/output too large/);
    await waitFor(() => fake.activeServiceSockets() === 0);
  });

  it('closes the device connection when collect times out', async () => {
    const quick = new HostClient(addr, 150);
    await expect(quick.collect('SER1', 'hold:')).rejects.toThrow(/timeout/);
    await waitFor(() => fake.activeServiceSockets() === 0);
  });

  it('hands back a socket that is already closed when the service ends right after OKAY', async () => {
    // Characterizes the paused-socket hazard: with no data pending, a paused socket still sees the peer's FIN and destroys itself.
    const socket = await client.openService('SER1', 'shell:true');
    await waitFor(() => socket.destroyed);
    expect(socket.destroyed).toBe(true);
  });

  it('delivers close to a handler attached synchronously after openService resolves', async () => {
    const socket = await client.openService('SER1', 'shell:true');
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});

describe('HostClient socket handling', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('pushes back bytes that share a chunk with the service OKAY', async () => {
    const server = await scriptedServer((socket) => socket.write('OKAY' + 'tail-bytes'));
    closers.push(server.close);
    const socket = await new HostClient({ host: '127.0.0.1', port: server.port }, 2000).openService('SER1', 'shell:x');
    expect(socket.isPaused()).toBe(true);
    expect(socket.readableLength).toBe('tail-bytes'.length);
    const got = await new Promise<string>((resolve) => {
      socket.once('data', (c) => resolve(c.toString()));
      socket.resume();
    });
    expect(got).toBe('tail-bytes');
    socket.destroy();
  });

  it('keeps an error listener on a returned socket so a late reset is not unhandled', async () => {
    const server = await scriptedServer((socket) => socket.write('OKAY'));
    closers.push(server.close);
    const socket = await new HostClient({ host: '127.0.0.1', port: server.port }, 2000).openService('SER1', 'shell:x');
    expect(() => socket.emit('error', new Error('late failure'))).not.toThrow();
    socket.destroy();
  });

  it('survives a connection reset that arrives after the socket was handed out', async () => {
    const uncaught: Error[] = [];
    const record = (e: Error) => uncaught.push(e);
    process.on('uncaughtException', record);
    try {
      const server = await scriptedServer((socket) => {
        socket.write('OKAY');
        setTimeout(() => socket.resetAndDestroy(), 20);
      });
      closers.push(server.close);
      const socket = await new HostClient({ host: '127.0.0.1', port: server.port }, 2000).openService('SER1', 'shell:x');
      const closed = new Promise<void>((r) => socket.once('close', () => r()));
      socket.resume();
      await closed;
      await new Promise((r) => setTimeout(r, 20));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
    }
  });

  it('rejects an unexpected status word from the server', async () => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.write('WHAT'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    await expect(new HostClient({ host: '127.0.0.1', port }, 2000).query('host:version')).rejects.toThrow(/unexpected status/);
  });

  it('rejects a FAIL reply with an empty message as a HostProtocolError reading FAIL', async () => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.write('FAIL0000'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    const failure = await new HostClient({ host: '127.0.0.1', port }, 2000).query('host:version').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HostProtocolError);
    expect((failure as Error).message).toBe('FAIL');
  });

  it('closes its socket when the service request is refused', async () => {
    let serverSide!: net.Socket;
    let markClosed!: () => void;
    const serverSideClosed = new Promise<void>((r) => (markClosed = r));
    const server = await scriptedServer((socket) => {
      serverSide = socket;
      socket.once('close', () => markClosed());
      socket.write('FAIL' + frame('refused'));
    });
    closers.push(server.close);
    const failure = await new HostClient({ host: '127.0.0.1', port: server.port }, 2000).openService('SER1', 'shell:x').catch((e: unknown) => e);
    expect((failure as Error).message).toBe('refused');
    expect(failure).not.toBeInstanceOf(DeviceUnavailableError);
    await serverSideClosed;
    expect(serverSide.destroyed).toBe(true);
  });

  it('does not call a connection dropped during the transport request a device that is unavailable', async () => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.destroy());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    const failure = await new HostClient({ host: '127.0.0.1', port }, 2000).openService('SER1', 'shell:x').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DeviceUnavailableError);
  });

  it('frames a multi-byte request by its byte length', async () => {
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', (c) => {
        seen.push(c.toString('utf8'));
        socket.write('OKAY' + frame('ok'));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    expect(await new HostClient({ host: '127.0.0.1', port }, 2000).query('host:é')).toBe('ok');
    expect(seen).toEqual([frame('host:é')]);
  });
});
