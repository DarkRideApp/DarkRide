import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

// delayed_ack mid-list and a different feature last, so a dropped last entry shows; none of these changes how a client talks to the fake.
const ADVERTISED = 'cmd,delayed_ack,track_app';
const EXPECTED_FEATURES = ['cmd', 'track_app'];

async function startProxy() {
  const fake = new FakeAdbServer([{ serial: 'FAKE1', features: ADVERTISED }], {
    shell: (_serial, command) => {
      if (command.startsWith('getprop')) return 'fakeprod\nFakeModel\nfakedev\n';
      if (command === 'big') return 'x'.repeat(1_000_000);
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
  expect(out.stdout.length).toBeGreaterThanOrEqual(1_000_000);
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

for (const bin of adbBins()) {
  const usable = await adbAvailable(bin);
  const ackSwitch = usable ? await delayedAckSwitch(bin) : null;
  describe.skipIf(!usable)(`real adb client: ${bin}`, () => {
    let proxy: Awaited<ReturnType<typeof startProxy>>;
    let adb: IsolatedAdb;
    let serial: string;
    let work: string;

    beforeAll(async () => {
      proxy = await startProxy();
      adb = await IsolatedAdb.create(bin);
      serial = `127.0.0.1:${proxy.port}`;
      work = mkdtempSync(join(tmpdir(), 'adb-proxy-conformance-'));
    });

    afterAll(async () => {
      await adb?.stop();
      await proxy?.stop();
      if (work) rmSync(work, { recursive: true, force: true });
    });

    it('shows unauthorized and files an approval request that carries the client key', async () => {
      // The text `adb connect` prints for an unknown key differs between client versions; `adb devices` is the truth.
      await adb.run(['connect', serial]);
      await adb.waitForState(serial, 'unauthorized');
      await vi.waitFor(() => expect(proxy.service.snapshot().pending).toHaveLength(1));

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

    it('sees every feature the device advertises except delayed_ack, last entry included', async () => {
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

    it('forwards a TCP port to the device', async () => {
      const local = await freePortBase();
      const forward = await adb.run(['-s', serial, 'forward', `tcp:${local}`, 'tcp:9999']);
      expect(forward.code, forward.stderr).toBe(0);
      const echoed = await new Promise<string>((resolve, reject) => {
        const s = net.connect(local, '127.0.0.1');
        s.on('error', reject);
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

    it('drops the connection when the key is revoked and never returns to device', async () => {
      const rec = proxy.service.listKeys()[0];
      expect(proxy.service.revokeKey(rec.id, null)).toEqual({ ok: true });
      await vi.waitFor(async () => {
        expect((await adb.devices()).get(serial)).not.toBe('device');
      }, { timeout: 10_000, interval: 250 });
      await adb.run(['connect', serial]);
      await new Promise((r) => setTimeout(r, 2000));
      expect((await adb.devices()).get(serial)).not.toBe('device');
      expect(proxy.service.snapshot().pending).toEqual([]);
    });

    // The device advertises delayed_ack; the proxy must not pass it on, so a client switched to offer it still gets plain framing.
    it.skipIf(!ackSwitch)(
      ackSwitch
        ? `keeps working when the client offers delayed ack (${ackSwitch}=1)`
        : 'keeps working when the client offers delayed ack (skipped: neither ADB_DELAYED_ACK=1 nor ADB_BURST_MODE=1 changes what this client offers)',
      async () => {
        const advertising = await startProxy();
        const switched = await IsolatedAdb.create(bin, { [ackSwitch as string]: '1' });
        const dir = mkdtempSync(join(tmpdir(), 'adb-proxy-conformance-'));
        try {
          const target = `127.0.0.1:${advertising.port}`;
          await switched.run(['connect', target]);
          await switched.waitForState(target, 'unauthorized');
          await vi.waitFor(() => expect(advertising.service.snapshot().pending).toHaveLength(1));
          expect(advertising.service.approveRequest(advertising.service.snapshot().pending[0].requestId, null)).toEqual({ ok: true });
          await switched.waitForState(target, 'device');

          await expectFeatures(switched, target);
          await expectShell(switched, target);
          await expectBigOutput(switched, target);
          await expectPushPull(switched, target, dir);
        } finally {
          await switched.stop();
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
    const adb = await IsolatedAdb.create(bin);
    try {
      const serial = `127.0.0.1:${service.snapshot().devices[0].port}`;
      await adb.run(['connect', serial]);
      await vi.waitFor(() => expect(service.snapshot().pending).toHaveLength(1));
      service.approveRequest(service.snapshot().pending[0].requestId, null);
      await adb.waitForState(serial, 'device');
      const viaProxy = await adb.run(['-s', serial, 'shell', 'getprop', 'ro.product.model']);
      const direct = await new Promise<string>((resolve) => {
        execFile(bin, ['-s', liveSerial, 'shell', 'getprop', 'ro.product.model'], { encoding: 'utf8' }, (_e, out) => resolve(out));
      });
      expect(viaProxy.stdout.trim()).toBe(direct.trim());
      expect(viaProxy.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      await adb.stop();
      await service.stop();
    }
  });
});
