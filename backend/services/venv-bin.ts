import { resolve } from 'path';
import { existsSync } from 'fs';

const isWindows = process.platform === 'win32';

/**
 * Resolve a binary name to an absolute path inside the project's `.venv`
 * (created by python-bridge or python-bridge-async on first run), or fall
 * back to the bare name so `spawn()` will perform a regular `PATH` lookup.
 *
 * Used by services that shell out to Python-installed tools like
 * `mitmdump`, `mitmproxy`, or other entries in `python/requirements.txt`.
 *
 * Why this exists: the host's PATH may not include `.venv/bin` (the
 * standard scenario in CI where DarkRide is launched from a fresh
 * checkout without activating the venv first). Without this, every
 * subprocess that names a Python-installed tool fails with ENOENT even
 * though the tool is present on disk.
 *
 * @param name unsuffixed binary name (e.g. "mitmdump"); on Windows the
 *   ".exe" variant is also tried.
 */
export function resolveVenvBin(name: string): string {
  const venvRoot = resolve(process.cwd(), '.venv');
  if (isWindows) {
    const exe = resolve(venvRoot, 'Scripts', `${name}.exe`);
    if (existsSync(exe)) return exe;
    const bare = resolve(venvRoot, 'Scripts', name);
    if (existsSync(bare)) return bare;
  } else {
    const bin = resolve(venvRoot, 'bin', name);
    if (existsSync(bin)) return bin;
  }
  return name;
}
