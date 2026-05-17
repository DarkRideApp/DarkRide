import { createHash } from 'crypto';

/**
 * Compute a unique deterministic hash for a version label and optional
 * variable map. Used by plugins that need to identify a (label, variables)
 * pair in a stable way.
 *
 * Pure: no I/O, no state, no side effects. Same inputs → same output.
 */
export function computeVariableHash(
  versionLabel: string,
  variables?: Record<string, string>,
): string {
  const parts = [versionLabel];
  if (variables) {
    const sorted = Object.keys(variables)
      .sort()
      .map((k) => `${k}=${variables[k]}`);
    parts.push(...sorted);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
