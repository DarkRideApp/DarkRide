import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../../db/schema';
import { createSettingsApi } from '../settings-api';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('SettingsApi', () => {
  it('set + get round-trip', async () => {
    const api = createSettingsApi(makeDb());
    await api.set('foo', 'bar');
    expect(await api.get('foo')).toBe('bar');
  });

  it('get returns null for missing key', async () => {
    const api = createSettingsApi(makeDb());
    expect(await api.get('absent')).toBeNull();
  });

  it('setJson + getJson round-trip', async () => {
    const api = createSettingsApi(makeDb());
    await api.setJson('cfg', { a: 1, b: 'two' });
    expect(await api.getJson<{ a: number; b: string }>('cfg')).toEqual({ a: 1, b: 'two' });
  });

  it('getJson returns null for missing key', async () => {
    const api = createSettingsApi(makeDb());
    expect(await api.getJson('absent')).toBeNull();
  });

  it('delete removes the row', async () => {
    const api = createSettingsApi(makeDb());
    await api.set('foo', 'bar');
    await api.delete('foo');
    expect(await api.get('foo')).toBeNull();
  });

  it('list with prefix returns matching pairs', async () => {
    const api = createSettingsApi(makeDb());
    await api.set('plugin.foo.a', '1');
    await api.set('plugin.foo.b', '2');
    await api.set('plugin.bar.x', 'X');
    const result = await api.list('plugin.foo.');
    expect(result).toHaveLength(2);
    expect(result.find(r => r.key === 'plugin.foo.a')?.value).toBe('1');
  });

  it('list without prefix returns all rows', async () => {
    const api = createSettingsApi(makeDb());
    await api.set('a', '1');
    await api.set('b', '2');
    expect(await api.list()).toHaveLength(2);
  });
});
