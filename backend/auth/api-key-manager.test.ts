import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { ApiKeyManager } from './api-key-manager';

function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function insertUser(
  db: BetterSQLite3Database<typeof schema>,
  username: string,
  scopes: string[],
): number {
  const now = new Date();
  const result = db.insert(schema.users).values({
    username,
    providerId: 'core.local',
    scopes,
    createdAt: now,
    updatedAt: now,
  }).run();
  return Number(result.lastInsertRowid);
}

describe('ApiKeyManager', () => {
  let db: ReturnType<typeof createTestDb>;
  let manager: ApiKeyManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new ApiKeyManager(db);
  });

  describe('create()', () => {
    it('creates a key with valid scopes and returns key starting with darkride_pat_', () => {
      const userId = insertUser(db, 'alice', ['devices:read', 'traffic:read']);
      const result = manager.create(userId, 'My Key', ['devices:read'], null);

      expect(result.id).toBeGreaterThan(0);
      expect(result.key).toMatch(/^darkride_pat_[0-9a-f]{40}$/);
      expect(result.keyPrefix).toMatch(/^[0-9a-f]{8}$/);
    });

    it('key is exactly 53 characters (13-char prefix + 40 hex)', () => {
      // 'darkride_pat_' = 13 chars, randomBytes(20).toString('hex') = 40 chars → total 53
      const userId = insertUser(db, 'bob', ['devices:read']);
      const result = manager.create(userId, 'Test Key', ['devices:read'], null);
      expect(result.key.length).toBe(53);
      expect(result.key).toMatch(/^darkride_pat_[0-9a-f]{40}$/);
    });

    it('rejects empty name', () => {
      const userId = insertUser(db, 'charlie', ['devices:read']);
      expect(() => manager.create(userId, '', ['devices:read'], null)).toThrow('Key name is required');
      expect(() => manager.create(userId, '   ', ['devices:read'], null)).toThrow('Key name is required');
    });

    it('rejects wildcard scope in key', () => {
      const userId = insertUser(db, 'dave', ['devices:*']);
      expect(() =>
        manager.create(userId, 'Wild Key', ['devices:*'], null),
      ).toThrow('cannot contain wildcards');
    });

    it('rejects scope the user does not have', () => {
      const userId = insertUser(db, 'eve', ['devices:read']);
      expect(() =>
        manager.create(userId, 'Over-reach', ['traffic:read'], null),
      ).toThrow("You don't have scope 'traffic:read'");
    });

    it('throws if user does not exist', () => {
      expect(() =>
        manager.create(9999, 'Ghost Key', ['devices:read'], null),
      ).toThrow('User not found');
    });

    it('two keys for same user have different key values (randomness)', () => {
      const userId = insertUser(db, 'frank', ['devices:read']);
      const k1 = manager.create(userId, 'Key 1', ['devices:read'], null);
      const k2 = manager.create(userId, 'Key 2', ['devices:read'], null);
      expect(k1.key).not.toBe(k2.key);
      expect(k1.keyPrefix).not.toBe(k2.keyPrefix);
    });

    it('creates a key with a future expiresAt and stores it', () => {
      const userId = insertUser(db, 'grace-expiry', ['core.devices:read']);
      const expiresAt = new Date(Date.now() + 86400_000); // 1 day from now
      const result = manager.create(userId, 'Expiring Key', ['core.devices:read'], expiresAt);
      expect(result.key).toMatch(/^darkride_pat_/);
      const keys = manager.listForUser(userId);
      const match = keys.find(k => k.id === result.id);
      expect(match).toBeDefined();
      expect(match!.expiresAt).not.toBeNull();
      // Expiry should be approximately 1 day from now (within 5s)
      expect(Math.abs(match!.expiresAt!.getTime() - expiresAt.getTime())).toBeLessThan(5000);
    });

    it('user with core.admin:* wildcard can create key with any specific scope', () => {
      const userId = insertUser(db, 'grace', ['core.admin:*']);
      const result = manager.create(userId, 'Admin Key', ['devices:read', 'traffic:write', 'plugins:admin'], null);
      expect(result.key).toMatch(/^darkride_pat_/);
    });

    it('stores the key hash (not plaintext) in the database', () => {
      const userId = insertUser(db, 'hank', ['devices:read']);
      const result = manager.create(userId, 'Hashed Key', ['devices:read'], null);

      const row = db.select().from(schema.apiKeys).get();
      expect(row).not.toBeNull();
      expect(row!.keyHash).not.toBe(result.key);
      expect(row!.keyHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    });
  });

  describe('listForUser()', () => {
    it('returns created keys without plaintext key', () => {
      const userId = insertUser(db, 'iris', ['devices:read', 'traffic:read']);
      manager.create(userId, 'Key A', ['devices:read'], null);
      manager.create(userId, 'Key B', ['traffic:read'], null);

      const keys = manager.listForUser(userId);
      expect(keys).toHaveLength(2);
      expect(keys.map(k => k.name).sort()).toEqual(['Key A', 'Key B']);
      // Should NOT include keyHash
      for (const k of keys) {
        expect(k).not.toHaveProperty('keyHash');
      }
    });

    it('does not return keys from other users', () => {
      const u1 = insertUser(db, 'jack', ['devices:read']);
      const u2 = insertUser(db, 'kate', ['devices:read']);
      manager.create(u1, 'Jack Key', ['devices:read'], null);
      manager.create(u2, 'Kate Key', ['devices:read'], null);

      const jackKeys = manager.listForUser(u1);
      expect(jackKeys).toHaveLength(1);
      expect(jackKeys[0].name).toBe('Jack Key');
    });

    it('does not return revoked keys', () => {
      const userId = insertUser(db, 'leo', ['devices:read']);
      const { id } = manager.create(userId, 'To Revoke', ['devices:read'], null);
      manager.create(userId, 'Active Key', ['devices:read'], null);

      manager.revoke(id, userId);

      const keys = manager.listForUser(userId);
      expect(keys).toHaveLength(1);
      expect(keys[0].name).toBe('Active Key');
    });
  });

  describe('listAll()', () => {
    it('returns active keys from all users', () => {
      const u1 = insertUser(db, 'mia', ['devices:read']);
      const u2 = insertUser(db, 'ned', ['devices:read']);
      manager.create(u1, 'Mia Key', ['devices:read'], null);
      manager.create(u2, 'Ned Key', ['devices:read'], null);

      const all = manager.listAll();
      expect(all).toHaveLength(2);
      expect(all.every(k => 'userId' in k)).toBe(true);
    });

    it('excludes revoked keys', () => {
      const userId = insertUser(db, 'opal', ['devices:read']);
      const { id } = manager.create(userId, 'Revoked', ['devices:read'], null);
      manager.revokeAsAdmin(id);
      manager.create(userId, 'Active', ['devices:read'], null);

      const all = manager.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Active');
    });

    // MG-4: listAll() must not expose keyHash in results
    it('listAll does not expose keyHash', () => {
      const userId = insertUser(db, 'petra', ['devices:read']);
      manager.create(userId, 'Test Key', ['devices:read'], null);
      const all = manager.listAll();
      expect(all.length).toBe(1);
      expect((all[0] as any).keyHash).toBeUndefined();
    });
  });

  describe('revoke()', () => {
    it('removes key from user list after revoke', () => {
      const userId = insertUser(db, 'pat', ['devices:read']);
      const { id } = manager.create(userId, 'My Key', ['devices:read'], null);

      const revoked = manager.revoke(id, userId);
      expect(revoked).toBe(true);

      const keys = manager.listForUser(userId);
      expect(keys).toHaveLength(0);
    });

    it('returns false when revoking non-existent key', () => {
      const userId = insertUser(db, 'quinn', ['devices:read']);
      const result = manager.revoke(9999, userId);
      expect(result).toBe(false);
    });

    it('cannot revoke another users key', () => {
      const u1 = insertUser(db, 'rose', ['devices:read']);
      const u2 = insertUser(db, 'sam', ['devices:read']);
      const { id } = manager.create(u1, 'Rose Key', ['devices:read'], null);

      const result = manager.revoke(id, u2);
      expect(result).toBe(false);

      // Key should still be active
      const keys = manager.listForUser(u1);
      expect(keys).toHaveLength(1);
    });
  });

  describe('revokeAsAdmin()', () => {
    it('revokes any key by ID', () => {
      const userId = insertUser(db, 'tara', ['devices:read']);
      const { id } = manager.create(userId, 'Admin Revoke', ['devices:read'], null);

      const result = manager.revokeAsAdmin(id);
      expect(result).toBe(true);

      const keys = manager.listForUser(userId);
      expect(keys).toHaveLength(0);
    });

    it('returns false for non-existent key ID', () => {
      const result = manager.revokeAsAdmin(9999);
      expect(result).toBe(false);
    });
  });
});

