import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { readApkVersion } from '../../utils/apk-version-reader';
import { createLoggers } from '../../logs';
import type { AppDatabase } from '../../db/index';
import { packageDir } from '../../utils/apk-paths';
import { isPrivateIp } from '../../utils/validators';
import type { RemoteApkSource, VersionCheckResult, DownloadResult } from './types';

const { log, error } = createLoggers('huawei-source');

/** Huawei AppGallery OTA `client.updateCheck` endpoint. */
const HUAWEI_API = 'https://store-dre.hispace.dbankcloud.com/hwmarket/api/clientApi';
const MIN_REQUEST_INTERVAL = 2000; // 2s between Huawei API calls
const DOWNLOAD_TIMEOUT = 600000; // 10 min — APKs can be 100MB+
const MAX_REDIRECTS = 5;
/**
 * UpdateSDK UA, mirrored from apkeep's Huawei source. The clientApi rejects /
 * degrades responses for an unexpected UA, so this string is load-bearing.
 */
const USER_AGENT = 'UpdateSDK##4.0.1.300##Android##Pixel 2##com.huawei.appmarket##12.0.1.301';
/**
 * Catalogues differ per region. We probe CN first (China-skewed catalog where
 * most of the apps we track actually live) and fall back to IE once on an empty
 * result, since some apps only surface under the international storefront.
 */
const SERVICE_COUNTRIES = ['CN', 'IE'];

/**
 * Host suffixes the download/icon URLs are allowed to point at. The download
 * URL + its sha256 both come from the (untrusted) clientApi JSON, so without
 * this a compromised/MITM'd endpoint could coerce a fetch to an internal
 * address (SSRF) or an attacker host. We pin to Huawei's app/CDN domains:
 *   - .hispace.dbankcloud.com  (clientApi + appdlc download origin)
 *   - .dbankcloud.com          (parent of the above)
 *   - .dbankcdn.com            (the CDN the fullDownUrl 302-redirects to)
 */
const ALLOWED_HOST_SUFFIXES = ['.hispace.dbankcloud.com', '.dbankcloud.com', '.dbankcdn.com'];

