import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { applyMigrations } from '../test-utils/create-test-db';

const { users } = schema;

describe('users.kind and service_owner', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');

    // Apply all migrations to get the realistic DB schema
    applyMigrations(sqlite);

    db = drizzle(sqlite, { schema });
  });

  it('defaults kind to human', () => {
    const now = new Date();
    db.insert(users).values({
      username: 'alice',
      email: 'alice@example.com',
      providerId: 'local',
      createdAt: now,
      updatedAt: now,
    }).run();

    const result = db.select().from(users).all();
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('human');
    expect(result[0].serviceOwner).toBeNull();
  });

  it('supports core-service and plugin-service kinds with owner', () => {
    const now = new Date();

    db.insert(users).values({
      username: 'core-service',
      providerId: 'service',
      kind: 'core-service',
      serviceOwner: 'darkride',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(users).values({
      username: 'plugin-service',
      providerId: 'service',
      kind: 'plugin-service',
      serviceOwner: 'my-plugin',
      createdAt: now,
      updatedAt: now,
    }).run();

    const results = db.select().from(users).all();
    expect(results).toHaveLength(2);

    expect(results[0].kind).toBe('core-service');
    expect(results[0].serviceOwner).toBe('darkride');

    expect(results[1].kind).toBe('plugin-service');
    expect(results[1].serviceOwner).toBe('my-plugin');
  });

  it('rejects duplicate (kind, service_owner) for non-human rows', () => {
    const now = new Date();

    db.insert(users).values({
      username: 'service1',
      providerId: 'service',
      kind: 'core-service',
      serviceOwner: 'darkride',
      createdAt: now,
      updatedAt: now,
    }).run();

    // Inserting a duplicate should fail (unique index on kind, service_owner for non-human)
    expect(() => {
      db.insert(users).values({
        username: 'service2',
        providerId: 'service',
        kind: 'core-service',
        serviceOwner: 'darkride',
        createdAt: now,
        updatedAt: now,
      }).run();
    }).toThrow();
  });

  it('allows multiple human rows with null service_owner', () => {
    const now = new Date();

    db.insert(users).values({
      username: 'alice',
      email: 'alice@example.com',
      providerId: 'local',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(users).values({
      username: 'bob',
      email: 'bob@example.com',
      providerId: 'local',
      createdAt: now,
      updatedAt: now,
    }).run();

    const results = db.select().from(users).all();
    expect(results).toHaveLength(2);
    expect(results[0].kind).toBe('human');
    expect(results[1].kind).toBe('human');
    expect(results[0].serviceOwner).toBeNull();
    expect(results[1].serviceOwner).toBeNull();
  });
});
