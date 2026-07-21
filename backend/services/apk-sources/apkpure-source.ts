import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { readApkVersion } from '../../utils/apk-version-reader';
import { unpackApkBundle } from '../apk-bundle';
import { createLoggers } from '../../logs';
import type { AppDatabase } from '../../db/index';
import { packageDir } from '../../utils/apk-paths';
import { isPrivateIp } from '../../utils/validators';
import type { RemoteApkSource, VersionCheckResult, DownloadResult } from './types';

const { log, error } = createLoggers('apkpure-source');

/**
 * APKPure's mobile-client metadata endpoint (api.pureapk.com, NOT the
 * Cloudflare-walled apkpure.com web front-end). Returns a length-delimited
 * protobuf blob (application/octet-stream). We do not fully decode it — we
 * byte-regex it exactly like the apkeep client does
 * (https://github.com/EFForg/apkeep, src/download_sources/apkpure.rs).
 */
const APKPURE_API = 'https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=';
/**
 * The endpoint returns INVALID_COMMAND without these client headers. They
 * identify the request as coming from the APKPure Android client (aegon).
 */
const APKPURE_HEADERS: Record<string, string> = {
  'User-Agent': 'pureap:com.apkpure.aegon',
  'x-cv': '3172501',
  'x-sv': '29',
  'x-abis': 'arm64-v8a,armeabi-v7a,armeabi',
  'x-gp': '1',
};

const MIN_REQUEST_INTERVAL = 2000; // 2s between metadata calls
const DOWNLOAD_TIMEOUT = 600000; // 10 min — APKs can be 100MB+
const MAX_REDIRECTS = 5;

/**
 * Host suffixes the download URL is allowed to resolve to. The download URL is
 * extracted from the (untrusted) protobuf blob and 302s download.pureapk.com →
 * a *.winudf.com CDN node, so without this an attacker-influenced blob could
 * coerce a fetch to an internal address (SSRF). We pin to APKPure's own hosts.
 */
const ALLOWED_HOST_SUFFIXES = ['.pureapk.com', '.winudf.com'];

/** apkeep's download-URL regex: a `XAPKJ`/`APKJ` marker, two protobuf length
 * bytes (the `..`), then the http(s) URL. The trailing char class extends
 * apkeep's with `|` so an embedded `c=<n>|<cat>|<b64>` param isn't truncated. */
const DOWNLOAD_URL_RE =
  /(X?APKJ)..(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=|]*)/;

/** versionCode (field 5, 0x2a) immediately followed by versionName (field 6,
 * 0x32) — the verified adjacency in the app_version blob. Anchoring on both
 * tags avoids matching a stray 0x2a/0x32 byte elsewhere. */
const VERSION_FIELDS_RE = /\x2a([\x01-\x10])([0-9]{1,16})\x32([\x01-\x40])/;

