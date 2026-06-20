import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { parseQqRecord, QqSource } from './qq-source';
import fixture from './__fixtures__/qq-ftthemepark.json';

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

describe('parseQqRecord', () => {
  it('maps the real wechat-apkinfo fixture', () => {
    const rec = (fixture as any).app_detail_records[PKG];
    const result = parseQqRecord(rec);
    expect(result).toEqual({
      versionName: '6.0.28',
      appName: '方特旅游',
      versionCode: 217,
      fileSize: 140490795,
      sha256: '9caaa8c5f424c6e6df812dda3035e393beea7196b7795524da64ca77095703ab',
    });
  });

  it('returns null for a missing or empty record', () => {
    expect(parseQqRecord(undefined)).toBeNull();
    expect(parseQqRecord({})).toBeNull();
    expect(parseQqRecord({ apk_all_data: { version_name: '1.0' } })).toBeNull(); // no url
  });
});

describe('QqSource.checkVersion', () => {
  let src: QqSource;
  beforeEach(() => {
    src = new QqSource();
    // No DB needed for checkVersion.
  });
  afterEach(() => vi.unstubAllGlobals());

  function mockPost(body: unknown, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  }

  it('parses a found app', async () => {
    mockPost(fixture);
    const r = await src.checkVersion(PKG);
    expect(r?.versionCode).toBe(217);
    expect(r?.versionName).toBe('6.0.28');
  });

  it('returns null when not on the store (ret=0, empty records)', async () => {
    mockPost({ ret: 0, app_detail_records: {} });
    expect(await src.checkVersion('com.not.cn')).toBeNull();
  });

  it('throws on a non-zero ret', async () => {
    mockPost({ ret: -1, err_msg: 'bad' });
    await expect(src.checkVersion(PKG)).rejects.toThrow(/ret=-1/);
  });

  it('throws on an HTTP error', async () => {
    mockPost({}, 503);
    await expect(src.checkVersion(PKG)).rejects.toThrow(/HTTP 503/);
  });
});

describe('QqSource.downloadApk', () => {
  let src: QqSource;
  let dataRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    src = new QqSource();
    prevDataRoot = process.env.DATA_ROOT;
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-test-'));
    process.env.DATA_ROOT = dataRoot;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  /** Mock the info POST + the file GET. record overrides apk_all_data fields. */
  function mockDownload(apk: Buffer, overrides: Record<string, unknown>) {
    const sha256 = crypto.createHash('sha256').update(apk).digest('hex');
    const record = {
      ret: 0,
      app_detail_records: {
        [PKG]: {
          app_info: { name: '方特旅游' },
          apk_all_data: {
            version_code: 217, version_name: '6.0.28',
            url: 'http://imtt.dd.qq.com/test.apk',
            size_byte: String(apk.length), sha256,
            ...overrides,
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('wechat-apkinfo')) return new Response(JSON.stringify(record), { status: 200 });
      return new Response(apk, { status: 200 }); // the APK download
    }));
    return sha256;
  }

  it('downloads + verifies sha256, returning a staged (not final) file', async () => {
    const apk = makeApk(217, '6.0.28');
    mockDownload(apk, {});
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(true);
    expect(r.versionCode).toBe(217);
    expect(r.versionName).toBe('6.0.28');
    expect(r.fileSize).toBe(apk.length);
    expect(fs.existsSync(r.filePath!)).toBe(true);
    // The final <versionCode>_<versionName>.apk move happens in the tracker; the
    // source returns a uniquely-named staging file to avoid clobbering on dedup.
    expect(path.basename(r.filePath!)).toMatch(/^\.dl-.*\.apk$/);
  });

  it('rejects a download URL on a non-Tencent host (SSRF guard)', async () => {
    const apk = makeApk(217, '6.0.28');
    mockDownload(apk, { url: 'http://169.254.169.254/latest/meta-data/' });
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/refusing fetch/i);
  });

  it('fails on a sha256 mismatch (tamper guard)', async () => {
    const apk = makeApk(217, '6.0.28');
    mockDownload(apk, { sha256: 'deadbeef'.repeat(8) });
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/sha256 mismatch/i);
  });

  it('fails on a size mismatch', async () => {
    const apk = makeApk(217, '6.0.28');
    mockDownload(apk, { size_byte: String(apk.length + 5) });
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/size mismatch/i);
  });

  it('fails cleanly when the app is not on the store', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ret: 0, app_detail_records: {} }), { status: 200 })));
    const r = await src.downloadApk('com.not.cn');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not available/i);
  });

  it('reuses the cached record so checkVersion + downloadApk issue a single info POST', async () => {
    const apk = makeApk(217, '6.0.28');
    const sha256 = crypto.createHash('sha256').update(apk).digest('hex');
    const record = {
      ret: 0,
      app_detail_records: {
        [PKG]: {
          app_info: { name: '方特旅游' },
          apk_all_data: {
            version_code: 217, version_name: '6.0.28',
            url: 'http://imtt.dd.qq.com/test.apk', size_byte: String(apk.length), sha256,
          },
        },
      },
    };
    let infoPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('wechat-apkinfo')) { infoPosts++; return new Response(JSON.stringify(record), { status: 200 }); }
      return new Response(apk, { status: 200 });
    }));

    await src.checkVersion(PKG);
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(true);
    expect(infoPosts).toBe(1); // record cached across the two calls
  });
});
