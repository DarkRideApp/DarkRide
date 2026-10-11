import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingRegistry } from './pending';

const logError = vi.hoisted(() => vi.fn());
vi.mock('../../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: logError }) }));

const input = (over: Partial<Parameters<PendingRegistry['add']>[0]> = {}) => ({
  keyId: 'k1', publicKey: 'cHVi', fingerprint: 'AA:BB', comment: 'ci@runner', deviceId: 'DEV1', peerIp: '10.0.0.5', ...over,
});

describe('PendingRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    logError.mockClear();
  });
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

  it('calls onChange once for each add, resolve, cancel and timeout', () => {
    const onChange = vi.fn();
    const reg = new PendingRegistry({ onChange });
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    expect(onChange).toHaveBeenCalledTimes(1);
    reg.resolve(r.entry.requestId, 'approved');
    expect(onChange).toHaveBeenCalledTimes(2);
    const c = reg.add(input({ keyId: 'c' }));
    if (!c.ok) throw new Error('add failed');
    expect(onChange).toHaveBeenCalledTimes(3);
    c.cancel();
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(reg.add(input({ keyId: 'd' })).ok).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(onChange).toHaveBeenCalledTimes(6);
  });

  it('calls onChange once for a replacement and never exposes the gap between the two entries', async () => {
    const seen: string[][] = [];
    const reg: PendingRegistry = new PendingRegistry({ onChange: () => { seen.push(reg.list().map((e) => e.requestId)); } });
    const first = reg.add(input());
    const second = reg.add(input());
    if (!first.ok || !second.ok) throw new Error('add failed');
    expect(seen).toEqual([[first.entry.requestId], [second.entry.requestId]]);
    await expect(first.decision).resolves.toBe('replaced');
  });

  it('lists entries oldest first as time advances, whatever their key order', () => {
    const reg = new PendingRegistry();
    for (const keyId of ['m', 'z', 'a']) {
      expect(reg.add(input({ keyId })).ok).toBe(true);
      vi.advanceTimersByTime(1_000);
    }
    const listed = reg.list();
    expect(listed.map((e) => e.keyId)).toEqual(['m', 'z', 'a']);
    expect(listed.map((e) => e.createdAt)).toEqual([0, 1_000, 2_000].map((ms) => Date.parse('2026-10-11T10:00:00Z') + ms));
  });

  it('cancel on a replaced handle leaves the entry that replaced it listed, timed and undecided', async () => {
    const reg = new PendingRegistry();
    const a = reg.add(input());
    const b = reg.add(input());
    if (!a.ok || !b.ok) throw new Error('add failed');
    let bSettled = false;
    void b.decision.then(() => { bSettled = true; });
    a.cancel();
    await Promise.resolve();
    await Promise.resolve();
    expect(bSettled).toBe(false);
    expect(reg.list()).toEqual([b.entry]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(b.decision).resolves.toBe('timeout');
  });

  describe('spec limits at their default values', () => {
    it('accepts the 20th pending request and refuses the 21st', () => {
      const reg = new PendingRegistry();
      for (let i = 1; i <= 20; i++) expect(reg.add(input({ keyId: `k${i}`, peerIp: `10.0.1.${i}` })).ok).toBe(true);
      expect(reg.add(input({ keyId: 'k21', peerIp: '10.0.1.21' }))).toEqual({ ok: false, reason: 'cap' });
    });

    it('accepts 3 new requests per IP per minute and refuses the 4th', () => {
      const reg = new PendingRegistry();
      for (const keyId of ['a', 'b', 'c']) expect(reg.add(input({ keyId })).ok).toBe(true);
      expect(reg.add(input({ keyId: 'd' }))).toEqual({ ok: false, reason: 'rate' });
    });

    it('holds an IP at its budget until exactly 60 seconds after its hit', () => {
      const reg = new PendingRegistry({ perIpPerMinute: 1 });
      expect(reg.add(input({ keyId: 'a' })).ok).toBe(true);
      vi.advanceTimersByTime(59_999);
      expect(reg.add(input({ keyId: 'b' }))).toEqual({ ok: false, reason: 'rate' });
      vi.advanceTimersByTime(1);
      expect(reg.add(input({ keyId: 'b' })).ok).toBe(true);
    });

    it('repeats for the same key and device never consume the rate budget', () => {
      const reg = new PendingRegistry({ perIpPerMinute: 2 });
      for (let i = 0; i < 3; i++) expect(reg.add(input({ keyId: 'A' })).ok).toBe(true);
      expect(reg.add(input({ keyId: 'B' })).ok).toBe(true);
      expect(reg.add(input({ keyId: 'C' }))).toEqual({ ok: false, reason: 'rate' });
    });
  });

  describe('tracked IP bound', () => {
    const fill = (reg: PendingRegistry, count: number, prefix = 'ip') => {
      for (let i = 0; i < count; i++) {
        const r = reg.add(input({ peerIp: `${prefix}-${i}` }));
        if (!r.ok) throw new Error(`add ${i} failed: ${r.reason}`);
        r.cancel();
      }
    };

    it('fails closed for an untracked IP once 4096 IPs are tracked and still serves a tracked one', () => {
      const reg = new PendingRegistry();
      fill(reg, 4096);
      expect(reg.add(input({ peerIp: 'ip-new' }))).toEqual({ ok: false, reason: 'rate' });
      expect(reg.add(input({ peerIp: 'ip-0' })).ok).toBe(true);
    });

    it('frees the bound by pruning IPs whose hits have all expired', () => {
      const reg = new PendingRegistry();
      fill(reg, 4096);
      vi.advanceTimersByTime(61_000);
      expect(reg.add(input({ peerIp: 'ip-new' })).ok).toBe(true);
    });

    it('prunes only expired IPs and keeps the budget of an IP with a live hit', () => {
      const reg = new PendingRegistry({ perIpPerMinute: 1 });
      fill(reg, 300, 'old');
      vi.advanceTimersByTime(30_000);
      fill(reg, 300, 'live');
      vi.advanceTimersByTime(31_000);
      fill(reg, 1, 'trigger');
      expect(reg.add(input({ peerIp: 'live-0' }))).toEqual({ ok: false, reason: 'rate' });
    });
  });

  describe('onChange failures', () => {
    const boom = () => { throw new Error('boom'); };

    it('keeps the entry registered and cancellable when onChange throws during add', async () => {
      const reg = new PendingRegistry({ onChange: boom });
      const r = reg.add(input());
      if (!r.ok) throw new Error('add failed');
      expect(reg.list()).toEqual([r.entry]);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('boom'));
      r.cancel();
      await expect(r.decision).resolves.toBe('cancelled');
      expect(reg.list()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles and removes the entry when onChange throws during resolve', async () => {
      const reg = new PendingRegistry({ onChange: boom });
      const r = reg.add(input());
      if (!r.ok) throw new Error('add failed');
      expect(() => reg.resolve(r.entry.requestId, 'approved')).not.toThrow();
      await expect(r.decision).resolves.toBe('approved');
      expect(reg.list()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not throw out of the timeout callback when onChange throws', async () => {
      const reg = new PendingRegistry({ onChange: boom });
      const r = reg.add(input());
      if (!r.ok) throw new Error('add failed');
      expect(() => vi.advanceTimersByTime(5 * 60_000 + 1)).not.toThrow();
      await expect(r.decision).resolves.toBe('timeout');
      expect(reg.list()).toEqual([]);
    });
  });

  it('stop latches: later adds are refused and create no timer', () => {
    const reg = new PendingRegistry();
    reg.stop();
    expect(reg.add(input())).toEqual({ ok: false, reason: 'cap' });
    expect(reg.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
