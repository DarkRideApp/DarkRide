import gplay from 'google-play-scraper';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { eq } from 'drizzle-orm';
import { readApkVersion } from '../utils/apk-version-reader';
import { unpackApkBundle } from './apk-bundle';
import { createLoggers } from '../logs';
import { settings } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { APK_DIR } from '../utils/apk-paths';
import type { RemoteApkSource, VersionCheckResult, DownloadResult } from './apk-sources/types';

export type { VersionCheckResult, DownloadResult };

const { log, error } = createLoggers('play-store');
const TOOLS_DIR = path.resolve('./data/tools');
const APKEEP_DIR = path.join(TOOLS_DIR, 'apkeep');
const APKEEP_BIN = path.join(APKEEP_DIR, 'apkeep');
const MIN_REQUEST_INTERVAL = 2000; // 2s between Play Store API calls

const APKEEP_VERSION = '0.18.0';
const APKEEP_DOWNLOAD_URL = `https://github.com/EFForg/apkeep/releases/download/${APKEEP_VERSION}/apkeep-x86_64-unknown-linux-gnu`;

/** Run apkeep CLI and return stdout. */
function runApkeep(args: string[], timeoutMs = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(APKEEP_BIN, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

export class PlayStoreSource implements RemoteApkSource {
  readonly id = 'playstore';
  readonly label = 'Play Store';

  private lastRequestTime = 0;
  private db: AppDatabase | null = null;

  setDatabase(db: AppDatabase): void {
    this.db = db;
  }

  /** Always usable — falls back to APKPure when Google Play creds are absent. */
  isConfigured(): boolean {
    return true;
  }

  /** Default-on, preserving the legacy autoFetchPlayStore=true behaviour. */
  defaultEnabled(): boolean {
    return true;
  }

  /** Google Play web listing, e.g. play.google.com/store/apps/details?id=com.x.y */
  storeUrl(packageName: string): string {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /** Read a setting from the database. */
  private getSetting(key: string): string | null {
    if (!this.db) return null;
    const row = this.db.select().from(settings).where(eq(settings.key, key)).all()[0];
    return row?.value ?? null;
  }

  /** Check if apkeep binary exists. Download if not. */
  async ensureApkeep(): Promise<boolean> {
    if (fs.existsSync(APKEEP_BIN)) return true;

    log(`Downloading apkeep ${APKEEP_VERSION}...`);
    fs.mkdirSync(APKEEP_DIR, { recursive: true });

    try {
      const res = await fetch(APKEEP_DOWNLOAD_URL, {
        signal: AbortSignal.timeout(120000),
        redirect: 'follow',
      });

      if (!res.ok || !res.body) {
        error(`Failed to download apkeep: HTTP ${res.status}`);
        return false;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(APKEEP_BIN, buffer);
      fs.chmodSync(APKEEP_BIN, 0o755);

      log(`Downloaded apkeep ${APKEEP_VERSION} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      return true;
    } catch (err: any) {
      error(`Failed to download apkeep: ${err.message}`);
      return false;
    }
  }

  /** Check if Google Play credentials are configured. */
  hasGooglePlayCredentials(): boolean {
    const email = this.getSetting('google_play_email');
    const token = this.getSetting('google_play_aas_token');
    return !!(email && token);
  }

  /**
   * Check the latest version of an app on Google Play.
   * Uses google-play-scraper (no auth needed).
   */
  async checkVersion(packageName: string): Promise<VersionCheckResult | null> {
    try {
      await this.rateLimit();
      const result = await gplay.app({ appId: packageName, lang: 'en', country: 'us' });
      return {
        versionName: result.version,
        appName: result.title,
      };
    } catch (err: any) {
      log(`Play Store check failed for ${packageName}: ${err.message}`);
      return null;
    }
  }

  /**
   * Download an APK using apkeep.
   * Uses Google Play (with credentials) if configured, otherwise falls back to APKPure (no auth).
   */
  async downloadApk(packageName: string, _appName: string): Promise<DownloadResult> {
    // Ensure apkeep binary is available
    const hasApkeep = await this.ensureApkeep();
    if (!hasApkeep) {
      return { success: false, error: 'Failed to download apkeep binary' };
    }

    // Try Google Play first if credentials are configured
    const email = this.getSetting('google_play_email');
    const token = this.getSetting('google_play_aas_token');
    const useGooglePlay = !!(email && token);

    if (useGooglePlay) {
      const result = await this.runApkeepDownload(packageName, [
        '-a', packageName,
        '-d', 'google-play',
        '-e', email!,
        '-t', token!,
      ], 'Google Play');

      if (result.success) return result;

      // Fall back to APKPure on Google Play failure
      log(`Google Play download failed for ${packageName}, falling back to APKPure`);
    }

    // APKPure — no auth needed (default apkeep source)
    return this.runApkeepDownload(packageName, [
      '-a', packageName,
    ], 'APKPure');
  }

  /** Run apkeep with given args, process the downloaded APK. */
  private async runApkeepDownload(
    packageName: string,
    apkeepArgs: string[],
    sourceName: string,
  ): Promise<DownloadResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-apkeep-'));

    try {
      log(`Downloading ${packageName} via apkeep (${sourceName})...`);

      await runApkeep([...apkeepArgs, tmpDir]);

      // Find downloaded files — apkeep may produce .apk or .xapk (split APK bundle)
      const allFiles = fs.readdirSync(tmpDir);
      const apkFiles = allFiles.filter(f => f.endsWith('.apk'));
      const xapkFiles = allFiles.filter(f => f.endsWith('.xapk'));

      // Both cases stage into the package dir. The tracker dedups first and
      // finalizes the move only when the version is kept, so a deduped download
      // can't overwrite/delete a stored APK.
      const pkgDir = path.join(APK_DIR, packageName);
      fs.mkdirSync(pkgDir, { recursive: true });

      if (xapkFiles.length > 0) {
        // XAPK is a ZIP of base.apk + config/density/ABI splits (the splits hold
        // native libraries). Explode the whole set into a staged dir on pkgDir's
        // filesystem so the tracker's finalize is a rename, not a copy.
        const xapkPath = path.join(tmpDir, xapkFiles[0]);
        log(`Exploding XAPK bundle: ${xapkFiles[0]} (${(fs.statSync(xapkPath).size / 1024 / 1024).toFixed(1)} MB)`);
        const splitDir = path.join(pkgDir, `.dl-${crypto.randomUUID()}`);
        const unpacked = await unpackApkBundle(xapkPath, splitDir);

        const versionInfo = readApkVersion(unpacked.baseApk);
        if (!versionInfo.versionCode) {
          fs.rmSync(splitDir, { recursive: true, force: true });
          log(`Could not extract versionCode from base APK for ${packageName}`);
          return { success: false, error: 'Could not extract versionCode from downloaded APK' };
        }
        const versionName = versionInfo.versionName || 'unknown';
        const totalSize = unpacked.apkFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
        if (totalSize < 1000) {
          fs.rmSync(splitDir, { recursive: true, force: true });
          return { success: false, error: 'Downloaded APK file too small' };
        }

        log(`Downloaded ${packageName} v${versionName} (${versionInfo.versionCode}) — ${unpacked.apkFiles.length} split(s), ${totalSize} bytes via ${sourceName}`);
        // splitDir is a STAGED directory; the tracker finalizes or discards it.
        return {
          success: true,
          splitDir,
          versionCode: versionInfo.versionCode,
          versionName,
          fileSize: totalSize,
        };
      }

      if (apkFiles.length === 0) {
        log(`apkeep produced no APK/XAPK files for ${packageName} (${sourceName}), got: ${allFiles.join(', ') || '(empty)'}`);
        return { success: false, error: `apkeep produced no downloadable files (${sourceName})` };
      }

      const apkPath = path.join(tmpDir, apkFiles[0]);
      const apkSize = fs.statSync(apkPath).size;
      if (apkSize < 1000) {
        log(`Downloaded APK too small (${apkSize} bytes) for ${packageName}`);
        return { success: false, error: 'Downloaded APK file too small' };
      }

      log(`apkeep downloaded ${packageName}: ${path.basename(apkPath)} (${(apkSize / 1024 / 1024).toFixed(1)} MB) from ${sourceName}`);

      // Extract version info from the APK
      const versionInfo = readApkVersion(apkPath);
      if (!versionInfo.versionCode) {
        log(`Could not extract versionCode from APK for ${packageName}`);
        return { success: false, error: 'Could not extract versionCode from downloaded APK' };
      }

      const versionName = versionInfo.versionName || 'unknown';
      const stagedPath = path.join(pkgDir, `.dl-${crypto.randomUUID()}.apk`);

      fs.copyFileSync(apkPath, stagedPath);
      const fileSize = fs.statSync(stagedPath).size;

      log(`Downloaded ${packageName} v${versionName} (${versionInfo.versionCode}) — ${fileSize} bytes via ${sourceName}`);

      // filePath is a STAGED file; the tracker finalizes or discards it.
      return {
        success: true,
        filePath: stagedPath,
        versionCode: versionInfo.versionCode,
        versionName,
        fileSize,
      };
    } catch (err: any) {
      error(`apkeep download failed for ${packageName} (${sourceName}): ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  }
}
