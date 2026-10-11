import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_VERSION, A_WRTE,
  AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN, MAX_DATA,
  PacketParser, encodePacket, type Packet,
} from '../packet';
import type { TestAdbKey } from './test-keys';

/** A minimal ADB client over the wire protocol, for driving the proxy in tests. */
export class WireClient {
  /** Every packet received, in order. */
  readonly packets: Packet[] = [];
  closed = false;
  private readonly parser = new PacketParser(MAX_DATA);
  private cursor = 0;
  private waiters: Array<() => void> = [];

  private constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      try {
        this.packets.push(...this.parser.push(chunk));
      } catch {
        socket.destroy();
      }
      this.wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('error', () => {});
  }

  static connect(port: number): Promise<WireClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => resolve(new WireClient(socket)));
      socket.once('error', reject);
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private sleepUntilWoken(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  send(command: number, arg0: number, arg1: number, data?: Buffer | string): void {
    const payload = typeof data === 'string' ? Buffer.from(data) : data;
    this.socket.write(encodePacket({ command, arg0, arg1, data: payload }));
  }

  /** The next unread packet; rejects on timeout or when the socket closed with nothing left. */
  async next(timeoutMs = 2000): Promise<Packet> {
    const deadline = Date.now() + timeoutMs;
    while (this.cursor >= this.packets.length) {
      if (this.closed) throw new Error('socket closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a packet');
      await this.sleepUntilWoken(left);
    }
    return this.packets[this.cursor++];
  }

  /** The first packet anywhere in the log that matches, waiting for it if needed. */
  async waitFor(predicate: (p: Packet) => boolean, timeoutMs = 2000): Promise<Packet> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.packets.find(predicate);
      if (hit) return hit;
      if (this.closed) throw new Error('socket closed before the packet arrived');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a matching packet');
      await this.sleepUntilWoken(left);
    }
  }

  async waitClosed(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await this.sleepUntilWoken(deadline - Date.now());
    return this.closed;
  }

  /** True when no packet arrived during the window. */
  async quiet(ms = 100): Promise<boolean> {
    const before = this.packets.length;
    await new Promise((r) => setTimeout(r, ms));
    return this.packets.length === before;
  }

  sendHostCnxn(): void {
    this.send(A_CNXN, A_VERSION, MAX_DATA, 'host::features=cmd\0');
  }

  /** CNXN, then answer the AUTH token with a signature from `key`. Returns the proxy's next packet. */
  async authenticate(key: TestAdbKey): Promise<Packet> {
    this.sendHostCnxn();
    const token = await this.next();
    if (token.command !== A_AUTH || token.arg0 !== AUTH_TOKEN) throw new Error('expected an AUTH token');
    this.send(A_AUTH, AUTH_SIGNATURE, 0, key.sign(token.data));
    return this.next();
  }

  /** CNXN, a signature over the token made with `key` (a real client signs first), then offer the public key. */
  async offerKey(key: TestAdbKey): Promise<void> {
    this.sendHostCnxn();
    const token = await this.next();
    if (token.command !== A_AUTH || token.arg0 !== AUTH_TOKEN) throw new Error('expected an AUTH token');
    this.send(A_AUTH, AUTH_SIGNATURE, 0, key.sign(token.data));
    const again = await this.next();
    if (again.command !== A_AUTH || again.arg0 !== AUTH_TOKEN) throw new Error('expected a second AUTH token');
    this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, key.publicKeyText);
  }

  /** Like offerKey, but the signature is garbage: this client cannot show it holds the private key. */
  async offerKeyWithoutProof(key: TestAdbKey): Promise<void> {
    this.sendHostCnxn();
    const token = await this.next();
    if (token.command !== A_AUTH || token.arg0 !== AUTH_TOKEN) throw new Error('expected an AUTH token');
    this.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
    const again = await this.next();
    if (again.command !== A_AUTH || again.arg0 !== AUTH_TOKEN) throw new Error('expected a second AUTH token');
    this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, key.publicKeyText);
  }

  async openRaw(service: string, remoteId: number): Promise<Packet> {
    this.send(A_OPEN, remoteId, 0, service + '\0');
    return this.next();
  }

  async open(service: string, remoteId = 1): Promise<{ localId: number }> {
    const reply = await this.openRaw(service, remoteId);
    if (reply.command !== A_OKAY) throw new Error(`open ${service} was refused`);
    return { localId: reply.arg0 };
  }

  /** Read WRTE data for a stream, acknowledging each, until `until` bytes arrived or the stream closed. */
  async collectStream(remoteId: number, localId: number, until: number | 'close', timeoutMs = 3000): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (until !== 'close' && total >= until) return Buffer.concat(chunks);
      const p = await this.next(Math.max(1, deadline - Date.now()));
      if (p.command === A_WRTE && p.arg0 === localId && p.arg1 === remoteId) {
        chunks.push(p.data);
        total += p.data.length;
        this.send(A_OKAY, remoteId, localId);
      } else if (p.command === A_CLSE && p.arg0 === localId) {
        return Buffer.concat(chunks);
      }
    }
  }

  close(): void {
    this.socket.destroy();
  }
}
