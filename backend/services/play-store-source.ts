import gplay from 'google-play-scraper';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { eq } from 'drizzle-orm';
import AdmZip from 'adm-zip';
import { readApkVersion } from '../utils/apk-version-reader';
import { createLoggers } from '../logs';
import { settings } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { APK_DIR } from '../utils/apk-paths';

const { log, error } = createLoggers('play-store');
const TOOLS_DIR = path.resolve('./data/tools');
const APKEEP_DIR = path.join(TOOLS_DIR, 'apkeep');
const APKEEP_BIN = path.join(APKEEP_DIR, 'apkeep');
const MIN_REQUEST_INTERVAL = 2000; // 2s between Play Store API calls

const APKEEP_VERSION = '0.18.0';
const APKEEP_DOWNLOAD_URL = `https://github.com/EFForg/apkeep/releases/download/${APKEEP_VERSION}/apkeep-x86_64-unknown-linux-gnu`;

export interface VersionCheckResult {
  versionName: string;
  appName: string;
}

export interface DownloadResult {
  success: boolean;
  filePath?: string;
  versionCode?: number;
  versionName?: string;
  fileSize?: number;
  error?: string;
}

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

/**
 * Extract the base APK from an XAPK bundle.
 * XAPK is a ZIP containing one or more .apk files + a manifest.json.
 */
function extractBaseApkFromXapk(xapkPath: string, tmpDir: string): string | null {
  try {
    const zip = new AdmZip(xapkPath);
    const entries = zip.getEntries();

    const apkEntries = entries.filter(e => e.entryName.endsWith('.apk'));
    if (apkEntries.length === 0) return null;

    // Prefer "base.apk" or non-split APK, otherwise take the largest
    const base = apkEntries.find(e => e.entryName === 'base.apk' || !e.entryName.includes('split'))
      || apkEntries.reduce((a, b) => a.header.size > b.header.size ? a : b);

    const outPath = path.join(tmpDir, 'base.apk');
    zip.extractEntryTo(base, tmpDir, false, true);
    const extractedName = path.join(tmpDir, path.basename(base.entryName));
    if (extractedName !== outPath && fs.existsSync(extractedName)) {
      fs.renameSync(extractedName, outPath);
    }

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      return outPath;
    }
    return null;
  } catch (err: any) {
    error(`Failed to extract base APK from XAPK: ${err.message}`);
    return null;
  }
}

export class PlayStoreSource {
  private lastRequestTime = 0;
  private db: AppDatabase | null = null;

  setDatabase(db: AppDatabase): void {
    this.db = db;
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

      let apkPath: string;

      if (apkFiles.length > 0) {
        apkPath = path.join(tmpDir, apkFiles[0]);
      } else if (xapkFiles.length > 0) {
        // XAPK is a ZIP containing base.apk + split APKs — extract the base APK
        const xapkPath = path.join(tmpDir, xapkFiles[0]);
        log(`Extracting base APK from XAPK bundle: ${xapkFiles[0]} (${(fs.statSync(xapkPath).size / 1024 / 1024).toFixed(1)} MB)`);
        const extracted = extractBaseApkFromXapk(xapkPath, tmpDir);
        if (!extracted) {
          return { success: false, error: 'Failed to extract base APK from XAPK bundle' };
        }
        apkPath = extracted;
      } else {
        log(`apkeep produced no APK/XAPK files for ${packageName} (${sourceName}), got: ${allFiles.join(', ') || '(empty)'}`);
        return { success: false, error: `apkeep produced no downloadable files (${sourceName})` };
      }

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
      const filename = `${versionInfo.versionCode}_${versionName}.apk`;
      const pkgDir = path.join(APK_DIR, packageName);
      fs.mkdirSync(pkgDir, { recursive: true });
      const finalPath = path.join(pkgDir, filename);

      fs.copyFileSync(apkPath, finalPath);
      const fileSize = fs.statSync(finalPath).size;

      log(`Downloaded ${packageName} v${versionName} (${versionInfo.versionCode}) — ${fileSize} bytes via ${sourceName}`);

      return {
        success: true,
        filePath: finalPath,
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
