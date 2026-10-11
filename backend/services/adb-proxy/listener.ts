import net from 'node:net';
import { createLoggers } from '../../logs';

const { error: logError } = createLoggers('adb-proxy');

const KEEPALIVE_MS = 30_000;
const ERROR_LOG_INTERVAL_MS = 1000;
const MAX_LOG_LENGTH = 200;

export class ListenError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ListenError';
  }
}

type State = 'idle' | 'listening' | 'closed';

const closedError = () => new ListenError('ECLOSED', 'listener is closed');

export class DeviceListener {
  private state: State = 'idle';
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  /** Settles when the latest bind attempt has finished, so close() can wait for it. */
  private binding: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private lastErrorLogAt = -Infinity;

  constructor(private readonly opts: { host: string; port: number; accept(socket: net.Socket): void }) {}

  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.opts.port;
  }

  listen(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(closedError());
    if (this.state === 'listening') return Promise.reject(new ListenError('ELISTENING', 'listener is already listening'));
    this.state = 'listening';
    const bind = new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (this.state === 'closed') return reject(closedError());
        this.state = 'idle';
        reject(new ListenError(err.code ?? 'UNKNOWN', err.message));
      });
      server.listen(this.opts.port, this.opts.host, () => {
        if (this.state === 'closed') {
          server.close(() => reject(closedError()));
          return;
        }
        server.removeAllListeners('error');
        server.on('error', (err: NodeJS.ErrnoException) => this.logServerError(err));
        this.server = server;
        resolve();
      });
    });
    this.binding = bind.catch(() => {});
    return bind;
  }

  close(): Promise<void> {
    this.state = 'closed';
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await this.binding;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onConnection(socket: net.Socket): void {
    if (this.state !== 'listening') {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.setKeepAlive(true, KEEPALIVE_MS);
    socket.setNoDelay(true);
    try {
      this.opts.accept(socket);
    } catch {
      socket.destroy();
    }
  }

  /** Accept-side failures such as EMFILE; only the errno code is logged, never free text. */
  private logServerError(err: NodeJS.ErrnoException): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    const code = typeof err.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(err.code) ? err.code : 'UNKNOWN';
    logError(`device listener ${this.opts.host}:${this.opts.port} server error ${code}`.slice(0, MAX_LOG_LENGTH));
  }
}
