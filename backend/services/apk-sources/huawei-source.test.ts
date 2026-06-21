import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { parseHuaweiRecord, HuaweiSource } from './huawei-source';
import fixture from './__fixtures__/huawei-wechat.json';

const PKG = 'com.tencent.mm';

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

describe('parseHuaweiRecord', () => {
  it('maps the real clientApi fixture', () => {
    const rec = (fixture as any).list[0];
    const result = parseHuaweiRecord(rec);
    expect(result).toEqual({
      versionName: '8.0.74',
      appName: '微信',
      versionCode: 3120,
      fileSize: 261152116,
      sha256: 'e69e0c5e1f0a8b2d3c4a5b6c7d8e9f0011223344556677889900aabbccddeeff',
    });
  });

  it('returns null for a missing or empty record', () => {
    expect(parseHuaweiRecord(undefined)).toBeNull();
    expect(parseHuaweiRecord({})).toBeNull();
    expect(parseHuaweiRecord({ version: '1.0' })).toBeNull(); // no fullDownUrl
  });
});

describe('HuaweiSource.checkVersion', () => {
  let src: HuaweiSource;
  beforeEach(() => {
    src = new HuaweiSource();
    // No DB needed for checkVersion.
  });
  afterEach(() => vi.unstubAllGlobals());

  function mockPost(body: unknown, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  }

  it('parses a found app', async () => {
    mockPost(fixture);
    const r = await src.checkVersion(PKG);
    expect(r?.versionCode).toBe(3120);
    expect(r?.versionName).toBe('8.0.74');
  });

  it('returns null when not on the store (count=0, empty list)', async () => {
    mockPost({ count: 0, list: [] });
    expect(await src.checkVersion('com.not.cn')).toBeNull();
  });

  it('retries the second serviceCountry once before giving up on count=0', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      posts++;
      // First (CN) returns nothing; second (IE) carries the app.
      const body = posts === 1 ? { count: 0, list: [] } : fixture;
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const r = await src.checkVersion(PKG);
    expect(posts).toBe(2);
    expect(r?.versionCode).toBe(3120);
  });

  it('throws on an HTTP error', async () => {
    mockPost({}, 503);
    await expect(src.checkVersion(PKG)).rejects.toThrow(/HTTP 503/);
  });
});

describe('HuaweiSource.downloadApk', () => {
  let src: HuaweiSource;
  let dataRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    src = new HuaweiSource();
    prevDataRoot = process.env.DATA_ROOT;
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huawei-test-'));
    process.env.DATA_ROOT = dataRoot;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  /** Mock the clientApi POST + the file GET. overrides patches the list[0] fields. */
  function mockDownload(apk: Buffer, overrides: Record<string, unknown>) {
    const sha256 = crypto.createHash('sha256').update(apk).digest('hex');
    const body = {
      count: 1,
      list: [
        {
          id: 'C5683',
          name: '微信',
          version: '8.0.74',
          versionCode: 3120,
          fullSize: apk.length,
          sha256,
          fullDownUrl: 'https://appdlc-dre.hispace.dbankcloud.com/dl/appdl/test.apk',
          ...overrides,
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('clientApi')) return new Response(JSON.stringify(body), { status: 200 });
      return new Response(apk, { status: 200 }); // the APK download
    }));
    return sha256;
  }

  it('downloads + verifies sha256, returning a staged (not final) file', async () => {
    const apk = makeApk(3120, '8.0.74');
    mockDownload(apk, {});
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(true);
    expect(r.versionCode).toBe(3120);
    expect(r.versionName).toBe('8.0.74');
    expect(r.fileSize).toBe(apk.length);
    expect(fs.existsSync(r.filePath!)).toBe(true);
    // The final <versionCode>_<versionName>.apk move happens in the tracker; the
    // source returns a uniquely-named staging file to avoid clobbering on dedup.
    expect(path.basename(r.filePath!)).toMatch(/^\.dl-.*\.apk$/);
  });

  it('rejects a download URL on a non-Huawei host (SSRF guard)', async () => {
    const apk = makeApk(3120, '8.0.74');
    mockDownload(apk, { fullDownUrl: 'https://evil.example.com/x.apk' });
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/refusing fetch/i);
  });

  it('rejects a download URL on a private IP host (SSRF guard)', async () => {
    const apk = makeApk(3120, '8.0.74');
    mockDownload(apk, { fullDownUrl: 'http://169.254.169.254/latest/meta-data/' });
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/refusing fetch/i);
  });

  it('fails on a sha256 mismatch (tamper guard)', async () => {
    const apk = makeApk(3120, '8.0.74');
    mockDownload(apk, { sha256: 'deadbeef'.repeat(8) });
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/sha256 mismatch/i);
  });

  it('fails on a size mismatch', async () => {
    const apk = makeApk(3120, '8.0.74');
    mockDownload(apk, { fullSize: apk.length + 5 });
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/size mismatch/i);
  });

  it('fails cleanly when the app is not on the store', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0, list: [] }), { status: 200 })));
    const r = await src.downloadApk('com.not.cn');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not available/i);
  });

  it('reuses the cached record so checkVersion + downloadApk issue a single info POST', async () => {
    const apk = makeApk(3120, '8.0.74');
    const sha256 = crypto.createHash('sha256').update(apk).digest('hex');
    const body = {
      count: 1,
      list: [
        {
          id: 'C5683', name: '微信', version: '8.0.74', versionCode: 3120,
          fullSize: apk.length, sha256,
          fullDownUrl: 'https://appdlc-dre.hispace.dbankcloud.com/dl/appdl/test.apk',
        },
      ],
    };
    let infoPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('clientApi')) { infoPosts++; return new Response(JSON.stringify(body), { status: 200 }); }
      return new Response(apk, { status: 200 });
    }));

    await src.checkVersion(PKG);
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(true);
    expect(infoPosts).toBe(1); // record cached across the two calls
  });
});
