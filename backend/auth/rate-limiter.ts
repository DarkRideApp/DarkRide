const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 30;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkIpRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true };
}

// Periodic cleanup (every 10 min)
if (typeof setInterval !== 'undefined') {
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < now) buckets.delete(key);
    }
  }, 10 * 60 * 1000);
  if (cleanup.unref) cleanup.unref();
}

/** Reset rate limiter state — useful in tests */
export function resetRateLimiter(): void {
  buckets.clear();
}
