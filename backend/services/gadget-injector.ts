import { eq, and, lt } from 'drizzle-orm';
import { join, resolve } from 'path';
import { getDataRoot } from '../config/paths';
import { existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { injectedApks, apkVersions, trackedApps } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { PythonBridgeManager } from './python-bridge';
import type { FridaReleaseManager } from './frida-release-manager';
import { createLoggers } from '../logs';
import { apkFilePath, resolveApkLocal } from '../utils/apk-paths';

const execFileAsync = promisify(execFile);
const { log, error } = createLoggers('gadget-injector');

const INJECTED_APK_DIR = join(getDataRoot(), 'apks-injected');
const KEYSTORE_PATH = './data/darkride-debug.keystore';
const KEYSTORE_PASS = 'darkride';
const KEYSTORE_ALIAS = 'darkride';
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export class GadgetInjector {
  constructor(
    private db: AppDatabase,
    private bridgeManager: PythonBridgeManager,
    private releaseManager: FridaReleaseManager,
  ) {}

  getCachedInjection(packageName: string, versionCode: number, fridaVersion: string) {
    return this.db.select().from(injectedApks)
      .where(and(
        eq(injectedApks.packageName, packageName),
        eq(injectedApks.versionCode, versionCode),
        eq(injectedApks.fridaVersion, fridaVersion),
      ))
      .all()[0] ?? null;
  }

  listInjected() {
    return this.db.select().from(injectedApks).all();
  }

  deleteInjected(id: number): void {
    const row = this.db.select().from(injectedApks).where(eq(injectedApks.id, id)).all()[0];
    if (row) {
      const filePath = resolve(INJECTED_APK_DIR, row.filename);
      try { if (existsSync(filePath)) unlinkSync(filePath); } catch {}
      this.db.delete(injectedApks).where(eq(injectedApks.id, id)).run();
    }
  }

  pruneExpired(): number {
    const cutoff = new Date(Date.now() - CACHE_TTL_MS);
    const expired = this.db.select().from(injectedApks)
      .where(lt(injectedApks.createdAt, cutoff))
      .all();

    for (const row of expired) {
      const filePath = resolve(INJECTED_APK_DIR, row.filename);
      try { if (existsSync(filePath)) unlinkSync(filePath); } catch {}
    }

    this.db.delete(injectedApks).where(lt(injectedApks.createdAt, cutoff)).run();
    if (expired.length > 0) log(`Pruned ${expired.length} expired injected APKs`);
    return expired.length;
  }

  async inject(packageName: string, versionCode?: number, fridaVersion?: string): Promise<typeof injectedApks.$inferSelect> {
    // 1. Resolve Frida version
    const resolvedVersion = fridaVersion
      ? this.releaseManager.resolveVersion(fridaVersion) ?? fridaVersion
      : this.releaseManager.resolveVersion(this.releaseManager.getDefaultVersion()) ?? 'latest';

    // 2. Find source APK
    const tracked = this.db.select().from(trackedApps)
      .where(eq(trackedApps.packageName, packageName)).all()[0];
    if (!tracked) throw new Error(`No tracked app found for ${packageName}. Pull the APK from a device first.`);

    let apkVersion;
    if (versionCode) {
      apkVersion = this.db.select().from(apkVersions)
        .where(and(eq(apkVersions.trackedAppId, tracked.id), eq(apkVersions.versionCode, versionCode)))
        .all()[0];
    } else {
      // Latest version
      apkVersion = this.db.select().from(apkVersions)
        .where(eq(apkVersions.trackedAppId, tracked.id))
        .all()
        .sort((a, b) => b.versionCode - a.versionCode)[0];
    }

    if (!apkVersion) throw new Error(`No APK version found for ${packageName}${versionCode ? ` v${versionCode}` : ''}`);

    // 3. Check cache
    const cached = this.getCachedInjection(packageName, apkVersion.versionCode, resolvedVersion);
    if (cached && existsSync(resolve(INJECTED_APK_DIR, cached.filename))) {
      log(`Cache hit for ${packageName} v${apkVersion.versionCode} frida-${resolvedVersion}`);
      return cached;
    }

    // 4. Ensure gadget binary
    const gadgetPath = await this.releaseManager.ensureGadget(resolvedVersion);

    // 5. Call Python bridge to inject
    const localResolution = resolveApkLocal(packageName, apkVersion.filename);
    const sourceApkPath = localResolution ? localResolution.baseApkPath : apkFilePath(packageName, apkVersion.filename);
    const vName = apkVersion.versionName ?? String(apkVersion.versionCode);
    const outputFilename = `${packageName}/${apkVersion.versionCode}_${vName}_frida-${resolvedVersion}.apk`;
    const outputPath = resolve(INJECTED_APK_DIR, outputFilename);

    const bridge = await this.bridgeManager.getBridge('__system__');
    const response = await fetch(`http://localhost:${bridge.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'frida_inject_apk',
        params: {
          apk_path: sourceApkPath,
          gadget_so_path: gadgetPath,
          output_path: outputPath,
        },
        id: Date.now().toString(),
      }),
    });

    const result = await response.json() as any;
    if (result.error) throw new Error(result.error.message);

    // 6. Sign the APK
    await this.signApk(outputPath);

    // 7. Record in DB. Use lastInsertRowid + a direct id lookup rather than
    // .all().pop()! — the old pattern race-conditioned under concurrent inserts.
    // Flagged 3× in the pre-launch review (R-3, P-3, Q-1).
    const fileSize = existsSync(outputPath) ? statSync(outputPath).size : null;
    const insertResult = this.db.insert(injectedApks).values({
      trackedAppId: tracked.id,
      packageName,
      versionCode: apkVersion.versionCode,
      versionName: apkVersion.versionName,
      fridaVersion: resolvedVersion,
      filename: outputFilename,
      fileSize,
      createdAt: new Date(),
    }).run();

    const insertedId = Number(insertResult.lastInsertRowid);
    const inserted = this.db
      .select()
      .from(injectedApks)
      .where(eq(injectedApks.id, insertedId))
      .get()!;
    log(`Injected gadget into ${packageName} v${apkVersion.versionCode} with frida-${resolvedVersion}`);
    return inserted;
  }

  private async signApk(apkPath: string): Promise<void> {
    // Ensure debug keystore exists
    if (!existsSync(KEYSTORE_PATH)) {
      log('Generating debug keystore...');
      await execFileAsync('keytool', [
        '-genkey', '-v',
        '-keystore', KEYSTORE_PATH,
        '-alias', KEYSTORE_ALIAS,
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', '10000',
        '-storepass', KEYSTORE_PASS,
        '-dname', 'CN=DarkRide',
      ]);
    }

    // Try apksigner first (Android SDK), fall back to jarsigner
    try {
      await execFileAsync('apksigner', [
        'sign',
        '--ks', KEYSTORE_PATH,
        '--ks-key-alias', KEYSTORE_ALIAS,
        '--ks-pass', `pass:${KEYSTORE_PASS}`,
        apkPath,
      ]);
      log('APK signed with apksigner');
    } catch {
      log('apksigner not found, falling back to jarsigner');
      await execFileAsync('jarsigner', [
        '-verbose',
        '-sigalg', 'SHA256withRSA',
        '-digestalg', 'SHA-256',
        '-keystore', KEYSTORE_PATH,
        '-storepass', KEYSTORE_PASS,
        apkPath,
        KEYSTORE_ALIAS,
      ]);
      log('APK signed with jarsigner');
    }
  }
}
