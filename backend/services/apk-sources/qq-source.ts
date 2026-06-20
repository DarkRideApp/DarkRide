import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { eq } from 'drizzle-orm';
import { readApkVersion } from '../../utils/apk-version-reader';
import { createLoggers } from '../../logs';
import { settings } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { packageDir } from '../../utils/apk-paths';
import { isPrivateIp } from '../../utils/validators';
import type { RemoteApkSource, VersionCheckResult, DownloadResult } from './types';

const { log, error } = createLoggers('qq-source');

/** Tencent App Store (应用宝) WeChat APK-info endpoint. */
const QQ_API = 'https://upage.html5.qq.com/wechat-apkinfo';
const MIN_REQUEST_INTERVAL = 2000; // 2s between QQ API calls
const DOWNLOAD_TIMEOUT = 600000; // 10 min — APKs can be 100MB+
const MAX_REDIRECTS = 5;
/** Browser-like UA + Referer; the endpoint rejects obviously-bot requests. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Host suffixes the download/icon URLs are allowed to point at. The download
 * URL + its checksum both come from the (untrusted) wechat-apkinfo JSON, so
 * without this a compromised/MITM'd endpoint could coerce a fetch to an
 * internal address (SSRF) or a cleartext attacker host. We pin to Tencent's
 * CDN/app domains. (The CDN is plain http, so we cannot simply force https.)
 */
const ALLOWED_HOST_SUFFIXES = ['.myapp.com', '.dd.qq.com', '.qq.com', '.gtimg.cn', '.tencent.com'];

