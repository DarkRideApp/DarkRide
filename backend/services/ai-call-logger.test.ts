import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { AiCallLogger } from './ai-call-logger';

describe('AiCallLogger', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let logger: AiCallLogger;
  let userId: number;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    applyMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    logger = new AiCallLogger(db);
    const now = new Date();
    userId = db.insert(schema.users).values({
      username: 'alice', providerId: 'core.password',
      scopes: [] as any,
      createdAt: now, updatedAt: now,
    } as any).returning({ id: schema.users.id }).get().id;
  });

  it('startCall writes a row and returns the log id', () => {
    const id = logger.startCall(
      { identityType: 'user', actorUserId: userId, effectiveScopes: ['mcp'] },
      { pageContext: 'chat', contextId: 'c-1' } as any,
    );
    const row = db.select().from(schema.aiCallLog).where(eq(schema.aiCallLog.id, id)).get()!;
    expect(row.identityType).toBe('user');
    expect(row.actorUserId).toBe(userId);
    expect(row.pageContext).toBe('chat');
    expect(row.contextId).toBe('c-1');
    expect(row.outcome).toBeNull();
    expect(row.endedAt).toBeNull();
    expect(row.effectiveScopes).toEqual(['mcp']);
  });

  it('endCall updates outcome, endedAt, and usage', () => {
    const id = logger.startCall(
      { identityType: 'user', actorUserId: userId, effectiveScopes: [] },
      {} as any,
    );
    logger.endCall(id, 'success', { inputTokens: 100, outputTokens: 50 });
    const row = db.select().from(schema.aiCallLog).where(eq(schema.aiCallLog.id, id)).get()!;
    expect(row.outcome).toBe('success');
    expect(row.endedAt).toBeInstanceOf(Date);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
  });

  it('records delegation with both on-behalf-of and acting-for', () => {
    const id = logger.startCall(
      {
        identityType: 'plugin-acting-for-user',
        actorUserId: userId, effectiveScopes: ['mcp'],
        onBehalfOfPlugin: 'example', actingForUserId: userId,
      },
      {} as any,
    );
    const row = db.select().from(schema.aiCallLog).where(eq(schema.aiCallLog.id, id)).get()!;
    expect(row.onBehalfOfPlugin).toBe('example');
    expect(row.actingForUserId).toBe(userId);
    expect(row.identityType).toBe('plugin-acting-for-user');
  });

  it('records core-service identity via on_behalf_of_service', () => {
    // Seed a core-service user
    const svcId = db.insert(schema.users).values({
      username: 'service:apk-diff-engine:ai',
      providerId: 'core.service',
      kind: 'core-service',
      serviceOwner: 'apk-diff-engine',
      scopes: ['core.apk:read'] as any,
      createdAt: new Date(), updatedAt: new Date(),
    } as any).returning({ id: schema.users.id }).get().id;
    const id = logger.startCall(
      { identityType: 'core-service', actorUserId: svcId, effectiveScopes: ['core.apk:read'], onBehalfOfService: 'apk-diff-engine' },
      { pageContext: 'apk-diff', contextId: '42' } as any,
    );
    const row = db.select().from(schema.aiCallLog).where(eq(schema.aiCallLog.id, id)).get()!;
    expect(row.onBehalfOfService).toBe('apk-diff-engine');
  });

  it('endCall with error status stores error text', () => {
    const id = logger.startCall(
      { identityType: 'user', actorUserId: userId, effectiveScopes: [] },
      {} as any,
    );
    logger.endCall(id, 'error', undefined, 'boom');
    const row = db.select().from(schema.aiCallLog).where(eq(schema.aiCallLog.id, id)).get()!;
    expect(row.outcome).toBe('error');
    expect(row.error).toBe('boom');
  });
});
