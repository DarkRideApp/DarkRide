/**
 * Per-stream rate-limiter for keyframe-request writes to scrcpy. Fires the
 * supplied `send` callback at most once per `intervalMs` (default 500). When
 * a request arrives within the window, schedules a single coalesced fire at
 * the boundary; further requests during the pending interval are no-ops on
 * the wire (the pending fire already satisfies them).
 */
export class KeyframeCoordinator {
  private lastSentMs: number | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: () => void,
    private readonly intervalMs: number = 500,
  ) {}

  request(): 'sent' | 'coalesced' {
    if (this.pendingTimer !== null) return 'coalesced';
    const now = Date.now();
    if (this.lastSentMs === null || now - this.lastSentMs >= this.intervalMs) {
      this.fire();
      return 'sent';
    }
    const wait = this.intervalMs - (now - this.lastSentMs);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.fire();
    }, wait);
    return 'coalesced';
  }

  reset(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.lastSentMs = null;
  }

  private fire(): void {
    this.send();
    this.lastSentMs = Date.now();
  }
}
