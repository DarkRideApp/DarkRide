import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DATA } from '../packet';
import { makeTestAdbKey } from './test-keys';
import { WireClient } from './wire-client';

// The server accepts and never answers, so every wait ends on its timeout.
let silent: net.Server;
let port: number;
const open: net.Socket[] = [];

beforeEach(async () => {
  silent = net.createServer((socket) => {
    open.push(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
  port = (silent.address() as net.AddressInfo).port;
});

afterEach(async () => {
  for (const socket of open.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

async function elapsedBeforeRejecting(run: (client: WireClient) => Promise<unknown>): Promise<number> {
  const client = await WireClient.connect(port);
  const started = Date.now();
  await expect(run(client)).rejects.toThrow('timed out waiting for a packet');
  client.close();
  return Date.now() - started;
}

describe('WireClient waits', () => {
  it('lets authenticate take the timeout of its first wait', async () => {
    const key = makeTestAdbKey();
    expect(await elapsedBeforeRejecting((c) => c.authenticate(key, MAX_DATA, 100))).toBeLessThan(1000);
  });

  it('lets offerKey take the timeout of its first wait', async () => {
    const key = makeTestAdbKey();
    expect(await elapsedBeforeRejecting((c) => c.offerKey(key, 100))).toBeLessThan(1000);
  });

  it('lets open and openRaw take the timeout of their wait', async () => {
    expect(await elapsedBeforeRejecting((c) => c.open('shell:true', 1, 100))).toBeLessThan(1000);
    expect(await elapsedBeforeRejecting((c) => c.openRaw('shell:true', 1, 100))).toBeLessThan(1000);
  });
});
