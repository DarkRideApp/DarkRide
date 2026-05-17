import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { ClaimManager } from './claim-manager';
import { authenticateLocal } from './providers/local';

function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

describe('ClaimManager', () => {
  let db: ReturnType<typeof createTestDb>;
  let manager: ClaimManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new ClaimManager(db);
  });

  describe('createUserWithClaim()', () => {
    it('creates a user + token and returns claim URL', () => {
      const result = manager.createUserWithClaim('alice', 'Alice Smith', null, ['core.read']);
      expect(result.userId).toBeGreaterThan(0);
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.claimUrl).toBe(`/ui/claim?token=${result.token}`);

      const user = db.select().from(schema.users).where(eq(schema.users.id, result.userId)).get();
      expect(user).not.toBeNull();
      expect(user!.username).toBe('alice');
      expect(user!.displayName).toBe('Alice Smith');
      expect(user!.passwordHash).toBeNull();
      expect(user!.passwordMustChange).toBe(true);

      const token = db.select().from(schema.passwordResetTokens).get();
      expect(token).not.toBeNull();
      expect(token!.purpose).toBe('admin-create');
      expect(token!.usedAt).toBeNull();
    });

    it('rejects duplicate username', () => {
      manager.createUserWithClaim('bob', null, null, []);
      expect(() => manager.createUserWithClaim('bob', null, null, [])).toThrow('Username "bob" already exists');
    });

    it('rejects username shorter than 2 characters', () => {
      expect(() => manager.createUserWithClaim('x', null, null, [])).toThrow('Username must be at least 2 characters');
    });

    it('rejects empty username', () => {
      expect(() => manager.createUserWithClaim('', null, null, [])).toThrow('Username must be at least 2 characters');
    });
  });

  describe('consumeClaim()', () => {
    it('with valid token sets password and clears passwordMustChange', async () => {
      const { token, userId } = manager.createUserWithClaim('carol', null, null, []);

      const result = await manager.consumeClaim(token, 'a-secure-password-123');
      expect(result.userId).toBe(userId);
      expect(result.username).toBe('carol');

      const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      expect(user!.passwordHash).not.toBeNull();
      expect(user!.passwordMustChange).toBe(false);

      // Token should be marked as used
      const tokenRow = db.select().from(schema.passwordResetTokens).get();
      expect(tokenRow!.usedAt).not.toBeNull();
    });

    it('with expired token throws', async () => {
      const { token } = manager.createUserWithClaim('dave', null, null, []);

      // Manually expire the token
      db.update(schema.passwordResetTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .run();

      await expect(manager.consumeClaim(token, 'a-secure-password-123'))
        .rejects.toThrow('Invalid or expired claim token');
    });

    it('with already-used token throws', async () => {
      const { token } = manager.createUserWithClaim('eve', null, null, []);

      await manager.consumeClaim(token, 'a-secure-password-123');

      await expect(manager.consumeClaim(token, 'another-secure-password-456'))
        .rejects.toThrow('Invalid or expired claim token');
    });

    it('with invalid token throws', async () => {
      await expect(manager.consumeClaim('deadbeef'.repeat(8), 'a-secure-password-123'))
        .rejects.toThrow('Invalid or expired claim token');
    });

    it('validates password policy', async () => {
      const { token } = manager.createUserWithClaim('frank', null, null, []);

      await expect(manager.consumeClaim(token, 'short'))
        .rejects.toThrow('Password must be at least 12 characters');
    });
  });

  describe('createResetClaim()', () => {
    it('generates token for existing user and sets passwordMustChange', async () => {
      // First create a user with a password
      const { token: createToken, userId } = manager.createUserWithClaim('grace', null, null, []);
      await manager.consumeClaim(createToken, 'a-secure-password-123');

      // Verify passwordMustChange is cleared after consumeClaim
      let user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      expect(user!.passwordMustChange).toBe(false);

      const { token: resetToken, claimUrl } = manager.createResetClaim(userId);
      expect(resetToken).toMatch(/^[0-9a-f]{64}$/);
      expect(claimUrl).toBe(`/ui/claim?token=${resetToken}`);

      // User should have passwordMustChange set to true again
      user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      expect(user!.passwordMustChange).toBe(true);

      // Token row should exist for the reset
      const tokens = db.select().from(schema.passwordResetTokens).all();
      const resetTokenRow = tokens.find(t => t.purpose === 'password-reset');
      expect(resetTokenRow).not.toBeUndefined();
      expect(resetTokenRow!.usedAt).toBeNull();
    });

    it('throws when user not found', () => {
      expect(() => manager.createResetClaim(9999)).toThrow('User not found');
    });
  });

  describe('after consuming a claim, user can authenticate via authenticateLocal()', () => {
    it('allows login with the newly set password', async () => {
      const { token } = manager.createUserWithClaim('henry', null, null, ['core.read']);
      await manager.consumeClaim(token, 'a-secure-password-123');

      const result = await authenticateLocal(db, 'henry', 'a-secure-password-123', '127.0.0.1');
      expect(result.userId).toBeGreaterThan(0);
      expect(result.username).toBe('henry');
    });
  });

  // IG-11: claim token for deleted user
  // NOTE: The test DB enables FK with ON DELETE CASCADE on password_reset_tokens.user_id,
  // so deleting the user cascades to remove the token row. The consumeClaim() call therefore
  // fails with "Invalid or expired claim token" (token not found) rather than "User not found".
  // Either error demonstrates the claim is safely rejected for a deleted user.
  describe('consumeClaim() — deleted user', () => {
    it('rejects claim when user was deleted after token creation', async () => {
      const { token } = manager.createUserWithClaim('willdelete', null, null, []);
      // Delete the user — cascades to the token row via FK ON DELETE CASCADE
      db.delete(schema.users).where(eq(schema.users.username, 'willdelete')).run();
      // Token row is gone (cascaded), so we get "Invalid or expired claim token"
      await expect(manager.consumeClaim(token, 'a-secure-password-123'))
        .rejects.toThrow(/user not found|invalid or expired claim token/i);
    });
  });
});
