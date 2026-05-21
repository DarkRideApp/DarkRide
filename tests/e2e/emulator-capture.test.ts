/**
 * Headline E2E test for emulator capture.
 *
 * Drives the full chain end-to-end:
 *   1. Spawn a docker-android container via DarkRide's API
 *   2. Install the fixture APK (built by CI from tests/e2e/fixtures/hello-world)
 *   3. Start capture session for the device
 *   4. Launch the app — it fires https://e2e.example.test/ping
 *   5. Assert the request appears in DarkRide's captured traffic
 *   6. Tear down
 *
 * Designed to run only in the ci-e2e-emulator.yml workflow. NOT included
 * in the standard backend vitest suite — excluded via vitest.config.ts.
 *
 * Wall-time budget: ~10 minutes per run on a hosted GitHub runner with
 * KVM nested virt. The container pull is the biggest factor and is
 * cached across runs via the workflow's image cache step.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';
import http from 'http';

const APK = resolve('./tests/e2e/fixtures/hello-world/app/build/outputs/apk/debug/app-debug.apk');
const HOST = process.env.DARKRIDE_HOST ?? 'http://localhost:3001';
const API_KEY = process.env.DARKRIDE_API_KEY;
const TIMEOUT_BOOT_MS = 5 * 60_000;
const TIMEOUT_CAPTURE_MS = 60_000;

async function rest(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  const url = new URL(path, HOST);
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  // CI provisions a long-lived admin API key after DarkRide boots; the
  // workflow exports it as DARKRIDE_API_KEY. Without auth, the
  // core.devices:manage + core.traffic:manage scoped endpoints reject.
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const opts: http.RequestOptions = { method, headers };
  return new Promise<{ status: number; body: any }>((resolveP, rejectP) => {
    const req = http.request(url, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolveP({ status: res.statusCode ?? 0, body: JSON.parse(text) }); }
        catch { resolveP({ status: res.statusCode ?? 0, body: text }); }
      });
    });
    req.on('error', rejectP);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null) return r;
    } catch {
      // ignore intermediate failures (DarkRide may still be starting)
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timeout after ${timeoutMs}ms`);
}

describe('E2E — emulator capture', () => {
  it(
    'spawns docker-android, installs fixture, captures the ping, asserts the trace',
    { timeout: 12 * 60_000 },
    async () => {
      const t0 = Date.now();
      const step = (msg: string) => console.log(`[E2E ${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

      // Sanity: the APK must exist (CI builds it before this test)
      step(`check fixture APK at ${APK}`);
      expect(existsSync(APK)).toBe(true);

      // 1. Create the emulator instance via the API
      step('POST /v1/devices/providers/docker-android/instances');
      const create = await rest('POST', '/v1/devices/providers/docker-android/instances', {
        displayName: `e2e-${Date.now()}`,
        config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
      });
      step(`create response: status=${create.status} body=${JSON.stringify(create.body).slice(0, 300)}`);
      expect(create.status).toBe(200);
      const instanceId = create.body?.data?.instance?.id as number;
      expect(instanceId).toBeDefined();

      try {
        // 2. Start the container — response carries the resolved serial
        //    (docker picks a free host port; serial = "localhost:<port>")
        step(`POST /v1/devices/providers/docker-android/instances/${instanceId}/start (this blocks for up to ~240s while emulator cold-boots)`);
        const startRes = await rest(
          'POST',
          `/v1/devices/providers/docker-android/instances/${instanceId}/start`,
        );
        step(`start response: status=${startRes.status} body=${JSON.stringify(startRes.body).slice(0, 500)}`);
        expect(startRes.status).toBe(200);
        const serial = startRes.body?.data?.running?.serial as string;
        expect(serial).toBeDefined();
        step(`emulator booted, serial=${serial}`);

        // 3. Wait until DarkRide marks the instance as running
        step('polling listInstances until state===running');
        await waitFor(async () => {
          const r = await rest('GET', `/v1/devices/providers/docker-android/instances`);
          const inst = r.body?.data?.instances?.find((i: any) => i.id === instanceId);
          return inst?.state === 'running' ? inst : undefined;
        }, TIMEOUT_BOOT_MS);
        step('listInstances reports running');

        // 4. Install the fixture APK on the running container
        step(`adb -s ${serial} install -r <fixture>`);
        execFileSync('adb', ['-s', serial, 'install', '-r', APK], { stdio: 'inherit' });
        step('APK installed');

        // 5. Start capture session for this device
        step(`POST /v1/capture/start { deviceId: ${serial} }`);
        const captureRes = await rest('POST', `/v1/capture/start`, { deviceId: serial });
        step(`capture start response: status=${captureRes.status} body=${JSON.stringify(captureRes.body).slice(0, 300)}`);
        expect(captureRes.status).toBe(200);
        // emu-http-proxy mode returns the mitmproxy host:port. The fixture
        // wires this into a Java Proxy() for the request — relying on
        // `settings put global http_proxy` alone doesn't work because
        // HttpURLConnection ignores the system setting in practice.
        const httpProxy = captureRes.body?.data?.httpProxy as { host: string; port: number } | undefined;
        expect(httpProxy).toBeDefined();
        const proxyUrl = `${httpProxy!.host}:${httpProxy!.port}`;
        step(`proxy from capture response: ${proxyUrl}`);

        // Diagnostic: prove mitmproxy is reachable at the advertised host
        // from the runner (rules out host-side firewall / wrong-interface
        // binding) and from inside the emulator (rules out QEMU NAT /
        // bridge-routing issues). Failures here pinpoint which layer
        // breaks the chain.
        try {
          const hostProbe = execFileSync(
            'curl',
            ['-s', '-o', '/dev/null', '-w', 'host->mitm http_code=%{http_code} time=%{time_total}s\n',
             '--max-time', '3', '--connect-timeout', '2',
             '-x', `http://${proxyUrl}`, 'http://e2e-diag.example.test/probe'],
            { encoding: 'utf8' },
          );
          step(`HOST->MITM probe: ${hostProbe.trim()}`);
        } catch (e: any) {
          step(`HOST->MITM probe FAILED: ${e.message?.slice(0, 200) ?? e}`);
        }
        try {
          const emuProbe = execFileSync(
            'adb',
            ['-s', serial, 'shell',
             `nc -w 2 -z ${httpProxy!.host} ${httpProxy!.port} && echo EMU_REACH_OK || echo EMU_REACH_FAIL`],
            { encoding: 'utf8' },
          );
          step(`EMU->MITM probe: ${emuProbe.trim()}`);
        } catch (e: any) {
          step(`EMU->MITM probe FAILED: ${e.message?.slice(0, 200) ?? e}`);
        }

        // 6. Launch the fixture activity — it fires https://e2e.example.test/ping
        //    from onCreate(), routed through DarkRide's mitmproxy bridge.
        step(`adb -s ${serial} shell am start ... --es proxy_url ${proxyUrl}`);
        execFileSync(
          'adb',
          [
            '-s', serial,
            'shell', 'am', 'start',
            '-n', 'wiki.themeparks.darkride.e2efixture/.MainActivity',
            '--es', 'proxy_url', proxyUrl,
          ],
          { stdio: 'inherit' },
        );
        step('app launched; polling traffic store for the captured request');

        // 7. Poll the traffic store until the captured request appears.
        //    Endpoint: GET /v1/traffic/list?deviceId=<serial>&hostname=e2e.example.test
        //    Response shape: { data: { items: [...], total, limit, offset } }
        const captured = await waitFor(async () => {
          const r = await rest(
            'GET',
            `/v1/traffic/list?deviceId=${encodeURIComponent(serial)}&hostname=e2e.example.test`,
          );
          const found = (r.body?.data?.items as any[] | undefined)?.find(
            (t: any) => {
              try {
                const u = new URL(t.requestUrl);
                return u.hostname === 'e2e.example.test' && u.pathname === '/ping';
              } catch {
                return false;
              }
            },
          );
          return found;
        }, TIMEOUT_CAPTURE_MS);
        step(`captured: ${JSON.stringify(captured).slice(0, 300)}`);

        expect(captured).toBeDefined();
        const capturedUrl = new URL(captured.requestUrl);
        expect(capturedUrl.hostname).toBe('e2e.example.test');
        expect(capturedUrl.pathname).toBe('/ping');
      } finally {
        // 8. Tear down — stop + delete the container even if assertions failed
        await rest(
          'POST',
          `/v1/devices/providers/docker-android/instances/${instanceId}/stop`,
        ).catch(() => {});
        await rest(
          'DELETE',
          `/v1/devices/providers/docker-android/instances/${instanceId}`,
        ).catch(() => {});
      }
    },
  );
});
