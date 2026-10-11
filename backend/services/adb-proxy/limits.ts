export class PreAuthLimiter {
  private readonly perIp = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxPerIp = 8,
    private readonly maxTotal = 64,
  ) {}

  get active(): number {
    return this.total;
  }

  /** Reserve a pre-auth slot, or null when the IP or the whole proxy is at its cap. The release is idempotent. */
  acquire(ip: string): (() => void) | null {
    const current = this.perIp.get(ip) ?? 0;
    if (this.total >= this.maxTotal || current >= this.maxPerIp) return null;
    this.total++;
    this.perIp.set(ip, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, left);
    };
  }
}