/** Validate a URL's host against the Huawei allowlist; reject private IPs. */
function assertAllowedHost(rawUrl: string): void {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error(`Invalid URL from Huawei: ${rawUrl}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Refusing non-http(s) URL from Huawei: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  // Reject IP-literal hosts outright (and especially private/link-local ones).
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error(`Refusing fetch to private address: ${host}`);
    throw new Error(`Refusing fetch to non-Huawei IP host: ${host}`);
  }
  if (!ALLOWED_HOST_SUFFIXES.some(s => host === s.slice(1) || host.endsWith(s))) {
    throw new Error(`Refusing fetch to non-Huawei host: ${host}`);
  }
}

/**
 * fetch() that re-validates the host on every redirect hop. `redirect: 'follow'`
 * would let an allowlisted URL 302 to an internal target, so we follow manually
 * and run assertAllowedHost on each Location. The fullDownUrl deliberately
 * 302-redirects (appdlc → dbankcdn), so manual following is the normal path.
 */
async function fetchHuawei(rawUrl: string, init: RequestInit): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedHost(url);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    url = new URL(location, url).toString();
  }
  throw new Error('Too many redirects');
}

/**
 * The `deviceSpecParams` blob + the rest of the clientApi body, mirrored
 * verbatim from apkeep's `huawei_app_gallery.rs::client_api_body`. A stripped
 * body silently returns `count:0` for real apps, so this must stay intact.
 * `{pkg}` / `{country}` are the only substitutions we make.
 *
 * The `pkgInfo` carries the target package with oldVersion=1.0 / versionCode=1
 * so the store reports its *current* version back as the "available update".
 */
const CLIENT_API_BODY_TEMPLATE =
  'agVersion=12.0.1&brand=Android&buildNumber=QQ2A.200405.005.2020.04.07.17&density=420' +
  '&deviceSpecParams=%7B%22abis%22%3A%22arm64-v8a%2Carmeabi-v7a%2Carmeabi%22%2C%22deviceFeatures%22%3A%22U%2CP%2CB%2C0c%2Ce%2C0J%2Cp%2Ca%2Cb%2C04%2Cm%2Candroid.hardware.wifi.rtt%2Ccom.google.hardware.camera.easel%2Ccom.google.android.feature.PIXEL_2017_EXPERIENCE%2C08%2C03%2CC%2CS%2C0G%2Cq%2CL%2C2%2C6%2CY%2CZ%2C0M%2Candroid.hardware.vr.high_performance%2Cf%2C1%2C07%2C8%2C9%2Candroid.hardware.sensor.hifi_sensors%2CO%2CH%2Ccom.google.android.feature.TURBO_PRELOAD%2Candroid.hardware.vr.headtracking%2CW%2Cx%2CG%2Co%2C06%2C0N%2Ccom.google.android.feature.PIXEL_EXPERIENCE%2C3%2CR%2Cd%2CQ%2Cn%2Candroid.hardware.telephony.carrierlock%2Cy%2CT%2Ci%2Cr%2Cu%2Ccom.google.android.feature.WELLBEING%2Cl%2C4%2C0Q%2CN%2CM%2C01%2C09%2CV%2C7%2C5%2C0H%2Cg%2Cs%2Cc%2C0l%2Ct%2C0L%2C0W%2C0X%2Ck%2C00%2Ccom.google.android.feature.GOOGLE_EXPERIENCE%2Candroid.hardware.sensor.assist%2Candroid.hardware.audio.pro%2CK%2CE%2C02%2CI%2CJ%2Cj%2CD%2Ch%2Candroid.hardware.wifi.aware%2C05%2CX%2Cv%22%2C%22dpi%22%3A420%2C%22preferLan%22%3A%22en%22%7D' +
  '&emuiApiLevel=0&firmwareVersion=10&getSafeGame=1&gmsSupport=0&hardwareType=0&harmonyApiLevel=0&harmonyDeviceType=&installCheck=0&isFullUpgrade=0&isUpdateSdk=1&locale=en_US&magicApiLevel=0&magicVer=&manufacturer=Google&mapleVer=0&method=client.updateCheck&odm=0&packageName=com.huawei.appmarket&phoneType=Pixel%202' +
  '&pkgInfo=%7B%22params%22%3A%5B%7B%22isPre%22%3A0%2C%22maple%22%3A0%2C%22oldVersion%22%3A%221.0%22%2C%22package%22%3A%22{pkg}%22%2C%22pkgMode%22%3A0%2C%22shellApkVer%22%3A0%2C%22targetSdkVersion%22%3A19%2C%22versionCode%22%3A1%7D%5D%7D' +
  '&resolution=1080_1794&sdkVersion=4.0.1.300&serviceCountry={country}&serviceType=0&supportMaple=0&ts=1649970862661&ver=1.2&version=12.0.1.301&versionCode=120001301';

/** Build the form body for a package under a given serviceCountry. */
function clientApiBody(packageName: string, serviceCountry: string): string {
  return CLIENT_API_BODY_TEMPLATE
    .replace('{pkg}', encodeURIComponent(packageName))
    .replace('{country}', encodeURIComponent(serviceCountry));
}

/** Subset of a clientApi `list[]` entry we care about. */
export interface HuaweiApkRecord {
  name?: string;
  version?: string;
  versionCode?: number | string;
  size?: number | string;
  fullSize?: number | string;
  sha256?: string;
  fullDownUrl?: string;
  downurl?: string;
  icon?: string;
}

interface HuaweiApiResponse {
  rtnCode?: number;
  count?: number;
  list?: HuaweiApkRecord[];
}

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Prefer the full-package download URL; tolerate the legacy `downurl` alias. */
function recordUrl(record: HuaweiApkRecord | undefined): string {
  return record?.fullDownUrl || record?.downurl || '';
}

/**
 * Pure mapping from a clientApi list entry to a VersionCheckResult.
 * Returns null when the record lacks a usable APK entry. Exported for tests.
 */
export function parseHuaweiRecord(record: HuaweiApkRecord | undefined): VersionCheckResult | null {
  if (!record || !recordUrl(record) || !record.version) return null;
  return {
    versionName: String(record.version),
    appName: record.name || undefined,
    versionCode: toInt(record.versionCode),
    // Huawei publishes both `fullSize` (full package) and `size`; the download
    // is the full package, so prefer fullSize for the integrity size-check.
    fileSize: toInt(record.fullSize) ?? toInt(record.size),
    sha256: record.sha256 ? String(record.sha256).toLowerCase() : undefined,
  };
}

export class HuaweiSource implements RemoteApkSource {
  readonly id = 'huawei';
  readonly label = 'Huawei AppGallery';

  private lastRequestTime = 0;
  private db: AppDatabase | null = null;
  /**
   * Short-lived per-package cache of the clientApi record. One logical fetch
   * (checkVersion → downloadApk) otherwise issues several POSTs to a
   * rate-limited endpoint; this collapses them to one.
   */
  private recordCache = new Map<string, { record: HuaweiApkRecord | null; at: number }>();
  private static readonly RECORD_TTL_MS = 15000;

  setDatabase(db: AppDatabase): void {
    this.db = db;
  }

  isConfigured(): boolean {
    return true; // No credentials required.
  }

  defaultEnabled(): boolean {
    // Opt-in extra store: off by default.
    return false;
  }

  // storeUrl is intentionally NOT implemented: Huawei's web listing is keyed by
  // an internal id (e.g. C5683), not the package name, so a usable URL cannot be
  // built from packageName alone. Omitting it lets the UI skip the broken link.

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
      await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /** POST the clientApi for one serviceCountry; return its parsed response. */
  private async postClientApi(packageName: string, serviceCountry: string): Promise<HuaweiApiResponse> {
    await this.rateLimit();
    const res = await fetch(HUAWEI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: clientApiBody(packageName, serviceCountry),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Huawei API HTTP ${res.status}`);
    return (await res.json()) as HuaweiApiResponse;
  }

  /**
   * POST the package to clientApi and return its first list record, or null
   * when the app isn't on the store (count:0 / empty list in every region we
   * probe). Tries CN first, then IE once. Throws on HTTP / network / parse
   * errors so the caller can record a per-source lastError.
   */
  private async fetchRecord(packageName: string): Promise<HuaweiApkRecord | null> {
    const cached = this.recordCache.get(packageName);
    if (cached && Date.now() - cached.at < HuaweiSource.RECORD_TTL_MS) return cached.record;

    let record: HuaweiApkRecord | null = null;
    for (const country of SERVICE_COUNTRIES) {
      const data = await this.postClientApi(packageName, country);
      const first = data.list?.[0];
      if (first && (data.count ?? data.list?.length ?? 0) > 0) {
        record = first;
        break;
      }
    }

    // Only successful lookups are cached (errors throw above, never cached).
    this.recordCache.set(packageName, { record, at: Date.now() });
    return record;
  }

  async checkVersion(packageName: string): Promise<VersionCheckResult | null> {
    const record = await this.fetchRecord(packageName);
    return parseHuaweiRecord(record ?? undefined);
  }

  async downloadApk(packageName: string, _appName?: string): Promise<DownloadResult> {
    let info: VersionCheckResult | null;
    let url: string;
    try {
      const record = await this.fetchRecord(packageName);
      info = parseHuaweiRecord(record ?? undefined);
      url = recordUrl(record ?? undefined);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    if (!info || !url) {
      return { success: false, error: 'App not available on Huawei AppGallery' };
    }

    // Stream into a uniquely-named staging file inside the package dir. We do
    // NOT write the final `<versionCode>_<versionName>.apk` here — the tracker
    // dedups first and finalizes the move only when the version is kept, so a
    // deduped download can never overwrite/delete an already-stored APK.
    const pkgDir = packageDir(packageName);
    fs.mkdirSync(pkgDir, { recursive: true });
    const stagedPath = path.join(pkgDir, `.dl-${crypto.randomUUID()}.apk`);

    try {
      const res = await fetchHuawei(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed: HTTP ${res.status}`);
      }

      // Single-pass stream to disk while computing sha256 (never buffer the
      // whole APK — they can be 100MB+).
      const hash = crypto.createHash('sha256');
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as any), tap, fs.createWriteStream(stagedPath));

      const size = fs.statSync(stagedPath).size;
      if (size < 1000) throw new Error('Downloaded APK too small');
      if (info.fileSize && size !== info.fileSize) {
        throw new Error(`Size mismatch: got ${size} bytes, expected ${info.fileSize}`);
      }

      // Note: the URL and its sha256 both come from the same clientApi response,
      // so this verifies transit integrity (truncation / corruption / a swapped
      // CDN object), NOT authenticity against a hostile endpoint.
      const digest = hash.digest('hex').toLowerCase();
      if (info.sha256 && digest !== info.sha256) {
        throw new Error('sha256 mismatch — corrupt or wrong file');
      }
      if (!info.sha256 && !info.fileSize) {
        log(`Huawei record for ${packageName} carried no sha256/size — accepted ${size} bytes without an integrity check`);
      }

      // Prefer the APK manifest's own versionCode; fall back to the API value.
      const manifest = readApkVersion(stagedPath);
      const versionCode = manifest.versionCode ?? info.versionCode ?? null;
      if (!versionCode) throw new Error('Could not determine versionCode');
      const versionName = manifest.versionName || info.versionName || 'unknown';

      log(`Huawei downloaded ${packageName} v${versionName} (${versionCode}) — ${(size / 1024 / 1024).toFixed(1)} MB, sha256 verified`);
      // filePath is a STAGED file; the tracker finalizes or discards it.
      return { success: true, filePath: stagedPath, versionCode, versionName, fileSize: size };
    } catch (err: any) {
      try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
      error(`Huawei download failed for ${packageName}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async fetchIcon(packageName: string): Promise<boolean> {
    try {
      const record = await this.fetchRecord(packageName);
      const iconUrl = record?.icon;
      if (!iconUrl) return false;
      const res = await fetchHuawei(iconUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return false;
      const pkgDir = packageDir(packageName);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'icon.png'), buf);
      log(`Fetched icon for ${packageName} from Huawei AppGallery`);
      return true;
    } catch {
      return false;
    }
  }
}
