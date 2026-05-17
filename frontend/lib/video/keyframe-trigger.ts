export type KeyframeReason = 'gap' | 'decode-error' | 'watchdog';

/**
 * Frontend-side guard for keyframe requests. Suppresses gaps below the
 * threshold (1-frame drops often decode through cleanly) and debounces a
 * burst of requests so we don't pile WS messages on top of the backend
 * rate-limit. Pure: no DOM, no WS, no timers — exposed via methods only.
 */
export class KeyframeTrigger {
  private lastFireMs: number | null = null;

  constructor(
    private readonly send: (reason: KeyframeReason) => void,
    private readonly debounceMs: number = 250,
  ) {}

  /**
   * Decide whether to fire a keyframe request. Returns true when the
   * `send` callback was invoked.
   *
   *  - For `reason === 'gap'`: requires `gap >= 2`.
   *  - In all cases: suppresses repeats within `debounceMs` of the last fire.
   */
  maybeFire(reason: KeyframeReason, gap: number = 0): boolean {
    if (reason === 'gap' && gap < 2) return false;
    const now = Date.now();
    if (this.lastFireMs !== null && now - this.lastFireMs < this.debounceMs) return false;
    this.lastFireMs = now;
    this.send(reason);
    return true;
  }

  reset(): void {
    this.lastFireMs = null;
  }
}
