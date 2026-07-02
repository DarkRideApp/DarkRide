import { eq, desc, sql, inArray } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import AdmZip from 'adm-zip';
import { registerEndpoint } from './api-service';
import { trackedApps, apkVersions, analysisJobs, apkContents, apkDiffReports, devices, appSources } from '../db/schema';
import { and } from 'drizzle-orm';
import { ensureAppSources } from '../services/apk-sources';
import { sourceLabel, type RemoteApkSource } from '../services/apk-sources/types';
import type { SourceRegistry } from '../services/apk-sources/registry';
import { adbShell, adbCommand, adbPull } from '../services/device-manager';
import type { DeviceManager } from '../services/device-manager';
import type { IosDeviceManager } from '../services/ios-device-manager';
import type { ApkTracker } from '../services/apk-tracker';
import { extractIconFromLocalApk, fetchIconFromGooglePlay, fetchIconFromSources } from '../services/apk-tracker';
import type { ApkAnalyzerService } from '../services/apk-analyzer';
import type { FileStorageService } from '../services/file-storage';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';
import { APK_DIR, packageDir, apkFilePath } from '../utils/apk-paths';
import { safeJoinInside } from '../utils/safe-path';
import { enumerateApkPaths } from '../utils/apk-utils';
import { isValidPackageName } from '../utils/validators';
import { computeVersionAvailability } from '../services/apk-availability';

const execFileAsync = promisify(execFile);
const { log, error } = createLoggers('apps-api');

// In-memory icon cache: key = "deviceId:packageName", value = { base64, expiry }
const iconCache = new Map<string, { base64: string | null; expiry: number }>();
const ICON_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// In-memory app list cache: key = deviceId, value = { data, fetchedAt }
interface AppListCacheEntry {
  data: any[];
  fetchedAt: number; // Date.now()
}
const appListCache = new Map<string, AppListCacheEntry>();
const APP_LIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Expose cache invalidation for external callers (e.g. when device goes offline). */
export function clearAppListCache(deviceId: string): void {
  appListCache.delete(deviceId);
}

/** In-flight one-off fetches keyed by `${trackedAppId}:${source}` (concurrency coalescing). */
const inFlightFetches = new Map<string, Promise<{ newVersionId: number | null; error?: string; notFound?: boolean }>>();

/**
 * Fire (or join) a coalesced force-fetch for one (app, source). A double-click,
 * or an add-with-fetch overlapping the scheduled scan, shouldn't launch two
 * 100MB pulls — concurrent triggers for the same key share one in-flight
 * promise. Shared by the explicit "Fetch now" endpoint and add-on-fetch.
 */
function coalescedFetch(
  apkTracker: ApkTracker,
  app: { id: number; packageName: string; appName: string | null },
  source: RemoteApkSource,
): Promise<{ newVersionId: number | null; error?: string; notFound?: boolean }> {
  const key = `${app.id}:${source.id}`;
  let pending = inFlightFetches.get(key);
  if (!pending) {
    // force: ignore the enabled flag + last-version skip for an explicit fetch.
    pending = apkTracker.checkRemoteSource(app, source, { force: true })
      .finally(() => inFlightFetches.delete(key));
    inFlightFetches.set(key, pending);
  }
  return pending;
}

/** Upsert the enabled flag on an app's app_sources row for a given source. */
function setSourceEnabled(db: AppDatabase, trackedAppId: number, source: string, enabled: boolean): void {
  // Atomic upsert on the (tracked_app_id, source) unique key — a single
  // statement so a concurrent toggle + tracker seeding can't both see "no row"
  // and race into a duplicate-insert that violates the constraint.
  db.insert(appSources)
    .values({ trackedAppId, source, enabled, createdAt: new Date() })
    .onConflictDoUpdate({ target: [appSources.trackedAppId, appSources.source], set: { enabled } })
    .run();
}

/**
 * Apply the Add-App store selection. Enables/disables each named source on the
 * app's app_sources rows (unknown ids ignored — fail closed); then, when
 * `fetch` is set, kicks off a NON-blocking coalesced fetch for every enabled
 * remote source. A QQ APK can be 100MB, so we never block the track response:
 * the version populates via the apk:version-pulled WS event, and any fetch
 * failure is recorded on the app_sources row (shown on the Sources panel)
 * rather than failing the add.
 */
function applyTrackSources(
  db: AppDatabase,
  sourceRegistry: SourceRegistry | undefined,
  apkTracker: ApkTracker | undefined,
  app: { id: number; packageName: string; appName: string | null },
  sources: unknown,
  fetch: boolean,
): void {
  if (!sourceRegistry) return;
  if (sources && typeof sources === 'object') {
    for (const [sourceId, enabled] of Object.entries(sources as Record<string, unknown>)) {
      if (typeof enabled !== 'boolean') continue;
      if (!sourceRegistry.has(sourceId)) continue; // ignore unknown ids
      setSourceEnabled(db, app.id, sourceId, enabled);
    }
  }
  if (!fetch || !apkTracker) return;
  const rows = db.select().from(appSources).where(eq(appSources.trackedAppId, app.id)).all();
  for (const row of rows) {
    if (!row.enabled) continue;
    const source = sourceRegistry.get(row.source);
    if (!source) continue;
    coalescedFetch(apkTracker, app, source).catch(() => { /* recorded on the row */ });
  }
}

// extractIconFromLocalApk and fetchIconFromGooglePlay imported from apk-tracker.ts

/** Resolve which icon file exists for a package (icon.png or icon.webp). */
function resolveIconPath(packageName: string): { path: string; contentType: string } | null {
  const pngPath = apkFilePath(packageName, 'icon.png');
  if (fs.existsSync(pngPath)) return { path: pngPath, contentType: 'image/png' };
  const webpPath = apkFilePath(packageName, 'icon.webp');
  if (fs.existsSync(webpPath)) return { path: webpPath, contentType: 'image/webp' };
  return null;
}

/**
 * Try to fetch and save an app icon from a device to disk.
 * Falls back to extracting from local APK if device method fails.
 * Best-effort — silently ignores failures.
 */