describe('ApiKeyManager — internal tokens', () => {
  let db: ReturnType<typeof createTestDb>;
  let mgr: ApiKeyManager;
  const USER_ID_SEED = 'alice-internal';

  beforeEach(() => {
    db = createTestDb();
    mgr = new ApiKeyManager(db);
  });

  it('create accepts internal flag and stores true', () => {
    const userId = insertUser(db, USER_ID_SEED, ['mcp']);
    const { id } = mgr.create(userId, 'AI Assistant (ephemeral)', ['mcp'], null, true);
    const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    expect(row!.internal).toBe(true);
  });

  it('internal mint bypasses the no-wildcards rule (user has wildcard scope)', () => {
    // A user with a wildcard scope (e.g. core.admin:*) should be able to have
    // their scope set minted into an internal token verbatim — the rule only
    // prevents *user-created* keys from carrying wildcards.
    const userId = insertUser(db, USER_ID_SEED, ['core.admin:*', 'mcp']);
    const { id } = mgr.create(userId, 'AI Assistant (ephemeral)', ['core.admin:*', 'mcp'], null, true);
    const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    expect(row!.internal).toBe(true);
    expect(row!.scopes).toEqual(['core.admin:*', 'mcp']);
  });

  it('non-internal mint still rejects wildcards even when user has them', () => {
    const userId = insertUser(db, USER_ID_SEED, ['core.admin:*']);
    expect(() =>
      mgr.create(userId, 'user-pat', ['core.admin:*'], null, false),
    ).toThrow('cannot contain wildcards');
  });

  it('create defaults internal to false', () => {
    const userId = insertUser(db, USER_ID_SEED, ['mcp']);
    const { id } = mgr.create(userId, 'user-created', ['mcp'], null);
    const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    expect(row!.internal).toBe(false);
  });

  it('listForUser excludes internal tokens', () => {
    const userId = insertUser(db, USER_ID_SEED, ['mcp']);
    mgr.create(userId, 'visible', ['mcp'], null);
    mgr.create(userId, 'hidden', ['mcp'], null, true);
    const visible = mgr.listForUser(userId);
    expect(visible).toHaveLength(1);
    expect(visible[0].name).toBe('visible');
  });

  it('revokeInternalOrphans revokes all non-revoked internal keys', () => {
    const userId = insertUser(db, USER_ID_SEED, ['mcp']);
    const a = mgr.create(userId, 'orphan1', ['mcp'], null, true);
    const b = mgr.create(userId, 'orphan2', ['mcp'], null, true);
    // A user-visible PAT should NOT be touched
    const c = mgr.create(userId, 'user-pat', ['mcp'], null);

    mgr.revokeInternalOrphans();

    const aRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, a.id)).get();
    const bRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, b.id)).get();
    const cRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, c.id)).get();

    expect(aRow!.revokedAt).not.toBeNull();
    expect(bRow!.revokedAt).not.toBeNull();
    expect(cRow!.revokedAt).toBeNull();
  });

  it('revokeInternalOrphans does not re-revoke already-revoked keys', () => {
    const userId = insertUser(db, USER_ID_SEED, ['mcp']);
    const a = mgr.create(userId, 'orphan', ['mcp'], null, true);
    mgr.revoke(a.id, userId);
    const firstRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, a.id)).get();
    const firstRevokedAt = firstRow!.revokedAt;

    // Ensure timestamp would differ if re-revoked
    const now = Date.now();
    while (Date.now() === now) { /* spin */ }
    mgr.revokeInternalOrphans();

    const secondRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, a.id)).get();
    expect(secondRow!.revokedAt!.getTime()).toBe(firstRevokedAt!.getTime());
  });
});
