import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { applyMigrations } from '../../test-utils/create-test-db';
import { authenticateLocal, AuthenticationError } from './local';
import { hashPassword } from '../password';
import { resetRateLimiter } from '../rate-limiter';

function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

describe('authenticateLocal()', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    resetRateLimiter();
    db = createTestDb();
    const hash = await hashPassword('correct-password-123');
    const now = new Date();
    db.insert(schema.users).values({
      username: 'alice',
      passwordHash: hash,
      providerId: 'core.local',
      scopes: JSON.stringify(['core.admin:*']) as any,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
  });

  it('authenticates successfully with correct credentials', async () => {
    const result = await authenticateLocal(db, 'alice', 'correct-password-123', '127.0.0.1');
    expect(result.username).toBe('alice');
    expect(result.scopes).toContain('core.admin:*');
    expect(typeof result.userId).toBe('number');
  });

  it('rejects wrong password with generic error', async () => {
    await expect(
      authenticateLocal(db, 'alice', 'wrong-password', '127.0.0.1'),
    ).rejects.toThrow(AuthenticationError);

    await expect(
      authenticateLocal(db, 'alice', 'wrong-password', '127.0.0.2'),
    ).rejects.toThrow('Invalid username or password');
  });

  it('rejects non-existent user with same generic error (no enumeration)', async () => {
    await expect(
      authenticateLocal(db, 'nobody', 'any-password', '127.0.0.1'),
    ).rejects.toThrow('Invalid username or password');
  });

  it('rejects disabled user with account disabled message', async () => {
    const now = new Date();
    db.insert(schema.users).values({
      username: 'disabled-user',
      passwordHash: 'somehash',
      providerId: 'core.local',
      scopes: JSON.stringify([]) as any,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    }).run();

    await expect(
      authenticateLocal(db, 'disabled-user', 'any-password', '127.0.0.1'),
    ).rejects.toThrow('Account is disabled');
  });

  it('increments failedLoginAttempts on wrong password', async () => {
    await expect(
      authenticateLocal(db, 'alice', 'wrong-password', '127.0.0.1'),
    ).rejects.toThrow();

    const [user] = db.select().from(schema.users).all();
    expect(user.failedLoginAttempts).toBe(1);
  });

  it('resets failedLoginAttempts on successful login', async () => {
    // Manually set some failed attempts
    db.update(schema.users)
      .set({ failedLoginAttempts: 5 })
      .run();

    const result = await authenticateLocal(db, 'alice', 'correct-password-123', '127.0.0.1');
    expect(result.username).toBe('alice');

    const [user] = db.select().from(schema.users).all();
    expect(user.failedLoginAttempts).toBe(0);
  });

  it('hard-locks account when failedLoginAttempts >= 20', async () => {
    db.update(schema.users)
      .set({ failedLoginAttempts: 20 })
      .run();

    await expect(
      authenticateLocal(db, 'alice', 'correct-password-123', '127.0.0.1'),
    ).rejects.toThrow('Account locked. Contact an administrator.');
  });

  it('login is case-sensitive — "Alice" does not match username "alice"', async () => {
    await expect(
      authenticateLocal(db, 'Alice', 'correct-password-123', '127.0.0.1'),
    ).rejects.toThrow('Invalid username or password');
  });

  it('rejects with delay message when lockedUntil is in the future', async () => {
    db.update(schema.users)
      .set({
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.users.username, 'alice'))
      .run();

    await expect(
      authenticateLocal(db, 'alice', 'correct-password-123', '127.0.0.1'),
    ).rejects.toThrow(/wait/i);
  });

  it('rate limiter rejects after 30+ rapid attempts from same IP', async () => {
    const ip = '10.0.0.1';

    // Make 30 attempts (all allowed by rate limiter, but wrong password)
    for (let i = 0; i < 30; i++) {
      await expect(
        authenticateLocal(db, 'alice', 'wrong-password', ip),
      ).rejects.toThrow('Invalid username or password');
    }

    // The 31st attempt should be rate-limited
    await expect(
      authenticateLocal(db, 'alice', 'correct-password-123', ip),
    ).rejects.toThrow('Too many login attempts. Please wait before trying again.');
  }, 15_000);

  // IG-1: null passwordHash (unclaimed account)
  it('rejects user with null passwordHash (unclaimed account)', async () => {
    const now = new Date();
    db.insert(schema.users).values({
      username: 'unclaimed',
      passwordHash: null,
      providerId: 'core.local',
      scopes: JSON.stringify([]) as any,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    await expect(authenticateLocal(db, 'unclaimed', 'any-password', '127.0.0.1'))
      .rejects.toThrow('Invalid username or password');
  });

  // IG-2: sets lockedUntil after 5 failed attempts
  it('sets lockedUntil after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await authenticateLocal(db, 'alice', 'wrong', '127.0.0.2').catch(() => {});
    }
    const user = db.select().from(schema.users).where(eq(schema.users.username, 'alice')).get();
    expect(user!.failedLoginAttempts).toBe(5);
    expect(user!.lockedUntil).not.toBeNull();
    // lockedUntil should be in the future
    expect(new Date(user!.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
  }, 10_000);
});
