import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { ProxyRotator } from './proxy-rotator';
import { createTestDb } from '../test-utils/create-test-db';

const { proxies } = schema;

function addProxy(db: BetterSQLite3Database<typeof schema>, url: string, opts?: { failureCount?: number; enabled?: boolean }) {
  db.insert(proxies).values({
    url,
    failureCount: opts?.failureCount ?? 0,
    enabled: opts?.enabled ?? true,
    createdAt: new Date(),
  }).run();
}

describe('ProxyRotator', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let rotator: ProxyRotator;

  beforeEach(() => {
    db = createTestDb();
    rotator = new ProxyRotator(db as any);
  });

  describe('getNextProxy', () => {
    it('should return null when no proxies exist', () => {
      expect(rotator.getNextProxy()).toBeNull();
    });

    it('should return null when all proxies are disabled', () => {
      addProxy(db, 'http://proxy1.com:8080', { enabled: false });
      addProxy(db, 'http://proxy2.com:8080', { enabled: false });
      expect(rotator.getNextProxy()).toBeNull();
    });

    it('should return an enabled proxy', () => {
      addProxy(db, 'http://proxy1.com:8080');
      const proxy = rotator.getNextProxy();
      expect(proxy).not.toBeNull();
      expect(proxy!.url).toBe('http://proxy1.com:8080');
    });

    it('should skip disabled proxies', () => {
      addProxy(db, 'http://disabled.com:8080', { enabled: false });
      addProxy(db, 'http://enabled.com:8080', { enabled: true });

      const proxy = rotator.getNextProxy();
      expect(proxy).not.toBeNull();
      expect(proxy!.url).toBe('http://enabled.com:8080');
    });

    it('should prefer proxies with fewer failures (weighted selection)', () => {
      // Add one proxy with 0 failures and one with 9 failures
      addProxy(db, 'http://good.com:8080', { failureCount: 0 });
      addProxy(db, 'http://bad.com:8080', { failureCount: 9 });

      // Run many selections — good proxy should be selected significantly more often
      const counts: Record<string, number> = {};
      for (let i = 0; i < 1000; i++) {
        const proxy = rotator.getNextProxy();
        const url = proxy!.url;
        counts[url] = (counts[url] || 0) + 1;
      }

      // good proxy has weight 10, bad proxy has weight 1
      // So good proxy should be selected ~90% of the time
      expect(counts['http://good.com:8080']).toBeGreaterThan(counts['http://bad.com:8080']);
      expect(counts['http://good.com:8080']).toBeGreaterThan(700); // Should be ~900
    });

    it('should return proxy with credentials', () => {
      db.insert(proxies).values({
        url: 'http://proxy.com:8080',
        username: 'user',
        password: 'pass',
        createdAt: new Date(),
      }).run();

      const proxy = rotator.getNextProxy();
      expect(proxy!.username).toBe('user');
      expect(proxy!.password).toBe('pass');
    });
  });

  describe('reportFailure', () => {
    it('should increment failure count', () => {
      addProxy(db, 'http://proxy.com:8080');

      rotator.reportFailure(1);

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(1);
    });

    it('should increment failure count multiple times', () => {
      addProxy(db, 'http://proxy.com:8080');

      rotator.reportFailure(1);
      rotator.reportFailure(1);
      rotator.reportFailure(1);

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(3);
    });

    it('should auto-disable proxy after reaching threshold (10)', () => {
      addProxy(db, 'http://proxy.com:8080', { failureCount: 9 });

      rotator.reportFailure(1);

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(10);
      expect(result[0].enabled).toBe(false);
    });

    it('should not error for non-existent proxy', () => {
      expect(() => rotator.reportFailure(999)).not.toThrow();
    });
  });

  describe('reportSuccess', () => {
    it('should decrement failure count', () => {
      addProxy(db, 'http://proxy.com:8080', { failureCount: 5 });

      rotator.reportSuccess(1);

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(4);
    });

    it('should not go below zero', () => {
      addProxy(db, 'http://proxy.com:8080', { failureCount: 0 });

      rotator.reportSuccess(1);

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(0);
    });

    it('should allow recovery from high failure count', () => {
      addProxy(db, 'http://proxy.com:8080', { failureCount: 8 });

      for (let i = 0; i < 5; i++) {
        rotator.reportSuccess(1);
      }

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(3);
    });

    it('should not error for non-existent proxy', () => {
      expect(() => rotator.reportSuccess(999)).not.toThrow();
    });
  });
});
