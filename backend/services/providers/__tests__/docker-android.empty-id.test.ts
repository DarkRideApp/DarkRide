import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Docker from 'dockerode';
import { createDockerAndroidProvider } from '../docker-android';

// A daemon that answers like Docker's router: a path with an empty segment is
// redirected to the cleaned path. docker-modem follows that redirect to a host
// named after the first path segment, and the failed lookup is an uncaught
// error that ends the process. So the provider must never send such a path.
describe('docker-android provider against a daemon that redirects empty path segments', () => {
  let dir: string;
  let socketPath: string;
  let server: http.Server;
  const seen: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
    socketPath = path.join(dir, 'docker.sock');
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const [pathname, query] = (req.url ?? '').split('?');
      if (pathname.includes('//')) {
        const cleaned = pathname.replace(/\/{2,}/g, '/') + (query ? `?${query}` : '');
        res.writeHead(301, { Location: cleaned });
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"no such container"}');
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeProvider() {
    return createDockerAndroidProvider(new Docker({ socketPath }) as any, {
      coturn: { ensure: async () => false, writeTurncfg: () => null },
    });
  }

  it('stopInstance with no container id sends nothing to the daemon', async () => {
    seen.length = 0;
    await makeProvider().stopInstance('');
    expect(seen).toEqual([]);
  });

  it('deleteInstance with no container id sends nothing to the daemon', async () => {
    seen.length = 0;
    await makeProvider().deleteInstance!('');
    expect(seen).toEqual([]);
  });

  it('startInstance with no container id sends nothing to the daemon', async () => {
    seen.length = 0;
    await expect(makeProvider().startInstance('')).rejects.toThrow(/no container/i);
    expect(seen).toEqual([]);
  });
});
