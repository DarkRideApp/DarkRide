// ---------------------------------------------------------------------------
// Response diffing for the Repeater drawer — deterministic, dependency-free.
//
// The repo ships no diff library (checked package.json + node_modules for
// diff/jsdiff/diff-match-patch — none present), and pulling a heavy one in for
// an MVP side-by-side isn't worth it. This is a small LCS line diff plus a
// case-insensitive header diff, both pure functions with their own tests.
// ---------------------------------------------------------------------------

export type LineOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: LineOp;
  /** Line text for the side it belongs to. */
  text: string;
}

/**
 * Longest-common-subsequence line diff. Returns a unified op list: 'equal'
 * lines appear once, 'remove' lines are only-in-old, 'add' lines are only-in-new.
 * Empty input on a side yields all adds/removes for the other side.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'equal', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'remove', text: a[i] });
      i++;
    } else {
      out.push({ op: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ op: 'remove', text: a[i++] });
  while (j < m) out.push({ op: 'add', text: b[j++] });
  return out;
}

/** True if the two texts differ at all (fast path for "changed?" badges). */
export function hasLineChanges(diff: DiffLine[]): boolean {
  return diff.some((d) => d.op !== 'equal');
}

export type HeaderChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface HeaderChange {
  /** Lower-cased header name (HTTP headers are case-insensitive). */
  key: string;
  kind: HeaderChangeKind;
  oldValue?: string;
  newValue?: string;
}

/**
 * Compare two header maps case-insensitively. Result is sorted by key; each
 * entry is added / removed / changed / unchanged. `changedOnly` drops the
 * unchanged rows (used when the UI only wants to surface deltas).
 */
export function diffHeaders(
  oldHeaders: Record<string, string> | null | undefined,
  newHeaders: Record<string, string> | null | undefined,
): HeaderChange[] {
  const norm = (h: Record<string, string> | null | undefined): Map<string, string> => {
    const map = new Map<string, string>();
    if (h) for (const [k, v] of Object.entries(h)) map.set(k.toLowerCase(), v);
    return map;
  };
  const oldMap = norm(oldHeaders);
  const newMap = norm(newHeaders);
  const keys = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();

  return keys.map((key): HeaderChange => {
    const inOld = oldMap.has(key);
    const inNew = newMap.has(key);
    const oldValue = oldMap.get(key);
    const newValue = newMap.get(key);
    if (inOld && !inNew) return { key, kind: 'removed', oldValue };
    if (!inOld && inNew) return { key, kind: 'added', newValue };
    if (oldValue !== newValue) return { key, kind: 'changed', oldValue, newValue };
    return { key, kind: 'unchanged', oldValue, newValue };
  });
}

/**
 * Pretty-print a body for line-diffing when it's JSON, so diffs land on
 * meaningful boundaries instead of one giant line. Non-JSON is returned as-is.
 */
export function prettyForDiff(body: string | null | undefined): string {
  if (!body) return '';
  const trimmed = body.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}
