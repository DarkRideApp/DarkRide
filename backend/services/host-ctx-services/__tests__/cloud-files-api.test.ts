import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../../db/schema';
import { createCloudFilesApi } from '../cloud-files-api';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE cloud_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      cloud_key TEXT NOT NULL UNIQUE,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sync_state TEXT NOT NULL,
      sync_error TEXT,
      retain INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('CloudFilesApi', () => {
  it('upsertByCloudKey creates a new row', async () => {
    const api = createCloudFilesApi(makeDb());
    await api.upsertByCloudKey({
      cloudKey: 'k', namespace: 'plugin-x',
      relativePath: 'a/b.txt', fileType: 'text/plain', fileSize: 100,
      syncState: 'cloud_only',
    });
    const rows = await api.listByNamespace('plugin-x');
    expect(rows).toHaveLength(1);
    expect(rows[0].cloudKey).toBe('k');
  });

  it('upsertByCloudKey updates if cloud_key already exists', async () => {
    const api = createCloudFilesApi(makeDb());
    await api.upsertByCloudKey({
      cloudKey: 'k', namespace: 'p', relativePath: 'a', fileType: 't', fileSize: 1,
      syncState: 'cloud_only', retain: false,
    });
    await api.upsertByCloudKey({
      cloudKey: 'k', namespace: 'p', relativePath: 'a', fileType: 't', fileSize: 1,
      syncState: 'cloud_only', retain: true,
    });
    const rows = await api.listByNamespace('p');
    expect(rows).toHaveLength(1);
    expect(rows[0].retain).toBe(true);
  });

  it('listByNamespace filters retain', async () => {
    const api = createCloudFilesApi(makeDb());
    const base = { fileType: 't', fileSize: 1, syncState: 'cloud_only' as const, namespace: 'p', relativePath: 'r' };
    await api.upsertByCloudKey({ ...base, cloudKey: 'keep', retain: true });
    await api.upsertByCloudKey({ ...base, cloudKey: 'stale', retain: false });
    const stale = await api.listByNamespace('p', { retain: false });
    expect(stale.map(r => r.cloudKey)).toEqual(['stale']);
  });

  it('setSyncState updates the row', async () => {
    const api = createCloudFilesApi(makeDb());
    await api.upsertByCloudKey({
      cloudKey: 'k', namespace: 'p', relativePath: 'r', fileType: 't', fileSize: 1, syncState: 'cloud_only',
    });
    const [row] = await api.listByNamespace('p');
    await api.setSyncState(row.id, 'local');
    const [updated] = await api.listByNamespace('p');
    expect(updated.syncState).toBe('local');
  });

  it('delete removes the row', async () => {
    const api = createCloudFilesApi(makeDb());
    await api.upsertByCloudKey({
      cloudKey: 'k', namespace: 'p', relativePath: 'r', fileType: 't', fileSize: 1, syncState: 'cloud_only',
    });
    const [row] = await api.listByNamespace('p');
    await api.delete(row.id);
    expect(await api.listByNamespace('p')).toHaveLength(0);
  });
});
