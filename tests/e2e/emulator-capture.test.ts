/**
 * Headline E2E test for emulator capture.
 *
 * Drives the full chain end-to-end:
 *   1. Spawn a docker-android container via DarkRide's API
 *   2. Install the fixture APK (built by CI from tests/e2e/fixtures/hello-world)
 *   3. Start capture session for the device
 *   4. Launch the app — it fires https://example.com/?darkride-e2e=ping
 *   5. Assert the request appears in DarkRide's captured traffic
 *   6. Stop the capture and assert the in-container relay is gone
 *   7. Tear down
 *
 * Designed to run only in the ci-e2e-emulator.yml workflow. NOT included
 * in the standard backend vitest suite — excluded via vitest.config.ts.
 *
 * Wall-time budget: ~10 minutes per run on a hosted GitHub runner with
 * KVM nested virt. The container pull is the biggest factor and is
 * cached across runs via the workflow's image cache step.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import path, { resolve } from 'path';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import http from 'http';

const APK = resolve('./tests/e2e/fixtures/hello-world/app/build/outputs/apk/debug/app-debug.apk');
const HOST = process.env.DARKRIDE_HOST ?? 'http://localhost:3001';
const API_KEY = process.env.DARKRIDE_API_KEY;
const TIMEOUT_BOOT_MS = 5 * 60_000;
const PING_WAIT_MS = 60_000;
const FIXTURE_PACKAGE = 'wiki.themeparks.darkride.e2efixture';

async function rest(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  const url = new URL(path, HOST);
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  // CI provisions a long-lived admin API key after DarkRide boots; the
  // workflow exports it as DARKRIDE_API_KEY. Without auth, the
  // core.devices:manage + core.traffic:manage scoped endpoints reject.
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  // No pooled connection: `adb install` blocks this process for several seconds,
  // long enough for the server to close an idle keep-alive socket that the next
  // request would reuse, which fails with "socket hang up".
  const opts: http.RequestOptions = { method, headers, agent: false };
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

/** Capture start runs one TCP relay inside the emulator container; this counts them. */
function countForwarderRelays(): number {
  const id = execFileSync('docker', ['ps', '-q', '--filter', 'label=darkride.emulator=true'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)[0];
  const out = execFileSync(
    'docker',
    ['exec', '-u', 'androidusr', id, 'sh', '-c', "grep -la 'LISTEN_PORT=[0-9]' /proc/[0-9]*/cmdline 2>/dev/null | wc -l"],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

/**
 * Print what the host knows about the emulator containers. A failed boot
 * leaves no trace once the test tears the container down, and the emulator's
 * own output is the only place the reason shows.
 */
function dumpEmulatorDiagnostics(): void {
  const run = (label: string, cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-120).join('\n');
    console.log(`[E2E diag] ${label}:\n${out || (r.error?.message ?? '(no output)')}`);
  };
  run('/dev/kvm', 'ls', ['-l', '/dev/kvm']);
  run('cpu virtualization flag', 'sh', ['-c', "grep -o -m1 -E 'vmx|svm' /proc/cpuinfo || echo none"]);
  run('adb devices', 'adb', ['devices', '-l']);
  const ids = (spawnSync('docker', ['ps', '-aq', '--filter', 'label=darkride.emulator=true'], { encoding: 'utf8' }).stdout ?? '')
    .split('\n').filter(Boolean);
  for (const id of ids) {
    run(`docker logs ${id.slice(0, 12)}`, 'docker', ['logs', '--tail', '120', id]);
    // The emulator writes its own log files; they survive a stopped container.
    for (const dir of ['/home/androidusr/logs', '/var/log/supervisor']) {
      const dest = mkdtempSync(path.join(tmpdir(), 'emu-logs-'));
      const cp = spawnSync('docker', ['cp', `${id}:${dir}/.`, dest], { encoding: 'utf8' });
      if (cp.status !== 0) {
        console.log(`[E2E diag] docker cp ${dir} failed: ${(cp.stderr ?? '').trim().slice(0, 200)}`);
        continue;
      }
      for (const name of readdirSync(dest)) {
        const file = path.join(dest, name);
        if (!statSync(file).isFile()) continue;
        const tail = readFileSync(file, 'utf8').trim().split('\n').slice(-60).join('\n');
        console.log(`[E2E diag] ${dir}/${name}:\n${tail}`);
      }
    }
  }
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
      let passed = false;

      try {
        // The create call answers at once with state "pulling" and no
        // container; the container is made in the background. Starting
        // before it exists sends Docker an empty container id.
        step('polling listInstances until the container exists (state!==pulling)');
        const created = await waitFor(async () => {
          const r = await rest('GET', `/v1/devices/providers/docker-android/instances`);
          const inst = r.body?.data?.instances?.find((i: any) => i.id === instanceId);
          return inst && inst.state !== 'pulling' ? inst : undefined;
        }, TIMEOUT_BOOT_MS);
        expect(created.state, `instance creation failed: ${created.lastError}`).toBe('created');
        step('container created');

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

        // 6. Launch the fixture activity — it fires https://example.com/?darkride-e2e=ping
        //    once from onCreate(), routed through DarkRide's mitmproxy bridge.
        //    capture/start returns only once the guest can reach the proxy, so a
        //    single launch must be enough: no relaunch, no retry.
        // Clear logcat first so the post-mortem only shows this launch.
        execFileSync('adb', ['-s', serial, 'logcat', '-c'], { stdio: 'inherit' });
        step(`adb -s ${serial} shell am start ... --es proxy_url ${proxyUrl}`);
        execFileSync(
          'adb',
          [
            '-s', serial,
            'shell', 'am', 'start',
            '-n', `${FIXTURE_PACKAGE}/.MainActivity`,
            '--es', 'proxy_url', proxyUrl,
          ],
          { stdio: 'inherit' },
        );
        step('app launched; polling traffic store for the captured request');

        // The fixture's MainActivity logs Log.i(TAG="e2efixture") for both the
        // opening attempt and the result — so even if mitmproxy never sees the
        // request, we know whether the app made the call, hit a TLS error, got
        // a connect refused, etc. `-s e2efixture` filters to that tag at
        // default (INFO+) priority — without it `*:F` would mute everything.
        const dumpFixtureLogcat = () => {
          try {
            const lc = execFileSync(
              'adb',
              ['-s', serial, 'logcat', '-d', '-s', 'e2efixture:V', 'AndroidRuntime:E', 'System.err:V'],
              { encoding: 'utf8' },
            );
            step(`logcat (e2efixture + errors):\n${lc.split('\n').slice(0, 40).join('\n')}`);
          } catch (e: any) {
            step(`logcat dump failed: ${e.message?.slice(0, 200) ?? e}`);
          }
        };

        // 7. Poll the traffic store until the captured request appears.
        //    Endpoint: GET /v1/traffic/list?deviceId=<serial>&hostname=example.com
        //    Response shape: { data: { items: [...], total, limit, offset } }
        //    The fixture hits https://example.com/?darkride-e2e=ping — a
        //    real domain so mitmproxy's CONNECT to it succeeds and the
        //    request gets captured + decrypted. The query param marks the
        //    request as ours so we don't false-positive on other example.com
        //    traffic (there shouldn't be any in CI, but be defensive).
        const findPing = async () => {
          const r = await rest(
            'GET',
            `/v1/traffic/list?deviceId=${encodeURIComponent(serial)}&hostname=example.com`,
          );
          return (r.body?.data?.items as any[] | undefined)?.find(
            (t: any) => {
              try {
                const u = new URL(t.requestUrl);
                return u.hostname === 'example.com' && u.searchParams.get('darkride-e2e') === 'ping';
              } catch {
                return false;
              }
            },
          );
        };

        const captured = await waitFor(findPing, PING_WAIT_MS, 2000).catch(async (err) => {
          dumpFixtureLogcat();
          // Dump everything the traffic store knows about this device so
          // we can tell whether the webhook fired at all and what shape
          // got persisted. Helps debug capture-pipeline issues without
          // another iteration.
          const dumpAll = await rest('GET', `/v1/traffic/list?deviceId=${encodeURIComponent(serial)}`);
          step(`traffic store dump (all for device): status=${dumpAll.status} total=${dumpAll.body?.data?.total ?? '?'} items=${JSON.stringify((dumpAll.body?.data?.items as any[] | undefined)?.slice(0, 5)?.map((t: any) => ({ url: t.requestUrl, host: t.hostname, status: t.responseStatus, dev: t.deviceId })))?.slice(0, 800)}`);
          throw err;
        });
        step(`captured: ${JSON.stringify(captured).slice(0, 300)}`);

        expect(captured).toBeDefined();
        const capturedUrl = new URL(captured.requestUrl);
        expect(capturedUrl.hostname).toBe('example.com');
        expect(capturedUrl.searchParams.get('darkride-e2e')).toBe('ping');

        // 8. Capture runs exactly one in-container relay and stopping it ends it.
        expect(countForwarderRelays()).toBe(1);
        step(`POST /v1/capture/stop { deviceId: ${serial} }`);
        const stopCapture = await rest('POST', '/v1/capture/stop', { deviceId: serial });
        expect(stopCapture.status).toBe(200);
        await waitFor(async () => (countForwarderRelays() === 0 ? true : undefined), 15_000, 500);
        step('no forwarder relay left in the container');
        passed = true;
      } finally {
        if (!passed) dumpEmulatorDiagnostics();
        // 9. Tear down — stop + delete the container even if assertions failed
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
