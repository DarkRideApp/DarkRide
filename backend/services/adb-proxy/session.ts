import type net from 'node:net';
import { randomBytes, type KeyObject } from 'node:crypto';
import { createLoggers } from '../../logs';
import { parseAdbPublicKey, verifyAuthSignature, type ParsedAdbKey } from './adb-key';
import {
  A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_VERSION, A_WRTE, AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN,
  MAX_DATA, PREAUTH_MAX_PAYLOAD, PacketError, PacketParser, commandName, encodePacket, type Packet,
} from './packet';

const { error: logError } = createLoggers('adb-proxy');

// A client signs once per key it holds before it offers a public key, so this bounds how many keys it may hold.
const MAX_SIGNATURE_ATTEMPTS = 8;
const DEFAULT_PREAUTH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STREAMS = 128;
const MAX_SERVICE_LENGTH = 4096;
// A client advertising less than this (or nothing) still gets WRTEs of this size, the classic ADB payload.
const MIN_PEER_MAX_DATA = 4096;
const OUTBOUND_HIGH_WATER = 4 * 1024 * 1024;
// The ADB server dispatches anything starting with "host" as a request to itself, even on a bound connection.
const REFUSED_PREFIXES = ['host', 'reverse:', 'tcpip:', 'usb:'];
// These services separate their arguments with NULs; adbd splits them back out.
const NUL_SEPARATED_PREFIXES = ['abb_exec:', 'abb:'];
const MALFORMED_SERVICE = '<malformed>';

export function checkService(service: string): { allowed: true } | { allowed: false; reason: string } {
  if (service.length === 0) return { allowed: false, reason: 'empty service' };
  if (service.length > MAX_SERVICE_LENGTH) return { allowed: false, reason: 'service too long' };
  const prefix = REFUSED_PREFIXES.find((p) => service.startsWith(p));
  if (prefix) return { allowed: false, reason: `${prefix} services are not proxied` };
  if (service.includes('\0') && !NUL_SEPARATED_PREFIXES.some((p) => service.startsWith(p))) {
    return { allowed: false, reason: 'NUL in service' };
  }
  return { allowed: true };
}

/** The service string of an OPEN payload without its one trailing NUL, or null when malformed. */
function parseService(data: Buffer): string | null {
  // Bound the work before decoding: the ready-state payload cap is 1 MiB.
  if (data.length > MAX_SERVICE_LENGTH + 1) return null;
  const raw = data.length > 0 && data[data.length - 1] === 0 ? data.subarray(0, data.length - 1) : data;
  if (raw.length === 0) return null;
  const text = raw.toString('utf8');
  return Buffer.from(text, 'utf8').equals(raw) ? text : null;
}

interface Stream {
  localId: number;
  remoteId: number;
  backend: net.Socket | null;
  windowOpen: boolean;
  outQueue: Buffer[];
  backendEnded: boolean;
  /** A client WRTE is written to the backend but not yet acknowledged. */
  ackPending: boolean;
}

export type SessionState = 'await-cnxn' | 'await-auth' | 'pending' | 'finishing' | 'ready' | 'closed';

export interface ApprovedKey {
  keyId: string;
  key: KeyObject;
}

export type OfferOutcome =
  | { kind: 'blocked' }
  | { kind: 'approved' }
  | { kind: 'pending'; requestId: string; decision: Promise<'approved' | 'denied'>; cancel(): void };

export interface AuthGate {
  /** Approved keys that may reach this device. */
  approvedKeys(deviceId: string): ApprovedKey[];
  /** A client proved possession of a key that is not approved for this device. */
  offer(o: { deviceId: string; parsed: ParsedAdbKey; peerIp: string }): OfferOutcome;
  /** A client proved possession of an approved key. */
  authenticated(i: { deviceId: string; keyId: string; peerIp: string }): void;
}

