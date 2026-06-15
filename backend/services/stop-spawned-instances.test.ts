import { describe, it, expect, vi } from 'vitest';
import { stopSpawnedInstances } from './stop-spawned-instances';

describe('stopSpawnedInstances', () => {
  it('stops only darkride-spawned running instances', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const registry = { get: () => ({ stopInstance: stop }) } as any;
    const repo = { listAll: () => [
      { id: 1, providerId: 'docker-android', runtimeId: 'c1', state: 'running', spawnedByDarkride: true },
      { id: 2, providerId: 'adb-device', runtimeId: '', state: 'running', spawnedByDarkride: false },
      { id: 3, providerId: 'docker-android', runtimeId: 'c3', state: 'stopped', spawnedByDarkride: true },
    ] } as any;
    await stopSpawnedInstances(registry, repo);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('c1');
  });

  it('continues stopping when one instance fails', async () => {
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const registry = { get: () => ({ stopInstance: stop }) } as any;
    const repo = { listAll: () => [
      { id: 1, providerId: 'docker-android', runtimeId: 'c1', state: 'running', spawnedByDarkride: true },
      { id: 2, providerId: 'docker-android', runtimeId: 'c2', state: 'running', spawnedByDarkride: true },
    ] } as any;
    await expect(stopSpawnedInstances(registry, repo)).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
