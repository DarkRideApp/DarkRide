import net from 'node:net';

export class ListenError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ListenError';
  }
}

export class DeviceListener {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: { host: string; port: number; accept(socket: net.Socket): void }) {}

  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.opts.port;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {});
        socket.setKeepAlive(true, 30_000);
        socket.setNoDelay(true);
        try {
          this.opts.accept(socket);
        } catch {
          socket.destroy();
        }
      });
      server.once('error', (err: NodeJS.ErrnoException) => reject(new ListenError(err.code ?? 'UNKNOWN', err.message)));
      server.listen(this.opts.port, this.opts.host, () => {
        server.removeAllListeners('error');
        server.on('error', () => {});
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
