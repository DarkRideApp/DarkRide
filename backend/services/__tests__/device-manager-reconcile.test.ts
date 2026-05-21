import { describe, it, expect, vi } from 'vitest';
import { reconcileWithProviders } from '../device-manager-reconcile';
import type { ProviderRegistry } from '../providers';

function makeMockRepo(rows: any[] = []) {
  const data = new Map(rows.map((r) => [r.id, r]));
  let nextId = Math.max(0, ...rows.map((r) => r.id)) + 1;
  return {
    insert: vi.fn().mockImplementation((input) => {
      const id = nextId++;
      const row = { id, ...input };
      data.set(id, row);
      return row;
    }),
    updateState: vi.fn().mockImplementation((id, state) => {
      const r = data.get(id);
      if (r) r.state = state;
    }),
    listAll: vi.fn().mockReturnValue(rows),
    listByProvider: vi.fn(),
    getById: vi.fn().mockImplementation((id) => data.get(id)),
    delete: vi.fn(),
  } as any;
}

function makeMockRegistry(instancesByProvider: Record<string, any[]>): ProviderRegistry {
  return {
    list: vi.fn().mockReturnValue(Object.keys(instancesByProvider).map((id) => ({ id }))),
    get: vi.fn(),
    register: vi.fn(),
    listInstancesAll: vi.fn().mockResolvedValue(
      Object.entries(instancesByProvider).flatMap(([providerId, instances]) =>
        instances.map((instance) => ({ providerId, instance })),
      ),
    ),
  } as any;
}

describe('reconcileWithProviders', () => {
  it('Case A: in DB, not in provider → mark stopped', async () => {
    const repo = makeMockRepo([
      { id: 1, providerId: 'docker-android', runtimeId: 'gone', state: 'running', spawnedByDarkride: true },
    ]);
    const reg = makeMockRegistry({ 'docker-android': [] });
    await reconcileWithProviders(reg, repo);
    expect(repo.updateState).toHaveBeenCalledWith(1, 'stopped');
  });

  it('Case B: in provider, not in DB → insert (BYOE auto-discovery)', async () => {
    const repo = makeMockRepo([]);
    const reg = makeMockRegistry({
      'adb-device': [
        { id: 'NEWSERIAL', displayName: 'NEWSERIAL', serial: 'NEWSERIAL', state: 'running', spawnedByDarkride: false },
      ],
    });
    await reconcileWithProviders(reg, repo);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'adb-device',
      runtimeId: 'NEWSERIAL',
      serial: 'NEWSERIAL',
      state: 'running',
      spawnedByDarkride: false,
    }));
  });

  it('Case C: state mismatch → update', async () => {
    const repo = makeMockRepo([
      { id: 1, providerId: 'docker-android', runtimeId: 'abc', state: 'stopped', spawnedByDarkride: true },
    ]);
    const reg = makeMockRegistry({
      'docker-android': [
        { id: 'abc', displayName: 'abc', state: 'running', serial: 'localhost:5556', spawnedByDarkride: true },
      ],
    });
    await reconcileWithProviders(reg, repo);
    expect(repo.updateState).toHaveBeenCalledWith(1, 'running');
  });

  it('matches DB rows to provider instances by (providerId, runtimeId) — NOT by id', async () => {
    // DB internal id is unrelated to provider runtime id.
    const repo = makeMockRepo([
      { id: 42, providerId: 'avd', runtimeId: 'Pixel_8', state: 'stopped', spawnedByDarkride: true },
    ]);
    const reg = makeMockRegistry({
      'avd': [{ id: 'Pixel_8', displayName: 'Pixel 8', state: 'running', spawnedByDarkride: true }],
    });
    await reconcileWithProviders(reg, repo);
    expect(repo.updateState).toHaveBeenCalledWith(42, 'running');
  });
});
