import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { unpackApkBundle } from './apk-bundle';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeZip(entries: Array<{ name: string; data: Buffer }>): string {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, e.data);
  const out = path.join(tmpDir('apk-bundle-src-'), 'bundle.xapk');
  zip.writeZip(out);
  return out;
}

const dummy = (n: number) => Buffer.alloc(n, 0x41);

describe('unpackApkBundle', () => {
  let dest: string;
  beforeEach(() => { dest = tmpDir('apk-bundle-dest-'); });

  it('(a) extracts base.apk + two split_config APKs, base named base.apk', async () => {
    const src = writeZip([
      { name: 'base.apk', data: dummy(2000) },
      { name: 'split_config.arm64_v8a.apk', data: dummy(1500) },
      { name: 'split_config.en.apk', data: dummy(500) },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]);
    const res = await unpackApkBundle(src, dest);
    expect(res.dir).toBe(dest);
    expect(res.baseApk).toBe(path.join(dest, 'base.apk'));
    expect(res.apkFiles).toHaveLength(3);
    expect(fs.existsSync(path.join(dest, 'base.apk'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'split_config.arm64_v8a.apk'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'split_config.en.apk'))).toBe(true);
    // manifest.json ignored
    expect(fs.existsSync(path.join(dest, 'manifest.json'))).toBe(false);
  });

  it('(b) when no base.apk, an entry without split/config becomes base.apk', async () => {
    const src = writeZip([
      { name: 'com.example.app.apk', data: dummy(3000) },
      { name: 'split_config.arm64_v8a.apk', data: dummy(1500) },
    ]);
    const res = await unpackApkBundle(src, dest);
    expect(res.baseApk).toBe(path.join(dest, 'base.apk'));
    expect(fs.existsSync(path.join(dest, 'base.apk'))).toBe(true);
    // the base is the non-split entry (3000 bytes)
    expect(fs.statSync(path.join(dest, 'base.apk')).size).toBe(3000);
    expect(res.apkFiles).toHaveLength(2);
  });

  it('(c) when all names look like splits, the largest becomes base.apk', async () => {
    const src = writeZip([
      { name: 'split_config.arm64_v8a.apk', data: dummy(1500) },
      { name: 'split_config.xxhdpi.apk', data: dummy(4000) },
      { name: 'split_config.en.apk', data: dummy(500) },
    ]);
    const res = await unpackApkBundle(src, dest);
    expect(res.baseApk).toBe(path.join(dest, 'base.apk'));
    expect(fs.statSync(path.join(dest, 'base.apk')).size).toBe(4000);
    expect(res.apkFiles).toHaveLength(3);
    // the two non-chosen splits keep their basenames
    expect(fs.existsSync(path.join(dest, 'split_config.arm64_v8a.apk'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'split_config.en.apk'))).toBe(true);
  });

  it('(d) nested-path entries are extracted by basename', async () => {
    const src = writeZip([
      { name: 'base.apk', data: dummy(2000) },
      { name: 'splits/split_config.arm64_v8a.apk', data: dummy(1500) },
    ]);
    const res = await unpackApkBundle(src, dest);
    expect(fs.existsSync(path.join(dest, 'base.apk'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'split_config.arm64_v8a.apk'))).toBe(true);
    expect(res.apkFiles).toHaveLength(2);
  });

  it('(e) throws when there are zero .apk entries', async () => {
    const src = writeZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'icon.png', data: dummy(100) },
    ]);
    await expect(unpackApkBundle(src, dest)).rejects.toThrow(/No APK entries found in bundle/);
  });

  it('prefixes a non-base split whose basename collides with base.apk', async () => {
    // base chosen by name; a nested entry also literally named base.apk exists
    const src = writeZip([
      { name: 'base.apk', data: dummy(3000) },
      { name: 'nested/base.apk', data: dummy(1000) },
      { name: 'split_config.en.apk', data: dummy(500) },
    ]);
    const res = await unpackApkBundle(src, dest);
    expect(fs.statSync(path.join(dest, 'base.apk')).size).toBe(3000);
    // the colliding second base.apk is written under a prefixed name
    expect(fs.existsSync(path.join(dest, 'split_base.apk'))).toBe(true);
    expect(res.apkFiles).toHaveLength(3);
  });
});