/** Validate a URL's host against the APKPure allowlist; reject private/IP hosts. */
function assertAllowedHost(rawUrl: string): void {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error(`Invalid URL from APKPure: ${rawUrl}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Refusing non-http(s) URL from APKPure: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  // Reject IP-literal hosts outright (and especially private/link-local ones).
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error(`Refusing fetch to private address: ${host}`);
    throw new Error(`Refusing fetch to non-APKPure IP host: ${host}`);
  }
  if (!ALLOWED_HOST_SUFFIXES.some(s => host === s.slice(1) || host.endsWith(s))) {
    throw new Error(`Refusing fetch to non-APKPure host: ${host}`);
  }
}

/**
 * fetch() that re-validates the host on every redirect hop. `redirect: 'follow'`
 * would let an allowlisted URL 302 to an internal target, so we follow manually
 * and run assertAllowedHost on each Location.
 */
async function fetchApkPure(rawUrl: string, init: RequestInit): Promise<Response> {
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

export interface ApkPureParsed {
  versionName: string;
  versionCode?: number;
  fileSize?: number;
  downloadUrl: string;
  /** true when the download is an XAPK bundle (XAPKJ marker), not a plain APK. */
  isXapk: boolean;
  /** Always undefined — APKPure publishes a sha1, not a sha256, so there is
   * nothing to verify a sha256 against. Kept in the shape for the contract. */
  sha256: undefined;
}

function toInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Decode an apkpure `c=` query value. Its form is `<n>|<CATEGORY>|<base64>`
 * where the base64'd third segment URL-decodes to e.g.
 *   `dev=...&t=apk&s=140490795&vn=6.0.28&vc=217`
 * Returns the parsed inner params, or null when absent/malformed.
 */
function parseCParam(downloadUrl: string): URLSearchParams | null {
  let c: string | null;
  try { c = new URL(downloadUrl).searchParams.get('c'); } catch { return null; }
  if (!c) return null;
  const seg = c.split('|').pop();
  if (!seg) return null;
  try {
    const decoded = Buffer.from(seg, 'base64').toString('utf8');
    return new URLSearchParams(decodeURIComponent(decoded));
  } catch {
    return null;
  }
}

/** Decode a protobuf varint at offset `i`; returns the value or undefined. */
function readVarint(buf: Buffer, i: number): number | undefined {
  let shift = 0, val = 0, n = 0;
  while (i + n < buf.length && n < 9) {
    const b = buf[i + n]; val |= (b & 0x7f) << shift; n += 1;
    if (!(b & 0x80)) return val >>> 0;
    shift += 7;
  }
  return undefined;
}

/**
 * Pure byte-regex parse of the api.pureapk.com app_version blob. Returns the
 * latest version's metadata + download URL, or null when the blob carries no
 * usable download marker (app not on the store / INVALID_COMMAND). Exported for
 * unit tests, which synthesize the byte markers without real protobuf bytes.
 *
 * Primary source for vc/vn is the adjacent protobuf fields:
 *   versionCode  field 5  -> 0x2a <len> "<digits>"
 *   versionName  field 6  -> 0x32 <len> "<str>"
 * For the file size:
 *   field 4  -> 0x20 <varint>  (sits just before the download marker)
 * The download URL's `c=` param (`s`/`vn`/`vc`, base64'd) is used to fill any
 * value the protobuf scan missed.
 */
export function parseApkPureBlob(buf: Buffer): ApkPureParsed | null {
  const text = buf.toString('latin1');
  const m = DOWNLOAD_URL_RE.exec(text);
  if (!m) return null;
  const isXapk = m[1] === 'XAPKJ';
  const downloadUrl = m[2];

  // Primary: the adjacent versionCode(0x2a)+versionName(0x32) protobuf fields.
  let versionName: string | undefined;
  let versionCode: number | undefined;
  const vm = VERSION_FIELDS_RE.exec(text);
  if (vm) {
    const vcLen = vm[1].charCodeAt(0);
    const vnLen = vm[3].charCodeAt(0);
    const vcStart = vm.index + 2;
    versionCode = toInt(text.slice(vcStart, vcStart + vcLen));
    const vnStart = vm.index + 2 + vcLen + 2; // +2 for the 0x32 tag + len byte
    versionName = text.slice(vnStart, vnStart + vnLen);
  }

  // File size: a 0x20 (field 4, varint) tag in the short window before the marker.
  let fileSize: number | undefined;
  const markerIdx = buf.indexOf(m[1]);
  if (markerIdx > 0) {
    for (let j = markerIdx - 1; j >= 0 && j > markerIdx - 40; j--) {
      if (buf[j] === 0x20) {
        const v = readVarint(buf, j + 1);
        if (v !== undefined && v > 1000 && v < 5_000_000_000) { fileSize = v; break; }
      }
    }
  }

  // Supplement anything still missing from the c= param.
  const c = parseCParam(downloadUrl);
  if (c) {
    if (!versionName) versionName = c.get('vn') ?? undefined;
    if (versionCode === undefined) versionCode = toInt(c.get('vc') ?? undefined);
    if (fileSize === undefined) fileSize = toInt(c.get('s') ?? undefined);
  }

  if (!versionName) return null; // no usable version → treat as not-on-store
  return { versionName, versionCode, fileSize, downloadUrl, isXapk, sha256: undefined };
}

export class ApkPureSource implements RemoteApkSource {
  readonly id = 'apkpure';
  readonly label = 'APKPure';

  private lastRequestTime = 0;
  private db: AppDatabase | null = null;
  /**
   * Short-lived per-package cache of the parsed blob. checkVersion → downloadApk
   * otherwise issues two GETs to the same rate-limited endpoint; this collapses
   * them into one within the TTL window.
   */
  private recordCache = new Map<string, { parsed: ApkPureParsed | null; at: number }>();
  private static readonly RECORD_TTL_MS = 15000;

  setDatabase(db: AppDatabase): void {
    this.db = db;
  }

  isConfigured(): boolean {
    return true; // No credentials required.
  }

  /**
   * APKPure's per-app slug needs a separate lookup, so we point at the search
   * page (a pure, no-network string) rather than guess a slug that may 404.
   */
  storeUrl(packageName: string): string {
    return `https://apkpure.com/search?q=${encodeURIComponent(packageName)}`;
  }

  defaultEnabled(): boolean {
    return false; // Opt-in.
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
      await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * GET the metadata endpoint and byte-regex it. Returns the parsed record, or
   * null when the app isn't on the store. Throws on HTTP / network errors.
   */
  private async fetchRecord(packageName: string): Promise<ApkPureParsed | null> {
    const cached = this.recordCache.get(packageName);
    if (cached && Date.now() - cached.at < ApkPureSource.RECORD_TTL_MS) return cached.parsed;

    await this.rateLimit();
    const res = await fetch(`${APKPURE_API}${encodeURIComponent(packageName)}`, {
      headers: APKPURE_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`APKPure API HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = parseApkPureBlob(buf);
    this.recordCache.set(packageName, { parsed, at: Date.now() });
    return parsed;
  }

  async checkVersion(packageName: string): Promise<VersionCheckResult | null> {
    const parsed = await this.fetchRecord(packageName);
    if (!parsed) return null;
    return {
      versionName: parsed.versionName,
      versionCode: parsed.versionCode,
      fileSize: parsed.fileSize,
      sha256: undefined, // APKPure publishes sha1, not sha256 — nothing to verify.
    };
  }

  async downloadApk(packageName: string, _appName?: string): Promise<DownloadResult> {
    let parsed: ApkPureParsed | null;
    try {
      parsed = await this.fetchRecord(packageName);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    if (!parsed || !parsed.downloadUrl) {
      return { success: false, error: 'App not available on APKPure' };
    }

    // Stream into a uniquely-named staging file inside the package dir. The
    // tracker dedups + finalizes the move only when the version is kept, so a
    // staged file can never clobber an already-stored APK.
    const pkgDir = packageDir(packageName);
    fs.mkdirSync(pkgDir, { recursive: true });
    const stagedPath = path.join(pkgDir, `.dl-${crypto.randomUUID()}.apk`);
    // XAPK download needs a scratch dir for the raw zip. The exploded split set
    // is staged inside pkgDir (same filesystem) so the tracker's finalize is a
    // rename, not a cross-device copy.
    let tmpDir: string | null = null;
    let splitDir: string | null = null;

    try {
      const res = await fetchApkPure(parsed.downloadUrl, {
        headers: { 'User-Agent': APKPURE_HEADERS['User-Agent'] },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      });
      if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

      // Download the raw bytes. For an XAPK we must land the whole zip first,
      // then explode it into its split set; for a plain APK the raw bytes ARE
      // the staged file, so we stream straight to stagedPath.
      let rawPath = stagedPath;
      if (parsed.isXapk) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkpure-xapk-'));
        rawPath = path.join(tmpDir, 'bundle.xapk');
      }
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(rawPath));

      const rawSize = fs.statSync(rawPath).size;
      if (rawSize < 1000) throw new Error('Downloaded file too small');
      // Size check against the metadata (the c=/protobuf `s`). This is a
      // transit-integrity check (truncation / wrong CDN object), NOT authenticity
      // — the URL and its size come from the same blob. APKPure gives no sha256.
      if (parsed.fileSize && rawSize !== parsed.fileSize) {
        throw new Error(`Size mismatch: got ${rawSize} bytes, expected ${parsed.fileSize}`);
      }

      // The APK we read version metadata from + the total on-disk size.
      let versionApk: string;
      let finalSize: number;
      if (parsed.isXapk) {
        // Explode the whole split set (base.apk + config/density/ABI splits, which
        // hold native libraries) into a staged dir on pkgDir's filesystem.
        splitDir = path.join(pkgDir, `.dl-${crypto.randomUUID()}`);
        const unpacked = await unpackApkBundle(rawPath, splitDir);
        versionApk = unpacked.baseApk;
        finalSize = unpacked.apkFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
      } else {
        versionApk = stagedPath;
        finalSize = fs.statSync(stagedPath).size;
      }
      if (finalSize < 1000) throw new Error('Extracted APK too small');

      // Prefer the APK manifest's own versionCode; fall back to the API value.
      const manifest = readApkVersion(versionApk);
      const versionCode = manifest.versionCode ?? parsed.versionCode ?? null;
      if (!versionCode) throw new Error('Could not determine versionCode');
      const versionName = manifest.versionName || parsed.versionName || 'unknown';

      log(`APKPure downloaded ${packageName} v${versionName} (${versionCode}) — ${(finalSize / 1024 / 1024).toFixed(1)} MB${parsed.isXapk ? ' (XAPK, splits preserved)' : ''}`);
      // The staged path (file or split dir) is finalized/discarded by the tracker.
      if (parsed.isXapk) {
        return { success: true, splitDir: splitDir!, versionCode, versionName, fileSize: finalSize };
      }
      return { success: true, filePath: stagedPath, versionCode, versionName, fileSize: finalSize };
    } catch (err: any) {
      try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
      if (splitDir) { try { fs.rmSync(splitDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      error(`APKPure download failed for ${packageName}: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }
}
