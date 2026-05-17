import type { ApkApi, ApkHandle, ApkVersionMeta } from '@darkrideapp/plugin-sdk';

/**
 * ApkApi — thin wrapper over host APK utilities.
 *
 * Signature notes for Task 12 production wiring:
 *
 * - `lookupVersionMeta`: the real host function is
 *   `lookupVersionMeta(db, versionId): VersionMeta | null` (sync, not async)
 *   from `backend/utils/apk-paths.ts`. Bind `db` at construction and wrap
 *   in `Promise.resolve()`. The host's `VersionMeta` shape is not identical to
 *   `ApkVersionMeta` — it lacks `versionId` and has extra fields. Map as:
 *     { versionId, packageName, versionName: meta.versionName ?? '', versionCode: meta.versionCode }
 *
 * - `ensureApkLocal`: the real host function is
 *   `ensureApkLocal(packageName, filename, fileSync, holder)` (from apk-paths.ts).
 *   In Task 12, bind db+fileSync at construction and resolve the handle from
 *   versionId internally. Return the resolved local path string on success.
 *
 * - `analysisDbPath`: the real host function is
 *   `analysisDbPath(packageName, versionCode)` (from apk-paths.ts).
 *   In Task 12, bind db at construction and resolve packageName+versionCode
 *   from the ApkHandle's versionId.
 */
export interface ApkDeps {
  lookupVersionMeta: (versionId: number) => Promise<ApkVersionMeta | null>;
  ensureApkLocal: (handle: ApkHandle) => Promise<string>;
  analysisDbPath: (handle: ApkHandle) => string;
}

export function createApkApi(deps: ApkDeps): ApkApi {
  return {
    lookupVersion: deps.lookupVersionMeta,
    ensureLocal: deps.ensureApkLocal,
    analysisDbPath: deps.analysisDbPath,
  };
}
