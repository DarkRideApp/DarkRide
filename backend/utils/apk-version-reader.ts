import AdmZip from 'adm-zip';
import { decodeAxml, isAxmlBuffer } from './axml-parser';

interface ApkVersionInfo {
  versionCode: number | null;
  versionName: string | null;
  packageName: string | null;
}

/**
 * Parse versionCode, versionName, and package from decoded AndroidManifest XML text.
 */
export function parseManifestXml(xml: string): ApkVersionInfo {
  let versionCode: number | null = null;
  let versionName: string | null = null;
  let packageName: string | null = null;

  // package="com.example.app"
  const pkgMatch = xml.match(/\bpackage="([^"]+)"/);
  if (pkgMatch) packageName = pkgMatch[1];

  // android:versionCode="123" or platformBuildVersionCode="123"
  // In decoded AXML, versionCode is a typed int value, shown as android:versionCode="123"
  const vcMatch = xml.match(/android:versionCode="(\d+)"/);
  if (vcMatch) versionCode = parseInt(vcMatch[1], 10);

  // android:versionName="1.2.3"
  const vnMatch = xml.match(/android:versionName="([^"]+)"/);
  if (vnMatch) versionName = vnMatch[1];

  return { versionCode, versionName, packageName };
}

/**
 * Read version info from an APK file on disk.
 * Opens the APK as a ZIP, extracts and decodes AndroidManifest.xml.
 */
export function readApkVersion(apkPath: string): ApkVersionInfo {
  const zip = new AdmZip(apkPath);
  const entry = zip.getEntry('AndroidManifest.xml');
  if (!entry) return { versionCode: null, versionName: null, packageName: null };

  const buf = entry.getData();
  let xml: string;

  if (isAxmlBuffer(buf)) {
    xml = decodeAxml(buf);
  } else {
    // Plain text XML (unlikely for APKs but handle gracefully)
    xml = buf.toString('utf8');
  }

  return parseManifestXml(xml);
}
