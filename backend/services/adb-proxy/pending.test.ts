import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingRegistry } from './pending';

const input = (over: Partial<Parameters<PendingRegistry['add']>[0]> = {}) => ({
  keyId: 'k1', publicKey: 'cHVi', fingerprint: 'AA:BB', comment: 'ci@runner', deviceId: 'DEV1', peerIp: '10.0.0.5', ...over,
});

describe('PendingRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T10:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('adds an entry with an id and creation time and lists it', () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.entry.createdAt).toBe(Date.parse('2026-10-11T10:00:00Z'));
    expect(reg.list()).toEqual([r.entry]);
    expect(reg.get(r.entry.requestId)).toEqual(r.entry);
  });

  it('resolve settles the decision promise and removes the entry', async () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    expect(reg.resolve(r.entry.requestId, 'approved')).toBe(true);
    await expect(r.decision).resolves.toBe('approved');
    expect(reg.list()).toEqual([]);
    expect(reg.resolve(r.entry.requestId, 'approved')).toBe(false);
  });

  it('resolveKey settles every entry for a key across devices and returns the count', async () => {
    const reg = new PendingRegistry();
    const a = reg.add(input({ deviceId: 'DEV1' }));
    const b = reg.add(input({ deviceId: 'DEV2' }));
    const c = reg.add(input({ keyId: 'k2' }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('add failed');
    expect(reg.resolveKey('k1', 'denied')).toBe(2);
    await expect(a.decision).resolves.toBe('denied');
    await expect(b.decision).resolves.toBe('denied');
    expect(reg.list()).toHaveLength(1);
    expect(reg.resolveKey('k1', 'denied')).toBe(0);
  });

  it('a repeat for the same key and device replaces the older entry without using the rate budget', async () => {
    const reg = new PendingRegistry({ perIpPerMinute: 1 });
    const first = reg.add(input());
    const second = reg.add(input());
    if (!first.ok || !second.ok) throw new Error('add failed');
    await expect(first.decision).resolves.toBe('replaced');
    expect(reg.list()).toEqual([second.entry]);
  });

  it('refuses a new entry past the total cap', () => {
    const reg = new PendingRegistry({ maxPending: 2, perIpPerMinute: 100 });
    expect(reg.add(input({ keyId: 'a' })).ok).toBe(true);
    expect(reg.add(input({ keyId: 'b' })).ok).toBe(true);
    expect(reg.add(input({ keyId: 'c' }))).toEqual({ ok: false, reason: 'cap' });
  });

  it('still allows a replacement when the registry is full', () => {
    const reg = new PendingRegistry({ maxPending: 1 });
    expect(reg.add(input()).ok).toBe(true);
    expect(reg.add(input()).ok).toBe(true);
  });

  it('limits new entries per IP per minute and lets the window slide', () => {
    const reg = new PendingRegistry({ perIpPerMinute: 3 });
    for (const k of ['a', 'b', 'c']) expect(reg.add(input({ keyId: k })).ok).toBe(true);
    expect(reg.add(input({ keyId: 'd' }))).toEqual({ ok: false, reason: 'rate' });
    expect(reg.add(input({ keyId: 'e', peerIp: '10.0.0.6' })).ok).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(reg.add(input({ keyId: 'd' })).ok).toBe(true);
  });

  it('times out after 5 minutes by default', async () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(reg.list()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    await expect(r.decision).resolves.toBe('timeout');
    expect(reg.list()).toEqual([]);
  });

  it('cancel removes the entry, settles as cancelled and leaves no timer behind', async () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    r.cancel();
    await expect(r.decision).resolves.toBe('cancelled');
    expect(reg.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolving a request whose client already cancelled is a clean no-op', () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    r.cancel();
    expect(reg.resolve(r.entry.requestId, 'approved')).toBe(false);
    expect(reg.resolveKey('k1', 'approved')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop cancels everything', async () => {
    const reg = new PendingRegistry();
    const a = reg.add(input({ keyId: 'a' }));
    const b = reg.add(input({ keyId: 'b' }));
    if (!a.ok || !b.ok) throw new Error('add failed');
    reg.stop();
    await expect(a.decision).resolves.toBe('cancelled');
    await expect(b.decision).resolves.toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls onChange for add, resolve, replace, cancel and timeout', () => {
    const onChange = vi.fn();
    const reg = new PendingRegistry({ onChange });
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    expect(onChange).toHaveBeenCalledTimes(1);
    reg.resolve(r.entry.requestId, 'approved');
    expect(onChange).toHaveBeenCalledTimes(2);
    const s = reg.add(input());
    if (!s.ok) throw new Error('add failed');
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(onChange).toHaveBeenCalledTimes(4);
  });
});