async function saveAppIconFromDevice(
  deviceId: string,
  packageName: string,
  db: AppDatabase,
  sourceRegistry: SourceRegistry | undefined,
): Promise<void> {
  if (resolveIconPath(packageName)) return;

  // Method 1: cmd package dump-icon (Android 13+)
  try {
    const check = await adbShell(deviceId, `cmd package dump-icon ${packageName}`, 5000);
    if (check && !check.includes('Error') && !check.includes('Unknown')) {
      const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'exec-out', 'cmd', 'package', 'dump-icon', packageName], {
        maxBuffer: 1024 * 1024,
        timeout: 5000,
        encoding: 'buffer',
      });
      if (stdout.length > 100) {
        fs.mkdirSync(packageDir(packageName), { recursive: true });
        fs.writeFileSync(apkFilePath(packageName, 'icon.png'), stdout);
        return;
      }
    }
  } catch { /* try fallback */ }

  // Method 2: Extract from local APK file
  if (extractIconFromLocalApk(packageName)) return;

  // Method 3: Fetch from the stores this app is tracked on (works for
  // adaptive-icon apps and China-store apps not on Google Play).
  if (await fetchIconFromSources(db, sourceRegistry, packageName)) return;

  // Method 4: Fetch from Google Play Store
  await fetchIconFromGooglePlay(packageName);
}

interface InstalledApp {
  packageName: string;
  appName: string | null;
  versionCode: number | null;
  versionName: string | null;
  isTracked: boolean;
  trackedAppId: number | null;
}

/**
 * Parse app label, versionCode, and versionName from `dumpsys package` output.
 */
function parseDumpsysPackage(output: string): {
  appName: string | null;
  versionCode: number | null;
  versionName: string | null;
} {
  let appName: string | null = null;
  let versionCode: number | null = null;
  let versionName: string | null = null;

  // Find the Packages: section for more reliable parsing
  const lines = output.split('\n');
  let inPackagesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'Packages:') {
      inPackagesSection = true;
      continue;
    }

    if (inPackagesSection) {
      // versionCode comes as "versionCode=123 ..."
      const vcMatch = trimmed.match(/^versionCode=(\d+)/);
      if (vcMatch && versionCode === null) {
        versionCode = parseInt(vcMatch[1], 10);
      }

      // versionName comes as "versionName=1.2.3"
      const vnMatch = trimmed.match(/^versionName=(.+)/);
      if (vnMatch && versionName === null) {
        versionName = vnMatch[1].trim();
      }
    }

    // Application label can appear in various places
    const labelMatch = trimmed.match(/^application-label(?:-[a-z]{2})?:'(.+)'$/);
    if (labelMatch && !appName) {
      appName = labelMatch[1];
    }
  }

  return { appName, versionCode, versionName };
}

/**
 * Get the app label via aapt on the device (more reliable for app names).
 */
async function getAppLabel(deviceId: string, packageName: string): Promise<string | null> {
  try {
    // Get the APK path first
    const pathOutput = await adbShell(deviceId, `pm path ${packageName}`, 5000);
    const apkPath = pathOutput.split('\n')[0]?.replace('package:', '').trim();
    if (!apkPath) return null;

    // Try to get label via aapt
    const aaptOutput = await adbShell(deviceId, `aapt dump badging ${apkPath} 2>/dev/null | head -1`, 5000);
    const labelMatch = aaptOutput.match(/application-label:'([^']+)'/);
    return labelMatch ? labelMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build a shell script that lists all third-party apps with metadata in one shot.
 * Uses aapt (fast) with dumpsys fallback. Outputs tab-separated lines: APP\tpkg\tvc\tvn\tlabel
 */
function buildListAppsScript(): string {
  return [
    '#!/system/bin/sh',
    'HAS_AAPT=0',
    'command -v aapt >/dev/null 2>&1 && HAS_AAPT=1',
    '',
    'pm list packages -3 -f | while IFS= read -r line; do',
    '  rest="${line#package:}"',
    '  pkg="${rest##*=}"',
    '  apk="${rest%=$pkg}"',
    '  vc=""',
    '  vn=""',
    '  label=""',
    '',
    '  if [ "$HAS_AAPT" = "1" ] && [ -f "$apk" ]; then',
    '    badging=$(aapt dump badging "$apk" 2>/dev/null | head -3)',
    '    if [ -n "$badging" ]; then',
    "      vc=$(echo \"$badging\" | grep -o \"versionCode='[^']*'\" | head -1 | cut -d\"'\" -f2)",
    "      vn=$(echo \"$badging\" | grep -o \"versionName='[^']*'\" | head -1 | cut -d\"'\" -f2)",
    '      label_line=$(echo "$badging" | grep "application-label" | head -1)',
    '      if [ -n "$label_line" ]; then',
    '        label="${label_line#*:}"',
    '        label="${label#?}"',
    '        label="${label%?}"',
    '      fi',
    '    fi',
    '  else',
    '    info=$(dumpsys package "$pkg" 2>/dev/null)',
    '    vc=$(echo "$info" | grep "versionCode=" | head -1)',
    '    vc="${vc#*versionCode=}"',
    '    vc="${vc%% *}"',
    '    vn_line=$(echo "$info" | grep "versionName=" | head -1)',
    '    vn="${vn_line#*versionName=}"',
    '  fi',
    '',
    "  printf 'APP\\t%s\\t%s\\t%s\\t%s\\n' \"$pkg\" \"$vc\" \"$vn\" \"$label\"",
    'done',
  ].join('\n');
}

/**
 * Get all installed third-party apps with metadata via a single batched ADB command.
 * Pushes a shell script to the device instead of running hundreds of individual adb calls.
 */
async function getInstalledAppsFast(deviceId: string): Promise<Array<{
  packageName: string;
  appName: string | null;
  versionCode: number | null;
  versionName: string | null;
}>> {
  const scriptContent = buildListAppsScript();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-apps-'));
  const tmpScript = path.join(tmpDir, 'list_apps.sh');
  try {
    fs.writeFileSync(tmpScript, scriptContent, 'utf-8');
    await adbCommand(['-s', deviceId, 'push', tmpScript, '/data/local/tmp/darkride_list_apps.sh']);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }

  const output = await adbShell(
    deviceId,
    'sh /data/local/tmp/darkride_list_apps.sh; rm -f /data/local/tmp/darkride_list_apps.sh',
    60000,
  );

  const apps: Array<{
    packageName: string;
    appName: string | null;
    versionCode: number | null;
    versionName: string | null;
  }> = [];

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('APP\t')) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const pkg = parts[1];
    if (!pkg) continue;

    const vcNum = parts[2] ? parseInt(parts[2], 10) : null;
    apps.push({
      packageName: pkg,
      appName: parts[4] || null,
      versionCode: vcNum !== null && !isNaN(vcNum) ? vcNum : null,
      versionName: parts[3] || null,
    });
  }

  return apps;
}

