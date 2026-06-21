import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { parseApkPureBlob, ApkPureSource } from './apkpure-source';

const PKG = 'com.hytch.ftthemepark';

/** Build a minimal but valid (>1KB) APK zip with a plaintext manifest. */
function makeApk(versionCode: number, versionName: string): Buffer {
  const zip = new AdmZip();
  const manifest =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<manifest package="com.test.app" android:versionCode="${versionCode}" android:versionName="${versionName}"></manifest>`;
  zip.addFile('AndroidManifest.xml', Buffer.from(manifest, 'utf8'));
  zip.addFile('filler.bin', crypto.randomBytes(4096)); // incompressible — keeps zip > 1KB floor
  return zip.toBuffer();
}

/** Wrap an apk Buffer as an XAPK (zip bundle with base.apk + a split). */
function makeXapk(apk: Buffer): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ package_name: 'com.test.app' }), 'utf8'));
  zip.addFile('config.arm64_v8a.apk', crypto.randomBytes(2048)); // a split — must NOT be picked
  zip.addFile('base.apk', apk);
  return zip.toBuffer();
}

/** protobuf varint encoder (used to embed the file-size field, x20). */
function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n & 0x7f);
  return Buffer.from(out);
}

/** Build the apkpure-style `c=` query value: "<n>|<CATEGORY>|<base64-of-urlencoded>". */
function makeCParam(opts: { t: string; s: number; vn: string; vc: number }): string {
  const inner = `dev=Acme&t=${opts.t}&s=${opts.s}&vn=${opts.vn}&vc=${opts.vc}`;
  const b64 = Buffer.from(encodeURIComponent(inner).replace(/%20/g, '+'), 'utf8').toString('base64');
  return `1|TRAVEL_AND_LOCAL|${b64}`;
}

/**
 * Synthesize a length-delimited-protobuf-ish blob carrying the byte markers the
 * real api.pureapk.com response carries (verified live for com.hytch.ftthemepark):
 *  - versionCode  : field 5  -> 0x2a <len> "<vc>"
 *  - versionName  : field 6  -> 0x32 <len> "<vn>"
 *  - sha1         : field 3  -> 0x1a 0x28 <40-hex>
 *  - file size    : field 4  -> 0x20 <varint>
 *  - download URL : marker   -> "APKJ"/"XAPKJ" + 2 length bytes + URL (apkeep regex)
 * The download URL carries an apkpure `c=` param whose 3rd pipe-segment base64-
 * decodes to `t=apk&s=...&vn=...&vc=...`.
 */
function makeBlob(opts: {
  marker?: 'APKJ' | 'XAPKJ';
  url?: string;
  vc?: number;
  vn?: string;
  size?: number;
  sha1?: string;
  withCParam?: boolean;
  cType?: string;
}): Buffer {
  const marker = opts.marker ?? 'APKJ';
  const vc = opts.vc ?? 217;
  const vn = opts.vn ?? '6.0.28';
  const size = opts.size ?? 140490795;
  const sha1 = opts.sha1 ?? 'ddd96fd833603cf90a5b94486e58e3b0fc91fc2c';

  let url = opts.url ?? 'https://download.pureapk.com/b/APK/Y29tLm9v?_fn=zzz&as=abc&ai=-1&at=1782';
  if (opts.withCParam !== false) {
    const c = makeCParam({ t: opts.cType ?? 'apk', s: size, vn, vc });
    url += `&c=${c}`;
  }

  const parts: Buffer[] = [];
  // some leading noise + package name
  parts.push(Buffer.from('\x12\x15', 'binary'), Buffer.from(PKG, 'utf8'));
  // versionCode field 5 (0x2a <len> digits)
  const vcStr = String(vc);
  parts.push(Buffer.from([0x2a, vcStr.length]), Buffer.from(vcStr, 'utf8'));
  // versionName field 6 (0x32 <len> str)
  parts.push(Buffer.from([0x32, vn.length]), Buffer.from(vn, 'utf8'));
  // signature md5 etc noise
  parts.push(Buffer.from(': B3049872FDAAFDF545C622C7A73EAB56A', 'utf8'));
  parts.push(Buffer.from([0, 0, 0, 0]));
  // sha1 field 3 (0x1a 0x28 <40-hex>)
  parts.push(Buffer.from([0x1a, 0x28]), Buffer.from(sha1, 'utf8'));
  // file size field 4 (0x20 <varint>) — sits just before the download marker
  parts.push(Buffer.from([0x20]), varint(size));
  // download marker + 2 protobuf length bytes + url
  const urlBuf = Buffer.from(url, 'utf8');
  parts.push(Buffer.from(`B\x03${marker}`, 'binary'));
  // two length bytes (varint of url length, padded to >=2 for the apkeep `..`)
  const lenV = varint(urlBuf.length);
  const twoLen = lenV.length >= 2 ? lenV.subarray(0, 2) : Buffer.concat([lenV, Buffer.from([0x00])]);
  parts.push(twoLen, urlBuf);
  return Buffer.concat(parts);
}

describe('parseApkPureBlob', () => {
  it('extracts versionName/versionCode/fileSize from the c= param (verified shape)', () => {
    const res = parseApkPureBlob(makeBlob({}));
    expect(res).toEqual({
      versionName: '6.0.28',
      versionCode: 217,
      fileSize: 140490795,
      downloadUrl: expect.stringContaining('download.pureapk.com'),
      isXapk: false,
      sha256: undefined,
    });
  });

  it('flags an XAPK download via the XAPKJ marker', () => {
    const res = parseApkPureBlob(makeBlob({ marker: 'XAPKJ', cType: 'xapk' }));
    expect(res?.isXapk).toBe(true);
  });

  it('falls back to protobuf version/size fields when the c= param is absent', () => {
    const res = parseApkPureBlob(makeBlob({ withCParam: false, vc: 99, vn: '1.2.3', size: 5_555_555 }));
    expect(res?.versionName).toBe('1.2.3');
    expect(res?.versionCode).toBe(99);
    expect(res?.fileSize).toBe(5_555_555);
    expect(res?.downloadUrl).toContain('pureapk.com');
  });

  it('never carries a sha256 (APKPure only publishes sha1)', () => {
    const res = parseApkPureBlob(makeBlob({}));
    expect(res?.sha256).toBeUndefined();
  });

  it('returns null when no download URL marker is present (not on store)', () => {
    expect(parseApkPureBlob(Buffer.from('no markers here, just noise', 'utf8'))).toBeNull();
    expect(parseApkPureBlob(Buffer.alloc(0))).toBeNull();
  });
});

describe('ApkPureSource.checkVersion', () => {
  let src: ApkPureSource;
  beforeEach(() => { src = new ApkPureSource(); });
  afterEach(() => vi.unstubAllGlobals());

  function mockGet(blob: Buffer, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blob, { status })));
  }

  it('parses a found app', async () => {
    mockGet(makeBlob({}));
    const r = await src.checkVersion(PKG);
    expect(r?.versionCode).toBe(217);
    expect(r?.versionName).toBe('6.0.28');
    expect(r?.fileSize).toBe(140490795);
    expect(r?.sha256).toBeUndefined();
  });

  it('returns null when the blob has no usable version/URL (not on store)', async () => {
    mockGet(Buffer.from('INVALID_COMMAND', 'utf8'));
    expect(await src.checkVersion('com.not.here')).toBeNull();
  });

  it('throws on an HTTP error', async () => {
    mockGet(Buffer.alloc(0), 503);
    await expect(src.checkVersion(PKG)).rejects.toThrow(/HTTP 503/);
  });
});

describe('ApkPureSource.downloadApk', () => {
  let src: ApkPureSource;
  let dataRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    src = new ApkPureSource();
    prevDataRoot = process.env.DATA_ROOT;
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apkpure-test-'));
    process.env.DATA_ROOT = dataRoot;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  /** Mock the metadata GET + the file GET. `download` is the bytes served by the CDN. */
  function mockDownload(blobOpts: Parameters<typeof makeBlob>[0], download: Buffer) {
    const blob = makeBlob(blobOpts);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('api.pureapk.com')) return new Response(blob, { status: 200 });
      return new Response(download, { status: 200 }); // the APK/XAPK download
    }));
  }

  it('downloads a plain APK, returning a staged (not final) file', async () => {
    const apk = makeApk(217, '6.0.28');
    mockDownload({ size: apk.length, url: 'https://download.pureapk.com/b/APK/x?as=a' }, apk);
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(true);
    expect(r.versionCode).toBe(217);
    expect(r.versionName).toBe('6.0.28');
    expect(r.fileSize).toBe(apk.length);
    expect(fs.existsSync(r.filePath!)).toBe(true);
    expect(path.basename(r.filePath!)).toMatch(/^\.dl-.*\.apk$/);
  });

  it('extracts base.apk from an XAPK bundle', async () => {
    const apk = makeApk(217, '6.0.28');
    const xapk = makeXapk(apk);
    mockDownload(
      { marker: 'XAPKJ', cType: 'xapk', size: xapk.length, url: 'https://download.pureapk.com/b/XAPK/x?as=a' },
      xapk,
    );
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(true);
    expect(r.versionCode).toBe(217); // read from the extracted base.apk manifest
    expect(fs.existsSync(r.filePath!)).toBe(true);
    expect(path.basename(r.filePath!)).toMatch(/^\.dl-.*\.apk$/);
    // The staged file is the base APK, not the XAPK zip.
    expect(new AdmZip(r.filePath!).getEntry('AndroidManifest.xml')).not.toBeNull();
  });

  it('rejects a download URL on a non-APKPure host (SSRF guard)', async () => {
    const apk = makeApk(217, '6.0.28');
    mockDownload({ size: apk.length, url: 'http://169.254.169.254/latest/meta-data/' }, apk);
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/refusing fetch/i);
  });

  it('fails on a size mismatch', async () => {
    const apk = makeApk(217, '6.0.28');
    mockDownload({ size: apk.length + 5, url: 'https://download.pureapk.com/b/APK/x?as=a' }, apk);
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/size mismatch/i);
  });

  it('fails on a too-small download (sanity floor)', async () => {
    const tiny = Buffer.from('nope');
    mockDownload({ size: tiny.length, url: 'https://download.pureapk.com/b/APK/x?as=a' }, tiny);
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too small/i);
  });

  it('fails cleanly when the app is not on the store', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('INVALID_COMMAND'), { status: 200 })));
    const r = await src.downloadApk('com.not.here');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not available/i);
  });
});

describe('ApkPureSource metadata', () => {
  it('exposes id/label and search storeUrl', () => {
    const src = new ApkPureSource();
    expect(src.id).toBe('apkpure');
    expect(src.label).toBe('APKPure');
    expect(src.isConfigured()).toBe(true);
    expect(src.defaultEnabled()).toBe(false);
    expect(src.storeUrl(PKG)).toBe('https://apkpure.com/search?q=com.hytch.ftthemepark');
  });
});
