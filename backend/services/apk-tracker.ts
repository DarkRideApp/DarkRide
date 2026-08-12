import { eq, and } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import AdmZip from 'adm-zip';
import { trackedApps, apkVersions, appSources } from '../db/schema';
import { adbShell, adbPull } from './device-manager';
import type { DeviceManager } from './device-manager';
import type { ApkAnalyzerService } from './apk-analyzer';
import type { FileStorageService } from './file-storage';
import type { SourceRegistry } from './apk-sources/registry';
import type { RemoteApkSource } from './apk-sources/types';
import { ensureAppSources } from './apk-sources';
import { sourceLabel } from './apk-sources/types';
import type { NotificationService } from './notification-service';
import type { AppDatabase } from '../db/index';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';
import { packageDir, sanitizeVersionName } from '../utils/apk-paths';
import { safeJoinInside } from '../utils/safe-path';
import { enumerateApkPaths } from '../utils/apk-utils';
import { applyRetentionForApp, applyRetentionForAllApps } from './apk-retention';
import { backfillApkCloudFiles, cleanupStaleAnalysisDirs } from './apk-backfill';
import { backfillNotesFromDisk } from './apk-notes';

const execAsync = promisify(exec);
const { log, error } = createLoggers('apk-tracker');
const DEFAULT_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

/** Density preference order for mipmap icon extraction (highest first). */
const DENSITY_ORDER = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi'] as const;

/** Suffixes to skip when scanning mipmap for launcher icons. */
const ICON_SKIP_SUFFIXES = ['_round', '_foreground', '_background', '_monochrome'];

/**
 * Find the largest launcher raster in an APK's mipmap dirs, scanning densities
 * highest-first and returning at the first density that has an accepted match.
 * `accept` receives the extension-less basename (e.g. `ic_launcher`,
 * `ic_launcher_foreground`) so callers can prefer flat icons over layers.
 * Entries whose uncompressed size is ≤100 bytes are ignored (placeholders).
 * Returns null when nothing matches.
 */
function pickBestLauncherEntry(
  allEntries: AdmZip.IZipEntry[],
  accept: (base: string) => boolean,
): AdmZip.IZipEntry | null {
  for (const density of DENSITY_ORDER) {
    // Search both mipmap-${density}-v4/ (AAPT2 default) and mipmap-${density}/ (legacy)
    const prefixes = [`res/mipmap-${density}-v4/`, `res/mipmap-${density}/`];

    const candidates = allEntries.filter(e => {
      const matchedPrefix = prefixes.find(p => e.entryName.startsWith(p));
      if (!matchedPrefix) return false;
      const name = e.entryName.slice(matchedPrefix.length);
      if (!name.includes('launcher')) return false;
      if (!(name.endsWith('.png') || name.endsWith('.webp'))) return false;
      if (e.header.size <= 100) return false;
      const base = name.replace(/\.(png|webp)$/, '');
      return accept(base);
    });

    if (candidates.length === 0) continue;

    // Pick the largest candidate (most likely the branded icon)
    candidates.sort((a, b) => b.header.size - a.header.size);
    return candidates[0];
  }
  return null;
}

/**
 * Extract the launcher icon from a local APK file (ZIP) on disk.
 * At each density, finds the largest *launcher* PNG/WebP (handles apps
 * that use custom names like `dlp_ic_launcher.png` instead of `ic_launcher.png`),
 * falling back to the adaptive-icon foreground layer when no flat icon exists.
 * Returns true if an icon was saved.
 */
