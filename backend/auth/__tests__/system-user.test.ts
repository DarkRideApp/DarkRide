import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/create-test-db';
import { users } from '../../db/schema';
import { ensureSystemUser, SYSTEM_USERNAME } from '../system-user';

describe('ensureSystemUser', () => {
  let db: any;

  beforeEach(() => {
    db = createTestDb([users]);
  });

  it('creates the __system__ user on first call', () => {
    const id = ensureSystemUser(db);
    expect(id).toBeGreaterThan(0);

    const row = db.select().from(users).where(eq(users.username, SYSTEM_USERNAME)).get();
    expect(row).toBeTruthy();
    expect(row.providerId).toBe('core.system');
    expect(row.passwordHash).toBeNull();
    expect(row.enabled).toBe(true);
    expect(row.scopes).toEqual(['core.admin:*']);
  });

  it('returns the same id on repeat calls (idempotent)', () => {
    const first = ensureSystemUser(db);
    const second = ensureSystemUser(db);
    expect(second).toBe(first);
    // Still exactly one row
    const count = db.select().from(users).where(eq(users.username, SYSTEM_USERNAME)).all().length;
    expect(count).toBe(1);
  });

  it('exports SYSTEM_USERNAME constant', () => {
    expect(SYSTEM_USERNAME).toBe('__system__');
  });
});
