import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { PluginStateManager } from './plugin-state-manager';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

describe('PluginStateManager', () => {
  let db: ReturnType<typeof createTestDb>;
  let manager: PluginStateManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PluginStateManager(db);
  });

  it('reconcile creates entries for newly discovered plugins', () => {
    manager.reconcile([
      { name: 'plugin-a', version: '1.0.0', source: 'workspace' },
      { name: 'plugin-b', version: '2.0.0', source: 'npm', npmPackage: '@org/plugin-b' },
    ]);

    const all = manager.getAll();
    expect(all).toHaveLength(2);
    expect(all.find(p => p.name === 'plugin-a')).toMatchObject({
      name: 'plugin-a',
      version: '1.0.0',
      installedVia: 'workspace',
      enabled: true,
    });
    expect(all.find(p => p.name === 'plugin-b')).toMatchObject({
      name: 'plugin-b',
      version: '2.0.0',
      installedVia: 'npm',
      npmPackage: '@org/plugin-b',
      enabled: true,
    });
  });

  it('reconcile preserves enabled=false for known plugins', () => {
    manager.reconcile([{ name: 'plugin-a', version: '1.0.0', source: 'workspace' }]);
    manager.setEnabled('plugin-a', false);

    manager.reconcile([{ name: 'plugin-a', version: '1.1.0', source: 'workspace' }]);

    const row = manager.get('plugin-a');
    expect(row?.enabled).toBe(false);
    expect(row?.version).toBe('1.1.0');
  });

  it('reconcile marks missing plugins as missing', () => {
    manager.reconcile([
      { name: 'plugin-a', version: '1.0.0', source: 'workspace' },
      { name: 'plugin-b', version: '2.0.0', source: 'workspace' },
    ]);

    // Second reconcile with only plugin-b present
    manager.reconcile([{ name: 'plugin-b', version: '2.0.0', source: 'workspace' }]);

    const rowA = manager.get('plugin-a');
    expect(rowA?.installedVia).toBe('missing');
  });

  it('isEnabled returns true by default', () => {
    manager.reconcile([{ name: 'plugin-a', version: '1.0.0', source: 'workspace' }]);
    expect(manager.isEnabled('plugin-a')).toBe(true);
  });

  it('isEnabled returns false after disable', () => {
    manager.reconcile([{ name: 'plugin-a', version: '1.0.0', source: 'workspace' }]);
    manager.setEnabled('plugin-a', false);
    expect(manager.isEnabled('plugin-a')).toBe(false);
  });

  it('isEnabled returns false for unknown plugins', () => {
    expect(manager.isEnabled('nonexistent-plugin')).toBe(false);
  });

  it('remove deletes the state entry', () => {
    manager.reconcile([{ name: 'plugin-a', version: '1.0.0', source: 'workspace' }]);
    expect(manager.get('plugin-a')).toBeDefined();

    manager.remove('plugin-a');
    expect(manager.get('plugin-a')).toBeUndefined();
  });

  it('upsert creates or updates a plugin entry', () => {
    manager.upsert({ name: 'plugin-c', version: '3.0.0', source: 'manual' });
    expect(manager.get('plugin-c')).toMatchObject({
      name: 'plugin-c',
      version: '3.0.0',
      installedVia: 'manual',
    });

    manager.upsert({ name: 'plugin-c', version: '3.1.0', source: 'manual', description: 'Updated' });
    const row = manager.get('plugin-c');
    expect(row?.version).toBe('3.1.0');
    expect(row?.description).toBe('Updated');
  });

  describe('defaultEnabled for new plugins', () => {
    it('inserts managed plugins enabled by default', () => {
      // Marketplace installs auto-enable — the user explicitly clicked
      // "Install" so requiring a separate "Enable" click is friction.
      manager.reconcile([{ name: 'p', version: '1', source: 'managed' }]);
      expect(manager.get('p')?.enabled).toBe(true);
    });

    it('inserts workspace plugins enabled by default', () => {
      manager.reconcile([{ name: 'p', version: '1', source: 'workspace' }]);
      expect(manager.get('p')?.enabled).toBe(true);
    });

    it('inserts npm plugins enabled by default', () => {
      manager.reconcile([{ name: 'p', version: '1', source: 'npm' }]);
      expect(manager.get('p')?.enabled).toBe(true);
    });
  });

  describe('upsertManagedPending', () => {
    it('creates a row with installedVia=managed, enabled=true, and npmPackage set', () => {
      manager.upsertManagedPending('test-plugin', '@x/p', 5);
      const row = manager.get('test-plugin')!;
      expect(row.installedVia).toBe('managed');
      expect(row.enabled).toBe(true);
      expect(row.npmPackage).toBe('@x/p');
    });

    it('preserves existing enabled state on re-install', () => {
      manager.upsertManagedPending('test-plugin', '@x/p', 5);
      manager.setEnabled('test-plugin', true);
      manager.upsertManagedPending('test-plugin', '@x/p', 5);
      expect(manager.get('test-plugin')?.enabled).toBe(true);
      expect(manager.get('test-plugin')?.npmPackage).toBe('@x/p');
    });
  });
});
