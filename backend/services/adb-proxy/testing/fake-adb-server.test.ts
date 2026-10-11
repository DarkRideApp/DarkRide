import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { FakeAdbServer } from './fake-adb-server';

const frame = (s: string) => s.length.toString(16).padStart(4, '0') + s;

function readUntil(socket: net.Socket, predicate: (all: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let all = '';
    const timer = setTimeout(() => reject(new Error('timeout, got: ' + all)), 2000);
    socket.on('data', (c) => {
      all += c.toString();
      if (predicate(all)) {
        clearTimeout(timer);
        resolve(all);
      }
    });
  });
}

describe('FakeAdbServer', () => {
  let fake: FakeAdbServer;
  let port: number;

  beforeEach(async () => {
    fake = new FakeAdbServer([{ serial: 'SER1' }]);
    port = (await fake.start()).port;
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('pushes a new device list to track-devices clients when a device goes offline', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:track-devices-l'));
    const first = await readUntil(client, (a) => a.includes('device product:'));
    expect(first.startsWith('OKAY')).toBe(true);
    fake.setOnline('SER1', false);
    const next = await readUntil(client, (a) => a.includes('offline'));
    expect(next).toContain('SER1');
    client.destroy();
  });

  it('records requests in order across connections', async () => {
    const first = net.connect(port, '127.0.0.1');
    first.write(frame('host:version'));
    await readUntil(first, (a) => a.includes('0029'));
    const second = net.connect(port, '127.0.0.1');
    second.write(frame('host:devices'));
    await readUntil(second, (a) => a.includes('device\n'));
    expect(fake.requests).toEqual(['host:version', 'host:devices']);
    first.destroy();
    second.destroy();
  });

  it('answers a transport request and the service request that follows it in one write', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:transport:SER1') + frame('shell:ls'));
    const reply = await readUntil(client, (a) => a.includes('ran: ls\n'));
    expect(reply).toBe('OKAYOKAYran: ls\n');
    expect(fake.requests).toEqual(['host:transport:SER1', 'shell:ls']);
    client.destroy();
  });

  it('feeds bytes that follow the service request in the same write to the service', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:transport:SER1') + frame('echo:') + 'abc');
    const reply = await readUntil(client, (a) => a === 'OKAYOKAYabc');
    expect(reply).toBe('OKAYOKAYabc');
    client.destroy();
  });

  it('closes after a host reply and ignores a second request sent in the same write', async () => {
    const client = net.connect(port, '127.0.0.1');
    const closed = new Promise<void>((r) => client.on('close', () => r()));
    client.write(frame('host:version') + frame('host:devices'));
    const reply = await readUntil(client, (a) => a.includes('0029'));
    await closed;
    expect(reply).toBe('OKAY' + frame('0029'));
    expect(fake.requests).toEqual(['host:version']);
  });

  it('destroys bound service sockets when the device goes offline', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:transport:SER1'));
    await readUntil(client, (a) => a === 'OKAY');
    client.write(frame('hold:'));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.activeServiceSockets()).toBe(1);
    const closed = new Promise<void>((r) => client.on('close', () => r()));
    fake.setOnline('SER1', false);
    await closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.activeServiceSockets()).toBe(0);
  });

  it('lists devices in short and long form', async () => {
    const short = net.connect(port, '127.0.0.1');
    short.write(frame('host:devices'));
    const shortReply = await readUntil(short, (a) => a.includes('device\n'));
    expect(shortReply).toBe('OKAY' + frame('SER1\tdevice\n'));
    short.destroy();

    const long = net.connect(port, '127.0.0.1');
    long.write(frame('host:devices-l'));
    const longReply = await readUntil(long, (a) => a.includes('transport_id:1\n'));
    expect(longReply).toContain('SER1');
    expect(longReply).toContain(' device product:fakeprod model:FakeModel device:fakedev transport_id:1\n');
    long.destroy();
  });

  it('answers a feature query and fails it for an unknown device', async () => {
    const ok = net.connect(port, '127.0.0.1');
    ok.write(frame('host-serial:SER1:features'));
    expect(await readUntil(ok, (a) => a.includes('stat_v2'))).toBe('OKAY' + frame('cmd,stat_v2'));
    ok.destroy();

    const missing = net.connect(port, '127.0.0.1');
    missing.write(frame('host-serial:NOPE:features'));
    expect(await readUntil(missing, (a) => a.startsWith('FAIL') && a.includes('not found'))).toBe(
      'FAIL' + frame("device 'NOPE' not found"),
    );
    missing.destroy();
  });

  it('records host:kill and closes the connection', async () => {
    const client = net.connect(port, '127.0.0.1');
    const closed = new Promise<void>((r) => client.on('close', () => r()));
    client.resume();
    client.write(frame('host:kill'));
    await closed;
    expect(fake.requests).toEqual(['host:kill']);
  });

  it('floods exactly the requested number of bytes, then closes', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:transport:SER1'));
    await readUntil(client, (a) => a === 'OKAY');
    let bytes = 0;
    const ended = new Promise<void>((r) => client.on('end', () => r()));
    client.on('data', (c) => (bytes += c.length));
    client.write(frame('flood:150000'));
    await ended;
    // 4 bytes of service OKAY precede the payload
    expect(bytes).toBe(4 + 150_000);
  });

  it('refuses a service it does not know', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:transport:SER1'));
    await readUntil(client, (a) => a === 'OKAY');
    const reply = readUntil(client, (a) => a.startsWith('FAIL') && a.includes('unknown service'));
    client.write(frame('nonsense:'));
    expect(await reply).toBe('FAIL' + frame('unknown service'));
    client.destroy();
  });
});
