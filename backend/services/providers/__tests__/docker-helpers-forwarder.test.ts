import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { spawnContainerHttpForwarder, stopContainerHttpForwarders, type DockerLike } from '../docker-helpers';

// Runs the exact commands the product sends to the container (sh + python3) on
// this machine instead of in docker, so the relay, the sweep and the readiness
// check are exercised as real processes.
function localDocker(): DockerLike {
  const container = {
    exec: async (opts: { Cmd: string[]; Detach?: boolean }) => ({
      start: async (startOpts: { Detach?: boolean }) => {
        const [bin, ...args] = opts.Cmd;
        if (opts.Detach || startOpts?.Detach) {
          spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
          return undefined;
        }
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = new PassThrough();
        child.stdout!.pipe(out, { end: false });
        child.stderr!.pipe(out, { end: false });
        child.on('close', () => out.end());
        return out;
      },
    }),
  };
  return { getContainer: () => container } as unknown as DockerLike;
}

const open = new Set<net.Server>();
const decoys = new Set<ChildProcess>();

async function listen(host: string, port = 0): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((sock) => sock.pipe(sock));
  open.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, port: (server.address() as net.AddressInfo).port };
}

async function freePort(): Promise<number> {
  const { server, port } = await listen('127.0.0.1');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

async function echoesThrough(port: number): Promise<boolean> {
  try {
    const sock = await connect(port);
    return await new Promise<boolean>((resolve) => {
      sock.once('data', (d) => { sock.destroy(); resolve(d.toString() === 'ping'); });
      sock.once('error', () => resolve(false));
      sock.once('close', () => resolve(false));
      sock.write('ping');
    });
  } catch {
    return false;
  }
}

async function refuses(port: number): Promise<boolean> {
  try {
    (await connect(port)).destroy();
    return false;
  } catch (err: any) {
    return err.code === 'ECONNREFUSED';
  }
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

const logPath = (port: number) => `/tmp/darkride-forwarder-${port}.log`;

describe.skipIf(process.platform !== 'linux')('in-container HTTP forwarder (real processes)', () => {
  const docker = localDocker();

  afterEach(async () => {
    await stopContainerHttpForwarders(docker, 'local');
    for (const d of decoys) d.kill();
    decoys.clear();
    for (const s of open) s.close();
    open.clear();
  });

  it('relays a connection to the target', async () => {
    const target = await listen('127.0.0.1');
    const port = await freePort();
    await spawnContainerHttpForwarder(docker, 'local', port, '127.0.0.1', target.port);
    expect(await echoesThrough(port)).toBe(true);
  }, 20_000);

  it('stopContainerHttpForwarders ends the relay and removes its log', async () => {
    const target = await listen('127.0.0.1');
    const port = await freePort();
    await spawnContainerHttpForwarder(docker, 'local', port, '127.0.0.1', target.port);
    expect(existsSync(logPath(port))).toBe(true);

    await stopContainerHttpForwarders(docker, 'local');

    expect(await eventually(() => refuses(port))).toBe(true);
    expect(existsSync(logPath(port))).toBe(false);
  }, 20_000);

  it('a new relay replaces the previous one instead of piling up beside it', async () => {
    const target = await listen('127.0.0.1');
    const first = await freePort();
    await spawnContainerHttpForwarder(docker, 'local', first, '127.0.0.1', target.port);
    const second = await freePort();
    await spawnContainerHttpForwarder(docker, 'local', second, '127.0.0.1', target.port);

    expect(await echoesThrough(second)).toBe(true);
    expect(await eventually(() => refuses(first))).toBe(true);
    expect(existsSync(logPath(first))).toBe(false);
  }, 30_000);

  it('rejects when another process already holds the port, even though something is listening', async () => {
    const target = await listen('127.0.0.1');
    const squatter = await listen('0.0.0.0');

    await expect(
      spawnContainerHttpForwarder(docker, 'local', squatter.port, '127.0.0.1', target.port),
    ).rejects.toThrow(/failed to start/);
  }, 20_000);

  it('leaves unrelated processes alone', async () => {
    const target = await listen('127.0.0.1');
    const port = await freePort();
    const bystander = spawn('sh', ['-c', 'sleep 60', 'LISTEN_PORT=none'], { stdio: 'ignore' });
    decoys.add(bystander);
    await spawnContainerHttpForwarder(docker, 'local', port, '127.0.0.1', target.port);

    await stopContainerHttpForwarders(docker, 'local');

    expect(await eventually(() => refuses(port))).toBe(true);
    expect(bystander.exitCode).toBeNull();
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
  }, 20_000);
});
