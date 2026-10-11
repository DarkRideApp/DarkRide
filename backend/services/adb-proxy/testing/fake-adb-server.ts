import net from 'node:net';

export interface FakeDevice {
  serial: string;
  features?: string;
  name?: string;
  model?: string;
  device?: string;
  online?: boolean;
}

type Entry = Required<FakeDevice>;
type Handled = { bind?: string; raw?: (chunk: Buffer) => void; close?: boolean };

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

export class FakeAdbServer {
  /** Every request string received, in order, across all connections. */
  readonly requests: string[] = [];
  /** Files pushed over `sync:` (path to contents). */
  readonly files = new Map<string, Buffer>();
  /** Package bytes received by each streamed `abb_exec:package install`, in order. */
  readonly installs: Buffer[] = [];
  private readonly devices = new Map<string, Entry>();
  private readonly sockets = new Set<net.Socket>();
  private readonly deviceSockets = new Map<string, Set<net.Socket>>();
  private readonly trackers = new Set<{ socket: net.Socket; long: boolean }>();
  private readonly server: net.Server;
  private readonly shell: (serial: string, command: string) => string;

  constructor(devices: FakeDevice[], opts: { shell?: (serial: string, command: string) => string } = {}) {
    for (const d of devices) {
      this.devices.set(d.serial, {
        serial: d.serial,
        features: d.features ?? 'cmd,stat_v2',
        name: d.name ?? 'fakeprod',
        model: d.model ?? 'FakeModel',
        device: d.device ?? 'fakedev',
        online: d.online ?? true,
      });
    }
    this.shell = opts.shell ?? ((_serial, command) => `ran: ${command}\n`);
    this.server = net.createServer((s) => this.accept(s));
  }

  async start(port = 0): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    return { host: '127.0.0.1', port: (this.server.address() as net.AddressInfo).port };
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  setOnline(serial: string, online: boolean): void {
    const d = this.devices.get(serial);
    if (!d) return;
    d.online = online;
    if (!online) for (const s of this.deviceSockets.get(serial) ?? []) s.destroy();
    for (const t of this.trackers) t.socket.write(this.frame(this.list(t.long)));
  }

  activeServiceSockets(): number {
    let n = 0;
    for (const set of this.deviceSockets.values()) n += set.size;
    return n;
  }

  private frame(payload: string): string {
    return hex4(Buffer.byteLength(payload)) + payload;
  }

