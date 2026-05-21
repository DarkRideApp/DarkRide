/**
 * Parsers for Google Android SDK CLI output. The `avd` provider uses
 * these to translate `avdmanager list avd` and `sdkmanager --list`
 * stdout into typed entries.
 */

export interface AvdEntry {
  name: string;
  device: string;
  target: string;
  androidVersion: string;
  apiLevel: number;
  abi: string;
}

/**
 * Parse `avdmanager list avd` output. Each AVD is a key/value block
 * separated by lines of dashes.
 */
export function parseAvdList(stdout: string): AvdEntry[] {
  const blocks = stdout.split(/^-+$/m).map((b) => b.trim()).filter(Boolean);
  const out: AvdEntry[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    const get = (key: string) => lines.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
    const name = get('Name');
    if (!name) continue;
    const based = lines.find((l) => l.includes('Based on:'));
    const versionMatch = based?.match(/Android (\S+) \(API level (\d+)\)/);
    const abiMatch = based?.match(/Tag\/ABI:\s*(\S+)/);
    out.push({
      name,
      device: get('Device') ?? '',
      target: (get('Target') ?? '').replace(/\s*\(.*\)\s*$/, ''),
      androidVersion: versionMatch?.[1] ?? '',
      apiLevel: Number(versionMatch?.[2] ?? 0),
      abi: abiMatch?.[1] ?? '',
    });
  }
  return out;
}

export interface SystemImageEntry {
  pkg: string;
  apiLevel: number;
  tag: string;
  abi: string;
  installed: boolean;
}

/**
 * Parse `sdkmanager --list` output. Tracks the "Installed packages:" vs.
 * "Available Packages:" section header to set `installed`.
 */
export function parseSystemImageList(stdout: string): SystemImageEntry[] {
  const lines = stdout.split('\n');
  let installed = false;
  const out: SystemImageEntry[] = [];
  for (const l of lines) {
    if (/^Installed packages:/.test(l)) { installed = true; continue; }
    if (/^Available Packages:/.test(l)) { installed = false; continue; }
    const m = l.match(/^\s*(system-images;android-(\d+);(\w+);([\w-]+))\s+\|/);
    if (m) {
      out.push({ pkg: m[1], apiLevel: Number(m[2]), tag: m[3], abi: m[4], installed });
    }
  }
  return out;
}