export function registerAppEndpoints(
  deviceManager: DeviceManager,
  db: AppDatabase,
  apkTracker?: ApkTracker,
  apkAnalyzer?: ApkAnalyzerService,
  fileSync?: FileStorageService,
  iosDeviceManager?: IosDeviceManager,
  sourceRegistry?: SourceRegistry,
): void {
  // GET /v1/device/apps/:deviceId — List installed third-party apps
  registerEndpoint('GET', '/v1/device/apps/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId as string;
    const force = req.query.force === 'true';

    // iOS: use InstallationProxyService via bridge
    const deviceRow = db.select().from(devices).where(eq(devices.id, deviceId)).all()[0];
    if (deviceRow?.platform === 'ios') {
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      // Return cached data if valid and not a force refresh
      if (!force) {
        const cached = appListCache.get(deviceId);
        if (cached && (Date.now() - cached.fetchedAt) < APP_LIST_CACHE_TTL_MS) {
          res.json({ success: true, data: cached.data });
          return;
        }
      }
      try {
        const apps = await iosDeviceManager.listApps(deviceId);
        // Map iOS app fields to InstalledApp-compatible shape
        const mapped = apps.map(a => ({
          packageName: a.packageName,
          appName: a.name,
          versionCode: a.versionCode ? parseInt(a.versionCode, 10) || null : null,
          versionName: a.versionName || null,
          isTracked: false,
          trackedAppId: null,
        }));
        appListCache.set(deviceId, { data: mapped, fetchedAt: Date.now() });
        res.json({ success: true, data: mapped });
      } catch (err: any) {
        error(`Failed to list iOS apps for ${deviceId}: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }

    if (!deviceManager.isOnline(deviceId)) {
      res.status(400).json({ success: false, error: 'Device is not online' });
      return;
    }

    // Return cached data if valid and not a force refresh
    if (!force) {
      const cached = appListCache.get(deviceId);
      if (cached && (Date.now() - cached.fetchedAt) < APP_LIST_CACHE_TTL_MS) {
        res.json({ success: true, data: cached.data });
        return;
      }
    }

    try {
      const appList = await getInstalledAppsFast(deviceId);

      // Get tracked apps from DB
      const tracked = db.select().from(trackedApps).all();
      const trackedMap = new Map(tracked.map(t => [t.packageName, t.id]));

      const apps: InstalledApp[] = appList.map(a => ({
        ...a,
        isTracked: trackedMap.has(a.packageName),
        trackedAppId: trackedMap.get(a.packageName) ?? null,
      }));

      // Sort by app name (alphabetical), packages without names go to end
      apps.sort((a, b) => {
        const na = (a.appName || a.packageName).toLowerCase();
        const nb = (b.appName || b.packageName).toLowerCase();
        return na.localeCompare(nb);
      });

      // Store in cache
      appListCache.set(deviceId, { data: apps, fetchedAt: Date.now() });

      res.json({ success: true, data: apps });
    } catch (err: any) {
      error(`Failed to list apps for ${deviceId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/device/app-icon/:deviceId/:packageName — Get app icon as base64 PNG
  registerEndpoint('GET', '/v1/device/app-icon/:deviceId/:packageName', async (req, res) => {
    const deviceId = req.params.deviceId as string;
    const packageName = req.params.packageName as string;

    if (!isValidPackageName(packageName)) {
      res.status(400).json({ success: false, error: 'Invalid package name' });
      return;
    }

    // Check cache
    const cacheKey = `${deviceId}:${packageName}`;
    const cached = iconCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      res.json({ success: true, data: { icon: cached.base64 } });
      return;
    }

    if (!deviceManager.isOnline(deviceId)) {
      res.json({ success: true, data: { icon: null } });
      return;
    }

    try {
      // Try Android 13+ dump-icon command
      const iconData = await adbShell(deviceId, `cmd package dump-icon ${packageName}`, 5000);
      if (iconData && !iconData.includes('Error') && !iconData.includes('Unknown')) {
        // The output is raw PNG data — convert to base64
        const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'exec-out', 'cmd', 'package', 'dump-icon', packageName], {
          maxBuffer: 1024 * 1024,
          timeout: 5000,
          encoding: 'buffer',
        });
        const buf = stdout;
        if (buf.length > 100) { // valid PNG should be larger than 100 bytes
          const base64 = buf.toString('base64');
          iconCache.set(cacheKey, { base64, expiry: Date.now() + ICON_CACHE_TTL });
          // Persist to disk for APK browser
          const iconDiskPath = apkFilePath(packageName, 'icon.png');
          try {
            fs.mkdirSync(packageDir(packageName), { recursive: true });
            fs.writeFileSync(iconDiskPath, buf);
          } catch {}
          res.json({ success: true, data: { icon: base64 } });
          return;
        }
      }
    } catch {
      // Fallback: no icon available
    }

    iconCache.set(cacheKey, { base64: null, expiry: Date.now() + ICON_CACHE_TTL });
    res.json({ success: true, data: { icon: null } });
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/icon/:packageName — Serve cached app icon (PNG/WebP) from disk
  registerEndpoint('GET', '/v1/apps/icon/:packageName', async (req, res) => {
    const packageName = req.params.packageName as string;

    if (!isValidPackageName(packageName)) {
      res.status(400).json({ success: false, error: 'Invalid package name' });
      return;
    }

    // Fast path: serve from disk cache
    const cached = resolveIconPath(packageName);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(cached.path).pipe(res as any);
      return;
    }

    // Try fetching from device (also falls back to local APK extraction)
    try {
      const allDevices = await deviceManager.getAllDeviceStatuses();
      const firstOnline = allDevices.find(d => d.isOnline);
      if (firstOnline) {
        await saveAppIconFromDevice(firstOnline.id, packageName, db, sourceRegistry);
      } else {
        // No device online — try local extraction, then the tracked stores,
        // then Google Play.
        if (!extractIconFromLocalApk(packageName) &&
            !(await fetchIconFromSources(db, sourceRegistry, packageName))) {
          await fetchIconFromGooglePlay(packageName);
        }
      }

      const resolved = resolveIconPath(packageName);
      if (resolved) {
        res.setHeader('Content-Type', resolved.contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(resolved.path).pipe(res as any);
        return;
      }
    } catch {}

    // Last resort: if APK was evicted to cloud, temporarily fetch it to extract the icon
    if (fileSync) {
      try {
        const app = db.select().from(trackedApps).where(eq(trackedApps.packageName, packageName)).all()[0];
        if (app) {
          const latestVersion = db.select().from(apkVersions)
            .where(eq(apkVersions.trackedAppId, app.id))
            .orderBy(desc(apkVersions.versionCode))
            .limit(1)
            .all()[0];
          if (latestVersion) {
            const { ensureApkLocal } = await import('../utils/apk-paths');
            const handle = await ensureApkLocal(packageName, latestVersion.filename, fileSync, 'icon-extract');
            if (!('error' in handle)) {
              try {
                extractIconFromLocalApk(packageName);
              } finally {
                handle.release();
              }
              const resolved = resolveIconPath(packageName);
              if (resolved) {
                res.setHeader('Content-Type', resolved.contentType);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                fs.createReadStream(resolved.path).pipe(res as any);
                return;
              }
            }
          }
        }
      } catch {}
    }

    res.status(404).json({ success: false, error: 'Icon not available' });
  }, { requires: ['core.apk:read'] });

  // POST /v1/device/pull-apk/:deviceId — Pull APK from device and save to disk
  registerEndpoint('POST', '/v1/device/pull-apk/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId as string;
    const { packageName } = req.body;

    if (!packageName || typeof packageName !== 'string') {
      res.status(400).json({ success: false, error: 'packageName is required' });
      return;
    }

    if (!deviceManager.isOnline(deviceId)) {
      res.status(400).json({ success: false, error: 'Device is not online' });
      return;
    }

    try {
      // Get APK paths on device (split APKs return multiple paths)
      const pathOutput = await adbShell(deviceId, `pm path ${packageName}`, 5000);
      let apkPaths = pathOutput.split('\n')
        .map(l => l.replace(/\r$/, '').replace('package:', '').trim())
        .filter(Boolean);
      if (apkPaths.length === 0) {
        res.status(404).json({ success: false, error: 'APK path not found' });
        return;
      }

      // pm path can omit base.apk on some Android versions for split APKs.
      // Enumerate the on-device directory directly so we never miss a file.
      apkPaths = await enumerateApkPaths(deviceId, apkPaths);

      // Get version info
      const dumpsys = await adbShell(deviceId, `dumpsys package ${packageName}`, 10000);
      const { versionCode, versionName, appName } = parseDumpsysPackage(dumpsys);

      const vc = versionCode ?? 0;
      const vn = versionName ?? 'unknown';

      // Prepare local directory
      const pkgDir = packageDir(packageName);
      fs.mkdirSync(pkgDir, { recursive: true });

      const isSplit = apkPaths.length > 1;
      let filename: string;
      let totalSize = 0;

      if (isSplit) {
        // Split APK: store in subdirectory
        filename = `${vc}_${vn}`;
        const splitDir = safeJoinInside(pkgDir, filename);
        fs.mkdirSync(splitDir, { recursive: true });
        for (const apkPath of apkPaths) {
          const apkName = path.basename(apkPath);
          const localPath = path.join(splitDir, apkName);
          await adbPull(deviceId, apkPath, localPath);
          totalSize += fs.statSync(localPath).size;
        }
        log(`Pulled split APK (${apkPaths.length} files) for ${packageName} v${vn} from ${deviceId}`);
      } else {
        // Single APK
        filename = `${vc}_${vn}.apk`;
        const localPath = safeJoinInside(pkgDir, filename);
        await adbPull(deviceId, apkPaths[0], localPath);
        totalSize = fs.statSync(localPath).size;
      }

      // Ensure tracked app exists (auto-create if pulling)
      let tracked = db.select().from(trackedApps)
        .where(eq(trackedApps.packageName, packageName))
        .all()[0];

      if (!tracked) {
        // Auto-create tracked entry
        const label = appName || await getAppLabel(deviceId, packageName);
        db.insert(trackedApps)
          .values({
            packageName,
            appName: label,
            createdAt: new Date(),
          })
          .run();
        tracked = db.select().from(trackedApps)
          .where(eq(trackedApps.packageName, packageName))
          .all()[0];
      }

      // Check if this version already exists
      const existingVersion = db.select().from(apkVersions)
        .where(eq(apkVersions.trackedAppId, tracked!.id))
        .all()
        .find(v => v.versionCode === vc);

      if (existingVersion) {
        // Update app name if missing
        if (tracked && !tracked.appName && appName) {
          db.update(trackedApps).set({ appName }).where(eq(trackedApps.id, tracked.id)).run();
        }
        saveAppIconFromDevice(deviceId, packageName, db, sourceRegistry).catch(() => {});
        res.json({ success: true, data: existingVersion });
        return;
      }

      // Insert version record
      db.insert(apkVersions)
        .values({
          trackedAppId: tracked!.id,
          versionCode: vc,
          versionName: vn,
          filename,
          fileSize: totalSize,
          deviceId,
          source: 'device',
          downloadedAt: new Date(),
        })
        .run();

      // Get inserted record
      const versions = db.select().from(apkVersions)
        .where(eq(apkVersions.trackedAppId, tracked!.id))
        .all();
      const inserted = versions[versions.length - 1];

      // Update app name if missing
      if (tracked && !tracked.appName && appName) {
        db.update(trackedApps).set({ appName }).where(eq(trackedApps.id, tracked.id)).run();
      }
      // Fire-and-forget: cache icon
      saveAppIconFromDevice(deviceId, packageName, db, sourceRegistry).catch(() => {});

      log(`Pulled APK for ${packageName} v${vn} (${vc}) from ${deviceId}`);
      // Auto-enqueue for analysis
      if (apkAnalyzer && inserted) {
        apkAnalyzer.enqueue(inserted.id).catch(() => {});
      }
      res.json({ success: true, data: inserted });
    } catch (err: any) {
      error(`Failed to pull APK ${packageName} from ${deviceId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:manage'] });

  // POST /v1/apps/track — Start tracking a package
  registerEndpoint('POST', '/v1/apps/track', (req, res) => {
    const { packageName, appName } = req.body;

    if (!packageName || typeof packageName !== 'string') {
      res.status(400).json({ success: false, error: 'packageName is required' });
      return;
    }
    // Validate before persisting — this value becomes the DB-canonical id and
    // flows into cloud keys + the QQ request body.
    if (!isValidPackageName(packageName)) {
      res.status(400).json({ success: false, error: 'Invalid packageName' });
      return;
    }

    // Check if already tracked
    const existing = db.select().from(trackedApps)
      .where(eq(trackedApps.packageName, packageName))
      .all()[0];

    // Optional store selection from the Add App modal: { qq: true, ... } plus
    // an optional `fetch` flag to pull immediately from the enabled stores.
    const { sources, fetch } = req.body as { sources?: unknown; fetch?: unknown };
    const fetchNow = fetch === true;

    if (existing) {
      if (sourceRegistry) ensureAppSources(db, existing.id, sourceRegistry);
      applyTrackSources(db, sourceRegistry, apkTracker,
        { id: existing.id, packageName: existing.packageName, appName: existing.appName }, sources, fetchNow);
      res.json({ success: true, data: existing });
      return;
    }

    db.insert(trackedApps)
      .values({
        packageName,
        appName: appName || null,
        createdAt: new Date(),
      })
      .run();

    const inserted = db.select().from(trackedApps)
      .where(eq(trackedApps.packageName, packageName))
      .all()[0];

    // Seed per-source rows (Play Store on by default, QQ opt-in) so the app
    // can be fetched remotely with no device attached, then apply the modal's
    // explicit selection + optional immediate fetch.
    if (sourceRegistry) ensureAppSources(db, inserted.id, sourceRegistry);
    applyTrackSources(db, sourceRegistry, apkTracker,
      { id: inserted.id, packageName: inserted.packageName, appName: inserted.appName }, sources, fetchNow);

    res.status(201).json({ success: true, data: inserted });
  }, { requires: ['core.apk:manage'] });

  // GET /v1/apps/sources — list available remote stores (registry-level, no app
  // needed) so the Add App modal can render a store picker dynamically.
  registerEndpoint('GET', '/v1/apps/sources', (_req, res) => {
    const data = (sourceRegistry?.all() ?? []).map(s => ({
      source: s.id,
      label: s.label,
      defaultEnabled: s.defaultEnabled(),
    }));
    res.json({ success: true, data });
  }, { requires: ['core.apk:read'] });

  // PATCH /v1/apps/track/:id — Update per-app settings (e.g. autoFetchPlayStore)
  registerEndpoint('PATCH', '/v1/apps/track/:id', (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }

    const existing = db.select().from(trackedApps)
      .where(eq(trackedApps.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }

    // Back-compat: `autoFetchPlayStore` now lives in app_sources('playstore').
    if (typeof req.body.autoFetchPlayStore === 'boolean') {
      setSourceEnabled(db, id, 'playstore', req.body.autoFetchPlayStore);
    }
    if (typeof req.body.appName === 'string') {
      const appName = req.body.appName.trim();
      // Reject blank renames (the tracker's `!appName` auto-fill would re-clobber
      // them anyway) and cap length defensively.
      if (appName.length === 0 || appName.length > 200) {
        res.status(400).json({ success: false, error: 'appName must be 1–200 non-blank characters' });
        return;
      }
      db.update(trackedApps).set({ appName }).where(eq(trackedApps.id, id)).run();
    }

    const updated = db.select().from(trackedApps)
      .where(eq(trackedApps.id, id))
      .all()[0];

    res.json({ success: true, data: updated });
  }, { requires: ['core.apk:manage'] });

  // GET /v1/apps/track/:id/sources — per-app remote source config + health
  registerEndpoint('GET', '/v1/apps/track/:id/sources', (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }
    const app = db.select().from(trackedApps).where(eq(trackedApps.id, id)).all()[0];
    if (!app) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }
    if (sourceRegistry) ensureAppSources(db, id, sourceRegistry);

    const rows = db.select().from(appSources).where(eq(appSources.trackedAppId, id)).all();
    // Order by registry order when available, else stable by source id.
    const order = sourceRegistry?.ids() ?? rows.map(r => r.source);
    const data = rows
      .map(r => {
        const src = sourceRegistry?.get(r.source);
        return {
          source: r.source,
          label: sourceLabel(r.source),
          enabled: !!r.enabled,
          lastVersion: r.lastVersion,
          lastCheckedAt: r.lastCheckedAt,
          lastError: r.lastError,
          // Deep link to the store listing (null when the source has no web page).
          storeUrl: src?.storeUrl ? src.storeUrl(app.packageName) : null,
        };
      })
      .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

    res.json({ success: true, data });
  }, { requires: ['core.apk:read'] });

  // POST /v1/apps/track/:id/sources/check — probe EVERY source's availability
  // with a lightweight checkVersion (no download) and persist the result, so
  // the UI can show whether the app is actually on each store before you decide
  // to enable fetching. lastCheckedAt distinguishes "not on store" (checked, no
  // version, no error) from "not checked yet" (lastCheckedAt null).
  registerEndpoint('POST', '/v1/apps/track/:id/sources/check', async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }
    const app = db.select().from(trackedApps).where(eq(trackedApps.id, id)).all()[0];
    if (!app) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }
    if (!sourceRegistry) {
      res.status(503).json({ success: false, error: 'No remote sources configured' });
      return;
    }
    ensureAppSources(db, id, sourceRegistry);

    const setState = (source: string, patch: Partial<typeof appSources.$inferInsert>) => {
      db.update(appSources).set(patch)
        .where(and(eq(appSources.trackedAppId, id), eq(appSources.source, source))).run();
    };
    // Probe sources concurrently — distinct stores don't share a rate limiter.
    const data = await Promise.all(sourceRegistry.all().map(async (source) => {
      try {
        const info = await source.checkVersion(app.packageName);
        if (info) {
          setState(source.id, { lastVersion: info.versionName, lastCheckedAt: new Date(), lastError: null });
          return { source: source.id, available: true, version: info.versionName, error: null };
        }
        // null = genuinely not on this store (a normal, non-error outcome).
        setState(source.id, { lastVersion: null, lastCheckedAt: new Date(), lastError: null });
        return { source: source.id, available: false, version: null, error: null };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        setState(source.id, { lastCheckedAt: new Date(), lastError: msg });
        return { source: source.id, available: null, version: null, error: msg };
      }
    }));

    res.json({ success: true, data });
  }, { requires: ['core.apk:manage'] });

  // PATCH /v1/apps/track/:id/sources/:source — enable/disable a source
  registerEndpoint('PATCH', '/v1/apps/track/:id/sources/:source', (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    const source = req.params.source as string;
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }
    // Fail closed: only accept known sources (mirrors the fetch endpoint).
    if (!sourceRegistry || !sourceRegistry.has(source)) {
      res.status(400).json({ success: false, error: `Unknown source: ${source}` });
      return;
    }
    if (typeof req.body.enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
      return;
    }
    if (!db.select().from(trackedApps).where(eq(trackedApps.id, id)).all()[0]) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }
    setSourceEnabled(db, id, source, req.body.enabled);
    const row = db.select().from(appSources)
      .where(and(eq(appSources.trackedAppId, id), eq(appSources.source, source))).all()[0];
    res.json({ success: true, data: row });
  }, { requires: ['core.apk:manage'] });

  // POST /v1/apps/track/:id/sources/:source/fetch — fetch now from one source
  registerEndpoint('POST', '/v1/apps/track/:id/sources/:source/fetch', async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    const source = req.params.source as string;
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }
    const app = db.select().from(trackedApps).where(eq(trackedApps.id, id)).all()[0];
    if (!app) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }
    const remoteSource = sourceRegistry?.get(source);
    if (!remoteSource || !apkTracker) {
      res.status(400).json({ success: false, error: `Source not available: ${source}` });
      return;
    }
    try {
      const result = await coalescedFetch(
        apkTracker,
        { id: app.id, packageName: app.packageName, appName: app.appName },
        remoteSource,
      );

      // A download/verify failure is a real error, not a success-with-note.
      if (result.error) {
        res.status(502).json({ success: false, error: result.error });
        return;
      }
      const outcome = result.newVersionId ? 'new' : result.notFound ? 'not-found' : 'up-to-date';
      res.json({ success: true, data: { newVersionId: result.newVersionId, outcome } });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:manage'] });

  // DELETE /v1/apps/track/:id — Stop tracking (keeps archived APKs)
  registerEndpoint('DELETE', '/v1/apps/track/:id', (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }

    const existing = db.select().from(trackedApps)
      .where(eq(trackedApps.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }

    // Delete version records first (FK constraint)
    db.delete(apkVersions).where(eq(apkVersions.trackedAppId, id)).run();
    db.delete(trackedApps).where(eq(trackedApps.id, id)).run();

    res.json({ success: true });
  }, { requires: ['core.apk:manage'] });

  // DELETE /v1/apps/version/:versionId — Delete a single APK version (DB record + files on disk)
  registerEndpoint('DELETE', '/v1/apps/version/:versionId', async (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const version = db.select().from(apkVersions).where(eq(apkVersions.id, versionId)).all()[0];
    if (!version) {
      res.status(404).json({ success: false, error: 'Version not found' });
      return;
    }

    const tracked = db.select().from(trackedApps).where(eq(trackedApps.id, version.trackedAppId)).all()[0];

    // Delete file(s) from disk
    if (tracked) {
      const filePath = apkFilePath(tracked.packageName, version.filename);
      try {
        if (fs.existsSync(filePath)) {
          if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true });
          } else {
            fs.unlinkSync(filePath);
          }
        }
      } catch (err: any) {
        log(`Failed to delete APK file ${filePath}: ${err.message}`);
      }
    }

    // Remove from cloud storage tracking
    if (fileSync && tracked) {
      const cloudKey = `apks/${tracked.packageName}/${version.filename}`;
      await fileSync.removeFile(cloudKey);
    }

    // Delete related rows that FK-reference this apkVersion
    db.delete(analysisJobs).where(eq(analysisJobs.apkVersionId, versionId)).run();
    db.delete(apkContents).where(eq(apkContents.apkVersionId, versionId)).run();
    db.delete(apkDiffReports).where(eq(apkDiffReports.apkVersionId, versionId)).run();
    db.delete(apkDiffReports).where(eq(apkDiffReports.compareVersionId, versionId)).run();
    // mapVersions has a nullable FK — null it out rather than delete the map version
    // Use raw SQL since the maps plugin table may not exist
    try {
      (db as any).run(sql`UPDATE map_versions SET apk_version_id = NULL WHERE apk_version_id = ${versionId}`);
    } catch { /* maps plugin table may not exist */ }

    // Delete DB record
    db.delete(apkVersions).where(eq(apkVersions.id, versionId)).run();

    log(`Deleted APK version ${versionId}${tracked ? ` (${tracked.packageName} v${version.versionCode})` : ''}`);
    res.json({ success: true });
  }, { requires: ['core.apk:manage'] });

  // GET /v1/apps/tracked — List all tracked apps with latest version info
  registerEndpoint('GET', '/v1/apps/tracked', (_req, res) => {
    const tracked = db.select().from(trackedApps).all();

    // Single query: get all versions, group by app in JS
    const allVersions = db.select().from(apkVersions).all();
    const versionsByApp = new Map<number, typeof allVersions>();
    for (const v of allVersions) {
      const list = versionsByApp.get(v.trackedAppId) || [];
      list.push(v);
      versionsByApp.set(v.trackedAppId, list);
    }

    // Resolve each app's latest version up front so the jobs query can be
    // scoped to just those versions (bounded by app count) instead of scanning
    // the whole analysisJobs table.
    const latestByApp = new Map<number, typeof allVersions[number] | null>();
    const latestVersionIds: number[] = [];
    for (const app of tracked) {
      const versions = versionsByApp.get(app.id) || [];
      const latest = versions.length > 0
        ? versions.reduce((a, b) => (a.versionCode > b.versionCode ? a : b))
        : null;
      latestByApp.set(app.id, latest);
      if (latest) latestVersionIds.push(latest.id);
    }

    // Most-recent analysis job for each latest version — exactly one row per
    // version via a MAX(id) GROUP BY subquery (no per-version historical scan).
    const latestJobByVersion = new Map<number, { status: string; stage: string | null; error: string | null }>();
    if (latestVersionIds.length > 0) {
      const maxJobIds = db
        .select({ maxId: sql<number>`max(${analysisJobs.id})`.as('maxId') })
        .from(analysisJobs)
        .where(inArray(analysisJobs.apkVersionId, latestVersionIds))
        .groupBy(analysisJobs.apkVersionId);
      const jobs = db.select().from(analysisJobs).where(inArray(analysisJobs.id, maxJobIds)).all();
      for (const j of jobs) {
        latestJobByVersion.set(j.apkVersionId, { status: j.status, stage: j.stage ?? null, error: j.error ?? null });
      }
    }

    const result = tracked.map(app => {
      const versions = versionsByApp.get(app.id) || [];
      const latest = latestByApp.get(app.id) ?? null;
      const job = latest ? latestJobByVersion.get(latest.id) : undefined;

      return {
        ...app,
        versionCount: versions.length,
        latestVersion: latest,
        latestAnalysis: job ?? null,
      };
    });

    res.json({ success: true, data: result });
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/versions/:trackedAppId — List all APK versions for a tracked app
  registerEndpoint('GET', '/v1/apps/versions/:trackedAppId', (req, res) => {
    const trackedAppId = parseInt(req.params.trackedAppId as string, 10);
    if (isNaN(trackedAppId)) {
      res.status(400).json({ success: false, error: 'Invalid trackedAppId' });
      return;
    }

    const app = db.select().from(trackedApps)
      .where(eq(trackedApps.id, trackedAppId))
      .all()[0];

    if (!app) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }

    const versions = db.select().from(apkVersions)
      .where(eq(apkVersions.trackedAppId, trackedAppId))
      .all()
      .sort((a, b) => b.versionCode - a.versionCode);

    // Latest analysis job per version in a single query (MAX(id) GROUP BY), so
    // the client can render status without an N+1 of analysis-status calls.
    const versionIds = versions.map(v => v.id);
    const latestJobByVersion = new Map<number, { status: string; stage: string | null; error: string | null }>();
    if (versionIds.length > 0) {
      const maxJobIds = db
        .select({ maxId: sql<number>`max(${analysisJobs.id})`.as('maxId') })
        .from(analysisJobs)
        .where(inArray(analysisJobs.apkVersionId, versionIds))
        .groupBy(analysisJobs.apkVersionId);
      const jobs = db.select().from(analysisJobs).where(inArray(analysisJobs.id, maxJobIds)).all();
      for (const j of jobs) {
        latestJobByVersion.set(j.apkVersionId, { status: j.status, stage: j.stage ?? null, error: j.error ?? null });
      }
    }

    const enriched = versions.map(v => {
      let availability: string;
      try {
        availability = computeVersionAvailability(db as any, v.id).state;
      } catch {
        availability = 'lost';
      }
      const job = latestJobByVersion.get(v.id);
      // aiRunning is in-memory analyzer state; only meaningful once a job exists.
      const analysis = job
        ? { ...job, aiRunning: apkAnalyzer ? apkAnalyzer.isAiAgentRunning(v.id) : false }
        : null;
      return { ...v, availability, analysis };
    });

    res.json({ success: true, data: enriched });
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis-jobs/recent — Recent analysis jobs across all tracked apps
  registerEndpoint('GET', '/v1/apps/analysis-jobs/recent', (_req, res) => {
    const jobs = db.select().from(analysisJobs).orderBy(desc(analysisJobs.id)).limit(50).all();

    // Only fetch the versions/apps referenced by these 50 jobs
    const versionIds = [...new Set(jobs.map(j => j.apkVersionId))];
    const versions = versionIds.length > 0
      ? db.select().from(apkVersions).all().filter(v => versionIds.includes(v.id))
      : [];
    const versionMap = new Map(versions.map(v => [v.id, v]));

    const appIds = [...new Set(versions.map(v => v.trackedAppId))];
    const apps = appIds.length > 0
      ? db.select().from(trackedApps).all().filter(a => appIds.includes(a.id))
      : [];
    const appMap = new Map(apps.map(a => [a.id, a]));

    const data = jobs.map(j => {
      const version = versionMap.get(j.apkVersionId);
      const app = version ? appMap.get(version.trackedAppId) : undefined;
      return {
        id: j.id,
        apkVersionId: j.apkVersionId,
        status: j.status,
        stage: j.stage,
        error: j.error,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
        trackedAppId: app?.id ?? null,
        packageName: app?.packageName ?? 'unknown',
        appName: app?.appName ?? null,
        versionCode: version?.versionCode ?? 0,
        versionName: version?.versionName ?? null,
      };
    });

    res.json({ success: true, data });
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/recent — Recent APK version downloads across all tracked apps
  registerEndpoint('GET', '/v1/apps/recent', (_req, res) => {
    const recentVersions = db.select().from(apkVersions)
      .orderBy(desc(apkVersions.downloadedAt))
      .limit(30)
      .all();

    // Only fetch apps referenced by the 30 recent versions
    const appIds = [...new Set(recentVersions.map(v => v.trackedAppId))];
    const apps = appIds.length > 0
      ? db.select().from(trackedApps).all().filter(a => appIds.includes(a.id))
      : [];
    const appMap = new Map(apps.map(a => [a.id, a]));

    const recent = recentVersions.map(v => {
      const app = appMap.get(v.trackedAppId);
      return {
        ...v,
        packageName: app?.packageName ?? 'unknown',
        appName: app?.appName ?? null,
      };
    });

    res.json({ success: true, data: recent });
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/download/:versionId — Stream APK file download from disk
  registerEndpoint('GET', '/v1/apps/download/:versionId', async (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const version = db.select().from(apkVersions)
      .where(eq(apkVersions.id, versionId))
      .all()[0];

    if (!version) {
      res.status(404).json({ success: false, error: 'Version not found' });
      return;
    }

    // Get the tracked app for packageName
    const app = db.select().from(trackedApps)
      .where(eq(trackedApps.id, version.trackedAppId))
      .all()[0];

    if (!app) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }

    const filePath = apkFilePath(app.packageName, version.filename);

    if (!fs.existsSync(filePath)) {
      // Try cloud storage
      if (fileSync) {
        // For split APKs (directories), we can't use presigned URLs since they're multiple files
        // We need to acquire the files locally first
        const cloudKey = `apks/${app.packageName}/${version.filename}`;
        const acquired = await fileSync.acquireLocal(cloudKey, `download-${versionId}`, filePath);

        if (acquired.error) {
          res.status(404).json({ success: false, error: 'APK file not found on disk or in cloud' });
          return;
        }
        // File is now available locally at filePath
      } else {
        res.status(404).json({ success: false, error: 'APK file not found on disk or in cloud' });
        return;
      }
    }

    // Handle split APK directories: create zip with all APK files
    if (fs.statSync(filePath).isDirectory()) {
      const apkFiles = fs.readdirSync(filePath).filter(f => f.endsWith('.apk'));
      if (apkFiles.length === 0) {
        res.status(404).json({ success: false, error: 'No APK files found in split directory' });
        return;
      }

      const downloadName = `${app.packageName}_${version.filename}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

      // Create zip archive on-the-fly
      const zip = new AdmZip();
      for (const apkFile of apkFiles) {
        const apkPath = path.join(filePath, apkFile);
        zip.addLocalFile(apkPath);
      }

      const zipBuffer = zip.toBuffer();
      res.send(zipBuffer);
      log(`Served split APK as zip: ${downloadName} (${apkFiles.length} files)`);
      return;
    }

    // Single APK file - try presigned URL for cloud-only files
    if (fileSync) {
      const cloudKey = `apks/${app.packageName}/${version.filename}`;
      const url = await fileSync.getDirectUrl(cloudKey);
      if (url) {
        res.redirect(302, url);
        return;
      }
    }

    // Serve single APK file from disk
    const downloadName = `${app.packageName}_${version.filename}`;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res as any);
  }, { requires: ['core.apk:read'] });

  // POST /v1/apps/trigger-scan — Manually trigger APK version scan
  registerEndpoint('POST', '/v1/apps/trigger-scan', async (_req, res) => {
    if (!apkTracker) {
      res.status(503).json({ success: false, error: 'APK tracker not available' });
      return;
    }
    // Run in background so the response returns immediately
    apkTracker.checkForUpdates().catch(err => {
      error(`Manual APK scan failed: ${err.message}`);
    });
    res.json({ success: true, message: 'APK scan started' });
  }, { requires: ['core.apk:manage'] });

  // POST /v1/apps/install/:deviceId — Install an APK version onto a device
  registerEndpoint('POST', '/v1/apps/install/:deviceId', async (req, res) => {
    const { apkVersionId } = req.body;
    const deviceId = req.params.deviceId;
    if (!apkVersionId) {
      res.status(400).json({ success: false, error: 'apkVersionId is required' });
      return;
    }
    const version = db.select().from(apkVersions).where(eq(apkVersions.id, apkVersionId)).all()[0];
    if (!version) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }
    const tracked = db.select().from(trackedApps).where(eq(trackedApps.id, version.trackedAppId)).all()[0];
    if (!tracked) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }
    try {
      const apkPath = apkFilePath(tracked.packageName, version.filename);

      // If file not on disk, try to fetch from cloud storage
      if (!fs.existsSync(apkPath) && fileSync) {
        const cloudKey = `apks/${tracked.packageName}/${version.filename}`;
        const acquired = await fileSync.acquireLocal(cloudKey, `install-${deviceId}`, apkPath);
        if (acquired.error) {
          res.status(404).json({ success: false, error: `APK file not available: ${acquired.error}` });
          return;
        }
      } else if (!fs.existsSync(apkPath)) {
        res.status(404).json({ success: false, error: `APK file not found: ${version.filename}` });
        return;
      }

      // Determine if this is a split APK (directory) or single APK (file)
      const isDirectory = fs.statSync(apkPath).isDirectory();
      let adbArgs: string[];
      if (isDirectory) {
        // Split APK: use install-multiple with all .apk files in the directory
        const apkFiles = fs.readdirSync(apkPath).filter(f => f.endsWith('.apk'));
        if (apkFiles.length === 0) {
          res.status(404).json({ success: false, error: 'No APK files found in split directory' });
          return;
        }
        adbArgs = ['-s', deviceId, 'install-multiple', '-r', ...apkFiles.map(f => path.join(apkPath, f))];
        log(`Installing split APK (${apkFiles.length} files) ${tracked.packageName} v${version.versionCode} on ${deviceId}`);
      } else {
        adbArgs = ['-s', deviceId, 'install', '-r', apkPath];
        log(`Installing ${tracked.packageName} v${version.versionCode} on ${deviceId}`);
      }

      const { stdout, stderr } = await execFileAsync('adb', adbArgs, { timeout: 120000 });
      const output = (stdout || '') + (stderr || '');
      if (output.includes('Failure') || output.includes('INSTALL_FAILED')) {
        const failMatch = output.match(/Failure \[([^\]]+)\]/);
        const reason = failMatch ? failMatch[1] : output.trim();
        error(`Install failed on ${deviceId}: ${reason}`);
        res.status(500).json({ success: false, error: `Install failed: ${reason}` });
        return;
      }
      log(`Install succeeded: ${tracked.packageName} v${version.versionCode} on ${deviceId}`);
      res.json({ success: true, data: { packageName: tracked.packageName, versionCode: version.versionCode } });
    } catch (err: any) {
      error(`Install error on ${deviceId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:manage'] });

  // POST /v1/apps/analysis-jobs/:jobId/cancel — Cancel a pending or running analysis job
  registerEndpoint('POST', '/v1/apps/analysis-jobs/:jobId/cancel', (req, res) => {
    if (!apkAnalyzer) {
      res.status(503).json({ success: false, error: 'APK analyzer not available' });
      return;
    }
    const jobId = parseInt(req.params.jobId as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ success: false, error: 'Invalid jobId' });
      return;
    }
    const cancelled = apkAnalyzer.cancelJob(jobId);
    if (!cancelled) {
      res.status(409).json({ success: false, error: 'Job is not cancellable (already completed or failed)' });
      return;
    }
    res.json({ success: true });
  }, { requires: ['core.apk:manage'] });

  // POST /v1/apps/analyze/:versionId — Queue APK version for analysis (or re-analysis)
  registerEndpoint('POST', '/v1/apps/analyze/:versionId', async (req, res) => {
    if (!apkAnalyzer) {
      res.status(503).json({ success: false, error: 'APK analyzer not available' });
      return;
    }
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }
    const version = db.select().from(apkVersions)
      .where(eq(apkVersions.id, versionId))
      .all()[0];
    if (!version) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }
    const jobId = await apkAnalyzer.enqueue(versionId);
    res.json({ success: true, data: { jobId } });
  }, { requires: ['core.apk:manage'] });

  // GET /v1/device/package-version/:deviceId/:packageName — Get installed version of a package
  registerEndpoint('GET', '/v1/device/package-version/:deviceId/:packageName', async (req, res) => {
    const deviceId = req.params.deviceId as string;
    const packageName = req.params.packageName as string;

    if (!isValidPackageName(packageName)) {
      res.status(400).json({ success: false, error: 'Invalid package name' });
      return;
    }

    if (!deviceManager.isOnline(deviceId)) {
      res.json({ success: true, data: { installed: false, versionCode: null, versionName: null } });
      return;
    }

    try {
      const dumpsys = await adbShell(deviceId, `dumpsys package ${packageName}`, 10000);
      const { versionCode, versionName } = parseDumpsysPackage(dumpsys);
      const installed = versionCode !== null;
      res.json({ success: true, data: { installed, versionCode, versionName } });
    } catch {
      res.json({ success: true, data: { installed: false, versionCode: null, versionName: null } });
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis-status/:versionId — Get analysis job status for a version
  registerEndpoint('GET', '/v1/apps/analysis-status/:versionId', (req, res) => {
    if (!apkAnalyzer) {
      res.status(503).json({ success: false, error: 'APK analyzer not available' });
      return;
    }
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }
    const job = apkAnalyzer.getJobStatusForVersion(versionId);
    // AI analysis only starts once the primary analysis job completes, so
    // aiRunning implies a job row exists. When no job exists, keep data null
    // to preserve the "never-analysed" semantic the UI already handles.
    const aiRunning = apkAnalyzer.isAiAgentRunning(versionId);
    res.json({ success: true, data: job ? { ...job, aiRunning } : null });
  }, { requires: ['core.apk:read'] });

}
