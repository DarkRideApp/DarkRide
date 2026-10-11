import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../backend/test-utils/create-test-db';
import { adbProxyDevices, adbProxyKeys, deviceInstances, devices, settings, users } from '../../backend/db/schema';
import { fingerprintOf } from '../../backend/services/adb-proxy/adb-key';
import { AdbProxyService } from '../../backend/services/adb-proxy/adb-proxy-service';
import { HostClient } from '../../backend/services/adb-proxy/host-client';
import { saveSettings } from '../../backend/services/adb-proxy/settings';
import { FakeAdbServer } from '../../backend/services/adb-proxy/testing/fake-adb-server';
import { freePortBase } from '../../backend/services/adb-proxy/testing/free-port';
import { StubDirectory } from '../../backend/services/adb-proxy/testing/stub-directory';
import { IsolatedAdb, adbAvailable, adbBins, delayedAckSwitch } from './support/real-adb';

// delayed_ack mid-list and a different feature last, so a dropped last entry shows; abb_exec makes the client install over abb_exec:.
const ADVERTISED = 'cmd,delayed_ack,abb_exec,track_app';
const EXPECTED_FEATURES = ['abb_exec', 'cmd', 'track_app'];
const WAIT = { timeout: 10_000, interval: 100 };
const LOG_LINE = '10-11 12:00:00.000  1234  1234 I fake    : conformance log line';

