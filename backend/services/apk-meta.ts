import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getPythonPath } from '../utils/python-path';

const execFileAsync = promisify(execFile);

export interface ApkQuickMeta {
  packageName: string;
  versionCode: number;
  versionName: string | null;
}

/** Parse + validate apk_quick_meta.py stdout. Throws Error with a user-presentable message. */
export function parseQuickMetaOutput(stdout: string): ApkQuickMeta {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // The error reaches users via the upload endpoint — give a clear message
    // instead of a raw "Unexpected token …" SyntaxError.
    throw new Error('Could not read APK: analyzer returned unexpected output');
  }
  if (parsed.error) throw new Error(`Could not read APK: ${parsed.error}`);
  if (!parsed.packageName || parsed.versionCode == null) {
    throw new Error('APK identity (package/versionCode) missing from manifest');
  }
  return {
    packageName: String(parsed.packageName),
    versionCode: Number(parsed.versionCode),
    versionName: parsed.versionName != null ? String(parsed.versionName) : null,
  };
}

/** Extract package identity from an APK on disk via the venv's androguard. ~1-2s. */
export async function extractApkQuickMeta(apkPath: string): Promise<ApkQuickMeta> {
  const script = path.resolve('python/apk_quick_meta.py');
  const { stdout } = await execFileAsync(getPythonPath(), [script, apkPath], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: any) => {
    // Non-zero exit still writes JSON to stdout — surface that message if present
    if (err.stdout) return { stdout: err.stdout as string };
    throw new Error(`APK metadata extraction failed: ${err.message}`);
  });
  return parseQuickMetaOutput(stdout);
}

export type ApkMetaExtractor = typeof extractApkQuickMeta;
