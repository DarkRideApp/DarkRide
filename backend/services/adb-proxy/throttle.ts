/** Wrap `fn` so it runs at most once per interval; calls inside the interval are dropped. */
export function onceEvery<A extends unknown[]>(
  intervalMs: number,
  fn: (...args: A) => void,
  now: () => number = Date.now,
): (...args: A) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (...args: A) => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    fn(...args);
  };
}
