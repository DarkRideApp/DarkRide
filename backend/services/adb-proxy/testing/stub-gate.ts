import type { ParsedAdbKey } from '../adb-key';
import type { ApprovedKey, AuthGate, OfferOutcome } from '../session';

export class StubGate implements AuthGate {
  approved: ApprovedKey[] = [];
  outcome: OfferOutcome = { kind: 'blocked' };
  offers: Array<{ deviceId: string; keyId: string; peerIp: string }> = [];
  authenticatedCalls: Array<{ deviceId: string; keyId: string; peerIp: string }> = [];

  approvedKeys(): ApprovedKey[] {
    return this.approved;
  }

  offer(o: { deviceId: string; parsed: ParsedAdbKey; peerIp: string }): OfferOutcome {
    this.offers.push({ deviceId: o.deviceId, keyId: o.parsed.keyId, peerIp: o.peerIp });
    return this.outcome;
  }

  authenticated(info: { deviceId: string; keyId: string; peerIp: string }): void {
    this.authenticatedCalls.push(info);
  }
}
