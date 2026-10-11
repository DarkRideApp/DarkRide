import net from 'node:net';

export interface AdbServerAddress {
  host: string;
  port: number;
}

export function resolveAdbServerAddress(env: NodeJS.ProcessEnv = process.env): AdbServerAddress {
  return {
    host: env.ANDROID_ADB_SERVER_ADDRESS || '127.0.0.1',
    port: Number(env.ANDROID_ADB_SERVER_PORT) || 5037,
  };
}

export class HostProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostProtocolError';
  }
}

function frame(service: string): Buffer {
  const body = Buffer.from(service, 'utf8');
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** Read exactly n bytes; surplus bytes are pushed back so the next reader (or a pipe) sees them. */
function readExact(socket: net.Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let have = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      have = Buffer.concat([have, chunk]);
      if (have.length < n) return;
      cleanup();
      socket.pause();
      if (have.length > n) socket.unshift(have.subarray(n));
      resolve(have.subarray(0, n));
    };
    const onEnd = () => {
      cleanup();
      reject(new HostProtocolError('connection closed'));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new HostProtocolError('timeout'));
    }, timeoutMs);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onError);
    socket.resume();
  });
}

async function sendRequest(socket: net.Socket, service: string, timeoutMs: number): Promise<void> {
  socket.write(frame(service));
  const status = (await readExact(socket, 4, timeoutMs)).toString('ascii');
  if (status === 'OKAY') return;
  if (status === 'FAIL') {
    const len = parseInt((await readExact(socket, 4, timeoutMs)).toString('ascii'), 16);
    const message = len > 0 ? (await readExact(socket, len, timeoutMs)).toString('utf8') : '';
    throw new HostProtocolError(message || 'FAIL');
  }
  throw new HostProtocolError(`unexpected status ${JSON.stringify(status)}`);
}

function cleanProp(value: string | undefined): string {
  return (value ?? '').replace(/[;=\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

// Burst mode changes the stream framing (OPEN carries a window, OKAY carries a byte count), which the session does not implement.
const UNSUPPORTED_FEATURES = new Set(['delayed_ack']);

function supportedFeatures(features: string): string {
  return features.trim().split(',').filter((f) => !UNSUPPORTED_FEATURES.has(f)).join(',');
}

export class HostClient {
  constructor(
    private readonly addr: AdbServerAddress = resolveAdbServerAddress(),
    private readonly timeoutMs = 5000,
  ) {}

  private dial(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.addr.host, port: this.addr.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HostProtocolError('timeout'));
      }, this.timeoutMs);
      // Stays attached after connect: once the promise has settled, reject() is a no-op and this listener keeps a later reset from being unhandled.
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
    });
  }

  /** A raw pipe to a device service. The socket is returned paused; attach 'end'/'close' handlers synchronously after the await, or check `socket.destroyed`/`socket.readableEnded`, because a service that ends right after OKAY can close the paused socket before a late handler exists. */
  async openService(serial: string, service: string): Promise<net.Socket> {
    const socket = await this.dial();
    try {
      await sendRequest(socket, `host:transport:${serial}`, this.timeoutMs);
      await sendRequest(socket, service, this.timeoutMs);
      return socket;
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }

  async query(service: string): Promise<string> {
    const socket = await this.dial();
    try {
      await sendRequest(socket, service, this.timeoutMs);
      const len = parseInt((await readExact(socket, 4, this.timeoutMs)).toString('ascii'), 16);
      if (!Number.isFinite(len) || len < 0) throw new HostProtocolError('bad length');
      const body = len === 0 ? Buffer.alloc(0) : await readExact(socket, len, this.timeoutMs);
      return body.toString('utf8');
    } finally {
      socket.destroy();
    }
  }

  features(serial: string): Promise<string> {
    return this.query(`host-serial:${serial}:features`);
  }

  /** Run a service to completion and return its output, bounded in size and time. */
  async collect(serial: string, service: string, maxBytes = 65536): Promise<string> {
    const socket = await this.openService(serial, service);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HostProtocolError('timeout'));
      }, this.timeoutMs);
      socket.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          clearTimeout(timer);
          socket.destroy();
          reject(new HostProtocolError('output too large'));
          return;
        }
        chunks.push(c);
      });
      socket.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.resume();
    });
  }

  /** The CNXN banner text: device identity plus the device's real feature list, minus features the proxy cannot carry. */
  async deviceBanner(serial: string): Promise<string> {
    const [features, props] = await Promise.all([
      this.features(serial),
      this.collect(serial, 'shell:getprop ro.product.name; getprop ro.product.model; getprop ro.product.device').catch(() => ''),
    ]);
    const [name, model, device] = props.split(/\r?\n/);
    return `device::ro.product.name=${cleanProp(name)};ro.product.model=${cleanProp(model)};ro.product.device=${cleanProp(device)};features=${supportedFeatures(features)}`;
  }
}
