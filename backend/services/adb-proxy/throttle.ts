export interface BudgetLogOptions {
  /** How long a window lasts, counted from the first event after idle. */
  windowMs: number;
  /** Detail lines allowed per window, across all kinds. */
  maxDetail: number;
  emit: (line: string) => void;
  /** Told when `emit` throws, at most once per window. */
  onError?: (error: unknown) => void;
}

export interface BudgetLog {
  log(kind: string, detail: string): void;
  /** Clears the timer and emits any pending summary; later events are emitted directly. */
  stop(): void;
}

/**
 * A log budget for lines a peer can provoke. A window opens on the first event after idle and lasts `windowMs`.
 * At most `maxDetail` events are written in full per window, whatever their kind; the rest are only counted per
 * kind. If anything was suppressed the window ends with one summary line, then the log goes idle, so the output
 * is at most `maxDetail + 1` lines per window however the events are spread.
 */
export function createBudgetLog(options: BudgetLogOptions): BudgetLog {
  const { windowMs, maxDetail, emit, onError } = options;
  let timer: NodeJS.Timeout | null = null;
  let written = 0;
  let reported = false;
  let stopped = false;
  const suppressed = new Map<string, number>();

  // A subscriber that throws must not skip arming or closing a window, or take the process down from a timer.
  const write = (line: string) => {
    try {
      emit(line);
    } catch (error) {
      if (reported) return;
      reported = true;
      try {
        onError?.(error);
      } catch {
        /* the report failed too; nothing left to tell */
      }
    }
  };

  const summarise = () => {
    if (suppressed.size === 0) return;
    let total = 0;
    const parts: string[] = [];
    for (const [kind, count] of suppressed) {
      total += count;
      parts.push(`${count} ${kind}`);
    }
    suppressed.clear();
    write(`${total} more events suppressed (${parts.join(', ')})`);
  };

  return {
    log(kind, detail) {
      if (stopped) return write(detail);
      if (!timer) {
        written = 0;
        reported = false;
        timer = setTimeout(() => {
          timer = null;
          summarise();
        }, windowMs);
        timer.unref?.();
      }
      if (written < maxDetail) {
        written++;
        write(detail);
      } else {
        suppressed.set(kind, (suppressed.get(kind) ?? 0) + 1);
      }
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
