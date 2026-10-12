import net from 'node:net';
import type { Session } from '../session';

export interface SessionServer {
  port: number;
  sessions: Session[];
  sockets: net.Socket[];
  close(): Promise<void>;
}

/** A throwaway TCP server that wraps every accepted socket in a Session built by `make`. */
export async function startSessionServer(make: (socket: net.Socket, index: number) => Session): Promise<SessionServer> {
  const sessions: Session[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    sessions.push(make(socket, sessions.length));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as net.AddressInfo).port,
    sessions,
    sockets,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