/** Validate a URL's host against the Tencent allowlist; reject private IPs. */
function assertAllowedHost(rawUrl: string): void {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error(`Invalid URL from QQ: ${rawUrl}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Refusing non-http(s) URL from QQ: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  // Reject IP-literal hosts outright (and especially private/link-local ones).
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error(`Refusing fetch to private address: ${host}`);
    throw new Error(`Refusing fetch to non-Tencent IP host: ${host}`);
  }
  if (!ALLOWED_HOST_SUFFIXES.some(s => host === s.slice(1) || host.endsWith(s))) {
    throw new Error(`Refusing fetch to non-Tencent host: ${host}`);
  }
}

/**
 * fetch() that re-validates the host on every redirect hop. `redirect: 'follow'`
 * would let an allowlisted URL 302 to an internal target, so we follow manually
 * and run assertAllowedHost on each Location.
 */
async function fetchTencent(rawUrl: string, init: RequestInit): Promise<Response> {
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

/** Subset of the wechat-apkinfo response we care about. */
export interface QqApkRecord {
  app_info?: {
    name?: string;
    logo_big?: string;
    logo_mid?: string;
    logo_small?: string;
  };
  apk_all_data?: {
    version_code?: number | string;
    version_name?: string;
    size_byte?: string | number;
    url?: string;
    sha256?: string;
    apk_md5?: string;
  };
}

interface QqApiResponse {
  ret: number;
  err_msg?: string;
  app_detail_records?: Record<string, QqApkRecord>;
}

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Pure mapping from a wechat-apkinfo record to a VersionCheckResult.
 * Returns null when the record lacks a usable APK entry. Exported for tests.
 */
export function parseQqRecord(record: QqApkRecord | undefined): VersionCheckResult | null {
  const apk = record?.apk_all_data;
  if (!apk || !apk.url || !apk.version_name) return null;
  return {
    versionName: String(apk.version_name),
    appName: record?.app_info?.name || undefined,
    versionCode: toInt(apk.version_code),
    fileSize: toInt(apk.size_byte),
    sha256: apk.sha256 ? String(apk.sha256).toLowerCase() : undefined,
  };
}

export class QqSource implements RemoteApkSource {
  readonly id = 'qq';
  readonly label = 'QQ App Store (应用宝)';

  private lastRequestTime = 0;
  private db: AppDatabase | null = null;
  /**
   * Short-lived per-package cache of the wechat-apkinfo record. One logical
   * fetch (checkVersion → downloadApk, plus fetchIcon) otherwise issues several
   * POSTs to a bot-sensitive, rate-limited endpoint; this collapses them to one.
   */
  private recordCache = new Map<string, { record: QqApkRecord | null; at: number }>();
  private static readonly RECORD_TTL_MS = 15000;

  setDatabase(db: AppDatabase): void {
    this.db = db;
  }

  isConfigured(): boolean {
    return true; // No credentials required.
  }

  defaultEnabled(): boolean {
    // Opt-in: off unless the operator flipped the global default.
    return this.getSetting('qq_fetch_default') === 'true';
  }

  private getSetting(key: string): string | null {
    if (!this.db) return null;
    const row = this.db.select().from(settings).where(eq(settings.key, key)).all()[0];
    return row?.value ?? null;
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
      await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * POST the package to wechat-apkinfo and return its record, or null when the
   * app isn't on the store (ret=0 with no matching record). Throws on HTTP /
   * network / parse errors and on a non-zero `ret`.
   */
  private async fetchRecord(packageName: string): Promise<QqApkRecord | null> {
    const cached = this.recordCache.get(packageName);
    if (cached && Date.now() - cached.at < QqSource.RECORD_TTL_MS) return cached.record;

    await this.rateLimit();
    const res = await fetch(QQ_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Referer': 'https://sj.qq.com/',
      },
      body: JSON.stringify({ packagename: packageName }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`QQ API HTTP ${res.status}`);

    const data = (await res.json()) as QqApiResponse;
    if (data.ret !== 0) throw new Error(`QQ API ret=${data.ret}${data.err_msg ? ` (${data.err_msg})` : ''}`);

    // Only successful lookups are cached (errors throw above, never cached).
    const record = data.app_detail_records?.[packageName] ?? null;
    this.recordCache.set(packageName, { record, at: Date.now() });
    return record;
  }

  async checkVersion(packageName: string): Promise<VersionCheckResult | null> {
    const record = await this.fetchRecord(packageName);
    return parseQqRecord(record ?? undefined);
  }

  async downloadApk(packageName: string, _appName?: string): Promise<DownloadResult> {
    let info: VersionCheckResult | null;
    let url: string;
    try {
      const record = await this.fetchRecord(packageName);
      info = parseQqRecord(record ?? undefined);
      url = record?.apk_all_data?.url ?? '';
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    if (!info || !url) {
      return { success: false, error: 'App not available on QQ App Store' };
    }

    // Stream into a uniquely-named staging file inside the package dir. We do
    // NOT write the final `<versionCode>_<versionName>.apk` here — the tracker
    // dedups first and finalizes the move only when the version is kept, so a
    // deduped download can never overwrite/delete an already-stored APK.
    const pkgDir = packageDir(packageName);
    fs.mkdirSync(pkgDir, { recursive: true });
    const stagedPath = path.join(pkgDir, `.dl-${crypto.randomUUID()}.apk`);

    try {
      const res = await fetchTencent(url, {
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

      // Note: the URL and its sha256 both come from the same wechat-apkinfo
      // response, so this verifies transit integrity (truncation / corruption /
      // a swapped CDN object), NOT authenticity against a hostile endpoint.
      const digest = hash.digest('hex').toLowerCase();
      if (info.sha256 && digest !== info.sha256) {
        throw new Error('sha256 mismatch — corrupt or wrong file');
      }
      if (!info.sha256 && !info.fileSize) {
        log(`QQ record for ${packageName} carried no sha256/size — accepted ${size} bytes without an integrity check`);
      }

      // Prefer the APK manifest's own versionCode; fall back to the API value.
      const manifest = readApkVersion(stagedPath);
      const versionCode = manifest.versionCode ?? info.versionCode ?? null;
      if (!versionCode) throw new Error('Could not determine versionCode');
      const versionName = manifest.versionName || info.versionName || 'unknown';

      log(`QQ downloaded ${packageName} v${versionName} (${versionCode}) — ${(size / 1024 / 1024).toFixed(1)} MB, sha256 verified`);
      // filePath is a STAGED file; the tracker finalizes or discards it.
      return { success: true, filePath: stagedPath, versionCode, versionName, fileSize: size };
    } catch (err: any) {
      try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
      error(`QQ download failed for ${packageName}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async fetchIcon(packageName: string): Promise<boolean> {
    try {
      const record = await this.fetchRecord(packageName);
      const iconUrl = record?.app_info?.logo_big || record?.app_info?.logo_mid || record?.app_info?.logo_small;
      if (!iconUrl) return false;
      const res = await fetchTencent(iconUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return false;
      const pkgDir = packageDir(packageName);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'icon.png'), buf);
      log(`Fetched icon for ${packageName} from QQ App Store`);
      return true;
    } catch {
      return false;
    }
  }
}
