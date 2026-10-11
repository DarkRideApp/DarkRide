export interface BurstLog {
  log(line: string): void;
  /** Clears the timer and emits any pending summary; later events are emitted directly. */
  stop(): void;
}

const MAX_BACKOFF_FACTOR = 60;

/**
 * Emits the first event after a quiet period in full, counts the rest, and ends the interval with one
 * "N more <kind> events suppressed" line. While events keep arriving the next interval is twice as long, up to
 * 60 times the base, and its events are only counted; an interval with no events resets it.
 */
export function createBurstLog(intervalMs: number, kind: string, emit: (line: string) => void): BurstLog {
  const longest = intervalMs * MAX_BACKOFF_FACTOR;
  let timer: NodeJS.Timeout | null = null;
  let length = intervalMs;
  let suppressed = 0;
  let stopped = false;

  // A subscriber that throws must not take the process down from a timer or from stop().
  const summarise = () => {
    const count = suppressed;
    suppressed = 0;
    if (count === 0) return;
    try {
      emit(`${count} more ${kind} events suppressed`);
    } catch {
      /* logging itself failed; nothing left to report it to */
    }
  };

  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      const hot = suppressed > 0;
      summarise();
      if (hot) {
        length = Math.min(length * 2, longest);
        arm();
      } else {
        length = intervalMs;
      }
    }, length);
    timer.unref?.();
  };

  return {
    log(line) {
      if (stopped) return emit(line);
      if (timer) {
        suppressed++;
        return;
      }
      emit(line);
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      summarise();
    },
  };
}

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
