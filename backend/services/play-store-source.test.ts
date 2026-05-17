import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock google-play-scraper
vi.mock('google-play-scraper', () => ({
  default: {
    app: vi.fn(),
  },
}));

// Mock readApkVersion
vi.mock('../utils/apk-version-reader', () => ({
  readApkVersion: vi.fn(),
}));

// Mock adm-zip
vi.mock('adm-zip', () => ({
  default: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...(actual as any).default,
      existsSync: vi.fn().mockReturnValue(true),
      mkdtempSync: vi.fn().mockReturnValue('/tmp/darkride-apkeep-test'),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn().mockReturnValue(['com.example.app.apk']),
      copyFileSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ size: 5000000 }),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
      chmodSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(true),
    mkdtempSync: vi.fn().mockReturnValue('/tmp/darkride-apkeep-test'),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue(['com.example.app.apk']),
    copyFileSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 5000000 }),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

import gplay from 'google-play-scraper';
import { execFile } from 'child_process';
import fs from 'fs';
import { readApkVersion } from '../utils/apk-version-reader';
import { PlayStoreSource } from './play-store-source';

describe('PlayStoreSource', () => {
  let source: PlayStoreSource;

  beforeEach(() => {
    vi.clearAllMocks();
    source = new PlayStoreSource();
    // apkeep binary exists by default
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  describe('checkVersion', () => {
    it('returns version info on success', async () => {
      vi.mocked(gplay.app).mockResolvedValue({
        version: '5.2.1',
        title: 'YouTube',
      } as any);

      const result = await source.checkVersion('com.google.android.youtube');
      expect(result).toEqual({ versionName: '5.2.1', appName: 'YouTube' });
      expect(gplay.app).toHaveBeenCalledWith({
        appId: 'com.google.android.youtube',
        lang: 'en',
        country: 'us',
      });
    });

    it('returns null on error', async () => {
      vi.mocked(gplay.app).mockRejectedValue(new Error('Not found'));

      const result = await source.checkVersion('com.nonexistent.app');
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      vi.mocked(gplay.app).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await source.checkVersion('com.example.app');
      expect(result).toBeNull();
    });
  });

  describe('downloadApk', () => {
    it('uses APKPure when no credentials configured', async () => {
      // No database set — no credentials, falls back to APKPure
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, 'Downloaded', '');
        return {} as any;
      });

      vi.mocked(readApkVersion).mockReturnValue({
        versionCode: 100,
        versionName: '1.0.0',
        packageName: 'com.example.app',
      });

      const result = await source.downloadApk('com.example.app', 'Example App');
      expect(result.success).toBe(true);
      expect(result.versionCode).toBe(100);

      // Should have called apkeep without -d google-play flags
      const callArgs = vi.mocked(execFile).mock.calls[0][1] as string[];
      expect(callArgs).toContain('-a');
      expect(callArgs).toContain('com.example.app');
      expect(callArgs).not.toContain('-d');
      expect(callArgs).not.toContain('google-play');
    });

    it('uses Google Play when credentials are configured', async () => {
      let settingsCallCount = 0;
      const settingsValues = [
        [{ key: 'google_play_email', value: 'test@gmail.com' }],
        [{ key: 'google_play_aas_token', value: 'aas_token_123' }],
      ];
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              all: () => settingsValues[settingsCallCount++] || [],
            }),
          }),
        }),
      };
      source.setDatabase(mockDb as any);

      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, 'Downloaded com.example.app', '');
        return {} as any;
      });

      vi.mocked(readApkVersion).mockReturnValue({
        versionCode: 123,
        versionName: '1.2.3',
        packageName: 'com.example.app',
      });

      const result = await source.downloadApk('com.example.app', 'Example App');
      expect(result.success).toBe(true);
      expect(result.versionCode).toBe(123);
      expect(result.versionName).toBe('1.2.3');

      // Should have called apkeep with Google Play flags
      const callArgs = vi.mocked(execFile).mock.calls[0][1] as string[];
      expect(callArgs).toContain('-d');
      expect(callArgs).toContain('google-play');
      expect(callArgs).toContain('-e');
      expect(callArgs).toContain('test@gmail.com');
    });

    it('falls back to APKPure when Google Play fails', async () => {
      let settingsCallCount = 0;
      const settingsValues = [
        [{ key: 'google_play_email', value: 'test@gmail.com' }],
        [{ key: 'google_play_aas_token', value: 'bad_token' }],
      ];
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              all: () => settingsValues[settingsCallCount++] || [],
            }),
          }),
        }),
      };
      source.setDatabase(mockDb as any);

      let execCallCount = 0;
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        execCallCount++;
        if (execCallCount === 1) {
          // Google Play fails
          cb(new Error('exit code 1'), '', 'Authentication failed');
        } else {
          // APKPure succeeds
          cb(null, 'Downloaded', '');
        }
        return {} as any;
      });

      vi.mocked(readApkVersion).mockReturnValue({
        versionCode: 200,
        versionName: '2.0.0',
        packageName: 'com.example.app',
      });

      const result = await source.downloadApk('com.example.app', 'Example App');
      expect(result.success).toBe(true);
      expect(result.versionCode).toBe(200);

      // Should have been called twice (Google Play then APKPure)
      expect(execFile).toHaveBeenCalledTimes(2);
    });

    it('returns failure when both sources fail', async () => {
      let settingsCallCount = 0;
      const settingsValues = [
        [{ key: 'google_play_email', value: 'test@gmail.com' }],
        [{ key: 'google_play_aas_token', value: 'token' }],
      ];
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              all: () => settingsValues[settingsCallCount++] || [],
            }),
          }),
        }),
      };
      source.setDatabase(mockDb as any);

      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(new Error('exit code 1'), '', 'Download failed');
        return {} as any;
      });

      const result = await source.downloadApk('com.example.app', 'Example App');
      expect(result.success).toBe(false);
    });

    it('returns failure when no APK files produced', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, '', '');
        return {} as any;
      });

      vi.mocked(fs.readdirSync).mockReturnValue([]);

      const result = await source.downloadApk('com.example.app', 'Example App');
      expect(result.success).toBe(false);
      expect(result.error).toContain('no downloadable files');
    });
  });

  describe('hasGooglePlayCredentials', () => {
    it('returns false without database', () => {
      expect(source.hasGooglePlayCredentials()).toBe(false);
    });

    it('returns false without credentials', () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              all: () => [],
            }),
          }),
        }),
      };
      source.setDatabase(mockDb as any);
      expect(source.hasGooglePlayCredentials()).toBe(false);
    });
  });
});
