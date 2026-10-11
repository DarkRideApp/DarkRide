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

function recorder(socket: net.Socket) {
  let all = Buffer.alloc(0);
  socket.on('data', (c: Buffer) => { all = Buffer.concat([all, c]); });
  return {
    get data() { return all; },
    async until(predicate: (b: Buffer) => boolean) {
      const end = Date.now() + 2000;
      while (!predicate(all)) {
        if (Date.now() > end) throw new Error('timed out, got ' + all.toString('latin1'));
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const sync = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id), u32(body.length), body]);

describe('FakeAdbServer extra services', () => {
  let fake: FakeAdbServer;
  let port: number;

  beforeEach(async () => {
    fake = new FakeAdbServer([{ serial: 'SER1' }]);
    port = (await fake.start()).port;
  });
  afterEach(async () => { await fake.stop(); });

  async function bound(service: string) {
    const client = net.connect(port, '127.0.0.1');
    const rec = recorder(client);
    client.write(frame('host:transport:SER1'));
    client.write(frame(service));
    await rec.until((b) => b.toString('latin1').startsWith('OKAYOKAY'));
    return { client, rec };
  }

  it('runs exec: like shell:', async () => {
    const { client, rec } = await bound('exec:id');
    await rec.until((b) => b.toString().includes('ran: id'));
    client.destroy();
  });

  it('echoes on tcp:<port>', async () => {
    const { client, rec } = await bound('tcp:9999');
    client.write('ping');
    await rec.until((b) => b.length >= 12);
    expect(rec.data.subarray(8).toString()).toBe('ping');
    client.destroy();
  });

  it('stores a pushed file and serves it back over sync v1', async () => {
    const { client, rec } = await bound('sync:');
    const payload = Buffer.from('hello sync');
    client.write(sync('STAT', Buffer.from('/data/x')));
    await rec.until((b) => b.length >= 8 + 16);
    expect(rec.data.subarray(8, 12).toString()).toBe('STAT');
    expect(rec.data.readUInt32LE(12)).toBe(0);

    client.write(Buffer.concat([sync('SEND', Buffer.from('/data/x,33188')), sync('DATA', payload), Buffer.concat([Buffer.from('DONE'), u32(1)])]));
    await rec.until((b) => b.length >= 8 + 16 + 8);
    expect(rec.data.subarray(24, 28).toString()).toBe('OKAY');
    expect(fake.files.get('/data/x')?.toString()).toBe('hello sync');

    client.write(sync('STAT', Buffer.from('/data/x')));
    await rec.until((b) => b.length >= 8 + 16 + 8 + 16);
    expect(rec.data.readUInt32LE(8 + 16 + 8 + 8)).toBe(payload.length);

    client.write(sync('RECV', Buffer.from('/data/x')));
    await rec.until((b) => b.toString('latin1').endsWith('DONE\0\0\0\0'));
    expect(rec.data.toString('latin1')).toContain('hello sync');

    client.write(sync('RECV', Buffer.from('/data/missing')));
    await rec.until((b) => b.toString('latin1').includes('FAIL'));
    client.destroy();
  });
});
