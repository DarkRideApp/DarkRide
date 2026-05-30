import { describe, it, expect } from 'vitest';
import { createInMemoryDocStore } from '../in-memory-doc-store';

describe('createInMemoryDocStore', () => {
  it('getDoc returns null for an absent key', async () => {
    const ds = createInMemoryDocStore();
    expect(await ds.getDoc('nope')).toBeNull();
  });

  it('round-trips a put value', async () => {
    const ds = createInMemoryDocStore();
    await ds.putDoc('k', { a: 1 });
    expect(await ds.getDoc('k')).toEqual({ a: 1 });
  });

  it('JSON-serialises on put so non-serialisable values reject', async () => {
    const ds = createInMemoryDocStore();
    const circular: any = {}; circular.self = circular;
    await expect(ds.putDoc('k', circular)).rejects.toThrow();
  });

  it('last-write-wins', async () => {
    const ds = createInMemoryDocStore();
    await ds.putDoc('k', { v: 1 });
    await ds.putDoc('k', { v: 2 });
    expect(await ds.getDoc('k')).toEqual({ v: 2 });
  });

  it('exposes _store and clear() for assertions/isolation', async () => {
    const ds = createInMemoryDocStore();
    await ds.putDoc('k', { v: 1 });
    expect(ds._store.has('k')).toBe(true);
    ds.clear();
    expect(ds._store.size).toBe(0);
    expect(await ds.getDoc('k')).toBeNull();
  });

  it('rejects keys prod would reject (parity with the host adapter)', async () => {
    const ds = createInMemoryDocStore();
    await expect(ds.putDoc('', { v: 1 })).rejects.toThrow('non-empty string');
    await expect(ds.putDoc('has space', { v: 1 })).rejects.toThrow('whitespace or control');
    await expect(ds.getDoc('x'.repeat(257))).rejects.toThrow('256 bytes');
    // a valid key with hyphen/underscore is NOT rejected
    await expect(ds.putDoc('genting-skyworlds_token', { v: 1 })).resolves.toBeUndefined();
  });
});
