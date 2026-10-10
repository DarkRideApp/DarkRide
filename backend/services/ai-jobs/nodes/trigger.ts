import { eq } from 'drizzle-orm';
import { apkVersions, trackedApps } from '../../../db/schema';
import type { AppDatabase } from '../../../db/index';

export interface TriggerCtx {
  db: AppDatabase;
}

export type TriggerExpander = (rawInput: Record<string, unknown>, ctx: TriggerCtx) => Promise<Record<string, unknown>>;

export const TRIGGER_REGISTRY: Record<string, TriggerExpander> = {};

export function registerTrigger(name: string, fn: TriggerExpander): void {
  TRIGGER_REGISTRY[name] = fn;
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
});
