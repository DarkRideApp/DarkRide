import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseXiaomiResponse, XiaomiSource } from './xiaomi-source';
import fixture from './__fixtures__/xiaomi-wechat.json';

const PKG = 'com.tencent.mm';

describe('parseXiaomiResponse', () => {
  it('maps the real /apm/app fixture', () => {
    const result = parseXiaomiResponse(fixture);
    expect(result).toEqual({
      versionName: '8.0.74',
      appName: '微信',
      versionCode: 3120,
      fileSize: 261152116,
      sha256: undefined,
    });
  });

  it('returns null when there is no app object (not on store)', () => {
    expect(parseXiaomiResponse({})).toBeNull();
    expect(parseXiaomiResponse({ host: 'x', app: null })).toBeNull();
    expect(parseXiaomiResponse({ app: {} })).toBeNull(); // no versionName
    expect(parseXiaomiResponse(undefined)).toBeNull();
  });
});

describe('XiaomiSource.checkVersion', () => {
  let src: XiaomiSource;
  beforeEach(() => {
    src = new XiaomiSource();
  });
  afterEach(() => vi.unstubAllGlobals());

  function mockGet(body: unknown, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  }

  it('parses a found app', async () => {
    mockGet(fixture);
    const r = await src.checkVersion(PKG);
    expect(r?.versionCode).toBe(3120);
    expect(r?.versionName).toBe('8.0.74');
    expect(r?.fileSize).toBe(261152116);
    expect(r?.appName).toBe('微信');
  });

  it('returns null when not on the store (no app object)', async () => {
    mockGet({ host: 'https://app.market.xiaomi.com' });
    expect(await src.checkVersion('com.not.cn')).toBeNull();
  });

  it('throws on an HTTP error', async () => {
    mockGet({}, 503);
    await expect(src.checkVersion(PKG)).rejects.toThrow(/HTTP 503/);
  });

  it('throws on invalid JSON (parse error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(src.checkVersion(PKG)).rejects.toThrow();
  });
});

describe('XiaomiSource.downloadApk', () => {
  let src: XiaomiSource;
  beforeEach(() => {
    src = new XiaomiSource();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns success:false with the gated-error message and makes NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await src.downloadApk(PKG);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/store-gated/i);
    expect(r.error).toMatch(/availability/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('XiaomiSource metadata', () => {
  const src = new XiaomiSource();

  it('is configured and opt-in by default', () => {
    expect(src.isConfigured()).toBe(true);
    expect(src.defaultEnabled()).toBe(false);
  });

  it('builds the package-keyed store URL', () => {
    expect(src.storeUrl('com.tencent.mm')).toBe('https://app.mi.com/details?id=com.tencent.mm');
  });

  it('encodes the package name in the store URL', () => {
    expect(src.storeUrl('a b')).toBe('https://app.mi.com/details?id=a%20b');
  });
});
