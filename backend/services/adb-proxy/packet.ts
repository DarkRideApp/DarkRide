export const A_CNXN = 0x4e584e43;
export const A_AUTH = 0x48545541;
export const A_OPEN = 0x4e45504f;
export const A_OKAY = 0x59414b4f;
export const A_CLSE = 0x45534c43;
export const A_WRTE = 0x45545257;

export const A_VERSION = 0x01000001;
/** The largest payload current ADB clients and devices advertise in their CNXN. */
export const MAX_DATA = 1024 * 1024;
/**
 * The largest payload the proxy advertises and accepts once a session is ready. Each stream can hold one unacknowledged
 * client WRTE in the backend's write buffer, so this bounds that memory; clients use the smaller of the two maximums.
 */
export const PROXY_MAX_PAYLOAD = 256 * 1024;
export const PREAUTH_MAX_PAYLOAD = 4096;
export const HEADER_SIZE = 24;

export const AUTH_TOKEN = 1;
export const AUTH_SIGNATURE = 2;
export const AUTH_RSAPUBLICKEY = 3;

const NAMES: Record<number, string> = {
  [A_CNXN]: 'CNXN',
  [A_AUTH]: 'AUTH',
  [A_OPEN]: 'OPEN',
  [A_OKAY]: 'OKAY',
  [A_CLSE]: 'CLSE',
  [A_WRTE]: 'WRTE',
};

export interface Packet {
  command: number;
  arg0: number;
  arg1: number;
  data: Buffer;
}

export class PacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketError';
  }
}

export function isKnownCommand(command: number): boolean {
  return NAMES[command] !== undefined;
}

export function commandName(command: number): string {
  return NAMES[command] ?? `0x${command.toString(16)}`;
}

export function encodePacket(p: { command: number; arg0: number; arg1: number; data?: Buffer }): Buffer {
  const data = p.data ?? Buffer.alloc(0);
  const out = Buffer.alloc(HEADER_SIZE + data.length);
  out.writeUInt32LE(p.command >>> 0, 0);
  out.writeUInt32LE(p.arg0 >>> 0, 4);
  out.writeUInt32LE(p.arg1 >>> 0, 8);
  out.writeUInt32LE(data.length, 12);
  let sum = 0;
  for (const b of data) sum = (sum + b) >>> 0;
  out.writeUInt32LE(sum, 16);
  out.writeUInt32LE((p.command ^ 0xffffffff) >>> 0, 20);
  data.copy(out, HEADER_SIZE);
  return out;
}

export class PacketParser {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private maxPayload: number) {}

  setMaxPayload(n: number): void {
    this.maxPayload = n;
  }

  /** Feed bytes; returns every complete packet. Throws PacketError on a bad magic or an oversize payload. */
  push(chunk: Buffer): Packet[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Packet[] = [];
    while (this.buf.length >= HEADER_SIZE) {
      const command = this.buf.readUInt32LE(0);
      const arg0 = this.buf.readUInt32LE(4);
      const arg1 = this.buf.readUInt32LE(8);
      const length = this.buf.readUInt32LE(12);
      const magic = this.buf.readUInt32LE(20);
      if (magic !== ((command ^ 0xffffffff) >>> 0)) throw new PacketError('bad magic');
      if (length > this.maxPayload) throw new PacketError(`payload too large: ${length}`);
      if (this.buf.length < HEADER_SIZE + length) break;
      out.push({ command, arg0, arg1, data: Buffer.from(this.buf.subarray(HEADER_SIZE, HEADER_SIZE + length)) });
      this.buf = this.buf.subarray(HEADER_SIZE + length);
    }
    return out;
  }
}
