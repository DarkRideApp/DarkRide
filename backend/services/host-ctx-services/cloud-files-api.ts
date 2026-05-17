import { and, eq, lt } from 'drizzle-orm';
import type { CloudFilesApi, CloudFileRow } from '@darkrideapp/plugin-sdk';
import type { AppDatabase } from '../../db/index';
import { cloudFiles } from '../../db/schema';

export function createCloudFilesApi(db: AppDatabase): CloudFilesApi {
  return {
    async listByNamespace(namespace, filter) {
      const conditions = [eq(cloudFiles.namespace, namespace)];
      if (filter?.retain !== undefined) {
        conditions.push(eq(cloudFiles.retain, filter.retain));
      }
      if (filter?.beforeCreatedAt !== undefined) {
        conditions.push(lt(cloudFiles.createdAt, filter.beforeCreatedAt));
      }
      const rows = db.select().from(cloudFiles).where(and(...conditions)).all();
      return rows.map(toCloudFileRow);
    },

    async setSyncState(id, state) {
      db.update(cloudFiles).set({ syncState: state }).where(eq(cloudFiles.id, id)).run();
    },

    async setSyncError(id, error) {
      db.update(cloudFiles).set({ syncError: error }).where(eq(cloudFiles.id, id)).run();
    },

    async setRetain(id, retain) {
      db.update(cloudFiles).set({ retain }).where(eq(cloudFiles.id, id)).run();
    },

    async delete(id) {
      db.delete(cloudFiles).where(eq(cloudFiles.id, id)).run();
    },

    async upsertByCloudKey(record) {
      const now = new Date();
      const lastAccessed = record.lastAccessed ?? now;
      db.insert(cloudFiles)
        .values({
          cloudKey: record.cloudKey,
          namespace: record.namespace,
          relativePath: record.relativePath,
          fileType: record.fileType,
          fileSize: record.fileSize,
          syncState: record.syncState,
          syncError: record.syncError ?? null,
          retain: record.retain ?? false,
          lastAccessed,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: cloudFiles.cloudKey,
          set: {
            namespace: record.namespace,
            relativePath: record.relativePath,
            fileType: record.fileType,
            fileSize: record.fileSize,
            syncState: record.syncState,
            syncError: record.syncError ?? null,
            retain: record.retain ?? false,
            lastAccessed,
          },
        })
        .run();
    },
  };
}

function toCloudFileRow(row: any): CloudFileRow {
  return {
    id: row.id,
    namespace: row.namespace,
    relativePath: row.relativePath,
    cloudKey: row.cloudKey,
    fileType: row.fileType,
    fileSize: row.fileSize,
    syncState: row.syncState,
    syncError: row.syncError ?? null,
    retain: !!row.retain,
    lastAccessed: row.lastAccessed,
    createdAt: row.createdAt,
  };
}
