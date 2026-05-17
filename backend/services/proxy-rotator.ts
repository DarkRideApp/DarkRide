import { eq, and, gt } from 'drizzle-orm';
import { proxies } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('proxy-rotator');

const FAILURE_THRESHOLD = 10;

export class ProxyRotator {
  constructor(private db: AppDatabase) {}

  /**
   * Get the next proxy using weighted rotation.
   * Proxies with fewer failures get higher priority.
   * Disabled proxies are skipped entirely.
   * Returns null if no enabled proxies are available.
   */
  getNextProxy(): { id: number; url: string; username: string | null; password: string | null } | null {
    const enabledProxies = this.db
      .select()
      .from(proxies)
      .where(eq(proxies.enabled, true))
      .all();

    if (enabledProxies.length === 0) {
      return null;
    }

    // Weighted selection: weight = max(1, threshold - failureCount)
    // Higher weight = more likely to be selected
    const weights = enabledProxies.map((p) => ({
      proxy: p,
      weight: Math.max(1, FAILURE_THRESHOLD - (p.failureCount ?? 0)),
    }));

    const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
    let random = Math.random() * totalWeight;

    for (const { proxy, weight } of weights) {
      random -= weight;
      if (random <= 0) {
        log(`Selected proxy ${proxy.id} (${proxy.url})`);
        return {
          id: proxy.id,
          url: proxy.url,
          username: proxy.username,
          password: proxy.password,
        };
      }
    }

    // Fallback to first proxy (shouldn't normally reach here)
    const fallback = enabledProxies[0];
    return {
      id: fallback.id,
      url: fallback.url,
      username: fallback.username,
      password: fallback.password,
    };
  }

  /**
   * Report a failure for a proxy. Increments failureCount.
   * If failureCount exceeds threshold, auto-disable the proxy.
   */
  reportFailure(proxyId: number): void {
    const proxy = this.db
      .select()
      .from(proxies)
      .where(eq(proxies.id, proxyId))
      .all()[0];

    if (!proxy) {
      error(`Proxy ${proxyId} not found`);
      return;
    }

    const newCount = (proxy.failureCount ?? 0) + 1;
    const updates: { failureCount: number; enabled?: boolean } = { failureCount: newCount };

    if (newCount >= FAILURE_THRESHOLD) {
      updates.enabled = false;
      log(`Proxy ${proxyId} auto-disabled after ${newCount} failures`);
    }

    this.db.update(proxies).set(updates).where(eq(proxies.id, proxyId)).run();
  }

  /**
   * Report a success for a proxy. Decrements failureCount (min 0) to allow recovery.
   */
  reportSuccess(proxyId: number): void {
    const proxy = this.db
      .select()
      .from(proxies)
      .where(eq(proxies.id, proxyId))
      .all()[0];

    if (!proxy) {
      error(`Proxy ${proxyId} not found`);
      return;
    }

    const newCount = Math.max(0, (proxy.failureCount ?? 0) - 1);
    this.db.update(proxies).set({ failureCount: newCount }).where(eq(proxies.id, proxyId)).run();
  }
}
