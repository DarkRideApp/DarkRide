/**
 * Returns true iff `latest` is strictly newer than `current` per a simple
 * semver compare. Pre-release suffixes (e.g. "-rc.1") are stripped before
 * comparing — we don't distinguish 1.0.0-rc.1 from 1.0.0 for upgrade-prompt
 * purposes. Malformed or missing inputs return false.
 *
 * Companion to `PluginInstaller.isCompatible` which answers "is current >=
 * min?" — this answers "is latest > current?".
 */
export function isNewer(latest: string, current: string): boolean {
  const stripPre = (v: string) => v.split('-')[0];
  const parse = (v: string): [number, number, number] | null => {
    if (!v) return null;
    const parts = stripPre(v).split('.');
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => Number.isNaN(n))) return null;
    return [nums[0], nums[1], nums[2]];
  };

  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;

  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
}