export interface BackendConnector {
  openService(serial: string, service: string): Promise<net.Socket>;
  deviceBanner(serial: string): Promise<string>;
}

export type SessionEvent =
  | { kind: 'auth-failed' | 'authenticated' | 'pending' | 'blocked'; session: Session }
  | { kind: 'refused-service'; session: Session; service: string }
  | { kind: 'closed'; session: Session; reason: string };

export interface SessionOptions {
  socket: net.Socket;
  deviceId: string;
  peerIp: string;
  gate: AuthGate;
  backend: BackendConnector;
  isDeviceOnline(): boolean;
  onEvent?(e: SessionEvent): void;
  onClose?(s: Session): void;
  /** Called once when the connection stops counting against the pre-auth limits (pending, ready or closed). */
  onLeavePreAuth?(): void;
  preAuthTimeoutMs?: number;
  maxStreams?: number;
}

let sessionCounter = 0;

export class Session {
  readonly id = ++sessionCounter;
  readonly createdAt = Date.now();
  readonly deviceId: string;
  readonly peerIp: string;
  state: SessionState = 'await-cnxn';
  keyId: string | null = null;
  keyComment: string | null = null;

  private readonly parser = new PacketParser(PREAUTH_MAX_PAYLOAD);
  private token: Buffer | null = null;
  private signatureAttempts = 0;
  private proofs: Array<{ token: Buffer; signature: Buffer }> = [];
  private preAuthTimer: NodeJS.Timeout | null;
  private cancelPending: (() => void) | null = null;
  private preAuthLeft = false;
  private closed = false;
  private readonly streams = new Map<number, Stream>();
  private nextLocalId = 1;
  private peerMaxData = MAX_DATA;
  private readsPaused = false;