  private list(long: boolean): string {
    let n = 0;
    return [...this.devices.values()]
      .map((d) => {
        n++;
        const state = d.online ? 'device' : 'offline';
        return long
          ? `${d.serial.padEnd(22)} ${state} product:${d.name} model:${d.model} device:${d.device} transport_id:${n}\n`
          : `${d.serial}\t${state}\n`;
      })
      .join('');
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      for (const t of this.trackers) if (t.socket === socket) this.trackers.delete(t);
      for (const set of this.deviceSockets.values()) set.delete(socket);
    });
    let buf = Buffer.alloc(0);
    let bound: string | null = null;
    let raw: ((chunk: Buffer) => void) | null = null;
    socket.on('data', (chunk: Buffer) => {
      if (raw) {
        raw(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = parseInt(buf.subarray(0, 4).toString('ascii'), 16);
        if (!Number.isFinite(len)) {
          socket.destroy();
          return;
        }
        if (buf.length < 4 + len) return;
        const request = buf.subarray(4, 4 + len).toString('utf8');
        buf = buf.subarray(4 + len);
        this.requests.push(request);
        const result = this.handle(socket, request, bound);
        if (result.bind) bound = result.bind;
        if (result.raw) {
          raw = result.raw;
          if (buf.length > 0) {
            raw(buf);
            buf = Buffer.alloc(0);
          }
          return;
        }
        if (result.close) return;
      }
    });
  }

  private handle(socket: net.Socket, request: string, bound: string | null): Handled {
    const okay = () => socket.write('OKAY');
    const fail = (message: string): Handled => {
      socket.write('FAIL' + this.frame(message));
      socket.end();
      return { close: true };
    };
    const reply = (payload: string): Handled => {
      socket.write('OKAY' + this.frame(payload));
      socket.end();
      return { close: true };
    };

    if (bound) return this.service(socket, bound, request, okay, fail);

    if (request === 'host:version') return reply('0029');
    if (request === 'host:devices') return reply(this.list(false));
    if (request === 'host:devices-l') return reply(this.list(true));
    if (request === 'host:track-devices' || request === 'host:track-devices-l') {
      const long = request.endsWith('-l');
      okay();
      socket.write(this.frame(this.list(long)));
      this.trackers.add({ socket, long });
      return { raw: () => {} };
    }
    if (request === 'host:kill') {
      okay();
      socket.end();
      return { close: true };
    }
    const features = /^host-serial:(.+):features$/.exec(request);
    if (features) {
      const d = this.devices.get(features[1]);
      return d ? reply(d.features) : fail(`device '${features[1]}' not found`);
    }
    const transport = /^host:transport:(.+)$/.exec(request);
    if (transport) {
      const d = this.devices.get(transport[1]);
      if (!d || !d.online) return fail(`device '${transport[1]}' not found`);
      okay();
      return { bind: d.serial };
    }
    return fail('unknown host service');
  }

  private service(socket: net.Socket, serial: string, service: string, okay: () => void, fail: (m: string) => Handled): Handled {
    const set = this.deviceSockets.get(serial) ?? new Set<net.Socket>();
    set.add(socket);
    this.deviceSockets.set(serial, set);
    if (service.startsWith('shell:') || service.startsWith('exec:')) {
      okay();
      socket.write(this.shell(serial, service.slice(service.indexOf(':') + 1)));
      socket.end();
      return { raw: () => {} };
    }
    if (service === 'echo:' || service.startsWith('tcp:')) {
      okay();
      return { raw: (chunk) => socket.write(chunk) };
    }
    if (service === 'sync:') {
      okay();
      return { raw: this.syncHandler(socket) };
    }
    // A real adbd prints a line and then restarts or reboots, dropping the transport.
    if (service === 'root:' || service === 'unroot:' || service.startsWith('reboot')) {
      okay();
      socket.end(service.startsWith('reboot') ? '' : `restarting adbd as ${service === 'root:' ? 'root' : 'non root'}\n`);
      return { raw: () => {} };
    }
    if (service === 'hold:') {
      okay();
      return { raw: () => {} };
    }
    const flood = /^flood:(\d+)$/.exec(service);
    if (flood) {
      okay();
      this.flood(socket, Number(flood[1]));
      return { raw: () => {} };
    }
    if (service.startsWith('abb_exec:')) {
      const args = service.slice('abb_exec:'.length).split('\0');
      if (args[args.length - 1] === '') args.pop();
      if (args[0] === 'settings' && args[1] === 'get') {
        okay();
        socket.end('null\n');
        return { raw: () => {} };
      }
      const size = args.length === 4 && args[0] === 'package' && args[1] === 'install' && args[2] === '-S' ? Number(args[3]) : NaN;
      if (Number.isInteger(size) && size >= 0) {
        okay();
        return { raw: this.installHandler(socket, size) };
      }
    }
    return fail('unknown service');
  }

  /** The device side of a streamed install: exactly `size` bytes of package, then a status line. */
  private installHandler(socket: net.Socket, size: number): (chunk: Buffer) => void {
    const chunks: Buffer[] = [];
    let received = 0;
    const finish = () => {
      this.installs.push(Buffer.concat(chunks));
      socket.end('Success\n');
    };
    if (size === 0) finish();
    return (chunk) => {
      if (received >= size) return;
      const piece = chunk.subarray(0, size - received);
      chunks.push(Buffer.from(piece));
      received += piece.length;
      if (received === size) finish();
    };
  }

  /** The device side of the adb sync v1 protocol: STAT, SEND (with DATA and DONE), RECV and QUIT. */
  private syncHandler(socket: net.Socket): (chunk: Buffer) => void {
    let buf = Buffer.alloc(0);
    let sending: { path: string; chunks: Buffer[] } | null = null;
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n >>> 0);
      return b;
    };
    return (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 8) return;
        const id = buf.toString('ascii', 0, 4);
        const len = buf.readUInt32LE(4);
        if (id === 'DONE') {
          // The length field carries the mtime; no body follows.
          if (sending) {
            this.files.set(sending.path, Buffer.concat(sending.chunks));
            sending = null;
            socket.write(Buffer.concat([Buffer.from('OKAY'), u32(0)]));
          }
          buf = buf.subarray(8);
          continue;
        }
        if (id === 'QUIT') {
          socket.end();
          return;
        }
        if (buf.length < 8 + len) return;
        const body = Buffer.from(buf.subarray(8, 8 + len));
        buf = buf.subarray(8 + len);
        if (id === 'STAT') {
          const file = this.files.get(body.toString());
          socket.write(Buffer.concat([Buffer.from('STAT'), u32(file ? 0x81a4 : 0), u32(file?.length ?? 0), u32(file ? 1 : 0)]));
        } else if (id === 'RECV') {
          const file = this.files.get(body.toString());
          if (!file) {
            const msg = Buffer.from('No such file');
            socket.write(Buffer.concat([Buffer.from('FAIL'), u32(msg.length), msg]));
            continue;
          }
          for (let off = 0; off < file.length; off += 65536) {
            const piece = file.subarray(off, off + 65536);
            socket.write(Buffer.concat([Buffer.from('DATA'), u32(piece.length), piece]));
          }
          socket.write(Buffer.concat([Buffer.from('DONE'), u32(0)]));
        } else if (id === 'SEND') {
          const spec = body.toString();
          sending = { path: spec.slice(0, spec.lastIndexOf(',')), chunks: [] };
        } else if (id === 'DATA' && sending) {
          sending.chunks.push(body);
        }
      }
    };
  }

  private flood(socket: net.Socket, total: number): void {
    let remaining = total;
    const chunk = Buffer.alloc(65536, 'x');
    const pump = () => {
      while (remaining > 0) {
        const piece = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        remaining -= piece.length;
        if (!socket.write(piece)) {
          socket.once('drain', pump);
          return;
        }
      }
      socket.end();
    };
    pump();
  }
}
