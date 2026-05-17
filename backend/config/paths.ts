import path from 'path';

/**
 * Absolute root for all on-disk data. Every cloud_files.local_path is
 * relative to this. Resolved lazily so tests and tools that change cwd or
 * DATA_ROOT after module load observe the new root.
 */
export function getDataRoot(): string {
  return path.resolve(process.env.DATA_ROOT || './data');
}

/** Resolve a cloud_files.local_path row value to an absolute filesystem path. */
export function absoluteLocalPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(getDataRoot(), stored);
}

/**
 * Normalise an incoming path to the relative form stored in cloud_files.
 * Absolute paths under DATA_ROOT are stripped to their DATA_ROOT-relative form.
 * Absolute paths outside DATA_ROOT throw — we refuse to track files that
 * live outside our managed data directory.
 */
export function toRelativeLocalPath(input: string): string {
  if (!path.isAbsolute(input)) return input;
  const rel = path.relative(getDataRoot(), input);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside DATA_ROOT cannot be tracked: ${input}`);
  }
  return rel;
}
