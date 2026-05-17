import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { SessionManager } from './session-manager';

function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

describe('SessionManager', () => {
  let db: ReturnType<typeof createTestDb>;
  let manager: SessionManager;
  let userId: number;

  beforeEach(() => {
    db = createTestDb();
    manager = new SessionManager(db);

    const now = new Date();
    const result = db.insert(schema.users).values({
      username: 'alice',
      providerId: 'core.local',
      scopes: JSON.stringify(['core.admin:*']) as any,
      createdAt: now,
      updatedAt: now,
    }).run();
    userId = Number(result.lastInsertRowid);
  });

  describe('create()', () => {
    it('returns id (64 hex chars)', () => {
      const session = manager.create(userId, 'core.local', 'Mozilla/5.0', '192.168.1.1');
      expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns csrfToken (64 hex chars)', () => {
      const session = manager.create(userId, 'core.local', 'Mozilla/5.0', '192.168.1.1');
      expect(session.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns expiresAt approximately 30 days from now', () => {
      const before = Date.now();
      const session = manager.create(userId, 'core.local', null, null);
      const after = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
      expect(session.expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
    });

    it('returns the correct userId and providerId', () => {
      const session = manager.create(userId, 'core.local', null, null);
      expect(session.userId).toBe(userId);
      expect(session.providerId).toBe('core.local');
    });
  });

  describe('validate()', () => {
    it('validates a valid session and returns userId + scopes from joined users table', () => {
      const { id } = manager.create(userId, 'core.local', 'TestAgent', null);
      const result = manager.validate(id);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe(userId);
      expect(result!.scopes).toContain('core.admin:*');
    });

    it('includes username from users table', () => {
      const { id } = manager.create(userId, 'core.local', null, null);
      const result = manager.validate(id);
      expect(result).not.toBeNull();
      expect(result!.username).toBe('alice');
    });

    it('rejects a non-existent session', () => {
      expect(manager.validate('nonexistent')).toBeNull();
    });

    it('rejects a revoked session', () => {
      const { id } = manager.create(userId, 'core.local', null, null);
      manager.revoke(id);
      expect(manager.validate(id)).toBeNull();
    });

    it('rejects an expired session', () => {
      const { id } = manager.create(userId, 'core.local', null, null);
      // Manually expire the session
      db.update(schema.sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.sessions.id, id))
        .run();
      expect(manager.validate(id)).toBeNull();
    });

    it('rejects session for disabled user', () => {
      const { id } = manager.create(userId, 'core.local', null, null);
      db.update(schema.users)
        .set({ enabled: false })
        .where(eq(schema.users.id, userId))
        .run();
      expect(manager.validate(id)).toBeNull();
    });
  });

  describe('revoke()', () => {
    it('revokes a session so validate returns null', () => {
      const { id } = manager.create(userId, 'core.local', null, null);
      expect(manager.validate(id)).not.toBeNull();
      manager.revoke(id);
      expect(manager.validate(id)).toBeNull();
    });
  });

  describe('revokeAllForUser()', () => {
    it('revokes all active sessions for a user', () => {
      const s1 = manager.create(userId, 'core.local', null, null);
      const s2 = manager.create(userId, 'core.local', 'AnotherAgent', null);
      manager.revokeAllForUser(userId);
      expect(manager.validate(s1.id)).toBeNull();
      expect(manager.validate(s2.id)).toBeNull();
    });

    it('does not throw when there are already-revoked sessions (idempotent)', () => {
      const s1 = manager.create(userId, 'core.local', null, null);
      manager.revoke(s1.id);
      expect(() => manager.revokeAllForUser(userId)).not.toThrow();
    });
  });

  describe('sliding expiry', () => {
    it('bumps expiry when session is within 7 days of expiry and cooldown has elapsed', () => {
      const session = manager.create(userId, 'core.local', null, null);
      // Put expiry 3 days from now (within 7-day threshold) and lastAccessedAt 2 hours ago
      const nearExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      db.update(schema.sessions)
        .set({ expiresAt: nearExpiry, lastAccessedAt: longAgo })
        .where(eq(schema.sessions.id, session.id))
        .run();

      const before = Date.now();
      const result = manager.validate(session.id);
      const after = Date.now();
      expect(result).not.toBeNull();

      // Re-read from DB to check the bumped expiry
      const row = db.select({ expiresAt: schema.sessions.expiresAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, session.id))
        .get();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
      expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
    });

    it('does NOT bump expiry when cooldown has not elapsed', () => {
      const session = manager.create(userId, 'core.local', null, null);
      const nearExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const recentAccess = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      db.update(schema.sessions)
        .set({ expiresAt: nearExpiry, lastAccessedAt: recentAccess })
        .where(eq(schema.sessions.id, session.id))
        .run();

      manager.validate(session.id);

      const row = db.select({ expiresAt: schema.sessions.expiresAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, session.id))
        .get();
      // Expiry should remain at nearExpiry (within ±1s tolerance)
      expect(Math.abs(row!.expiresAt.getTime() - nearExpiry.getTime())).toBeLessThan(1000);
    });

    it('does NOT bump expiry when session has more than 7 days remaining', () => {
      const session = manager.create(userId, 'core.local', null, null);
      // Default session has ~30 days — validate immediately without manipulating DB
      const originalExpiry = session.expiresAt;

      manager.validate(session.id);

      const row = db.select({ expiresAt: schema.sessions.expiresAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, session.id))
        .get();
      // Expiry should be unchanged (within ±1s)
      expect(Math.abs(row!.expiresAt.getTime() - originalExpiry.getTime())).toBeLessThan(1000);
    });
  });

  describe('listForUser()', () => {
    it('returns all active sessions for a user', () => {
      manager.create(userId, 'core.local', 'Agent1', null);
      manager.create(userId, 'core.local', 'Agent2', null);
      const list = manager.listForUser(userId);
      expect(list).toHaveLength(2);
    });

    it('excludes revoked sessions from the list', () => {
      const s1 = manager.create(userId, 'core.local', 'Agent1', null);
      manager.create(userId, 'core.local', 'Agent2', null);
      manager.revoke(s1.id);
      const list = manager.listForUser(userId);
      expect(list).toHaveLength(1);
    });

    it('excludes expired sessions from the list', () => {
      const { id } = manager.create(userId, 'core.local', 'Agent1', null);
      manager.create(userId, 'core.local', 'Agent2', null);
      db.update(schema.sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.sessions.id, id))
        .run();
      const list = manager.listForUser(userId);
      expect(list).toHaveLength(1);
    });

    it('returns empty list when user has no sessions', () => {
      expect(manager.listForUser(999)).toHaveLength(0);
    });
  });
});
