import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

/** Result of unpacking an XAPK/APKS bundle into a directory of split APKs. */
export interface UnpackedBundle {
  /** The destination directory containing the extracted `.apk` files. */
  dir: string;
  /** Absolute path to the base APK, always named `base.apk`. */
  baseApk: string;
  /** Absolute paths of every `.apk` written (base + splits). */
  apkFiles: string[];
}

const isSplitName = (basename: string): boolean => {
  const lower = basename.toLowerCase();
  return lower.includes('split') || lower.includes('config');
};

/**
 * Unpack an XAPK/APKS bundle (a ZIP of `base.apk` + `split_config.*.apk`) into
 * `destDir`, preserving every split. Native libraries ship in the ABI/config
 * splits, so keeping them is the whole point.
 *
 * The chosen base APK is always written as `destDir/base.apk` because the
 * analyzer keys off a file literally named `base.apk`. Non-base entries keep
 * their original basename; a non-base entry whose basename would collide with
 * `base.apk` is prefixed with `split_`.
 *
 * The async signature is for future-proofing; adm-zip is synchronous.
 */
export async function unpackApkBundle(bundlePath: string, destDir: string): Promise<UnpackedBundle> {
  const zip = new AdmZip(bundlePath);
  const apkEntries = zip.getEntries().filter(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.apk'));

  if (apkEntries.length === 0) {
    throw new Error('No APK entries found in bundle');
  }

  // Pick the base: an entry basenamed `base.apk`; else one whose basename has
  // neither "split" nor "config"; else the largest `.apk` by size.
  const baseEntry =
    apkEntries.find(e => path.basename(e.entryName) === 'base.apk')
    ?? apkEntries.find(e => !isSplitName(path.basename(e.entryName)))
    ?? apkEntries.reduce((a, b) => (a.header.size >= b.header.size ? a : b));

  fs.mkdirSync(destDir, { recursive: true });

  const apkFiles: string[] = [];
  const basePath = path.join(destDir, 'base.apk');

  // Write the base first, forced to the exact name `base.apk`.
  fs.writeFileSync(basePath, baseEntry.getData());
  apkFiles.push(basePath);

  for (const entry of apkEntries) {
    if (entry === baseEntry) continue;
    let outName = path.basename(entry.entryName);
    // A non-base entry named base.apk would clobber the chosen base — prefix it.
    if (outName === 'base.apk') outName = `split_${outName}`;
    const outPath = path.join(destDir, outName);
    fs.writeFileSync(outPath, entry.getData());
    apkFiles.push(outPath);
  }

  return { dir: destDir, baseApk: basePath, apkFiles };
}
