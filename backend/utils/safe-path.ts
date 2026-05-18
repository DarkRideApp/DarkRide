import { resolve, sep } from 'path';

/**
 * Throws if `candidate` resolves outside `base`. Used as a defense-in-depth
 * containment check against path-traversal (zipslip, untrusted entry names,
 * user-supplied filenames that haven't been validated upstream).
 *
 * The check is sep-aware — `/tmp/foo-evil/x` is NOT inside `/tmp/foo`,
 * which a naive `startsWith` would get wrong.
 */
export function assertPathInside(base: string, candidate: string): void {
  const resolvedBase = resolve(base);
  const resolvedCandidate = resolve(candidate);
  const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(baseWithSep)) {
    throw new Error(`Path resolves outside base directory: ${candidate}`);
  }
}

/**
 * Like `path.join(base, ...parts)`, but throws if the result escapes `base`.
 * Use when joining untrusted components into a known-safe base directory.
 */
export function safeJoinInside(base: string, ...parts: string[]): string {
  const candidate = resolve(base, ...parts);
  assertPathInside(base, candidate);
  return candidate;
}
