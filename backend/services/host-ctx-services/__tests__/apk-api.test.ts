import { describe, it, expect, vi } from 'vitest';
import { createApkApi } from '../apk-api';

describe('ApkApi', () => {
  it('lookupVersion forwards', async () => {
    const lookupVersionMeta = vi.fn().mockResolvedValue({
      versionId: 1, packageName: 'com.x', versionName: '1.0', versionCode: 1
    });
    const ensureApkLocal = vi.fn();
    const analysisDbPath = vi.fn();
    const api = createApkApi({ lookupVersionMeta, ensureApkLocal, analysisDbPath });
    expect(await api.lookupVersion(1)).toMatchObject({ packageName: 'com.x' });
    expect(lookupVersionMeta).toHaveBeenCalledWith(1);
  });

  it('ensureLocal forwards', async () => {
    const lookupVersionMeta = vi.fn();
    const ensureApkLocal = vi.fn().mockResolvedValue('/tmp/apk');
    const analysisDbPath = vi.fn();
    const api = createApkApi({ lookupVersionMeta, ensureApkLocal, analysisDbPath });
    expect(await api.ensureLocal({ versionId: 1 })).toBe('/tmp/apk');
  });

  it('analysisDbPath forwards', () => {
    const lookupVersionMeta = vi.fn();
    const ensureApkLocal = vi.fn();
    const analysisDbPath = vi.fn().mockReturnValue('/tmp/analysis.db');
    const api = createApkApi({ lookupVersionMeta, ensureApkLocal, analysisDbPath });
    expect(api.analysisDbPath({ versionId: 1 })).toBe('/tmp/analysis.db');
  });
});
