import { describe, it, expect, beforeEach } from 'vitest';
import { checkIpRateLimit, resetRateLimiter } from './rate-limiter';

describe('rate-limiter', () => {
  beforeEach(() => resetRateLimiter());

  it('allows the first 30 attempts from one IP', () => {
    for (let i = 0; i < 30; i++) {
      expect(checkIpRateLimit('1.2.3.4').allowed).toBe(true);
    }
  });

  it('blocks on the 31st attempt and returns retryAfterMs', () => {
    for (let i = 0; i < 30; i++) checkIpRateLimit('1.2.3.4');
    const result = checkIpRateLimit('1.2.3.4');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('treats different IPs independently', () => {
    for (let i = 0; i < 30; i++) checkIpRateLimit('1.1.1.1');
    expect(checkIpRateLimit('1.1.1.1').allowed).toBe(false);
    expect(checkIpRateLimit('2.2.2.2').allowed).toBe(true);
  });

  it('resetRateLimiter clears all buckets', () => {
    for (let i = 0; i < 31; i++) checkIpRateLimit('3.3.3.3');
    expect(checkIpRateLimit('3.3.3.3').allowed).toBe(false);
    resetRateLimiter();
    expect(checkIpRateLimit('3.3.3.3').allowed).toBe(true);
  });
});
