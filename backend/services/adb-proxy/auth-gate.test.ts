import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyKeys, users } from '../../db/schema';
import { parseAdbPublicKey } from './adb-key';
import { KeyAuthGate, type GateEvent } from './auth-gate';
import { KeyStore } from './key-store';
import { PendingRegistry, type PendingOptions } from './pending';
import { makeTestAdbKey } from './testing/test-keys';

function setup(pendingOpts: PendingOptions = {}) {
  const db = createTestDb([users, adbProxyKeys]);
  const keys = new KeyStore(db);
  const pending = new PendingRegistry(pendingOpts);
  const events: GateEvent[] = [];
  const gate = new KeyAuthGate(keys, pending, (e) => events.push(e));
  return { keys, pending, gate, events };
}

const offered = (text: string, deviceId = 'DEV1', peerIp = '10.0.0.5') => ({ deviceId, parsed: parseAdbPublicKey(text), peerIp });

describe('KeyAuthGate', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.pending.stop(); });

  const approve = (k = makeTestAdbKey(), deviceIds: string[] | null = null) => {
    const p = parseAdbPublicKey(k.publicKeyText);
    const rec = ctx.keys.upsertDecision({ keyId: p.keyId, publicKey: p.publicKey, comment: p.comment, status: 'approved', ip: '1.1.1.1', deviceId: 'DEV1', userId: null });
    if (deviceIds) ctx.keys.setDeviceIds(rec.id, deviceIds);
    return { k, p, rec };
  };

  it('offers approved keys for the device as usable key objects', () => {
    const { k } = approve();
    const list = ctx.gate.approvedKeys('DEV1');
    expect(list.map((a) => a.keyId)).toEqual([k.keyId]);
    expect(list[0].key.type).toBe('public');
  });

  it('leaves out keys whose allow-list excludes the device', () => {
    approve(makeTestAdbKey(), ['OTHER']);
    expect(ctx.gate.approvedKeys('DEV1')).toEqual([]);
    expect(ctx.gate.approvedKeys('OTHER')).toHaveLength(1);
  });

  it('turns an unknown key into a pending request', async () => {
    const k = makeTestAdbKey('ci@runner');
    const outcome = ctx.gate.offer(offered(k.publicKeyText));
    expect(outcome.kind).toBe('pending');
    expect(ctx.pending.list()).toHaveLength(1);
    expect(ctx.pending.list()[0]).toMatchObject({ keyId: k.keyId, comment: 'ci@runner', deviceId: 'DEV1', peerIp: '10.0.0.5' });
    expect(ctx.events[0]).toMatchObject({ kind: 'requested' });
    if (outcome.kind !== 'pending') return;
    ctx.pending.resolve(ctx.pending.list()[0].requestId, 'approved');
    await expect(outcome.decision).resolves.toBe('approved');
  });

  it('maps an admin denial to denied', async () => {
    const outcome = ctx.gate.offer(offered(makeTestAdbKey().publicKeyText));
    if (outcome.kind !== 'pending') throw new Error('expected pending');
    ctx.pending.resolve(ctx.pending.list()[0].requestId, 'denied');
    await expect(outcome.decision).resolves.toBe('denied');
  });

  it('maps a timed-out request to denied and drops it from the registry', async () => {
    const short = setup({ timeoutMs: 20 });
    try {
      const outcome = short.gate.offer(offered(makeTestAdbKey().publicKeyText));
      if (outcome.kind !== 'pending') throw new Error('expected pending');
      await expect(outcome.decision).resolves.toBe('denied');
      expect(short.pending.list()).toEqual([]);
    } finally {
      short.pending.stop();
    }
  });

  it('maps a replaced request to denied and keeps only the newer one', async () => {
    const k = makeTestAdbKey();
    const first = ctx.gate.offer(offered(k.publicKeyText));
    const second = ctx.gate.offer(offered(k.publicKeyText));
    if (first.kind !== 'pending' || second.kind !== 'pending') throw new Error('expected pending');
    await expect(first.decision).resolves.toBe('denied');
    expect(ctx.pending.list().map((e) => e.requestId)).toEqual([second.requestId]);
  });

  it('maps a cancelled request to denied', async () => {
    const outcome = ctx.gate.offer(offered(makeTestAdbKey().publicKeyText));
    if (outcome.kind !== 'pending') throw new Error('expected pending');
    outcome.cancel();
    await expect(outcome.decision).resolves.toBe('denied');
  });

  it('cancel() on the outcome removes the pending request', () => {
    const outcome = ctx.gate.offer(offered(makeTestAdbKey().publicKeyText));
    if (outcome.kind !== 'pending') throw new Error('expected pending');
    outcome.cancel();
    expect(ctx.pending.list()).toEqual([]);
  });

  it('blocks a denied key and a revoked key without creating a request', () => {
    const denied = makeTestAdbKey();
    const dp = parseAdbPublicKey(denied.publicKeyText);
    ctx.keys.upsertDecision({ keyId: dp.keyId, publicKey: dp.publicKey, comment: '', status: 'denied', ip: 'x', deviceId: 'DEV1', userId: null });
    const { k, rec } = approve();
    ctx.keys.setStatus(rec.id, 'revoked', null);
    expect(ctx.gate.offer(offered(denied.publicKeyText))).toEqual({ kind: 'blocked' });
    expect(ctx.gate.offer(offered(k.publicKeyText))).toEqual({ kind: 'blocked' });
    expect(ctx.pending.list()).toEqual([]);
    expect(ctx.events.map((e) => (e.kind === 'blocked' ? e.reason : e.kind))).toEqual(['denied', 'revoked']);
  });

  it('blocks an approved key on a device outside its allow-list, with no pending request', () => {
    const { k } = approve(makeTestAdbKey(), ['ONLY-THIS']);
    expect(ctx.gate.offer(offered(k.publicKeyText, 'DEV1'))).toEqual({ kind: 'blocked' });
    expect(ctx.pending.list()).toEqual([]);
    expect(ctx.events[0]).toMatchObject({ kind: 'blocked', reason: 'not-allowed' });
  });

  it('reports an approved key on an allowed device as approved', () => {
    const { k } = approve();
    expect(ctx.gate.offer(offered(k.publicKeyText))).toEqual({ kind: 'approved' });
  });

  it('blocks and reports a flood drop when the pending registry refuses', () => {
    const tight = setup({ maxPending: 1 });
    tight.gate.offer(offered(makeTestAdbKey().publicKeyText));
    expect(tight.gate.offer(offered(makeTestAdbKey().publicKeyText))).toEqual({ kind: 'blocked' });
    expect(tight.events.at(-1)).toMatchObject({ kind: 'flood-drop', reason: 'cap' });
    tight.pending.stop();
  });

  it('authenticated() refreshes the key record', () => {
    const { p } = approve();
    ctx.gate.authenticated({ deviceId: 'DEV2', keyId: p.keyId, peerIp: '10.0.0.9' });
    expect(ctx.keys.findByKeyId(p.keyId)).toMatchObject({ lastSeenIp: '10.0.0.9', lastDeviceId: 'DEV2' });
  });

  it('stops offering a revoked key without any invalidate() call', () => {
    const { rec } = approve();
    expect(ctx.gate.approvedKeys('DEV1')).toHaveLength(1);
    ctx.keys.setStatus(rec.id, 'revoked', null);
    expect(ctx.gate.approvedKeys('DEV1')).toEqual([]);
  });

  it('reuses the parsed key object until invalidate() drops it', () => {
    const { p } = approve();
    const first = ctx.gate.approvedKeys('DEV1')[0].key;
    expect(ctx.gate.approvedKeys('DEV1')[0].key).toBe(first);
    ctx.gate.invalidate(p.keyId);
    const reparsed = ctx.gate.approvedKeys('DEV1')[0].key;
    expect(reparsed).not.toBe(first);
    expect(reparsed.equals(first)).toBe(true);
  });
});
