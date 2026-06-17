import path from 'path';
import { existsSync } from 'fs';

const isWindows = process.platform === 'win32';

/**
 * Locate the Android SDK root on this host.
 *
 * Searches in order:
 *  1. ANDROID_HOME env var (the modern canonical name)
 *  2. ANDROID_SDK_ROOT env var (the legacy name, still set by some installers)
 *  3. Platform defaults from Android Studio's installer:
 *     - macOS: ~/Library/Android/sdk
 *     - Linux: ~/Android/Sdk
 *     - Windows: %LOCALAPPDATA%\Android\Sdk
 *
 * Returns the absolute path of the first hit that exists on disk, or
 * null if nothing was found.
 */
export function findAndroidSdkRoot(): string | null {
  const envCandidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  for (const c of envCandidates) {
    if (c && existsSync(c)) return path.resolve(c);
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  const pathCandidates: string[] = [];
  if (home) {
    if (process.platform === 'darwin') pathCandidates.push(path.join(home, 'Library', 'Android', 'sdk'));
    pathCandidates.push(path.join(home, 'Android', 'Sdk'));
  }
  if (isWindows && process.env.LOCALAPPDATA) {
    pathCandidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  }
  for (const c of pathCandidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Resolve an SDK binary by name to an absolute path, with cross-platform
 * extension handling and fallback to PATH lookup if the SDK isn't found.
 *
 * Names follow Android Studio's layout:
 *   - `emulator`        → <sdk>/emulator/emulator(.exe)
 *   - `avdmanager`      → <sdk>/cmdline-tools/latest/bin/avdmanager(.bat)
 *   - `sdkmanager`      → <sdk>/cmdline-tools/latest/bin/sdkmanager(.bat)
 *   - `adb`             → <sdk>/platform-tools/adb(.exe)
 *
 * Returns the absolute path if found, else the bare name (so `spawn`
 * still tries a PATH lookup — preserves existing behaviour for users
 * who've added the SDK to PATH).
 */
export function resolveAndroidBin(name: 'emulator' | 'avdmanager' | 'sdkmanager' | 'adb'): string {
  const sdk = findAndroidSdkRoot();
  if (!sdk) return name; // fall back to PATH
  if (name === 'emulator') {
    const p = path.join(sdk, 'emulator', isWindows ? 'emulator.exe' : 'emulator');
    return existsSync(p) ? p : name;
  }
  if (name === 'adb') {
    const p = path.join(sdk, 'platform-tools', isWindows ? 'adb.exe' : 'adb');
    return existsSync(p) ? p : name;
  }
  // avdmanager + sdkmanager: cmdline-tools layout. Android Studio's
  // installer puts the latest tools under cmdline-tools/latest/bin.
  const ext = isWindows ? '.bat' : '';
  const p = path.join(sdk, 'cmdline-tools', 'latest', 'bin', `${name}${ext}`);
  return existsSync(p) ? p : name;
}
