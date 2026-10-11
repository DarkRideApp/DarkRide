import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyKeys, users } from '../../db/schema';
import { KeyStore } from './key-store';

function setup() {
  const db = createTestDb([users, adbProxyKeys]);
  const user = db.insert(users).values({ username: 'admin', providerId: 'local', createdAt: new Date(), updatedAt: new Date() }).returning({ id: users.id }).get();
  let clock = new Date('2026-10-11T10:00:00Z');
  const store = new KeyStore(db, () => clock);
  return { db, store, userId: user.id, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

const base = { keyId: 'k1', publicKey: 'cHVi', comment: 'ci@runner', ip: '10.0.0.5', deviceId: 'DEV1' };

describe('KeyStore', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('records an approval with first and last seen set to now and no allow-list', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: ctx.userId });
    expect(rec.status).toBe('approved');
    expect(rec.deviceIds).toBeNull();
    expect(rec.firstSeenAt).toEqual(new Date('2026-10-11T10:00:00Z'));
    expect(rec.lastSeenAt).toEqual(rec.firstSeenAt);
    expect(rec.lastSeenIp).toBe('10.0.0.5');
    expect(rec.lastDeviceId).toBe('DEV1');
    expect(rec.decidedBy).toBe(ctx.userId);
  });

  it('flips an existing key and keeps its first seen time', () => {
    ctx.store.upsertDecision({ ...base, status: 'denied', userId: ctx.userId });
    ctx.advance(60_000);
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', ip: '10.0.0.9', userId: ctx.userId });
    expect(rec.status).toBe('approved');
    expect(rec.firstSeenAt).toEqual(new Date('2026-10-11T10:00:00Z'));
    expect(rec.lastSeenAt).toEqual(new Date('2026-10-11T10:01:00Z'));
    expect(rec.lastSeenIp).toBe('10.0.0.9');
    expect(ctx.store.list()).toHaveLength(1);
  });

  it('finds by key id and by row id, and lists in insertion order', () => {
    const a = ctx.store.upsertDecision({ ...base, keyId: 'a', status: 'approved', userId: null });
    const b = ctx.store.upsertDecision({ ...base, keyId: 'b', status: 'denied', userId: null });
    expect(ctx.store.findByKeyId('b')?.id).toBe(b.id);
    expect(ctx.store.findById(a.id)?.keyId).toBe('a');
    expect(ctx.store.findByKeyId('missing')).toBeUndefined();
    expect(ctx.store.list().map((r) => r.keyId)).toEqual(['a', 'b']);
  });

  it('approvedFor returns only approved keys, honouring the allow-list', () => {
    const open = ctx.store.upsertDecision({ ...base, keyId: 'open', status: 'approved', userId: null });
    const listed = ctx.store.upsertDecision({ ...base, keyId: 'listed', status: 'approved', userId: null });
    const other = ctx.store.upsertDecision({ ...base, keyId: 'other', status: 'approved', userId: null });
    const empty = ctx.store.upsertDecision({ ...base, keyId: 'empty', status: 'approved', userId: null });
    ctx.store.upsertDecision({ ...base, keyId: 'denied', status: 'denied', userId: null });
    const revoked = ctx.store.upsertDecision({ ...base, keyId: 'revoked', status: 'approved', userId: null });
    ctx.store.setStatus(revoked.id, 'revoked', ctx.userId);
    ctx.store.setDeviceIds(listed.id, ['DEV1', 'DEV2']);
    ctx.store.setDeviceIds(other.id, ['DEV9']);
    ctx.store.setDeviceIds(empty.id, []);
    expect(ctx.store.approvedFor('DEV1').map((r) => r.keyId).sort()).toEqual(['empty', 'listed', 'open']);
    expect(open.status).toBe('approved');
  });

  it('setStatus records who decided and when', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: null });
    ctx.advance(5_000);
    const revoked = ctx.store.setStatus(rec.id, 'revoked', ctx.userId);
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.decidedBy).toBe(ctx.userId);
    expect(revoked?.decidedAt).toEqual(new Date('2026-10-11T10:00:05Z'));
    expect(ctx.store.setStatus(9999, 'revoked', null)).toBeUndefined();
  });

  it('setDeviceIds round-trips a list and null', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: null });
    expect(ctx.store.setDeviceIds(rec.id, ['A', 'B'])?.deviceIds).toEqual(['A', 'B']);
    expect(ctx.store.setDeviceIds(rec.id, null)?.deviceIds).toBeNull();
    expect(ctx.store.setDeviceIds(9999, ['A'])).toBeUndefined();
  });

  it('touch updates last seen time, ip and device only', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: ctx.userId });
    ctx.advance(30_000);
    ctx.store.touch('k1', '10.0.0.77', 'DEV2');
    const after = ctx.store.findById(rec.id)!;
    expect(after.lastSeenAt).toEqual(new Date('2026-10-11T10:00:30Z'));
    expect(after.lastSeenIp).toBe('10.0.0.77');
    expect(after.lastDeviceId).toBe('DEV2');
    expect(after.status).toBe('approved');
    expect(after.decidedAt).toEqual(rec.decidedAt);
    expect(() => ctx.store.touch('missing', 'x', 'y')).not.toThrow();
  });

  it('forget removes the record and reports whether it existed', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: null });
    expect(ctx.store.forget(rec.id)).toBe(true);
    expect(ctx.store.forget(rec.id)).toBe(false);
    expect(ctx.store.list()).toHaveLength(0);
  });
});
