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
    if (service.startsWith('shell:')) {
      okay();
      socket.write(this.shell(serial, service.slice('shell:'.length)));
      socket.end();
      return { raw: () => {} };
    }
    if (service === 'echo:') {
      okay();
      return { raw: (chunk) => socket.write(chunk) };
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
    return fail('unknown service');
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
