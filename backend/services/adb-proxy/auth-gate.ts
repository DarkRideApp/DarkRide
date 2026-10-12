import type { KeyObject } from 'node:crypto';
import { parseAdbPublicKey, type ParsedAdbKey } from './adb-key';
import type { KeyStore } from './key-store';
import type { PendingEntry, PendingRegistry } from './pending';
import type { ApprovedKey, AuthGate, OfferOutcome } from './session';

export type GateEvent =
  | { kind: 'blocked'; reason: 'denied' | 'revoked' | 'not-allowed'; keyId: string; deviceId: string; peerIp: string }
  | { kind: 'flood-drop'; reason: 'cap' | 'rate'; deviceId: string; peerIp: string }
  | { kind: 'requested'; entry: PendingEntry };

export class KeyAuthGate implements AuthGate {
  private readonly parsed = new Map<string, KeyObject>();

  constructor(
    private readonly keys: KeyStore,
    private readonly pending: PendingRegistry,
    private readonly onEvent: (e: GateEvent) => void = () => {},
  ) {}

  approvedKeys(deviceId: string): ApprovedKey[] {
    return this.keys.approvedFor(deviceId).flatMap((r) => {
      const key = this.keyObject(r.keyId, r.publicKey);
      return key ? [{ keyId: r.keyId, key }] : [];
    });
  }

  offer(o: { deviceId: string; parsed: ParsedAdbKey; peerIp: string }): OfferOutcome {
    const { deviceId, parsed, peerIp } = o;
    const record = this.keys.findByKeyId(parsed.keyId);
    if (record) {
      if (record.status !== 'approved') {
        this.onEvent({ kind: 'blocked', reason: record.status, keyId: parsed.keyId, deviceId, peerIp });
        return { kind: 'blocked' };
      }
      if (record.deviceIds && record.deviceIds.length > 0 && !record.deviceIds.includes(deviceId)) {
        this.onEvent({ kind: 'blocked', reason: 'not-allowed', keyId: parsed.keyId, deviceId, peerIp });
        return { kind: 'blocked' };
      }
      return { kind: 'approved' };
    }
    const added = this.pending.add({
      keyId: parsed.keyId,
      publicKey: parsed.publicKey,
      fingerprint: parsed.fingerprint,
      comment: parsed.comment,
      deviceId,
      peerIp,
    });
    if (!added.ok) {
      this.onEvent({ kind: 'flood-drop', reason: added.reason, deviceId, peerIp });
      return { kind: 'blocked' };
    }
    this.onEvent({ kind: 'requested', entry: added.entry });
    return {
      kind: 'pending',
      requestId: added.entry.requestId,
      decision: added.decision.then((d) => (d === 'approved' ? 'approved' : 'denied')),
      cancel: added.cancel,
    };
  }

  authenticated(info: { deviceId: string; keyId: string; peerIp: string }): void {
    this.keys.touch(info.keyId, info.peerIp, info.deviceId);
  }

  /** Forget the cached key object after a revoke, forget or re-decision. */
  invalidate(keyId: string): void {
    this.parsed.delete(keyId);
  }

  private keyObject(keyId: string, publicKey: string): KeyObject | null {
    const cached = this.parsed.get(keyId);
    if (cached) return cached;
    try {
      const key = parseAdbPublicKey(publicKey).key;
      this.parsed.set(keyId, key);
      return key;
    } catch {
      return null;
    }
  }
}