export function extractIconFromLocalApk(packageName: string): boolean {
  const pkgDir = packageDir(packageName);
  if (!fs.existsSync(pkgDir)) return false;

  // Look for an APK file directly in the package dir
  let apkFile = fs.readdirSync(pkgDir).find(f => f.endsWith('.apk'));

  // If no direct .apk files, look inside split APK directories for base.apk
  if (!apkFile) {
    for (const entry of fs.readdirSync(pkgDir)) {
      const entryPath = safeJoinInside(pkgDir,entry);
      try {
        if (fs.statSync(entryPath).isDirectory()) {
          const baseApk = safeJoinInside(entryPath, 'base.apk');
          if (fs.existsSync(baseApk)) {
            apkFile = path.join(entry, 'base.apk');
            break;
          }
        }
      } catch { /* skip */ }
    }
  }
  if (!apkFile) return false;

  try {
    const zip = new AdmZip(safeJoinInside(pkgDir,apkFile));
    const allEntries = zip.getEntries();

    // Prefer a flat launcher raster (the finished icon). If the app ships only
    // an adaptive icon — an anydpi XML plus separate foreground/background
    // layers, with no flat ic_launcher.png at any density — fall back to the
    // foreground layer, which is the branded glyph. Without this fallback,
    // adaptive-icon-only apps (the modern default) yield no icon at all.
    const best =
      pickBestLauncherEntry(allEntries, base => !ICON_SKIP_SUFFIXES.some(s => base.endsWith(s))) ||
      pickBestLauncherEntry(allEntries, base => base.endsWith('_foreground'));

    if (best) {
      const buf = best.getData();
      if (buf.length > 100) {
        const ext = best.entryName.endsWith('.webp') ? 'webp' : 'png';
        const iconFile = ext === 'png' ? 'icon.png' : 'icon.webp';
        fs.writeFileSync(safeJoinInside(pkgDir,iconFile), buf);
        log(`Extracted icon for ${packageName} (${best.entryName})`);
        return true;
      }
    }
  } catch { /* best-effort */ }
  return false;
}

/**
 * Fetch the app icon from Google Play Store as a last-resort fallback.
 * Scrapes the og:image meta tag from the store listing page.
 * Returns true if an icon was saved.
 */
