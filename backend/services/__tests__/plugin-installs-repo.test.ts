import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { PluginInstallsRepo } from '../plugin-installs-repo';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE plugin_installs (
      name TEXT PRIMARY KEY NOT NULL,
      npm_package TEXT NOT NULL,
      source_url TEXT NOT NULL,
      resolved_ref TEXT,
      source_id INTEGER,
      installed_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('PluginInstallsRepo', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'plugin-installs-')); });

  it('records a new install', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'git+https://e.com/x.git', resolvedRef: 'abc123', sourceId: 5 });
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'git+https://e.com/x.git', resolvedRef: 'abc123', sourceId: 5 });
    expect(all[0].installedAt).toBeGreaterThan(0);
  });

  it('record with null resolvedRef + sourceId is allowed', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: '@x/p', resolvedRef: null, sourceId: null });
    expect(repo.getAll()[0]).toMatchObject({ resolvedRef: null, sourceId: null });
  });

  it('record is upsert (re-record same name updates row)', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u1', resolvedRef: 'a', sourceId: 1 });
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u2', resolvedRef: 'b', sourceId: 2 });
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sourceUrl: 'u2', resolvedRef: 'b', sourceId: 2 });
  });

  it('remove deletes the row', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u', resolvedRef: null, sourceId: null });
    repo.remove('@x/p');
    expect(repo.getAll()).toHaveLength(0);
  });

  it('remove on a nonexistent name is a no-op', () => {
    const repo = new PluginInstallsRepo(makeDb());
    expect(() => repo.remove('does-not-exist')).not.toThrow();
  });

  it('getMissingDirs returns rows whose <root>/<npmPackage>/ does not exist', () => {
    const repo = new PluginInstallsRepo(makeDb());
    mkdirSync(join(tmp, 'node_modules', '@x', 'present'), { recursive: true });
    repo.record({ name: 'present-runtime', npmPackage: '@x/present', sourceUrl: 'u', resolvedRef: null, sourceId: null });
    repo.record({ name: 'absent-runtime',  npmPackage: '@x/absent',  sourceUrl: 'u', resolvedRef: null, sourceId: null });

    const missing = repo.getMissingDirs(join(tmp, 'node_modules'));
    expect(missing.map(r => r.name)).toEqual(['absent-runtime']);
  });
});
