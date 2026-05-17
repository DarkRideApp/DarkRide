import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../../backend/db/schema';
import { applyMigrations } from '../../backend/test-utils/create-test-db';
import { createAdminUser, adminCreate } from '../commands/admin-create';
import { verifyPassword } from '../../backend/auth/password';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

describe('createAdminUser', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates an admin user with core.admin:* scope', async () => {
    const result = await createAdminUser(db, 'alice', 'a-secure-password-123');
    expect(result.userId).toBe(1);

    const user = db.select().from(schema.users).where(eq(schema.users.id, 1)).get();
    expect(user).toBeDefined();
    expect(user!.username).toBe('alice');
    expect(user!.providerId).toBe('core.local');

    const scopes = typeof user!.scopes === 'string'
      ? JSON.parse(user!.scopes)
      : user!.scopes;
    expect(scopes).toContain('core.admin:*');
  });

  it('hashes the password with argon2id', async () => {
    await createAdminUser(db, 'bob', 'correct-horse-battery-staple');
    const user = db.select().from(schema.users).where(eq(schema.users.username, 'bob')).get();
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct-horse-battery-staple', user!.passwordHash!)).toBe(true);
    expect(await verifyPassword('wrong-password', user!.passwordHash!)).toBe(false);
  });

  it('rejects when users already exist and forceAdd is false', async () => {
    await createAdminUser(db, 'first', 'password-for-first-user');
    await expect(
      createAdminUser(db, 'second', 'password-for-second-user'),
    ).rejects.toThrow(/already exist/);
  });

  it('allows creating when users exist and forceAdd is true', async () => {
    await createAdminUser(db, 'first', 'password-for-first-user');
    const result = await createAdminUser(db, 'second', 'password-for-second-user', { forceAdd: true });
    expect(result.userId).toBe(2);
  });

  it('rejects duplicate username even with forceAdd', async () => {
    await createAdminUser(db, 'alice', 'password-for-alice-one');
    await expect(
      createAdminUser(db, 'alice', 'password-for-alice-two', { forceAdd: true }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects weak password (policy violation)', async () => {
    await expect(
      createAdminUser(db, 'admin', 'short'),
    ).rejects.toThrow(/12 characters/);
  });

  it('rejects password matching the username', async () => {
    await expect(
      createAdminUser(db, 'myusernamehere', 'myusernamehere'),
    ).rejects.toThrow(/username/);
  });

  it('rejects common password', async () => {
    await expect(
      createAdminUser(db, 'admin', 'password1234'),
    ).rejects.toThrow(/common/i);
  });
});

// MG-6: adminCreate CLI wrapper arg parsing
describe('adminCreate CLI wrapper', () => {
  it('exits with code 1 when --username is missing', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await adminCreate(['--password-from-env', 'SOME_VAR']);
    } catch (e: any) {
      expect(e.message).toBe('exit');
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('exits with code 1 when --password-from-env is missing', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await adminCreate(['--username', 'test']);
    } catch (e: any) {
      expect(e.message).toBe('exit');
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('exits with code 1 when env var is not set', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.NONEXISTENT_VAR;

    try {
      await adminCreate(['--username', 'test', '--password-from-env', 'NONEXISTENT_VAR']);
    } catch (e: any) {
      expect(e.message).toBe('exit');
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
    mockError.mockRestore();
  });
});
