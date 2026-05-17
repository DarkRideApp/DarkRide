import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, desc } from 'drizzle-orm';
import * as schema from './schema';
import { applyMigrations } from '../test-utils/create-test-db';

const { aiCallLog, users } = schema;

describe('ai_call_log table', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');

    // Apply all migrations to get the realistic DB schema
    applyMigrations(sqlite);

    db = drizzle(sqlite, { schema });
  });

  it('inserts a user-identity row', () => {
    const now = new Date();

    // Insert a human user first
    db.insert(users).values({
      username: 'alice',
      email: 'alice@example.com',
      providerId: 'local',
      createdAt: now,
      updatedAt: now,
    }).run();

    const userResult = db.select().from(users).all();
    const userId = userResult[0].id;

    // Insert a call log entry with user identity
    db.insert(aiCallLog).values({
      startedAt: now,
      endedAt: new Date(now.getTime() + 1000),
      identityType: 'user',
      actorUserId: userId,
      effectiveScopes: ['core.apk:read'],
      outcome: 'success',
    }).run();

    const result = db.select().from(aiCallLog).all();
    expect(result).toHaveLength(1);
    expect(result[0].identityType).toBe('user');
    expect(result[0].actorUserId).toBe(userId);
    expect(result[0].effectiveScopes).toEqual(['core.apk:read']);
    expect(result[0].outcome).toBe('success');
  });

  it('inserts a plugin-acting-for-user row with both identities', () => {
    const now = new Date();

    // Insert two users: one acting, one being acted for
    db.insert(users).values({
      username: 'plugin-service',
      providerId: 'service',
      kind: 'plugin-service',
      serviceOwner: 'my-plugin',
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

    const allUsers = db.select().from(users).all();
    const pluginUserId = allUsers[0].id;
    const bobUserId = allUsers[1].id;

    // Insert a call log entry with plugin-acting-for-user identity
    db.insert(aiCallLog).values({
      startedAt: now,
      endedAt: new Date(now.getTime() + 1000),
      identityType: 'plugin-acting-for-user',
      actorUserId: pluginUserId,
      onBehalfOfPlugin: 'my-plugin',
      actingForUserId: bobUserId,
      effectiveScopes: ['core.data:read', 'core.data:write'],
      outcome: 'success',
    }).run();

    const result = db.select().from(aiCallLog).all();
    expect(result).toHaveLength(1);
    expect(result[0].identityType).toBe('plugin-acting-for-user');
    expect(result[0].actorUserId).toBe(pluginUserId);
    expect(result[0].onBehalfOfPlugin).toBe('my-plugin');
    expect(result[0].actingForUserId).toBe(bobUserId);
    expect(result[0].effectiveScopes).toEqual(['core.data:read', 'core.data:write']);
  });

  it('indexes support fast time-ordered lookup by actor', () => {
    const baseTime = Math.floor(Date.now() / 1000) * 1000; // Round to nearest second

    // Insert a human user
    db.insert(users).values({
      username: 'charlie',
      email: 'charlie@example.com',
      providerId: 'local',
      createdAt: new Date(baseTime),
      updatedAt: new Date(baseTime),
    }).run();

    const userResult = db.select().from(users).all();
    const userId = userResult[0].id;

    // Insert 5 rows with incrementing startedAt timestamps
    for (let i = 0; i < 5; i++) {
      db.insert(aiCallLog).values({
        startedAt: new Date(baseTime + i * 1000),
        identityType: 'user',
        actorUserId: userId,
        effectiveScopes: ['core.apk:read'],
        outcome: 'success',
      }).run();
    }

    // Query with Drizzle filtering by actor and ordering by desc(startedAt)
    const result = db.select()
      .from(aiCallLog)
      .where(eq(aiCallLog.actorUserId, userId))
      .orderBy(desc(aiCallLog.startedAt))
      .all();

    expect(result).toHaveLength(5);
    // Verify most-recent first (descending order)
    for (let i = 0; i < 5; i++) {
      expect(result[i].startedAt.getTime()).toBe(baseTime + (4 - i) * 1000);
    }
  });
});