export async function fetchIconFromGooglePlay(packageName: string): Promise<boolean> {
  const pkgDir = packageDir(packageName);
  try {
    const pageRes = await fetch(
      `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) },
    );
    if (!pageRes.ok) return false;
    const html = await pageRes.text();
    const match = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
    if (!match) return false;

    const imgRes = await fetch(match[1], { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) return false;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length < 100) return false;

    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(safeJoinInside(pkgDir,'icon.png'), buf);
    log(`Fetched icon for ${packageName} from Google Play`);
    return true;
  } catch { return false; }
}

/**
 * Fetch an app icon from the remote stores the app is tracked on.
 *
 * Iterates the app's enabled `app_sources` rows and asks each source that
 * implements `fetchIcon` until a store returns an icon. This is the reliable
 * path for apps that ship only an adaptive icon (nothing to extract locally)
 * and aren't on Google Play — most notably the China-store apps this project
 * tracks (QQ, Huawei, Xiaomi). Best-effort: returns false if no source has an
 * icon or none is configured.
 */
export async function fetchIconFromSources(
  db: AppDatabase,
  registry: SourceRegistry | null | undefined,
  packageName: string,
): Promise<boolean> {
  if (!registry) return false;
  const app = db.select().from(trackedApps).where(eq(trackedApps.packageName, packageName)).all()[0];
  if (!app) return false;
  const rows = db.select().from(appSources)
    .where(and(eq(appSources.trackedAppId, app.id), eq(appSources.enabled, true)))
    .all();
  for (const row of rows) {
    const source = registry.get(row.source);
    if (!source?.fetchIcon) continue;
    try {
      if (await source.fetchIcon(packageName)) return true;
    } catch { /* try the next source */ }
  }
  return false;
}

/**
 * Parse versionCode from dumpsys package output.
 */
function parseVersionCode(dumpsysOutput: string): number | null {
  const lines = dumpsysOutput.split('\n');
  let inPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'Packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = trimmed.match(/^versionCode=(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return null;
}

function parseVersionName(dumpsysOutput: string): string | null {
  const lines = dumpsysOutput.split('\n');
  let inPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'Packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = trimmed.match(/^versionName=(.+)/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

export class ApkTracker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private apkAnalyzer: ApkAnalyzerService | null = null;
  private fileSync: FileStorageService | null = null;
  private sourceRegistry: SourceRegistry | null = null;
  private notificationService: NotificationService | null = null;

  private hookBus: import('@darkrideapp/plugin-sdk').HookBus | null = null;

  constructor(
    private db: AppDatabase,
    private deviceManager: DeviceManager,
    private checkIntervalMs: number = DEFAULT_CHECK_INTERVAL,
  ) {}

  setHookBus(bus: import('@darkrideapp/plugin-sdk').HookBus): void {
    this.hookBus = bus;
  }

  /**
   * Announce a new version. Fires whether or not the APK is downloaded, which
   * is the point: with auto-analyse off nothing else in the pipeline runs, so
   * `apk:analyzed` never fires and a subscriber would hear nothing at all.
   *
   * Never allowed to break a check cycle — a throwing subscriber must not stop
   * us recording the version we just found.
   */
  private emitVersionDetected(payload: {
    trackedAppId: number; packageName: string; appName: string | null;
    source: string; versionName: string; previousVersion: string | null;
    analysed: boolean;
  }): void {
    if (!this.hookBus) return;
    try {
      this.hookBus.emit('apk:version-detected', payload);
    } catch (err: any) {
      error(`apk:version-detected hook failed for ${payload.packageName}: ${err.message}`);
    }
  }

  setApkAnalyzer(analyzer: ApkAnalyzerService): void {
    this.apkAnalyzer = analyzer;
  }

  setFileSync(sync: FileStorageService): void {
    this.fileSync = sync;
  }

  setSourceRegistry(registry: SourceRegistry): void {
    this.sourceRegistry = registry;
  }

  setNotificationService(service: NotificationService): void {
    this.notificationService = service;
  }

  start(): void {
    if (this.interval) return;
    log(`APK tracker started (check interval: ${this.checkIntervalMs / 1000}s)`);
    this.interval = setInterval(() => this.checkForUpdates(), this.checkIntervalMs);

    // One-time backfills (cloud_files + notes) + retention flag pass +
    // stale-analysis-dir cleanup. Non-blocking: runs on next tick so startup
    // isn't delayed.
    setImmediate(() => {
      try {
        if (this.fileSync) {
          backfillApkCloudFiles(this.db, this.fileSync);
        }
        backfillNotesFromDisk(this.db);
        applyRetentionForAllApps(this.db);
        cleanupStaleAnalysisDirs(this.db);
      } catch (err: any) {
        error(`APK backfill failed: ${err.message}`);
      }
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    log('APK tracker stopped');
  }

  /**
   * Run a single check cycle. Can be called manually for testing.
   */
  async checkForUpdates(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    let newVersions = 0;

    try {
      const tracked = this.db.select().from(trackedApps).all();
      if (tracked.length === 0) {
        this.checking = false;
        broadcastToAll({ type: 'apk:scan-complete', newVersions: 0 });
        return;
      }

      // Fire off remote-source checks in parallel (don't block device checks).
      // Each enabled (app, source) pair is one independent check.
      const remotePromises: Promise<boolean>[] = [];
      if (this.sourceRegistry) {
        const registry = this.sourceRegistry;
        for (const app of tracked) {
          ensureAppSources(this.db, app.id, registry);
          for (const source of registry.all()) {
            remotePromises.push(
              this.checkRemoteSource(app, source)
                .then(r => r.newVersionId !== null)
                .catch(err => {
                  error(`${source.label} check failed for ${app.packageName}: ${err.message}`);
                  return false;
                }),
            );
          }
        }
      }

      // Get all device statuses
      const allDevices = await this.deviceManager.getAllDeviceStatuses();
      const onlineDevices = allDevices.filter(d => d.isOnline && !d.isBusy);

      for (const app of tracked) {
        for (const device of onlineDevices) {
          // Skip if device became busy
          if (this.deviceManager.isBusy(device.id)) continue;

          try {
            const pulled = await this.checkAppOnDevice(app, device.id);
            if (pulled) newVersions++;
          } catch (err: any) {
            // Package might not be installed on this device — suppress only those errors
            const msg = err.message ?? '';
            const isPackageNotInstalled = msg.includes('Unknown package') || msg.includes('Package not found');
            if (!isPackageNotInstalled) {
              error(`Error checking ${app.packageName} on ${device.id}: ${msg}`);
            }
          }
        }
      }

      // Wait for remote-source checks to complete
      const remoteResults = await Promise.all(remotePromises);
      newVersions += remoteResults.filter(Boolean).length;
    } catch (err: any) {
      error(`APK tracker check failed: ${err.message}`);
    } finally {
      this.checking = false;
      broadcastToAll({ type: 'apk:scan-complete', newVersions });
    }
  }

  /**
   * Check one remote source for one app, downloading + ingesting a new version
   * if there is one. Gated on the app's app_sources row being enabled. Persists
   * per-source state (lastVersion / lastCheckedAt / lastError) so the UI can
   * surface health and the next cycle can skip unchanged versions.
   *
   * Public so the API can trigger a one-off "fetch now" for a single source.
   */
  async checkRemoteSource(
    app: { id: number; packageName: string; appName: string | null },
    source: RemoteApkSource,
    opts: { force?: boolean } = {},
  ): Promise<{ newVersionId: number | null; error?: string; notFound?: boolean }> {
    let row = this.db.select().from(appSources)
      .where(and(eq(appSources.trackedAppId, app.id), eq(appSources.source, source.id)))
      .all()[0];

    // A forced fetch (fetch-now / AI tool) may target an app with no row yet
    // (e.g. a pre-existing app whose qq row was never backfilled). Create it so
    // lastVersion/lastError state is recorded rather than silently dropped.
    // onConflictDoNothing + re-select by the (tracked_app_id, source) key makes
    // this safe under concurrent fetch-now calls: if another request inserted
    // the row first, we don't fail the constraint and we still get the row
    // (relying on lastInsertRowid would be wrong when the insert was ignored).
    if (!row && opts.force) {
      this.db.insert(appSources).values({
        trackedAppId: app.id,
        source: source.id,
        enabled: source.defaultEnabled(),
        createdAt: new Date(),
      }).onConflictDoNothing().run();
      row = this.db.select().from(appSources)
        .where(and(eq(appSources.trackedAppId, app.id), eq(appSources.source, source.id)))
        .all()[0];
    }

    // Scheduled cycles respect the enabled flag; an explicit force (fetch-now)
    // bypasses it but still records state.
    if (!opts.force && !(row?.enabled)) return { newVersionId: null };

    const markState = (patch: Partial<typeof appSources.$inferInsert>) => {
      if (row) {
        this.db.update(appSources).set(patch).where(eq(appSources.id, row.id)).run();
      }
    };

    try {
      const versionInfo = await source.checkVersion(app.packageName);
      if (!versionInfo) {
        markState({ lastCheckedAt: new Date(), lastError: null });
        return { newVersionId: null, notFound: true };
      }

      // Store-listing metadata rides along with the version: the source already
      // fetched it in the same response, so persisting it costs nothing and
      // saves consumers a second identical request.
      const storeMeta = {
        lastIconUrl: versionInfo.iconUrl ?? row?.lastIconUrl ?? null,
        lastReleaseNotes: versionInfo.releaseNotes ?? row?.lastReleaseNotes ?? null,
        lastSizeLabel: versionInfo.sizeLabel ?? row?.lastSizeLabel ?? null,
        lastStoreUpdatedAt: versionInfo.storeUpdatedAt ?? row?.lastStoreUpdatedAt ?? null,
      };

      // Skip the download if the source reports the same version we last saw,
      // unless the caller forced a refresh. Metadata is still refreshed — a
      // store can edit an icon or release notes without shipping a new build.
      if (!opts.force && versionInfo.versionName && versionInfo.versionName === row?.lastVersion) {
        markState({ ...storeMeta, lastCheckedAt: new Date(), lastError: null });
        return { newVersionId: null };
      }

      const previousVersion = row?.lastVersion ?? null;
      const autoAnalyse = this.db.select({ autoAnalyse: trackedApps.autoAnalyse })
        .from(trackedApps).where(eq(trackedApps.id, app.id)).all()[0]?.autoAnalyse ?? false;

      // TRACK WITHOUT ANALYSING. A new version is recorded and announced, but
      // the APK is not fetched unless the app opted in. `force` is an explicit
      // human "fetch now", so it overrides — otherwise the button would appear
      // to do nothing.
      if (!autoAnalyse && !opts.force) {
        markState({
          ...storeMeta,
          lastVersion: versionInfo.versionName ?? row?.lastVersion ?? null,
          lastCheckedAt: new Date(),
          lastError: null,
        });
        if (!app.appName && versionInfo.appName) {
          this.db.update(trackedApps).set({ appName: versionInfo.appName }).where(eq(trackedApps.id, app.id)).run();
          app.appName = versionInfo.appName;
        }
        if (versionInfo.versionName) {
          this.emitVersionDetected({
            trackedAppId: app.id, packageName: app.packageName, appName: app.appName,
            source: source.id, versionName: versionInfo.versionName,
            previousVersion, analysed: false,
          });
        }
        log(`${source.label}: ${app.packageName} ${versionInfo.versionName} detected (auto-analyse off, not downloading)`);
        return { newVersionId: null };
      }

      const appName = versionInfo.appName || app.appName || app.packageName;
      const result = await source.downloadApk(app.packageName, appName);
      if (!result.success || !result.versionCode) {
        const msg = result.error || 'download failed';
        markState({ lastCheckedAt: new Date(), lastError: msg });
        log(`${source.label} download skipped for ${app.packageName}: ${msg}`);
        return { newVersionId: null, error: msg };
      }

      // Build a path-safe on-disk name from the (untrusted) versionName; the
      // display versionName stored on the row keeps its original value. A split
      // bundle (XAPK) is a DIRECTORY, so its name carries no `.apk` suffix —
      // mirroring the device split path (checkAppOnDevice).
      const safeName = `${result.versionCode}_${sanitizeVersionName(result.versionName)}`;
      const isSplit = !!result.splitDir;
      const filename = isSplit ? safeName : `${safeName}.apk`;

      // Remote sources return a STAGED temp path (a single .apk file, or a
      // directory of splits); ingestVersion moves it to `filename` only if the
      // version is kept, and discards it on dedup. The split case lets
      // ingestVersion build per-child cloudFiles — we don't build them here.
      const stagedPath = result.splitDir ?? result.filePath;
      const versionId = this.ingestVersion(app, source.id, {
        versionCode: result.versionCode,
        versionName: result.versionName || 'unknown',
        filename,
        fileSize: result.fileSize || 0,
        displayName: appName,
        staged: stagedPath
          ? { path: stagedPath, cloudKey: `apks/${app.packageName}/${filename}` }
          : undefined,
      });

      // Record the version string + clear errors regardless of dedup outcome so
      // we don't re-download an already-stored version next cycle.
      markState({ ...storeMeta, lastVersion: versionInfo.versionName ?? row?.lastVersion ?? null, lastCheckedAt: new Date(), lastError: null });
      if (!app.appName && versionInfo.appName) {
        this.db.update(trackedApps).set({ appName: versionInfo.appName }).where(eq(trackedApps.id, app.id)).run();
        app.appName = versionInfo.appName;
      }

      if (versionInfo.versionName) {
        this.emitVersionDetected({
          trackedAppId: app.id, packageName: app.packageName, appName: app.appName,
          source: source.id, versionName: versionInfo.versionName,
          previousVersion, analysed: true,
        });
      }

      return { newVersionId: versionId };
    } catch (err: any) {
      markState({ lastCheckedAt: new Date(), lastError: err.message });
      throw err;
    }
  }

  /**
   * Shared ingestion tail for every source (device + remote): dedup by
   * versionCode, finalize the downloaded file, insert the apk_versions row,
   * track cloud files, apply retention, broadcast, notify, and enqueue
   * analysis. Returns the new versionId, or null when deduped away.
   *
   * Device callers pass `cloudFiles` already at their final on-disk location.
   * Remote callers pass a `staged` temp file: it is moved into place ONLY when
   * the version is kept, and unlinked on dedup — so a deduped re-download can
   * never overwrite or delete an identically-named already-stored APK.
   */
  private ingestVersion(
    app: { id: number; packageName: string; appName: string | null },
    sourceId: string,
    data: {
      versionCode: number;
      versionName: string;
      filename: string;
      fileSize: number;
      deviceId?: string | null;
      /** Display name for the notification (avoids a trackedApps re-read). */
      displayName?: string | null;
      cloudFiles?: Array<{ localPath: string; cloudKey: string; size: number }>;
      staged?: { path: string; cloudKey: string };
    },
  ): number | null {
    const versions = this.db.select().from(apkVersions)
      .where(eq(apkVersions.trackedAppId, app.id))
      .all();
    const hasExact = versions.some(v => v.versionCode === data.versionCode);
    const latestCode = versions.length > 0 ? Math.max(...versions.map(v => v.versionCode)) : 0;

    if (hasExact || data.versionCode <= latestCode) {
      // Discard the staged download — never touch the stored final file. A
      // staged split bundle is a directory, so remove it recursively.
      if (data.staged) {
        try {
          if (fs.statSync(data.staged.path).isDirectory()) {
            fs.rmSync(data.staged.path, { recursive: true, force: true });
          } else {
            fs.unlinkSync(data.staged.path);
          }
        } catch { /* best-effort */ }
      }
      if (!hasExact && data.versionCode < latestCode) {
        log(`${sourceLabel(sourceId)} version skipped for ${app.packageName}: v${data.versionName} (${data.versionCode}) is older than stored (${latestCode})`);
      }
      return null;
    }

    // Kept: finalize a staged remote download into its real filename. The
    // versionCode is new (> latestCode), so `filename` cannot collide with an
    // existing version's file.
    let cloudFiles = data.cloudFiles ?? [];
    if (data.staged) {
      const pkgDir = packageDir(app.packageName);
      fs.mkdirSync(pkgDir, { recursive: true });
      const finalPath = safeJoinInside(pkgDir, data.filename);
      if (fs.statSync(data.staged.path).isDirectory()) {
        // A staged split bundle: rename the whole directory into place, then
        // track each child APK under a per-child cloudKey (native libs live in
        // the config/ABI splits, so every part must sync — mirrors the device
        // split path in checkAppOnDevice).
        fs.renameSync(data.staged.path, finalPath);
        cloudFiles = fs.readdirSync(finalPath)
          .filter(name => name.toLowerCase().endsWith('.apk'))
          .map(name => {
            const localPath = path.join(finalPath, name);
            return {
              localPath,
              cloudKey: `${data.staged!.cloudKey}/${name}`,
              size: fs.statSync(localPath).size,
            };
          });
      } else {
        fs.renameSync(data.staged.path, finalPath);
        cloudFiles = [{ localPath: finalPath, cloudKey: data.staged.cloudKey, size: data.fileSize }];
      }
    }

    const insertResult = this.db.insert(apkVersions)
      .values({
        trackedAppId: app.id,
        versionCode: data.versionCode,
        versionName: data.versionName || null,
        filename: data.filename,
        fileSize: data.fileSize || null,
        deviceId: data.deviceId ?? null,
        source: sourceId,
        downloadedAt: new Date(),
      })
      .run();
    const versionId = Number(insertResult.lastInsertRowid);

    log(`Pulled APK from ${sourceLabel(sourceId)}: ${app.packageName} v${data.versionName} (${data.versionCode})`);

    if (this.fileSync) {
      for (const cf of cloudFiles) {
        this.fileSync.trackFile(cf.localPath, cf.cloudKey, 'apk', cf.size);
      }
    }
    applyRetentionForApp(this.db, app.id, app.packageName);

    broadcastToAll({
      type: 'apk:version-pulled',
      trackedAppId: app.id,
      packageName: app.packageName,
      versionCode: data.versionCode,
      versionName: data.versionName || null,
      source: sourceId,
    });

    this.notificationService?.emit({
      type: 'apk:new-version',
      title: `New APK: ${data.displayName || app.appName || app.packageName}`,
      body: `v${data.versionName || data.versionCode} from ${sourceLabel(sourceId)}`,
      sourceType: 'apk',
      sourceId: String(versionId),
      url: `/ui/apps/${app.id}/analysis/${versionId}`,
    });

    if (this.apkAnalyzer) {
      this.apkAnalyzer.enqueue(versionId).catch(err => {
        error(`Failed to enqueue analysis for ${app.packageName} v${data.versionCode}: ${err.message}`);
      });
    }

    return versionId;
  }

  private async checkAppOnDevice(
    app: { id: number; packageName: string; appName: string | null },
    deviceId: string,
  ): Promise<boolean> {
    const { id: trackedAppId, packageName } = app;

    // Get current version on device
    const dumpsys = await adbShell(deviceId, `dumpsys package ${packageName}`, 10000);
    const currentVersionCode = parseVersionCode(dumpsys);

    if (currentVersionCode === null) return false; // package not installed

    // Backfill missing app name
    if (!app.appName) {
      try {
        const appName = await this.getAppLabel(deviceId, packageName);
        if (appName) {
          this.db.update(trackedApps).set({ appName }).where(eq(trackedApps.id, trackedAppId)).run();
          app.appName = appName;
          log(`Backfilled app name for ${packageName}: ${appName}`);
        }
      } catch { /* best-effort */ }
    }

    // Backfill missing icon
    try {
      await this.saveAppIconIfMissing(deviceId, packageName);
    } catch { /* best-effort */ }

    // Get latest stored version
    const versions = this.db.select().from(apkVersions)
      .where(eq(apkVersions.trackedAppId, trackedAppId))
      .all();

    const latestStored = versions.length > 0
      ? versions.reduce((a, b) => (a.versionCode > b.versionCode ? a : b))
      : null;

    // If we already have this version or newer, skip
    if (latestStored && latestStored.versionCode >= currentVersionCode) return false;

    // New version found! Pull it
    log(`New version detected: ${packageName} v${currentVersionCode} on ${deviceId}`);

    const versionName = parseVersionName(dumpsys) ?? 'unknown';
    // Path-safe component for on-disk filenames; the display versionName stored
    // on the row keeps its original value.
    const safeVersionName = sanitizeVersionName(versionName);

    // Get APK paths (split APKs return multiple paths)
    const pathOutput = await adbShell(deviceId, `pm path ${packageName}`, 5000);
    let apkPaths = pathOutput.split('\n')
      .map(l => l.replace(/\r$/, '').replace('package:', '').trim())
      .filter(Boolean);
    if (apkPaths.length === 0) return false;

    // pm path can omit base.apk on some Android versions for split APKs.
    // Enumerate the on-device directory directly so we never miss a file.
    apkPaths = await enumerateApkPaths(deviceId, apkPaths);

    // Prepare local directory
    const pkgDir = packageDir(packageName);
    fs.mkdirSync(pkgDir, { recursive: true });

    const isSplit = apkPaths.length > 1;
    let filename: string;
    let totalSize = 0;

    if (isSplit) {
      // Split APK: store all files in a subdirectory
      filename = `${currentVersionCode}_${safeVersionName}`;
      const splitDir = safeJoinInside(pkgDir,filename);
      fs.mkdirSync(splitDir, { recursive: true });
      for (const apkPath of apkPaths) {
        const apkName = path.basename(apkPath);
        const localPath = path.join(splitDir, apkName);
        await adbPull(deviceId, apkPath, localPath);
        totalSize += fs.statSync(localPath).size;
      }
      log(`Pulled split APK (${apkPaths.length} files) for ${packageName} v${versionName} from ${deviceId}`);
    } else {
      filename = `${currentVersionCode}_${safeVersionName}.apk`;
      const localPath = safeJoinInside(pkgDir,filename);
      await adbPull(deviceId, apkPaths[0], localPath);
      totalSize = fs.statSync(localPath).size;
    }

    // Build the cloud-file list (split APKs track each part individually).
    const cloudFiles: Array<{ localPath: string; cloudKey: string; size: number }> = [];
    if (isSplit) {
      const splitDir = safeJoinInside(pkgDir, filename);
      for (const apkPath of apkPaths) {
        const apkName = path.basename(apkPath);
        const localFilePath = path.join(splitDir, apkName);
        cloudFiles.push({
          localPath: localFilePath,
          cloudKey: `apks/${packageName}/${filename}/${apkName}`,
          size: fs.statSync(localFilePath).size,
        });
      }
    } else {
      cloudFiles.push({
        localPath: safeJoinInside(pkgDir, filename),
        cloudKey: `apks/${packageName}/${filename}`,
        size: totalSize,
      });
    }

    // Funnel through the shared ingestion tail. The device path already
    // pre-checked the version above, so dedup here is just defence.
    const versionId = this.ingestVersion(app, 'device', {
      versionCode: currentVersionCode,
      versionName,
      filename,
      fileSize: totalSize,
      deviceId,
      cloudFiles,
    });

    return versionId !== null;
  }

  private async getAppLabel(deviceId: string, packageName: string): Promise<string | null> {
    try {
      const pathOutput = await adbShell(deviceId, `pm path ${packageName}`, 5000);
      const apkPath = pathOutput.split('\n')[0]?.replace('package:', '').trim();
      if (!apkPath) return null;

      const aaptOutput = await adbShell(deviceId, `aapt dump badging ${apkPath} 2>/dev/null | head -1`, 5000);
      const labelMatch = aaptOutput.match(/application-label:'([^']+)'/);
      return labelMatch ? labelMatch[1] : null;
    } catch {
      return null;
    }
  }

  private async saveAppIconIfMissing(deviceId: string, packageName: string): Promise<void> {
    const pkgDir = packageDir(packageName);
    if (fs.existsSync(safeJoinInside(pkgDir,'icon.png')) || fs.existsSync(safeJoinInside(pkgDir,'icon.webp'))) return;

    // Method 1: Try cmd package dump-icon from device (Android 13+)
    try {
      const check = await adbShell(deviceId, `cmd package dump-icon ${packageName}`, 5000);
      if (check && !check.includes('Error') && !check.includes('Unknown')) {
        const { stdout } = await execAsync(`adb -s ${deviceId} exec-out cmd package dump-icon ${packageName}`, {
          maxBuffer: 1024 * 1024,
          timeout: 5000,
          encoding: 'buffer',
        });
        if (stdout.length > 100) {
          fs.mkdirSync(pkgDir, { recursive: true });
          fs.writeFileSync(safeJoinInside(pkgDir,'icon.png'), stdout);
          log(`Backfilled icon for ${packageName} (from device)`);
          return;
        }
      }
    } catch { /* try fallback */ }

    // Method 2: Extract from local APK file
    if (extractIconFromLocalApk(packageName)) return;

    // Method 3: Fetch from the stores this app is tracked on (branded icon,
    // works for adaptive-icon apps and China-store apps not on Google Play).
    if (await fetchIconFromSources(this.db, this.sourceRegistry, packageName)) return;

    // Method 4: Fetch from Google Play Store
    await fetchIconFromGooglePlay(packageName);
  }
}
