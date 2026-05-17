import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { ServiceUserManager } from './service-user-manager';

describe('ServiceUserManager', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let mgr: ServiceUserManager;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    applyMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    mgr = new ServiceUserManager(db);
  });

  it('ensurePluginServiceUser creates a plugin-service row', () => {
    const id = mgr.ensurePluginServiceUser('example', ['mcp']);
    const row = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
    expect(row.username).toBe('plugin:example:ai');
    expect(row.kind).toBe('plugin-service');
    expect(row.serviceOwner).toBe('example');
    expect(row.scopes).toEqual(['mcp']);
    expect(row.enabled).toBe(true);
    expect(row.passwordHash).toBeNull();
  });

  it('ensurePluginServiceUser is idempotent (updates scopes on subsequent call)', () => {
    const id1 = mgr.ensurePluginServiceUser('example', ['mcp']);
    const id2 = mgr.ensurePluginServiceUser('example', ['mcp', 'core.apk:read']);
    expect(id2).toBe(id1);
    const row = db.select().from(schema.users).where(eq(schema.users.id, id1)).get()!;
    expect(row.scopes).toEqual(['mcp', 'core.apk:read']);
  });

  it('ensureCoreServiceUser uses service: prefix', () => {
    const id = mgr.ensureCoreServiceUser('apk-diff-engine', ['core.apk:read']);
    const row = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
    expect(row.username).toBe('service:apk-diff-engine:ai');
    expect(row.kind).toBe('core-service');
    expect(row.serviceOwner).toBe('apk-diff-engine');
  });

  it('removePluginServiceUser deletes the row', () => {
    const id = mgr.ensurePluginServiceUser('example', ['mcp']);
    mgr.removePluginServiceUser('example');
    const row = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    expect(row).toBeUndefined();
  });

  it('getPluginServiceUser returns null when not provisioned', () => {
    expect(mgr.getPluginServiceUser('not-installed')).toBeNull();
  });

  it('getPluginServiceUser returns the row when provisioned', () => {
    mgr.ensurePluginServiceUser('example', ['mcp']);
    const row = mgr.getPluginServiceUser('example');
    expect(row).not.toBeNull();
    expect(row!.username).toBe('plugin:example:ai');
  });

  it('rejects empty aiScopes — callers must check before calling', () => {
    expect(() => mgr.ensurePluginServiceUser('bad', [])).toThrow(/aiScopes.*must.*non-empty/i);
  });
});
