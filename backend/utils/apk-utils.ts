import { adbShell } from '../services/device-manager';

/**
 * Enrich a list of APK paths obtained from `pm path` by also enumerating
 * the on-device directory with `ls`.
 *
 * Some Android versions omit base.apk from `pm path` output for split APKs.
 * Running `ls` against the parent directory catches any files that were missed.
 * The original `pmPaths` array is returned unchanged if the `ls` call fails.
 */
export async function enumerateApkPaths(deviceId: string, pmPaths: string[]): Promise<string[]> {
  if (pmPaths.length === 0) return pmPaths;
  try {
    const apkDeviceDir = pmPaths[0].substring(0, pmPaths[0].lastIndexOf('/'));
    const lsOutput = await adbShell(deviceId, `ls "${apkDeviceDir}"/*.apk 2>/dev/null`, 5000);
    const dirFiles = lsOutput.split('\n')
      .map(l => l.replace(/\r$/, '').trim())
      .filter(f => f.endsWith('.apk'));
    if (dirFiles.length > 0) {
      return [...new Set([...pmPaths, ...dirFiles])];
    }
  } catch {
    // Fall back to pm path results only
  }
  return pmPaths;
}
