import fs from 'fs';
import os from 'os';
import path from 'path';
import multer, { MulterError } from 'multer';
import { and, eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { getApiRouter } from './api-service';
import { trackedApps, apkVersions } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { broadcastToAll } from '../websocket/index';
import { extractApkQuickMeta, type ApkMetaExtractor } from '../services/apk-meta';
import { getApkDir } from '../utils/apk-paths';
import { safeJoinInside } from '../utils/safe-path';
import { isValidPackageName } from '../utils/validators';
import { scopeMatches } from '../auth/scope-matcher';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('apps-upload');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB — large game APKs exist

interface AnalyzerLike { enqueue(apkVersionId: number): Promise<number>; }

interface UploadDeps {
  extractor?: ApkMetaExtractor;
  apkDir?: string;
}

export function registerAppsUploadEndpoint(db: AppDatabase, analyzer: AnalyzerLike | null, deps: UploadDeps = {}): void {
  const extractor = deps.extractor ?? extractApkQuickMeta;
  const upload = multer({
    storage: multer.diskStorage({ destination: os.tmpdir() }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });

  // Convert multer's stream errors (e.g. oversize) into clean JSON instead of
  // Express's default HTML 500 page.
  const handleMulter = (req: Request, res: Response, next: NextFunction) => {
    upload.single('apk')(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? `APK exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024 * 1024))} GB upload limit`
          : err.message;
        res.status(status).json({ success: false, error: message });
        return;
      }
      if (err) { next(err); return; }
      next();
    });
  };

  getApiRouter().post('/v1/apps/upload', handleMulter, async (req: Request, res: Response) => {
    const file = req.file;
    // Always remove multer's temp file, whatever path we exit by (including the
    // early scope/validation returns below — multer has already written it).
    const cleanup = () => file ? fs.promises.unlink(file.path).catch(() => {}) : Promise.resolve();

    const authUser = (req as any).authUser;
    if (authUser && !scopeMatches(authUser.effectiveScopes, 'core.apk:manage')) {
      await cleanup();
      res.status(403).json({ success: false, error: 'Insufficient scope', required: ['core.apk:manage'] });
      return;
    }

    if (!file) {
      res.status(400).json({ success: false, error: 'No file uploaded (expected multipart field "apk")' });
      return;
    }

    try {
      if (!file.originalname.toLowerCase().endsWith('.apk')) {
        res.status(400).json({ success: false, error: 'File must be an .apk' });
        return;
      }

      const meta = await extractor(file.path).catch((e: any) => {
        throw Object.assign(new Error(e?.message || 'Could not read APK'), { statusCode: 400 });
      });
      if (!isValidPackageName(meta.packageName)) {
        res.status(400).json({ success: false, error: `Invalid package name in APK: ${meta.packageName}` });
        return;
      }

      let tracked = db.select().from(trackedApps).where(eq(trackedApps.packageName, meta.packageName)).get();
      if (!tracked) {
        db.insert(trackedApps).values({ packageName: meta.packageName, appName: null, createdAt: new Date() }).run();
        tracked = db.select().from(trackedApps).where(eq(trackedApps.packageName, meta.packageName)).get()!;
      }

      const dupe = db.select().from(apkVersions).where(and(
        eq(apkVersions.trackedAppId, tracked.id),
        eq(apkVersions.versionCode, meta.versionCode),
      )).get();
      if (dupe) {
        res.status(409).json({ success: false, error: `Version ${meta.versionCode} of ${meta.packageName} is already stored` });
        return;
      }

      const apkRoot = deps.apkDir ?? getApkDir();
      const safeName = (meta.versionName ?? String(meta.versionCode)).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `${meta.versionCode}_${safeName}.apk`;
      // safeJoinInside throws if packageName/filename would escape apkRoot — a
      // belt-and-suspenders guard on top of the isValidPackageName check above.
      const dest = safeJoinInside(apkRoot, meta.packageName, filename);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(file.path, dest); // copy+unlink: rename() fails across devices

      const stat = fs.statSync(dest);
      let inserted;
      try {
        db.insert(apkVersions).values({
          trackedAppId: tracked.id,
          versionCode: meta.versionCode,
          versionName: meta.versionName,
          filename,
          fileSize: stat.size,
          deviceId: null,
          source: 'upload',
          downloadedAt: new Date(),
        }).run();
        inserted = db.select().from(apkVersions).where(and(
          eq(apkVersions.trackedAppId, tracked.id),
          eq(apkVersions.versionCode, meta.versionCode),
        )).get()!;
      } catch (insertErr) {
        // Don't leave an orphaned APK on disk if the row couldn't be written.
        await fs.promises.unlink(dest).catch(() => {});
        throw insertErr;
      }

      broadcastToAll({
        type: 'apk:version-pulled',
        trackedAppId: tracked.id,
        packageName: meta.packageName,
        versionCode: meta.versionCode,
        versionName: meta.versionName,
        source: 'upload',
      });

      if (analyzer) {
        analyzer.enqueue(inserted.id).catch(() => {});
      }

      log(`Uploaded ${meta.packageName} v${meta.versionCode} (${stat.size} bytes)`);
      res.json({ success: true, data: { id: inserted.id, trackedAppId: tracked.id, packageName: meta.packageName, versionCode: meta.versionCode, versionName: meta.versionName } });
    } catch (err: any) {
      error(`Upload failed: ${err?.message}`);
      res.status(err?.statusCode ?? 500).json({ success: false, error: err?.message || 'Upload failed' });
    } finally {
      void cleanup();
    }
  });
}