  constructor(private readonly opts: SessionOptions) {
    this.deviceId = opts.deviceId;
    this.peerIp = opts.peerIp;
    opts.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    opts.socket.on('error', () => this.close('socket error'));
    opts.socket.on('close', () => this.close('socket closed'));
    this.preAuthTimer = setTimeout(() => this.close('pre-auth timeout'), opts.preAuthTimeoutMs ?? DEFAULT_PREAUTH_TIMEOUT_MS);
    this.preAuthTimer.unref?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  info() {
    return {
      id: this.id,
      deviceId: this.deviceId,
      peerIp: this.peerIp,
      state: this.state,
      keyId: this.keyId,
      comment: this.keyComment,
      since: this.createdAt,
      streams: this.streams.size,
    };
  }

  destroy(reason: string): void {
    this.close(reason);
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let packets: Packet[];
    try {
      packets = this.parser.push(chunk);
    } catch (e) {
      this.close(e instanceof PacketError ? e.message : 'parse error');
      return;
    }
    for (const p of packets) {
      if (this.closed) return;
      try {
        this.handlePacket(p);
      } catch (e: any) {
        logError(`session ${this.id} handler error: ${e?.message ?? e}`);
        this.close('handler error');
        return;
      }
    }
  }

  private handlePacket(p: Packet): void {
    switch (this.state) {
      case 'await-cnxn': return this.onCnxn(p);
      case 'await-auth': return this.onAuth(p);
      case 'pending': return;
      case 'ready': return this.onReadyPacket(p);
      default: this.close(`unexpected ${commandName(p.command)} while ${this.state}`);
    }
  }

  private onCnxn(p: Packet): void {
    if (p.command !== A_CNXN) return this.close('expected CNXN');
    if (!this.opts.isDeviceOnline()) return this.close('device offline');
    this.peerMaxData = Math.min(MAX_DATA, Math.max(MIN_PEER_MAX_DATA, p.arg1));
    this.sendToken();
    this.state = 'await-auth';
  }

  private sendToken(): void {
    this.token = randomBytes(20);
    this.send(A_AUTH, AUTH_TOKEN, 0, this.token);
  }

  private onAuth(p: Packet): void {
    if (p.command !== A_AUTH) return this.close('expected AUTH');
    if (p.arg0 === AUTH_SIGNATURE) return this.onSignature(p.data);
    if (p.arg0 === AUTH_RSAPUBLICKEY) return this.onPublicKey(p.data);
    this.close('bad AUTH type');
  }

  private onSignature(signature: Buffer): void {
    if (++this.signatureAttempts > MAX_SIGNATURE_ATTEMPTS) return this.close('too many signatures');
    const token = this.token;
    if (!token) return this.close('no token issued');
    for (const k of this.opts.gate.approvedKeys(this.deviceId)) {
      if (verifyAuthSignature(k.key, token, signature)) {
        this.keyId = k.keyId;
        this.opts.gate.authenticated({ deviceId: this.deviceId, keyId: k.keyId, peerIp: this.peerIp });
        this.startReady();
        return;
      }
    }
    this.proofs.push({ token, signature });
    this.emit({ kind: 'auth-failed', session: this });
    this.sendToken();
  }

  private onPublicKey(data: Buffer): void {
    let parsed: ParsedAdbKey;
    try {
      parsed = parseAdbPublicKey(data);
    } catch {
      return this.close('bad public key');
    }
    // A public key is not secret; only a signature over a token issued on this connection shows the client holds the private key.
    if (!this.proofs.some((p) => verifyAuthSignature(parsed.key, p.token, p.signature))) return this.close('key not proven');
    this.keyId = parsed.keyId;
    this.keyComment = parsed.comment;
    const outcome = this.opts.gate.offer({ deviceId: this.deviceId, parsed, peerIp: this.peerIp });
    if (outcome.kind === 'blocked') {
      this.emit({ kind: 'blocked', session: this });
      return this.close('key blocked');
    }
    if (outcome.kind === 'approved') {
      this.opts.gate.authenticated({ deviceId: this.deviceId, keyId: parsed.keyId, peerIp: this.peerIp });
      this.startReady();
      return;
    }
    this.state = 'pending';
    this.leavePreAuth();
    this.cancelPending = () => outcome.cancel();
    this.emit({ kind: 'pending', session: this });
    outcome.decision.then(
      (decision) => {
        if (this.closed) return;
        this.cancelPending = null;
        if (decision !== 'approved') return this.close('denied');
        // Async continuation: not covered by onData's catch.
        try {
          this.opts.gate.authenticated({ deviceId: this.deviceId, keyId: parsed.keyId, peerIp: this.peerIp });
        } catch (e: any) {
          logError(`session ${this.id} handler error: ${e?.message ?? e}`);
          return this.close('handler error');
        }
        this.startReady();
      },
      () => this.close('decision error'),
    );
  }

  private startReady(): void {
    this.becomeReady().catch((e: any) => {
      logError(`session ${this.id} handler error: ${e?.message ?? e}`);
      this.close('handler error');
    });
  }

  private async becomeReady(): Promise<void> {
    this.state = 'finishing';
    this.leavePreAuth();
    if (!this.opts.isDeviceOnline()) return this.close('device offline');
    let banner: string;
    try {
      banner = await this.opts.backend.deviceBanner(this.deviceId);
    } catch (e: any) {
      logError(`session ${this.id} banner failed: ${e?.message ?? e}`);
      return this.close('banner failed');
    }
    if (this.closed) return;
    // No terminator: clients split the banner on commas and a trailing NUL makes them drop the last feature.
    this.send(A_CNXN, A_VERSION, MAX_DATA, Buffer.from(banner, 'utf8'));
    this.parser.setMaxPayload(MAX_DATA);
    this.state = 'ready';
    this.emit({ kind: 'authenticated', session: this });
  }

  private onReadyPacket(p: Packet): void {
    switch (p.command) {
      case A_OPEN: return this.onOpen(p);
      case A_WRTE: return this.onWrite(p);
      case A_OKAY: return this.onOkay(p);
      case A_CLSE: return this.onPeerClose(p);
      default: return;
    }
  }

  private refuse(remoteId: number): void {
    if (remoteId !== 0) this.send(A_CLSE, 0, remoteId);
  }

  private onOpen(p: Packet): void {
    const remoteId = p.arg0;
    if (remoteId === 0) return;
    const service = parseService(p.data);
    if (service === null) {
      this.emit({ kind: 'refused-service', session: this, service: MALFORMED_SERVICE });
      return this.refuse(remoteId);
    }
    if (!checkService(service).allowed) {
      this.emit({ kind: 'refused-service', session: this, service });
      return this.refuse(remoteId);
    }
    const duplicate = [...this.streams.values()].some((s) => s.remoteId === remoteId);
    if (duplicate || this.streams.size >= (this.opts.maxStreams ?? DEFAULT_MAX_STREAMS)) return this.refuse(remoteId);
    const stream: Stream = {
      localId: this.nextLocalId++, remoteId, backend: null, windowOpen: false, outQueue: [], backendEnded: false, ackPending: false,
    };
    this.streams.set(stream.localId, stream);
    let opening: Promise<net.Socket>;
    try {
      opening = Promise.resolve(this.opts.backend.openService(this.deviceId, service));
    } catch (err: any) {
      logError(`session ${this.id} stream ${stream.localId} open error: ${err?.message ?? err}`);
      this.streams.delete(stream.localId);
      return this.refuse(remoteId);
    }
    opening.then(
      (sock) => this.guardStream(stream, 'open', () => {
        if (this.closed || !this.streams.has(stream.localId)) {
          sock.destroy();
          return;
        }
        this.attach(stream, sock);
      }),
      () => this.guardStream(stream, 'open', () => {
        if (this.streams.delete(stream.localId)) this.refuse(remoteId);
      }),
    );
  }

  private attach(stream: Stream, sock: net.Socket): void {
    stream.backend = sock;
    stream.windowOpen = true;
    this.send(A_OKAY, stream.localId, stream.remoteId);
    // The socket arrives paused and may already have ended; listen now, in the same tick, or its end is never seen.
    sock.on('data', (chunk: Buffer) => this.guardStream(stream, 'data', () => {
      stream.outQueue.push(chunk);
      sock.pause();
      this.pump(stream);
    }));
    const ended = () => this.guardStream(stream, 'end', () => {
      stream.backendEnded = true;
      this.pump(stream);
    });
    sock.on('end', ended);
    sock.on('close', ended);
    sock.on('error', () => this.guardStream(stream, 'error', () => this.closeStream(stream, true)));
    if (sock.destroyed || sock.readableEnded) {
      ended();
      return;
    }
    sock.resume();
  }

  /** Send queued backend data one WRTE at a time; ADB allows a single unacknowledged WRTE per stream. */
  private pump(stream: Stream): void {
    if (this.closed || !this.streams.has(stream.localId)) return;
    if (stream.windowOpen && stream.outQueue.length > 0) {
      const head = stream.outQueue[0];
      let piece = head;
      if (head.length > this.peerMaxData) {
        piece = head.subarray(0, this.peerMaxData);
        stream.outQueue[0] = head.subarray(this.peerMaxData);
      } else {
        stream.outQueue.shift();
      }
      stream.windowOpen = false;
      this.send(A_WRTE, stream.localId, stream.remoteId, piece);
    }
    if (stream.outQueue.length > 0) {
      stream.backend?.pause();
      return;
    }
    if (stream.backendEnded) {
      if (stream.windowOpen) this.closeStream(stream, true);
      return;
    }
    if (stream.windowOpen) stream.backend?.resume();
  }

  private onWrite(p: Packet): void {
    const stream = this.streams.get(p.arg1);
    if (!stream || stream.remoteId !== p.arg0 || !stream.backend) return;
    // ADB allows one unacknowledged WRTE per stream; a second one is a protocol error and would otherwise queue without bound.
    if (stream.ackPending) return this.closeStream(stream, true);
    const backend = stream.backend;
    stream.ackPending = true;
    this.guardStream(stream, 'write', () => {
      backend.write(p.data, (err) => this.guardStream(stream, 'write callback', () => {
        stream.ackPending = false;
        if (this.closed || !this.streams.has(stream.localId)) return;
        if (err) return this.closeStream(stream, true);
        this.send(A_OKAY, stream.localId, stream.remoteId);
      }));
    });
  }

  private onOkay(p: Packet): void {
    const stream = this.streams.get(p.arg1);
    if (!stream || stream.remoteId !== p.arg0) return;
    stream.windowOpen = true;
    this.guardStream(stream, 'ack', () => this.pump(stream));
  }

  private onPeerClose(p: Packet): void {
    const stream = this.streams.get(p.arg1);
    if (!stream || stream.remoteId !== p.arg0) return;
    this.closeStream(stream, true);
  }

  private closeStream(stream: Stream, notify: boolean): void {
    if (!this.streams.delete(stream.localId)) return;
    this.destroyBackend(stream);
    if (notify) this.send(A_CLSE, stream.localId, stream.remoteId);
  }

  private destroyBackend(stream: Stream): void {
    try {
      stream.backend?.destroy();
    } catch (err: any) {
      logError(`session ${this.id} stream ${stream.localId} destroy error: ${err?.message ?? err}`);
    }
  }

  /** Runs stream work that fires outside onData: a throw is logged and closes that stream, or the session if even that fails. */
  private guardStream(stream: Stream, label: string, fn: () => void): void {
    try {
      fn();
    } catch (err: any) {
      logError(`session ${this.id} stream ${stream.localId} ${label} error: ${err?.message ?? err}`);
      try {
        this.closeStream(stream, true);
      } catch (again: any) {
        logError(`session ${this.id} stream ${stream.localId} close error: ${again?.message ?? again}`);
        this.close('handler error');
      }
    }
  }

  private leavePreAuth(): void {
    if (this.preAuthLeft) return;
    this.preAuthLeft = true;
    if (this.preAuthTimer) clearTimeout(this.preAuthTimer);
    this.preAuthTimer = null;
    this.opts.onLeavePreAuth?.();
  }

  private send(command: number, arg0: number, arg1: number, data?: Buffer): void {
    if (this.closed || this.opts.socket.destroyed) return;
    this.opts.socket.write(encodePacket({ command, arg0, arg1, data }));
    this.limitBacklog();
  }

  /** A client that sends but never reads would grow the write buffer without limit; stop reading it until the buffer drains. */
  private limitBacklog(): void {
    const socket = this.opts.socket;
    if (this.readsPaused || socket.writableLength <= OUTBOUND_HIGH_WATER) return;
    this.readsPaused = true;
    socket.pause();
    socket.once('drain', () => {
      this.readsPaused = false;
      if (!this.closed) this.guard('resume', () => socket.resume());
    });
  }

  /** Runs a callback supplied by the owner; a throw is logged and never reaches the caller. */
  private guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err: any) {
      logError(`session ${this.id} ${label} error: ${err?.message ?? err}`);
    }
  }

  private emit(e: SessionEvent): void {
    this.guard('event handler', () => this.opts.onEvent?.(e));
  }

  private close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.opts.socket.destroy();
    for (const s of this.streams.values()) this.destroyBackend(s);
    this.streams.clear();
    this.guard('pre-auth release', () => this.leavePreAuth());
    const cancel = this.cancelPending;
    this.cancelPending = null;
    if (cancel) this.guard('cancel', cancel);
    this.emit({ kind: 'closed', session: this, reason });
    this.guard('close handler', () => this.opts.onClose?.(this));
  }
}