async function startProxy() {
  const fake = new FakeAdbServer([{ serial: 'FAKE1', features: ADVERTISED }], {
    shell: (_serial, command) => {
      if (command.startsWith('getprop')) return 'fakeprod\nFakeModel\nfakedev\n';
      if (command === 'big') return 'x'.repeat(1_000_000);
      if (command.includes('exec logcat')) return `${LOG_LINE}\n`;
      return `ran: ${command}\n`;
    },
  });
  const backend = new HostClient(await fake.start(), 5000);
  const db = createTestDb([users, deviceInstances, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
  db.insert(devices).values({ id: 'FAKE1' }).run();
  const base = await freePortBase();
  saveSettings(db, { enabled: true, bindHost: '127.0.0.1', portStart: base, portEnd: base + 4 });
  const service = new AdbProxyService({ db, directory: new StubDirectory(['FAKE1']), backend });
  await service.start();
  const port = service.snapshot().devices[0].port as number;
  return { fake, service, port, stop: async () => { await service.stop(); await fake.stop(); } };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function expectFeatures(adb: IsolatedAdb, serial: string) {
  const out = await adb.run(['-s', serial, 'features']);
  expect(out.code, out.stderr).toBe(0);
  expect(out.stdout.split('\n').filter(Boolean).sort()).toEqual(EXPECTED_FEATURES);
}

async function expectShell(adb: IsolatedAdb, serial: string) {
  const out = await adb.run(['-s', serial, 'shell', 'echo', 'hi']);
  expect(out.code, out.stderr).toBe(0);
  expect(out.stdout).toContain('ran: echo hi');
}

async function expectBigOutput(adb: IsolatedAdb, serial: string) {
  const out = await adb.run(['-s', serial, 'shell', 'big'], 30_000);
  expect(out.code, out.stderr).toBe(0);
  const body = out.stdout.replace(/[\r\n]/g, '');
  expect(body.length).toBe(1_000_000);
  expect(/^x+$/.test(body), 'output holds something other than x').toBe(true);
}

async function expectPushPull(adb: IsolatedAdb, serial: string, work: string) {
  const data = randomBytes(300_000);
  const local = join(work, 'in.bin');
  writeFileSync(local, data);
  const push = await adb.run(['-s', serial, 'push', local, '/data/local/tmp/in.bin'], 30_000);
  expect(push.code, push.stderr).toBe(0);
  const back = join(work, 'out.bin');
  const pull = await adb.run(['-s', serial, 'pull', '/data/local/tmp/in.bin', back], 30_000);
  expect(pull.code, pull.stderr).toBe(0);
  expect(sha(readFileSync(back))).toBe(sha(data));
}

async function expectInstall(adb: IsolatedAdb, serial: string, work: string, fake: FakeAdbServer) {
  const apk = randomBytes(200_000);
  const local = join(work, 'app.apk');
  writeFileSync(local, apk);
  const before = fake.installs.length;
  const out = await adb.run(['-s', serial, 'install', local], 30_000);
  expect(out.code, `${out.stdout}${out.stderr}`).toBe(0);
  expect(out.stdout).toContain('Success');
  expect(fake.installs).toHaveLength(before + 1);
  expect(sha(fake.installs[before])).toBe(sha(apk));
}

async function expectLogcat(adb: IsolatedAdb, serial: string) {
  const out = await adb.run(['-s', serial, 'logcat', '-d']);
  expect(out.code, out.stderr).toBe(0);
  expect(out.stdout).toContain(LOG_LINE);
}

for (const bin of adbBins()) {
  const usable = await adbAvailable(bin);
  let ackSwitch: string | null = null;
  let skipReason = usable ? '' : 'the binary does not run `version`';
  if (usable) {
    try {
      ackSwitch = await delayedAckSwitch(bin);
    } catch (e) {
      skipReason = `no isolated server could be started (${String((e as Error).message).split('\n')[0]})`;
    }
  }
  describe.skipIf(skipReason !== '')(`real adb client: ${bin}${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
    let proxy: Awaited<ReturnType<typeof startProxy>>;
    let adb: IsolatedAdb;
    let serial: string;
    let work: string;

    beforeAll(async () => {
      const started = await startProxy();
      try {
        adb = await IsolatedAdb.create(bin);
      } catch (e) {
        await started.stop();
        throw e;
      }
      proxy = started;
      serial = `127.0.0.1:${proxy.port}`;
      work = mkdtempSync(join(tmpdir(), 'adb-proxy-conformance-'));
    });

    afterAll(async () => {
      await adb?.stop();
      await proxy?.stop();
      if (work) rmSync(work, { recursive: true, force: true });
    });

    // The cases after the first reuse the pending request and the approval made by the earlier ones, so a `-t` filtered run fails.
    it('shows unauthorized and files an approval request that carries the client key', async () => {
      // The text `adb connect` prints for an unknown key differs between client versions; `adb devices` is the truth.
      await adb.run(['connect', serial]);
      await adb.waitForState(serial, 'unauthorized');
      await vi.waitFor(() => expect(proxy.service.snapshot().pending).toHaveLength(1), WAIT);

      const [req] = proxy.service.snapshot().pending;
      const pub = readFileSync(join(adb.home, '.android', 'adbkey.pub'), 'utf8').trim();
      const [b64, ...rest] = pub.split(/\s+/);
      expect(req.comment).toBe(rest.join(' '));
      expect(req.fingerprint).toBe(fingerprintOf(Buffer.from(b64, 'base64')));
      expect(req.deviceId).toBe('FAKE1');
    });

    it('becomes a device once the request is approved, with no tap on the phone', async () => {
      const [req] = proxy.service.snapshot().pending;
      expect(proxy.service.approveRequest(req.requestId, null)).toEqual({ ok: true });
      await adb.waitForState(serial, 'device');
    });

    it('is shown the device feature list it supports, last entry included', async () => {
      await expectFeatures(adb, serial);
    });

    it('runs a shell command', async () => {
      await expectShell(adb, serial);
    });

    it('streams a megabyte of output intact', async () => {
      await expectBigOutput(adb, serial);
    });

    it('pushes and pulls a file byte for byte', async () => {
      await expectPushPull(adb, serial, work);
    });

    it('installs a package through abb_exec, byte for byte', async () => {
      await expectInstall(adb, serial, work, proxy.fake);
      expect(proxy.fake.requests.some((r) => r.startsWith('abb_exec:package\0install\0'))).toBe(true);
    });

    it('dumps the log', async () => {
      await expectLogcat(adb, serial);
    });

    it('forwards a TCP port to the device', async () => {
      const local = await freePortBase();
      const forward = await adb.run(['-s', serial, 'forward', `tcp:${local}`, 'tcp:9999']);
      expect(forward.code, forward.stderr).toBe(0);
      const echoed = await new Promise<string>((resolve, reject) => {
        const s = net.connect(local, '127.0.0.1');
        s.on('error', reject);
        s.on('close', () => reject(new Error('the forwarded connection closed before an echo came back')));
        s.on('connect', () => s.write('ping'));
        s.once('data', (d) => {
          s.destroy();
          resolve(d.toString());
        });
      });
      expect(echoed).toBe('ping');
    });

    it('never offers a host service to the ADB server behind the proxy', () => {
      const hostRequests = proxy.fake.requests.filter(
        (r) => r.startsWith('host') && !r.startsWith('host:transport:') && !r.startsWith('host-serial:'),
      );
      expect(hostRequests).toEqual([]);
    });

    it('refuses tcpip and reverse from the client and never passes them to the device', async () => {
      const tcpip = await adb.run(['-s', serial, 'tcpip', '5555']);
      expect(tcpip.code, `tcpip should fail, stdout: ${tcpip.stdout}`).not.toBe(0);
      const reverse = await adb.run(['-s', serial, 'reverse', 'tcp:12345', 'tcp:12345']);
      expect(reverse.code, `reverse should fail, stdout: ${reverse.stdout}`).not.toBe(0);
      // The fake records every service string that reaches it, so an earlier shell proves the filter can see one.
      expect(proxy.fake.requests.some((r) => r.startsWith('shell:'))).toBe(true);
      expect(proxy.fake.requests.filter((r) => r.startsWith('tcpip:') || r.startsWith('reverse:'))).toEqual([]);
    });

    it('drops the connection when the key is revoked and refuses the reconnect without a new request', async () => {
      const rec = proxy.service.listKeys()[0];
      const before = proxy.service.snapshot().counters;
      expect(proxy.service.revokeKey(rec.id, null)).toEqual({ ok: true });
      await vi.waitFor(async () => {
        expect((await adb.devices()).get(serial)).not.toBe('device');
      }, { timeout: 10_000, interval: 250 });
      // The refusal only means something once the client has come back: nudge it, then wait for a new connection
      // and for a signature from the revoked key to be turned away.
      await adb.run(['connect', serial]);
      await vi.waitFor(() => expect(proxy.service.snapshot().counters.connections).toBeGreaterThan(before.connections), WAIT);
      await vi.waitFor(() => expect(proxy.service.snapshot().counters.authFailures).toBeGreaterThan(before.authFailures), WAIT);
      // Every session has closed again, so the handshake ended without any session becoming ready.
      await vi.waitFor(() => expect(proxy.service.snapshot().connections).toEqual([]), WAIT);
      expect((await adb.devices()).get(serial)).not.toBe('device');
      expect(proxy.service.snapshot().pending).toEqual([]);
    });

    // A client signs once with each key it holds before it offers its own public key.
    it('lets a client that holds four vendor keys besides its own request approval and connect', async () => {
      const proxy2 = await startProxy();
      let many: IsolatedAdb | undefined;
      const keyDir = mkdtempSync(join(tmpdir(), 'adb-proxy-vendor-keys-'));
      try {
        const paths = Array.from({ length: 4 }, (_, i) => {
          const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
          const path = join(keyDir, `vendor${i}.adb_key`);
          writeFileSync(path, privateKey.export({ type: 'pkcs1', format: 'pem' }));
          return path;
        });
        many = await IsolatedAdb.create(bin, { ADB_VENDOR_KEYS: paths.join(':') });
        const target = `127.0.0.1:${proxy2.port}`;
        await many.run(['connect', target]);
        await vi.waitFor(() => expect(proxy2.service.snapshot().pending).toHaveLength(1), WAIT);
        const [req] = proxy2.service.snapshot().pending;
        const b64 = readFileSync(join(many.home, '.android', 'adbkey.pub'), 'utf8').trim().split(/\s+/)[0];
        expect(req.fingerprint).toBe(fingerprintOf(Buffer.from(b64, 'base64')));
        expect(proxy2.service.snapshot().counters.authFailures).toBeGreaterThanOrEqual(5);
        expect(proxy2.service.approveRequest(req.requestId, null)).toEqual({ ok: true });
        await many.waitForState(target, 'device');
        await expectShell(many, target);
      } finally {
        await many?.stop();
        await proxy2.stop();
        rmSync(keyDir, { recursive: true, force: true });
      }
    });

    // The device advertises delayed_ack; the proxy must not pass it on, so a client switched to offer it still gets plain framing.
    it.skipIf(!ackSwitch)(
      ackSwitch
        ? `never sees delayed_ack in the device features and keeps working when the client offers it (${ackSwitch}=1)`
        : 'never sees delayed_ack in the device features when the client offers it (skipped: neither ADB_DELAYED_ACK=1 nor ADB_BURST_MODE=1 changes what this client offers)',
      async () => {
        const advertising = await startProxy();
        let switched: IsolatedAdb | undefined;
        const dir = mkdtempSync(join(tmpdir(), 'adb-proxy-conformance-'));
        try {
          switched = await IsolatedAdb.create(bin, { [ackSwitch as string]: '1' });
          const target = `127.0.0.1:${advertising.port}`;
          await switched.run(['connect', target]);
          await switched.waitForState(target, 'unauthorized');
          await vi.waitFor(() => expect(advertising.service.snapshot().pending).toHaveLength(1), WAIT);
          expect(advertising.service.approveRequest(advertising.service.snapshot().pending[0].requestId, null)).toEqual({ ok: true });
          await switched.waitForState(target, 'device');

          await expectFeatures(switched, target);
          await expectShell(switched, target);
          await expectBigOutput(switched, target);
          await expectPushPull(switched, target, dir);
          await expectInstall(switched, target, dir, advertising.fake);
          await expectLogcat(switched, target);
        } finally {
          await switched?.stop();
          await advertising.stop();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
}

describe.skipIf(!process.env.ADB_PROXY_LIVE_SERIAL)('live device through the proxy', () => {
  it('reports the same model as a direct adb call', async () => {
    const liveSerial = process.env.ADB_PROXY_LIVE_SERIAL as string;
    const bin = adbBins()[0];
    const db = createTestDb([users, deviceInstances, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
    db.insert(devices).values({ id: liveSerial }).run();
    const base = await freePortBase();
    saveSettings(db, { enabled: true, bindHost: '127.0.0.1', portStart: base, portEnd: base + 4 });
    const service = new AdbProxyService({ db, directory: new StubDirectory([liveSerial]), backend: new HostClient() });
    await service.start();
    let adb: IsolatedAdb | undefined;
    try {
      adb = await IsolatedAdb.create(bin);
      const serial = `127.0.0.1:${service.snapshot().devices[0].port}`;
      await adb.run(['connect', serial]);
      await vi.waitFor(() => expect(service.snapshot().pending).toHaveLength(1), WAIT);
      service.approveRequest(service.snapshot().pending[0].requestId, null);
      await adb.waitForState(serial, 'device');
      const viaProxy = await adb.run(['-s', serial, 'shell', 'getprop', 'ro.product.model']);
      const direct = await new Promise<string>((resolve) => {
        execFile(bin, ['-s', liveSerial, 'shell', 'getprop', 'ro.product.model'], { encoding: 'utf8' }, (_e, out) => resolve(out));
      });
      expect(viaProxy.stdout.trim()).toBe(direct.trim());
      expect(viaProxy.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      await adb?.stop();
      await service.stop();
    }
  });
});
