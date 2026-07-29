import path from 'path';

/**
 * Absolute root for all on-disk data. Every cloud_files.local_path is
 * relative to this. Resolved lazily so tests and tools that change cwd or
 * DATA_ROOT after module load observe the new root.
 */
export function getDataRoot(): string {
  return path.resolve(process.env.DATA_ROOT || './data');
}

/**
 * Resolve a cloud_files.local_path row value to an absolute filesystem path.
 *
 * Defence-in-depth: relative inputs are containment-checked against DATA_ROOT
 * to prevent any path that resolves outside the managed data directory. The
 * DB column is server-controlled but we treat its contents as untrusted
 * (defence against future bugs that write user input there). Absolute paths
 * are accepted as-is — these are produced by callers that already validated.
 */
export function absoluteLocalPath(stored: string): string {
  if (path.isAbsolute(stored)) return stored;
  const root = getDataRoot();
  const resolved = path.resolve(root, stored);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`absoluteLocalPath: stored path escapes DATA_ROOT: ${stored}`);
  }
  return resolved;
}

/**
 * Normalise an incoming path to the relative form stored in cloud_files.
 * Absolute paths under DATA_ROOT are stripped to their DATA_ROOT-relative form.
 * Absolute paths outside DATA_ROOT throw — we refuse to track files that
 * live outside our managed data directory.
 *
 * Separators are always forward slashes, on every platform. `path.relative`
 * emits `\` on Windows, and this value is the stored `cloud_files.local_path`,
 * which is compared against — and derived alongside — POSIX cloud keys:
 * `NamespacedStorage.list()` builds its prefix with `/` and matches it against
 * this column, so a backslash-separated row silently never matched and
 * cloud-only files vanished from listings. Keeping one canonical form also
 * means a `data/` directory plus its DB stays portable between OSes.
 * `absoluteLocalPath` re-resolves either separator correctly on Windows.
 */
export function toRelativeLocalPath(input: string): string {
  if (!path.isAbsolute(input)) return toPosixSeparators(input);
  const rel = path.relative(getDataRoot(), input);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside DATA_ROOT cannot be tracked: ${input}`);
  }
  return toPosixSeparators(rel);
}

/** Canonicalise separators to `/` so stored paths are platform-independent. */
function toPosixSeparators(p: string): string {
  return p.split(path.sep).join('/');
}
