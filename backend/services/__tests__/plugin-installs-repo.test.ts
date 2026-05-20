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
      auth_token TEXT,
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
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'git+https://e.com/x.git', resolvedRef: 'abc123', sourceId: 5, authToken: null });
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'git+https://e.com/x.git', resolvedRef: 'abc123', sourceId: 5, authToken: null });
    expect(all[0].installedAt).toBeGreaterThan(0);
  });

  it('record with null resolvedRef + sourceId is allowed', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: '@x/p', resolvedRef: null, sourceId: null, authToken: null });
    expect(repo.getAll()[0]).toMatchObject({ resolvedRef: null, sourceId: null, authToken: null });
  });

  it('record is upsert (re-record same name updates row)', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u1', resolvedRef: 'a', sourceId: 1, authToken: null });
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u2', resolvedRef: 'b', sourceId: 2, authToken: null });
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sourceUrl: 'u2', resolvedRef: 'b', sourceId: 2, authToken: null });
  });

  it('remove deletes the row', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u', resolvedRef: null, sourceId: null, authToken: null });
    repo.remove('@x/p');
    expect(repo.getAll()).toHaveLength(0);
  });

  it('remove on a nonexistent name is a no-op', () => {
    const repo = new PluginInstallsRepo(makeDb());
    expect(() => repo.remove('does-not-exist')).not.toThrow();
  });

  it('persists authToken so replay-on-boot can re-authenticate', () => {
    // Tokens captured at install time must round-trip through the row
    // so a server restart can re-authenticate against private repos
    // even when the originating source row has been deleted, or there
    // was no sourceId in the first place (raw installUrl).
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({
      name: '@x/p',
      npmPackage: '@x/p',
      sourceUrl: 'git+https://private.example.com/x.git',
      resolvedRef: null,
      sourceId: null,                  // no named source — direct install
      authToken: 'ghp_persisted-token',
    });
    expect(repo.getAll()[0]).toMatchObject({ authToken: 'ghp_persisted-token' });
  });

  it('persists null authToken when no auth was used', () => {
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u', resolvedRef: null, sourceId: null, authToken: null });
    expect(repo.getAll()[0].authToken).toBeNull();
  });

  it('upserting an existing row updates the authToken', () => {
    // Credential rotation: re-install (or re-record) overwrites the
    // previously stored token. Replay-on-boot then uses the fresh one.
    const repo = new PluginInstallsRepo(makeDb());
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u', resolvedRef: null, sourceId: null, authToken: 'old-token' });
    repo.record({ name: '@x/p', npmPackage: '@x/p', sourceUrl: 'u', resolvedRef: null, sourceId: null, authToken: 'new-token' });
    expect(repo.getAll()[0].authToken).toBe('new-token');
  });

  it('getMissingDirs returns rows whose <root>/<npmPackage>/ does not exist', () => {
    const repo = new PluginInstallsRepo(makeDb());
    mkdirSync(join(tmp, 'node_modules', '@x', 'present'), { recursive: true });
    repo.record({ name: 'present-runtime', npmPackage: '@x/present', sourceUrl: 'u', resolvedRef: null, sourceId: null, authToken: null });
    repo.record({ name: 'absent-runtime',  npmPackage: '@x/absent',  sourceUrl: 'u', resolvedRef: null, sourceId: null, authToken: null });

    const missing = repo.getMissingDirs(join(tmp, 'node_modules'));
    expect(missing.map(r => r.name)).toEqual(['absent-runtime']);
  });
});
