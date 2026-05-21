import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { DeviceInstancesRepo } from '../device-instances-repo';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE device_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      display_name TEXT,
      serial TEXT,
      state TEXT NOT NULL,
      spawned_by_darkride INTEGER NOT NULL DEFAULT 0,
      spawn_metadata TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      last_state_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('DeviceInstancesRepo', () => {
  let repo: DeviceInstancesRepo;
  beforeEach(() => { repo = new DeviceInstancesRepo(makeDb()); });

  it('insert + getById round-trip', () => {
    const created = repo.insert({
      providerId: 'docker-android',
      runtimeId: 'abc123',
      displayName: 'test-emulator',
      state: 'created',
      spawnedByDarkride: true,
      spawnMetadata: { image: 'docker-android:14', port: 5556 },
    });
    expect(created.id).toBeGreaterThan(0);
    const r = repo.getById(created.id);
    expect(r).toMatchObject({
      providerId: 'docker-android',
      runtimeId: 'abc123',
      state: 'created',
      spawnedByDarkride: true,
      spawnMetadata: { image: 'docker-android:14', port: 5556 },
    });
  });

  it('updateState transitions + bumps last_state_at + sets last_error when state=error', async () => {
    const inst = repo.insert({ providerId: 'avd', runtimeId: 'avd-1', state: 'created', spawnedByDarkride: true });
    const before = repo.getById(inst.id)!.lastStateAt;
    // tiny delay to ensure timestamp advances (Drizzle stores seconds in some configs)
    await new Promise(r => setTimeout(r, 1100));

    repo.updateState(inst.id, 'error', 'AVD failed to boot');
    const after = repo.getById(inst.id)!;
    expect(after.state).toBe('error');
    expect(after.lastError).toBe('AVD failed to boot');
    expect(after.lastStateAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('updateState to a non-error state clears last_error', () => {
    const inst = repo.insert({ providerId: 'avd', runtimeId: 'avd-1', state: 'error', spawnedByDarkride: true });
    repo.updateState(inst.id, 'error', 'first failure');
    repo.updateState(inst.id, 'running');
    expect(repo.getById(inst.id)!.lastError).toBeNull();
  });

  it('listByProvider returns only rows for the given provider', () => {
    repo.insert({ providerId: 'docker-android', runtimeId: 'd1', state: 'running', spawnedByDarkride: true });
    repo.insert({ providerId: 'avd', runtimeId: 'a1', state: 'running', spawnedByDarkride: true });
    repo.insert({ providerId: 'docker-android', runtimeId: 'd2', state: 'stopped', spawnedByDarkride: true });
    expect(repo.listByProvider('docker-android').map((r) => r.runtimeId).sort()).toEqual(['d1', 'd2']);
    expect(repo.listByProvider('avd').map((r) => r.runtimeId)).toEqual(['a1']);
  });

  it('listAll returns rows across every provider', () => {
    repo.insert({ providerId: 'docker-android', runtimeId: 'd1', state: 'running', spawnedByDarkride: true });
    repo.insert({ providerId: 'avd', runtimeId: 'a1', state: 'running', spawnedByDarkride: true });
    expect(repo.listAll()).toHaveLength(2);
  });

  it('delete removes the row', () => {
    const inst = repo.insert({ providerId: 'avd', runtimeId: 'a1', state: 'stopped', spawnedByDarkride: true });
    repo.delete(inst.id);
    expect(repo.getById(inst.id)).toBeUndefined();
  });
});
