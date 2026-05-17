import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import AdmZip from 'adm-zip';
import { trackedApps, apkVersions } from '../db/schema';
import { adbShell, adbPull } from './device-manager';
import type { DeviceManager } from './device-manager';
import type { ApkAnalyzerService } from './apk-analyzer';
import type { FileStorageService } from './file-storage';
import type { PlayStoreSource } from './play-store-source';
import type { NotificationService } from './notification-service';
import type { AppDatabase } from '../db/index';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';
import { APK_DIR } from '../utils/apk-paths';
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
 * Extract the launcher icon from a local APK file (ZIP) on disk.
 * At each density, finds the largest *launcher* PNG/WebP (handles apps
 * that use custom names like `dlp_ic_launcher.png` instead of `ic_launcher.png`).
 * Returns true if an icon was saved.
 */
export function extractIconFromLocalApk(packageName: string): boolean {
  const pkgDir = path.join(APK_DIR, packageName);
  if (!fs.existsSync(pkgDir)) return false;

  // Look for an APK file directly in the package dir
  let apkFile = fs.readdirSync(pkgDir).find(f => f.endsWith('.apk'));

  // If no direct .apk files, look inside split APK directories for base.apk
  if (!apkFile) {
    for (const entry of fs.readdirSync(pkgDir)) {
      const entryPath = path.join(pkgDir, entry);
      try {
        if (fs.statSync(entryPath).isDirectory()) {
          const baseApk = path.join(entryPath, 'base.apk');
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
    const zip = new AdmZip(path.join(pkgDir, apkFile));
    const allEntries = zip.getEntries();

    for (const density of DENSITY_ORDER) {
      // Search both mipmap-${density}-v4/ (AAPT2 default) and mipmap-${density}/ (legacy)
      const prefixes = [`res/mipmap-${density}-v4/`, `res/mipmap-${density}/`];

      // Find all launcher icon candidates at this density across both prefix variants
      const candidates = allEntries.filter(e => {
        const matchedPrefix = prefixes.find(p => e.entryName.startsWith(p));
        if (!matchedPrefix) return false;
        const name = e.entryName.slice(matchedPrefix.length);
        if (!name.includes('launcher')) return false;
        if (!(name.endsWith('.png') || name.endsWith('.webp'))) return false;
        const base = name.replace(/\.(png|webp)$/, '');
        return !ICON_SKIP_SUFFIXES.some(s => base.endsWith(s));
      });

      if (candidates.length === 0) continue;

      // Pick the largest candidate (most likely the branded icon)
      candidates.sort((a, b) => b.header.size - a.header.size);
      const best = candidates[0];
      const buf = best.getData();
      if (buf.length > 100) {
        const ext = best.entryName.endsWith('.webp') ? 'webp' : 'png';
        const iconFile = ext === 'png' ? 'icon.png' : 'icon.webp';
        fs.writeFileSync(path.join(pkgDir, iconFile), buf);
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
  const pkgDir = path.join(APK_DIR, packageName);
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
    fs.writeFileSync(path.join(pkgDir, 'icon.png'), buf);
    log(`Fetched icon for ${packageName} from Google Play`);
    return true;
  } catch { return false; }
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
  private playStoreSource: PlayStoreSource | null = null;
  private notificationService: NotificationService | null = null;

  constructor(
    private db: AppDatabase,
    private deviceManager: DeviceManager,
    private checkIntervalMs: number = DEFAULT_CHECK_INTERVAL,
  ) {}

  setApkAnalyzer(analyzer: ApkAnalyzerService): void {
    this.apkAnalyzer = analyzer;
  }

  setFileSync(sync: FileStorageService): void {
    this.fileSync = sync;
  }

  setPlayStoreSource(source: PlayStoreSource): void {
    this.playStoreSource = source;
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

      // Fire off Play Store checks in parallel (don't block device checks)
      const playStorePromises: Promise<boolean>[] = [];
      if (this.playStoreSource) {
        for (const app of tracked) {
          if (app.autoFetchPlayStore === false) continue;
          playStorePromises.push(
            this.checkPlayStore(app).catch(err => {
              error(`Play Store check failed for ${app.packageName}: ${err.message}`);
              return false;
            }),
          );
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

      // Wait for Play Store checks to complete
      const playStoreResults = await Promise.all(playStorePromises);
      newVersions += playStoreResults.filter(Boolean).length;
    } catch (err: any) {
      error(`APK tracker check failed: ${err.message}`);
    } finally {
      this.checking = false;
      broadcastToAll({ type: 'apk:scan-complete', newVersions });
    }
  }

  private async checkPlayStore(
    app: { id: number; packageName: string; appName: string | null; lastPlayStoreVersion: string | null },
  ): Promise<boolean> {
    if (!this.playStoreSource) return false;

    // Check latest version on Play Store
    const versionInfo = await this.playStoreSource.checkVersion(app.packageName);
    if (!versionInfo) return false;

    // Skip download if Play Store reports the same version we last saw
    if (versionInfo.versionName && versionInfo.versionName === app.lastPlayStoreVersion) {
      return false;
    }

    // Download via apkeep
    const appName = versionInfo.appName || app.appName || app.packageName;
    const result = await this.playStoreSource.downloadApk(app.packageName, appName);
    if (!result.success || !result.versionCode) {
      if (result.error) log(`Play Store download skipped for ${app.packageName}: ${result.error}`);
      return false;
    }

    // Dedup: check if this versionCode already exists or is older than what we have
    const allVersions = this.db.select().from(apkVersions)
      .where(eq(apkVersions.trackedAppId, app.id))
      .all();

    const hasExact = allVersions.find(v => v.versionCode === result.versionCode);
    const latestCode = allVersions.length > 0
      ? Math.max(...allVersions.map(v => v.versionCode))
      : 0;

    if (hasExact || result.versionCode <= latestCode) {
      // Already have this version or it's older — clean up downloaded file
      if (result.filePath) {
        try { fs.unlinkSync(result.filePath); } catch {}
      }
      // Still update lastPlayStoreVersion so we don't re-download next cycle
      if (versionInfo.versionName) {
        this.db.update(trackedApps).set({ lastPlayStoreVersion: versionInfo.versionName }).where(eq(trackedApps.id, app.id)).run();
      }
      if (!hasExact && result.versionCode < latestCode) {
        log(`Play Store download skipped for ${app.packageName}: downloaded v${result.versionName} (${result.versionCode}) is older than stored (${latestCode})`);
      }
      return false;
    }

    const filename = `${result.versionCode}_${result.versionName || 'unknown'}.apk`;

    // Insert version record
    const insertResult = this.db.insert(apkVersions)
      .values({
        trackedAppId: app.id,
        versionCode: result.versionCode,
        versionName: result.versionName || null,
        filename,
        fileSize: result.fileSize || null,
        deviceId: null,
        source: 'playstore',
        downloadedAt: new Date(),
      })
      .run();

    const versionId = Number(insertResult.lastInsertRowid);

    // Update lastPlayStoreVersion so we skip re-downloading the same version next cycle
    this.db.update(trackedApps)
      .set({
        lastPlayStoreVersion: versionInfo.versionName,
        ...(!app.appName && versionInfo.appName ? { appName: versionInfo.appName } : {}),
      })
      .where(eq(trackedApps.id, app.id))
      .run();

    log(`Pulled APK from Play Store: ${app.packageName} v${result.versionName} (${result.versionCode})`);

    // Cloud sync
    if (this.fileSync && result.filePath) {
      const cloudKey = `apks/${app.packageName}/${filename}`;
      this.fileSync.trackFile(result.filePath, cloudKey, 'apk', result.fileSize || 0);
    }
    applyRetentionForApp(this.db, app.id, app.packageName);

    // Broadcast
    broadcastToAll({
      type: 'apk:version-pulled',
      trackedAppId: app.id,
      packageName: app.packageName,
      versionCode: result.versionCode,
      versionName: result.versionName || null,
      source: 'playstore',
    });

    // Notify
    this.notificationService?.emit({
      type: 'apk:new-version',
      title: `New APK: ${app.appName || app.packageName}`,
      body: `v${result.versionName || result.versionCode} downloaded from Play Store`,
      sourceType: 'apk',
      sourceId: String(versionId),
      url: `/ui/apps/${app.id}/analysis/${versionId}`,
    });

    // Auto-enqueue for analysis
    if (this.apkAnalyzer) {
      this.apkAnalyzer.enqueue(versionId).catch(err => {
        error(`Failed to enqueue analysis for ${app.packageName} v${result.versionCode}: ${err.message}`);
      });
    }

    return true;
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
    const pkgDir = path.join(APK_DIR, packageName);
    fs.mkdirSync(pkgDir, { recursive: true });

    const isSplit = apkPaths.length > 1;
    let filename: string;
    let totalSize = 0;

    if (isSplit) {
      // Split APK: store all files in a subdirectory
      filename = `${currentVersionCode}_${versionName}`;
      const splitDir = path.join(pkgDir, filename);
      fs.mkdirSync(splitDir, { recursive: true });
      for (const apkPath of apkPaths) {
        const apkName = path.basename(apkPath);
        const localPath = path.join(splitDir, apkName);
        await adbPull(deviceId, apkPath, localPath);
        totalSize += fs.statSync(localPath).size;
      }
      log(`Pulled split APK (${apkPaths.length} files) for ${packageName} v${versionName} from ${deviceId}`);
    } else {
      filename = `${currentVersionCode}_${versionName}.apk`;
      const localPath = path.join(pkgDir, filename);
      await adbPull(deviceId, apkPaths[0], localPath);
      totalSize = fs.statSync(localPath).size;
    }

    // Insert version record
    const result = this.db.insert(apkVersions)
      .values({
        trackedAppId,
        versionCode: currentVersionCode,
        versionName,
        filename,
        fileSize: totalSize,
        deviceId,
        source: 'device',
        downloadedAt: new Date(),
      })
      .run();

    const versionId = Number(result.lastInsertRowid);

    log(`Pulled APK: ${packageName} v${versionName} (${currentVersionCode}) from ${deviceId}, ${totalSize} bytes`);

    // Track file(s) in cloud storage
    if (this.fileSync) {
      if (isSplit) {
        // Split APKs: track each individual .apk file inside the directory
        const splitDir = path.join(pkgDir, filename);
        for (const apkPath of apkPaths) {
          const apkName = path.basename(apkPath);
          const localFilePath = path.join(splitDir, apkName);
          const fileSize = fs.statSync(localFilePath).size;
          const cloudKey = `apks/${packageName}/${filename}/${apkName}`;
          this.fileSync.trackFile(localFilePath, cloudKey, 'apk', fileSize);
        }
      } else {
        const apkLocalPath = path.join(pkgDir, filename);
        const cloudKey = `apks/${packageName}/${filename}`;
        this.fileSync.trackFile(apkLocalPath, cloudKey, 'apk', totalSize);
      }
    }
    applyRetentionForApp(this.db, trackedAppId, packageName);

    // Broadcast to frontend
    broadcastToAll({
      type: 'apk:version-pulled',
      trackedAppId,
      packageName,
      versionCode: currentVersionCode,
      versionName,
      source: 'device',
    });

    // Notify
    const appRow = this.db.select().from(trackedApps).where(eq(trackedApps.id, trackedAppId)).all()[0];
    this.notificationService?.emit({
      type: 'apk:new-version',
      title: `New APK: ${appRow?.appName || packageName}`,
      body: `v${versionName || currentVersionCode} pulled from device`,
      sourceType: 'apk',
      sourceId: String(versionId),
      url: `/ui/apps/${trackedAppId}/analysis/${versionId}`,
    });

    // Auto-enqueue for analysis
    if (this.apkAnalyzer) {
      this.apkAnalyzer.enqueue(versionId).catch(err => {
        error(`Failed to enqueue analysis for ${packageName} v${currentVersionCode}: ${err.message}`);
      });
    }

    return true;
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
    const pkgDir = path.join(APK_DIR, packageName);
    if (fs.existsSync(path.join(pkgDir, 'icon.png')) || fs.existsSync(path.join(pkgDir, 'icon.webp'))) return;

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
          fs.writeFileSync(path.join(pkgDir, 'icon.png'), stdout);
          log(`Backfilled icon for ${packageName} (from device)`);
          return;
        }
      }
    } catch { /* try fallback */ }

    // Method 2: Extract from local APK file
    if (extractIconFromLocalApk(packageName)) return;

    // Method 3: Fetch from Google Play Store
    await fetchIconFromGooglePlay(packageName);
  }
}
