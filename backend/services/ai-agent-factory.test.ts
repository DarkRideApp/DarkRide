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

  describe('call logging', () => {
    const requests = [
      { model: 'claude-haiku-5-5', providerType: 'anthropic', inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 0, outputTokens: 10 },
      { model: 'claude-opus-5-5', providerType: 'anthropic', inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 150, outputTokens: 20 },
    ];

    function setup(handle: (...args: any[]) => Promise<any>) {
      const logger = { startCall: vi.fn().mockReturnValue(7), endCall: vi.fn() };
      const f = new AiAgentFactory({
        db, serviceUsers: svcUsers, apiKeys,
        providerFactory: () => ({ handleMessageWithIdentity: vi.fn(handle) } as any),
        logger,
      });
      return { logger, agent: f.forUser(humanUserId) };
    }
    const send = (agent: { handleMessage: (p: any) => Promise<any> }) =>
      agent.handleMessage({
        message: 'hi', conversationId: null, pageContext: 'chat', contextId: '', mode: 'streaming',
        onToken: vi.fn(), onToolStart: vi.fn(), onToolResult: vi.fn(),
      } as any);

    it('passes requests, turns and tool calls to the logger', async () => {
      const { logger, agent } = setup(async () => ({
        conversationId: 1,
        usage: { inputTokens: 300, outputTokens: 30 },
        run: { requests, turns: 2, toolCalls: 1 },
      }));
      await send(agent);
      expect(logger.endCall).toHaveBeenCalledWith(
        7, 'success',
        { inputTokens: 300, outputTokens: 30, requests, turns: 2, toolCalls: 1 },
        undefined,
      );
    });

    it('logs a cancelled run as aborted with its partial usage', async () => {
      const { logger, agent } = setup(async () => ({
        conversationId: 1,
        usage: { inputTokens: 100, outputTokens: 10 },
        run: { requests: requests.slice(0, 1), turns: 1, toolCalls: 0 },
        error: 'Request was cancelled',
        aborted: true,
      }));
      await send(agent);
      expect(logger.endCall).toHaveBeenCalledWith(
        7, 'aborted',
        { inputTokens: 100, outputTokens: 10, requests: requests.slice(0, 1), turns: 1, toolCalls: 0 },
        'Request was cancelled',
      );
    });

    it('still logs an error row, with the partial usage, when the agent throws', async () => {
      const { getRunUsageFromError, AiAgent } = await import('./ai-agent');
      // A real agent whose second request fails, so the thrown error carries the first request's usage.
      let call = 0;
      const provider = {
        name: 'mock',
        createStreamingRequest: () => (async function* () {
          call++;
          if (call === 1) {
            yield { type: 'tool_use' as const, id: 't1', name: 'request_tools', input: { contexts: [] } };
            yield { type: 'usage' as const, inputTokens: 50, outputTokens: 5, model: 'claude-haiku-5-5', providerType: 'anthropic' };
            return;
          }
          throw new Error('stream exploded');
        })(),
      };
      const { AiToolRegistry } = await import('./ai-tools');
      const realAgent = new AiAgent(db as any, new AiToolRegistry(), provider as any);
      const logger = { startCall: vi.fn().mockReturnValue(9), endCall: vi.fn() };
      const f = new AiAgentFactory({
        db, serviceUsers: svcUsers, apiKeys, providerFactory: () => realAgent, logger,
      });
      const err = await send(f.forUser(humanUserId)).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(getRunUsageFromError(err)?.requests).toHaveLength(1);
      expect(logger.endCall).toHaveBeenCalledTimes(1);
      const [id, outcome, usage, message] = logger.endCall.mock.calls[0];
      expect([id, outcome, message]).toEqual([9, 'error', 'Error: stream exploded']);
      expect(usage).toMatchObject({
        inputTokens: 50, outputTokens: 5, turns: 2, toolCalls: 0,
        requests: [{ model: 'claude-haiku-5-5', providerType: 'anthropic', inputTokens: 50, outputTokens: 5 }],
      });
    });

    it('writes exactly one request row for a stream that reports usage in a start event and two output deltas', async () => {
      const { AiAgent } = await import('./ai-agent');
      const { AiToolRegistry } = await import('./ai-tools');
      const { AiCallLogger } = await import('./ai-call-logger');
      const ev = { model: 'claude-haiku-5-5', providerType: 'anthropic' };
      const provider = {
        name: 'mock',
        createStreamingRequest: () => (async function* () {
          yield { type: 'usage' as const, inputTokens: 150_000, outputTokens: 0, cachedInputTokens: 40_000, cacheCreationInputTokens: 10_000, ...ev };
          yield { type: 'text' as const, text: 'hello' };
          yield { type: 'usage' as const, inputTokens: 0, outputTokens: 600, ...ev };
          yield { type: 'usage' as const, inputTokens: 0, outputTokens: 400, ...ev };
        })(),
      };
      const realAgent = new AiAgent(db as any, new AiToolRegistry(), provider as any);
      const f = new AiAgentFactory({
        db, serviceUsers: svcUsers, apiKeys, providerFactory: () => realAgent, logger: new AiCallLogger(db),
      });
      await send(f.forUser(humanUserId));

      const run = db.select().from(schema.aiCallLog).get()!;
      const rows = db.select().from(schema.aiCallRequest).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        callId: run.id, seq: 0, model: 'claude-haiku-5-5', providerType: 'anthropic',
        inputTokens: 150_000, cacheReadTokens: 40_000, cacheWriteTokens: 10_000, outputTokens: 1000,
      });
      // The prompt is over Haiku 5.5's 100,000-token tier, judged on the whole request, so the higher rates apply:
      // 100k uncached x $0.50 + 40k read x $0.05 + 10k write x $0.625 + 1k output x $2.50, per million.
      const expected = (100_000 * 0.5 + 40_000 * 0.05 + 10_000 * 0.625 + 1000 * 2.5) / 1e6;
      expect(rows[0].costUsd).toBeCloseTo(expected, 12);
      expect(run).toMatchObject({ outcome: 'success', turns: 1, toolCalls: 0, inputTokens: 150_000, outputTokens: 1000 });
      expect(run.costUsd).toBeCloseTo(expected, 12);
    });

    it('logs an error row with no usage when a non-agent provider throws', async () => {
      const { logger, agent } = setup(async () => { throw new Error('boom'); });
      await expect(send(agent)).rejects.toThrow('boom');
      expect(logger.endCall).toHaveBeenCalledWith(7, 'error', undefined, 'Error: boom');
    });
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
