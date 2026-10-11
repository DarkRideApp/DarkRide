import type net from 'node:net';
import { randomBytes, type KeyObject } from 'node:crypto';
import { createLoggers } from '../../logs';
import { parseAdbPublicKey, verifyAuthSignature, type ParsedAdbKey } from './adb-key';
import {
  A_AUTH, A_CNXN, A_VERSION, AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN, MAX_DATA, PREAUTH_MAX_PAYLOAD,
  PacketError, PacketParser, commandName, encodePacket, type Packet,
} from './packet';

const { error: logError } = createLoggers('adb-proxy');

const MAX_SIGNATURE_ATTEMPTS = 3;
const DEFAULT_PREAUTH_TIMEOUT_MS = 10_000;

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
  /** A client offered a key that no signature matched. */
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
      case 'ready': return;
      default: this.close(`unexpected ${commandName(p.command)} while ${this.state}`);
    }
  }

  private onCnxn(p: Packet): void {
    if (p.command !== A_CNXN) return this.close('expected CNXN');
    if (!this.opts.isDeviceOnline()) return this.close('device offline');
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
        void this.becomeReady();
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
      void this.becomeReady();
      return;
    }
    this.state = 'pending';
    this.leavePreAuth();
    this.cancelPending = outcome.cancel;
    this.emit({ kind: 'pending', session: this });
    outcome.decision.then(
      (decision) => {
        if (this.closed) return;
        this.cancelPending = null;
        if (decision !== 'approved') return this.close('denied');
        // This runs outside onData's try/catch, so a throw would be an unhandled rejection and leave the socket open.
        try {
          this.opts.gate.authenticated({ deviceId: this.deviceId, keyId: parsed.keyId, peerIp: this.peerIp });
        } catch (e: any) {
          logError(`session ${this.id} handler error: ${e?.message ?? e}`);
          return this.close('handler error');
        }
        void this.becomeReady();
      },
      () => this.close('decision error'),
    );
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
    this.send(A_CNXN, A_VERSION, MAX_DATA, Buffer.from(banner + '\0', 'utf8'));
    this.parser.setMaxPayload(MAX_DATA);
    this.state = 'ready';
    this.emit({ kind: 'authenticated', session: this });
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
  }

  private emit(e: SessionEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch (err: any) {
      logError(`session ${this.id} event handler error: ${err?.message ?? err}`);
    }
  }

  private close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.leavePreAuth();
    this.cancelPending?.();
    this.cancelPending = null;
    this.opts.socket.destroy();
    this.emit({ kind: 'closed', session: this, reason });
    this.opts.onClose?.(this);
  }
}
