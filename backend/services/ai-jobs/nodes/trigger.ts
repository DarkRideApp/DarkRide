import { eq } from 'drizzle-orm';
import { apkVersions, trackedApps } from '../../../db/schema';
import type { AppDatabase } from '../../../db/index';
import type { SchemaField } from '../types';

export interface TriggerCtx {
  db: AppDatabase;
}

export type TriggerExpander = (rawInput: Record<string, unknown>, ctx: TriggerCtx) => Promise<Record<string, unknown>>;

export const TRIGGER_REGISTRY: Record<string, TriggerExpander> = Object.create(null);
/** Human-readable "what this trigger does" text per registered expand function, for the editor UI. */
export const TRIGGER_DESCRIPTIONS: Record<string, string> = Object.create(null);
/**
 * The real, machine-checkable contract per registered expand function: what run parameters it
 * reads from rawInput, and what fields it returns. The one source of truth the editor's "Starts
 * from" picker populates a node's Run Parameters/Output Schema from — never hand-duplicated
 * elsewhere, so they can't silently drift from what the function underneath actually does (as
 * apk-analysis-pipeline.ts's old APK_TRIGGER_INPUT_SCHEMA/APK_CONTEXT_SCHEMA constants did).
 */
export const TRIGGER_SCHEMAS: Record<string, { inputSchema: SchemaField[]; outputSchema: SchemaField[] }> = Object.create(null);

export function registerTrigger(
  name: string, fn: TriggerExpander, description: string,
  schema: { inputSchema: SchemaField[]; outputSchema: SchemaField[] },
): void {
  TRIGGER_REGISTRY[name] = fn;
  TRIGGER_DESCRIPTIONS[name] = description;
  TRIGGER_SCHEMAS[name] = schema;
}

registerTrigger('apk-analysis/apk-context', async (rawInput, ctx) => {
  const versionId = rawInput.versionId;
  if (typeof versionId !== 'number') {
    throw new Error(`apk-analysis/apk-context Trigger requires a numeric "versionId" in its input, got ${JSON.stringify(rawInput)}`);
  }
  const row = ctx.db
    .select({
      appName: trackedApps.appName,
      packageName: trackedApps.packageName,
      versionName: apkVersions.versionName,
      versionCode: apkVersions.versionCode,
      fileSizeBytes: apkVersions.fileSize,
      downloadedAt: apkVersions.downloadedAt,
      source: apkVersions.source,
    })
    .from(apkVersions)
    .innerJoin(trackedApps, eq(apkVersions.trackedAppId, trackedApps.id))
    .where(eq(apkVersions.id, versionId))
    .all()[0];

  if (!row) throw new Error(`apk-analysis/apk-context Trigger: no apk_versions row for versionId ${versionId}`);

  return {
    appName: row.appName,
    packageName: row.packageName,
    versionName: row.versionName,
    versionCode: row.versionCode,
    fileSizeBytes: row.fileSizeBytes,
    downloadedAt: row.downloadedAt instanceof Date ? row.downloadedAt.toISOString() : row.downloadedAt,
    source: row.source,
  };
}, 'Looks up a tracked APK version by id and expands it into app name, package, version, size, and source fields.', {
  inputSchema: [
    { field: 'versionId', type: 'apk-version', description: 'Which analyzed APK version to run against' },
  ],
  outputSchema: [
    { field: 'appName', type: 'string', description: 'Display name' },
    { field: 'packageName', type: 'string', description: 'Reverse-DNS package name' },
    { field: 'versionName', type: 'string', description: 'Human version string' },
    { field: 'versionCode', type: 'number', description: 'Numeric version code' },
    { field: 'fileSizeBytes', type: 'number', description: 'APK file size in bytes' },
    { field: 'downloadedAt', type: 'string', description: 'ISO timestamp' },
    { field: 'source', type: 'string', description: "'device' | 'playstore' | 'qq' | 'upload'" },
  ],
});
