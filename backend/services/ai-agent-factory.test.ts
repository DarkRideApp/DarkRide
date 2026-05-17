import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { AiAgentFactory } from './ai-agent-factory';
import { ServiceUserManager } from '../auth/service-user-manager';
import { ApiKeyManager } from '../auth/api-key-manager';

describe('AiAgentFactory', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let factory: AiAgentFactory;
  let svcUsers: ServiceUserManager;
  let apiKeys: ApiKeyManager;
  let humanUserId: number;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    applyMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    svcUsers = new ServiceUserManager(db);
    apiKeys = new ApiKeyManager(db);
    factory = new AiAgentFactory({
      db, serviceUsers: svcUsers, apiKeys,
      providerFactory: () => ({ kind: 'fake' } as any),
      logger: { startCall: vi.fn().mockReturnValue(1), endCall: vi.fn() } as any,
    });
    const now = new Date();
    humanUserId = db.insert(schema.users).values({
      username: 'alice', providerId: 'core.password',
      scopes: ['core.apk:read', 'mcp'] as any,
      createdAt: now, updatedAt: now,
    } as any).returning({ id: schema.users.id }).get().id;
  });

  it('forUser binds to the user identity with their scopes', () => {
    const agent = factory.forUser(humanUserId);
    expect(agent.identity.identityType).toBe('user');
    expect(agent.identity.actorUserId).toBe(humanUserId);
    expect(agent.identity.effectiveScopes.sort())
      .toEqual(['core.apk:read', 'mcp']);
  });

  it('forUser throws on unknown user id', () => {
    expect(() => factory.forUser(999999)).toThrow(/user.*not found/i);
  });

  it('forUser throws when target is a service account, not a human', () => {
    svcUsers.ensurePluginServiceUser('demo-plugin', ['mcp']);
    const svcRow = svcUsers.getPluginServiceUser('demo-plugin')!;
    expect(() => factory.forUser(svcRow.id)).toThrow(/not a human/i);
  });

  it('registerCoreIdentity provisions the service user', () => {
    factory.registerCoreIdentity('apk-diff-engine', { aiScopes: ['core.apk:read'] });
    const row = svcUsers.getCoreServiceUser('apk-diff-engine');
    expect(row).not.toBeNull();
    expect(row!.scopes).toEqual(['core.apk:read']);
  });

  it('registerCoreIdentity is idempotent and updates scopes', () => {
    factory.registerCoreIdentity('apk-diff-engine', { aiScopes: ['core.apk:read'] });
    factory.registerCoreIdentity('apk-diff-engine', { aiScopes: ['core.apk:read', 'mcp'] });
    const row = svcUsers.getCoreServiceUser('apk-diff-engine');
    expect(row!.scopes).toEqual(['core.apk:read', 'mcp']);
  });

  it('registerCoreIdentity rejects keys not in CORE_SERVICE_IDENTITIES', () => {
    expect(() =>
      factory.registerCoreIdentity('unknown-service', { aiScopes: ['mcp'] }),
    ).toThrow(/CORE_SERVICE_IDENTITIES/);
  });

  it('forCoreService binds to the core-service identity', () => {
    factory.registerCoreIdentity('apk-diff-engine', { aiScopes: ['core.apk:read'] });
    const agent = factory.forCoreService('apk-diff-engine');
    expect(agent.identity.identityType).toBe('core-service');
    expect(agent.identity.onBehalfOfService).toBe('apk-diff-engine');
    expect(agent.identity.effectiveScopes).toEqual(['core.apk:read']);
  });

  it('forCoreService throws when called for an unregistered key', () => {
    expect(() => factory.forCoreService('apk-diff-engine' as any))
      .toThrow(/apk-diff-engine.*not registered/i);
  });

  it('forPluginInternal throws when plugin has no service user', () => {
    expect(() => factory.forPluginInternal('missing-plugin', ['mcp']))
      .toThrow(/missing-plugin.*service user/i);
  });

  it('forPluginInternal binds to the plugin service identity', () => {
    svcUsers.ensurePluginServiceUser('demo-plugin', ['mcp']);
    const agent = factory.forPluginInternal('demo-plugin', ['mcp']);
    expect(agent.identity.identityType).toBe('plugin');
    expect(agent.identity.onBehalfOfPlugin).toBe('demo-plugin');
    expect(agent.identity.effectiveScopes).toEqual(['mcp']);
  });

  it('forPluginActingForInternal intersects user scopes with plugin aiScopes', () => {
    svcUsers.ensurePluginServiceUser('apk-helper', ['core.apk:read', 'mcp']);
    const agent = factory.forPluginActingForInternal('apk-helper', humanUserId, ['core.apk:read', 'mcp']);
    expect(agent.identity.identityType).toBe('plugin-acting-for-user');
    expect(agent.identity.actorUserId).toBe(humanUserId);
    expect(agent.identity.actingForUserId).toBe(humanUserId);
    expect(agent.identity.onBehalfOfPlugin).toBe('apk-helper');
    // user has core.apk:read + mcp; plugin declares both → full intersection
    expect(agent.identity.effectiveScopes.sort()).toEqual(['core.apk:read', 'mcp']);
  });

  it('forPluginActingForInternal shrinks when user lacks plugin scopes', () => {
    svcUsers.ensurePluginServiceUser('wide-plugin', ['core.apk:read', 'core.traffic:read']);
    const agent = factory.forPluginActingForInternal('wide-plugin', humanUserId, ['core.apk:read', 'core.traffic:read']);
    // user has core.apk:read + mcp; plugin declared apk:read + traffic:read; intersection = apk:read only
    expect(agent.identity.effectiveScopes).toEqual(['core.apk:read']);
  });

  // Writers like claim-manager pre-stringify scopes before handing them to
  // Drizzle's mode:'json' column, so the stored value is double-encoded JSON.
  // Drizzle parses once on read, surfacing the inner JSON string rather than
  // an array. forUser/forPluginActingForInternal/forCoreService must cope.
  // Writers like claim-manager / bootstrap pre-stringify scopes before handing
  // them to Drizzle's mode:'json' column, which stringifies AGAIN — so the row
  // is double-encoded JSON. Drizzle parses once on read, surfacing the inner
  // JSON string rather than an array. forUser / forPluginActingForInternal
  // must cope.
  it('forUser handles double-encoded scopes written by legacy writers', () => {
    const now = new Date();
    db.insert(schema.users).values({
      username: 'bob', providerId: 'core.password',
      // Mirror the claim-manager pattern: pre-stringify, Drizzle re-stringifies.
      scopes: JSON.stringify(['core.admin:*']) as any,
      createdAt: now, updatedAt: now,
    } as any).run();
    const bobId = db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.username, 'bob')).get()!.id;

    const agent = factory.forUser(bobId);
    expect(Array.isArray(agent.identity.effectiveScopes)).toBe(true);
    expect(agent.identity.effectiveScopes).toEqual(['core.admin:*']);
  });

  it('passes tier option through to providerFactory', async () => {
    const providerFactory = vi.fn().mockReturnValue({
      handleMessageWithIdentity: vi.fn().mockResolvedValue({ conversationId: 1 }),
    });
    const tierFactory = new AiAgentFactory({
      db, serviceUsers: svcUsers, apiKeys,
      providerFactory,
      logger: { startCall: vi.fn().mockReturnValue(1), endCall: vi.fn() } as any,
    });
    svcUsers.ensurePluginServiceUser('test-plugin', ['mcp']);
    const agent = tierFactory.forPluginInternal('test-plugin', ['mcp'], { tier: 'Low' });
    await agent.handleMessage({
      message: 'hello',
      conversationId: null,
      tools: [],
      systemPrompt: '',
    } as any);
    expect(providerFactory).toHaveBeenCalledWith({ tier: 'Low' });
  });

  it('forPluginActingForInternal handles double-encoded user scopes', () => {
    const now = new Date();
    db.insert(schema.users).values({
      username: 'carol', providerId: 'core.password',
      scopes: JSON.stringify(['core.apk:read']) as any,
      createdAt: now, updatedAt: now,
    } as any).run();
    const carolId = db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.username, 'carol')).get()!.id;

    svcUsers.ensurePluginServiceUser('narrow-plugin', ['core.apk:read']);
    const agent = factory.forPluginActingForInternal('narrow-plugin', carolId, ['core.apk:read']);
    expect(agent.identity.effectiveScopes).toEqual(['core.apk:read']);
  });
});
