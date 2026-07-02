import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { extractIconFromLocalApk } from './apk-tracker';

// Real-fs test (no fs mock). Points DATA_ROOT at a temp dir so packageDir()
// resolves under it, builds real APK zips with AdmZip, and exercises the
// on-disk icon extraction path end to end.

const PKG = 'com.example.iconapp';

function bytes(n: number): Buffer {
  // Deterministic filler > the 100-byte minimum the extractor requires.
  return Buffer.alloc(n, 0xab);
}

/** Write an APK zip into the package dir under the temp DATA_ROOT. */
function writeApk(dataRoot: string, entries: Record<string, Buffer>): void {
  const pkgDir = path.join(dataRoot, 'apks', PKG);
  fs.mkdirSync(pkgDir, { recursive: true });
  const zip = new AdmZip();
  for (const [name, buf] of Object.entries(entries)) {
    zip.addFile(name, buf);
  }
  zip.writeZip(path.join(pkgDir, 'base.apk'));
}

function iconFiles(dataRoot: string): string[] {
  const pkgDir = path.join(dataRoot, 'apks', PKG);
  if (!fs.existsSync(pkgDir)) return [];
  return fs.readdirSync(pkgDir).filter(f => f === 'icon.png' || f === 'icon.webp');
}

describe('extractIconFromLocalApk', () => {
  let dataRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-icon-'));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = dataRoot;
  });

  afterEach(() => {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('extracts a legacy flat launcher raster (ic_launcher.png)', () => {
    writeApk(dataRoot, {
      'res/mipmap-xxxhdpi-v4/ic_launcher.png': bytes(2000),
      'res/mipmap-hdpi-v4/ic_launcher.png': bytes(500),
    });

    expect(extractIconFromLocalApk(PKG)).toBe(true);
    expect(iconFiles(dataRoot)).toContain('icon.png');
  });

  it('extracts an adaptive-icon foreground when no flat launcher raster exists', () => {
    // Modern adaptive-icon layout: the only rasters are the foreground/background
    // layers; the launcher itself is an anydpi XML that references them. There is
    // no plain ic_launcher.png/.webp at any density.
    writeApk(dataRoot, {
      'res/mipmap-anydpi-v26/ic_launcher.xml': bytes(300),
      'res/mipmap-xxxhdpi-v4/ic_launcher_foreground.webp': bytes(3000),
      'res/mipmap-xxxhdpi-v4/ic_launcher_background.webp': bytes(3000),
      'res/mipmap-hdpi-v4/ic_launcher_foreground.webp': bytes(800),
    });

    expect(extractIconFromLocalApk(PKG)).toBe(true);
    expect(iconFiles(dataRoot).length).toBeGreaterThan(0);
  });

  it('returns false when the APK has no launcher icon of any kind', () => {
    writeApk(dataRoot, {
      'res/drawable/random.png': bytes(2000),
      'classes.dex': bytes(2000),
    });

    expect(extractIconFromLocalApk(PKG)).toBe(false);
    expect(iconFiles(dataRoot)).toHaveLength(0);
  });
});
