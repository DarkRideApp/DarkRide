import { eq } from 'drizzle-orm';
import { createLoggers } from '../../logs';
import { settings } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import type { RemoteApkSource, VersionCheckResult, DownloadResult } from './types';

const { log } = createLoggers('xiaomi-source');

/**
 * Xiaomi GetApps (小米应用商店) app-metadata endpoint.
 *
 * We hit the China host `app.market.xiaomi.com` deliberately: it serves the
 * China-skewed catalog. The global host (`global.app.market.xiaomi.com`)
 * localizes/redirects and hides many CN-only apps, which defeats the point of
 * tracking availability on the Chinese store.
 *
 * The `os`/`sdk` query params make the response look like a real device query;
 * without them the endpoint sometimes returns an empty body.
 */
const XIAOMI_API = 'https://app.market.xiaomi.com/apm/app';
const MIN_REQUEST_INTERVAL = 2000; // 2s between Xiaomi API calls
/** Browser-like UA; the endpoint can reject obviously-bot requests. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Subset of the /apm/app response we care about. */
export interface XiaomiApp {
  appId?: number;
  packageName?: string;
  displayName?: string;
  versionName?: string;
  versionCode?: number;
  apkSize?: number;
  icon?: string;
  updateTime?: number;
}

export interface XiaomiApiResponse {
  host?: string;
  /** Absent / empty when the package isn't on the store. */
  app?: XiaomiApp | null;
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
 * Pure mapping from a /apm/app response to a VersionCheckResult. Returns null
 * when the response carries no usable `app` object (i.e. the package isn't on
 * Xiaomi's store — a normal, non-error outcome). Xiaomi publishes no
 * sha256/md5, so `sha256` is always undefined. Exported for tests.
 */
export function parseXiaomiResponse(json: XiaomiApiResponse | undefined): VersionCheckResult | null {
  const app = json?.app;
  if (!app || !app.versionName) return null;
  return {
    versionName: String(app.versionName),
    appName: app.displayName || undefined,
    versionCode: toInt(app.versionCode),
    fileSize: toInt(app.apkSize),
    sha256: undefined, // Xiaomi's API exposes no checksum.
  };
}

export class XiaomiSource implements RemoteApkSource {
  readonly id = 'xiaomi';
  readonly label = 'Xiaomi GetApps (小米应用商店)';

  private lastRequestTime = 0;
  private db: AppDatabase | null = null;
  /**
   * Short-lived per-package cache of the /apm/app response. checkVersion (and a
   * future fetchIcon) otherwise re-hit a rate-limited endpoint for the same
   * package within one logical refresh; this collapses them to one GET.
   */
  private recordCache = new Map<string, { record: XiaomiApiResponse | null; at: number }>();
  private static readonly RECORD_TTL_MS = 15000;

  setDatabase(db: AppDatabase): void {
    this.db = db;
  }

  isConfigured(): boolean {
    return true; // No credentials required.
  }

  defaultEnabled(): boolean {
    // Opt-in: off unless the operator flipped the global default. Availability-
    // only source (no download), so it stays out of the way by default.
    return this.getSetting('xiaomi_fetch_default') === 'true';
  }

  /** Xiaomi GetApps web listing, package-keyed: app.mi.com/details?id=com.x.y */
  storeUrl(packageName: string): string {
    return `https://app.mi.com/details?id=${encodeURIComponent(packageName)}`;
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
   * GET the package metadata and return the parsed response, or a response with
   * no `app` when the package isn't on the store. Throws on HTTP / network /
   * parse errors so the caller can record a per-source lastError.
   */
  private async fetchRecord(packageName: string): Promise<XiaomiApiResponse> {
    const cached = this.recordCache.get(packageName);
    if (cached && Date.now() - cached.at < XiaomiSource.RECORD_TTL_MS && cached.record) {
      return cached.record;
    }

    await this.rateLimit();
    const url = `${XIAOMI_API}?packageName=${encodeURIComponent(packageName)}&os=1.1.1&sdk=19`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Xiaomi API HTTP ${res.status}`);

    const data = (await res.json()) as XiaomiApiResponse;
    // Cache the parsed response (errors throw above and are never cached).
    this.recordCache.set(packageName, { record: data, at: Date.now() });
    return data;
  }

  async checkVersion(packageName: string): Promise<VersionCheckResult | null> {
    const record = await this.fetchRecord(packageName);
    return parseXiaomiResponse(record);
  }

  /**
   * Xiaomi GetApps does not allow direct APK download. The download endpoints
   * are server-side gated: the public `/download/<appId>` path returns a 0-byte
   * body, and `/apm/download/<appId>` returns `{ hosts: [], downloadCtl: 3 }` —
   * `downloadCtl: 3` is Xiaomi's "download not permitted for this client" flag.
   * There is no client-reachable URL to fetch, and apkeep doesn't support
   * Xiaomi for the same reason. So this source is availability + version
   * tracking only; we return a clear error and make NO network call.
   */
  async downloadApk(_packageName: string, _appName?: string): Promise<DownloadResult> {
    log('Xiaomi download requested but the store gates APK downloads (downloadCtl=3); availability-only.');
    return {
      success: false,
      error: 'Xiaomi GetApps does not allow direct APK download (store-gated); use it for availability + version tracking only.',
    };
  }
}
