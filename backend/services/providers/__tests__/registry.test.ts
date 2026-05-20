import { describe, it, expect, vi } from 'vitest';
import { createProviderRegistry } from '../index';
import type { DeviceProvider, DeviceProviderInstance } from '@darkrideapp/plugin-sdk';

function makeMockProvider(id: string, overrides: Partial<DeviceProvider> = {}): DeviceProvider {
  return {
    id,
    displayName: `Mock ${id}`,
    isAvailable: vi.fn().mockResolvedValue({ available: true }),
    listInstances: vi.fn().mockResolvedValue([]),
    startInstance: vi.fn() as DeviceProvider['startInstance'],
    stopInstance: vi.fn() as DeviceProvider['stopInstance'],
    getNetworkConfig: () => ({ mode: 'wireguard' }),
    ...overrides,
  };
}

describe('createProviderRegistry', () => {
  it('register + get returns the same instance', () => {
    const reg = createProviderRegistry();
    const p = makeMockProvider('test');
    reg.register(p);
    expect(reg.get('test')).toBe(p);
  });

  it('list returns providers in registration order', () => {
    const reg = createProviderRegistry();
    const a = makeMockProvider('a');
    const b = makeMockProvider('b');
    reg.register(a);
    reg.register(b);
    expect(reg.list().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('registering an id twice throws (provider IDs must be unique)', () => {
    const reg = createProviderRegistry();
    reg.register(makeMockProvider('dup'));
    expect(() => reg.register(makeMockProvider('dup'))).toThrow(/already registered/i);
  });

  it('get on an unknown id returns undefined (caller decides whether to throw)', () => {
    const reg = createProviderRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('listInstancesAll aggregates listInstances() across all registered providers', async () => {
    const reg = createProviderRegistry();
    const a = makeMockProvider('a', {
      listInstances: vi.fn().mockResolvedValue([{ id: 'a1', displayName: 'A1', state: 'running', spawnedByDarkride: false }]),
    });
    const b = makeMockProvider('b', {
      listInstances: vi.fn().mockResolvedValue([{ id: 'b1', displayName: 'B1', state: 'stopped', spawnedByDarkride: true }]),
    });
    reg.register(a); reg.register(b);
    const all = await reg.listInstancesAll();
    expect(all).toEqual([
      { providerId: 'a', instance: { id: 'a1', displayName: 'A1', state: 'running', spawnedByDarkride: false } },
      { providerId: 'b', instance: { id: 'b1', displayName: 'B1', state: 'stopped', spawnedByDarkride: true } },
    ]);
  });

  it('listInstancesAll continues past a single provider failure (one bad provider does not break the others)', async () => {
    const reg = createProviderRegistry();
    const a = makeMockProvider('a', { listInstances: vi.fn().mockRejectedValue(new Error('boom')) });
    const b = makeMockProvider('b', {
      listInstances: vi.fn().mockResolvedValue([{ id: 'b1', displayName: 'B1', state: 'running', spawnedByDarkride: false }]),
    });
    reg.register(a); reg.register(b);
    const all = await reg.listInstancesAll();
    expect(all).toEqual([
      { providerId: 'b', instance: { id: 'b1', displayName: 'B1', state: 'running', spawnedByDarkride: false } },
    ]);
  });

  it('listInstancesAll isolates a provider that throws synchronously (not just rejects)', async () => {
    // Defends against future refactors that drop the `async` wrapper in
    // the map callback — a sync throw would then leak past Promise.allSettled
    // and break the failure-isolation guarantee. A realistic failure mode:
    // a provider whose listInstances checks a prerequisite eagerly
    // (e.g. `if (!this.adbPath) throw ...`) before returning a promise.
    const reg = createProviderRegistry();
    const a = makeMockProvider('a', {
      listInstances: vi.fn().mockImplementation(() => { throw new Error('sync-boom'); }),
    });
    const b = makeMockProvider('b', {
      listInstances: vi.fn().mockResolvedValue([{ id: 'b1', displayName: 'B1', state: 'running', spawnedByDarkride: false }]),
    });
    reg.register(a); reg.register(b);
    const all = await reg.listInstancesAll();
    expect(all).toEqual([
      { providerId: 'b', instance: { id: 'b1', displayName: 'B1', state: 'running', spawnedByDarkride: false } },
    ]);
  });
});
