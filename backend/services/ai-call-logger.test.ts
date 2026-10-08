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

  describe('per-request usage', () => {
    const startRun = () => logger.startCall({ identityType: 'user', actorUserId: userId, effectiveScopes: [] }, {} as any);
    const requestRows = (id: number) => db.select().from(schema.aiCallRequest)
      .where(eq(schema.aiCallRequest.callId, id)).orderBy(schema.aiCallRequest.seq).all();
    const runRow = (id: number) => db.select().from(schema.aiCallLog).where(eq(schema.aiCallLog.id, id)).get()!;
    const round = (n: number | null | undefined) => (n == null ? n : Math.round(n * 1e9) / 1e9);

    it('writes one row per request in order and sums their estimated cost onto the run', () => {
      const id = startRun();
      logger.endCall(id, 'success', {
        inputTokens: 3_000_000, outputTokens: 1_000_000, turns: 2, toolCalls: 3,
        requests: [
          // Opus 5.5: 1M uncached ($4) + 1M cache read ($0.20) + 0 write, 0.5M output ($10) = $14.20
          { model: 'claude-opus-5-5', providerType: 'anthropic', inputTokens: 2_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 500_000 },
          // Sonnet 5.5: 1M cache write ($2.50), 0.5M output ($5) = $7.50
          { model: 'claude-sonnet-5-5', providerType: 'anthropic', inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 500_000,
            fallbacks: [{ model: 'claude-opus-5-5', error: 'rate limited' }] },
        ],
      });
      const rows = requestRows(id);
      expect(rows.map((r) => [r.seq, r.model, r.providerType, r.inputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.outputTokens]))
        .toEqual([
          [0, 'claude-opus-5-5', 'anthropic', 2_000_000, 1_000_000, 0, 500_000],
          [1, 'claude-sonnet-5-5', 'anthropic', 1_000_000, 0, 1_000_000, 500_000],
        ]);
      expect(round(rows[0].costUsd)).toBe(14.2);
      expect(round(rows[1].costUsd)).toBe(7.5);
      expect(rows[0].fallbacks).toBeNull();
      expect(rows[1].fallbacks).toEqual([{ model: 'claude-opus-5-5', error: 'rate limited' }]);
      expect(rows[0].startedAt).toBeInstanceOf(Date);
      const run = runRow(id);
      expect(round(run.costUsd)).toBe(21.7);
      expect(run.turns).toBe(2);
      expect(run.toolCalls).toBe(3);
      expect(run.inputTokens).toBe(3_000_000);
    });

    it('stores a null cost for an unpriced request and sums only the priced ones', () => {
      const id = startRun();
      logger.endCall(id, 'success', {
        inputTokens: 2, outputTokens: 0,
        requests: [
          { model: 'mystery-model', inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          { model: 'claude-sonnet-5-5', inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        ],
      });
      const rows = requestRows(id);
      expect(rows[0].costUsd).toBeNull();
      expect(round(rows[1].costUsd)).toBe(2);
      expect(round(runRow(id).costUsd)).toBe(2);
    });

    it('leaves the run cost null when no request has a known price', () => {
      const id = startRun();
      logger.endCall(id, 'success', {
        inputTokens: 10, outputTokens: 5,
        requests: [{ inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }],
      });
      expect(requestRows(id)).toHaveLength(1);
      expect(requestRows(id)[0].model).toBeNull();
      expect(runRow(id).costUsd).toBeNull();
    });

    it('leaves the run cost null when there were no requests', () => {
      const id = startRun();
      logger.endCall(id, 'error', { inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0, requests: [] }, 'boom');
      expect(requestRows(id)).toHaveLength(0);
      const run = runRow(id);
      expect(run.costUsd).toBeNull();
      expect(run.turns).toBe(0);
      expect(run.toolCalls).toBe(0);
    });

    it('prices with the ai_model_prices setting when it covers the model', () => {
      db.insert(schema.settings).values({
        key: 'ai_model_prices',
        value: JSON.stringify({ 'local-llm': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
      }).run();
      const id = startRun();
      logger.endCall(id, 'success', {
        inputTokens: 1_000_000, outputTokens: 1_000_000,
        requests: [{ model: 'local-llm', providerType: 'ollama', inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 }],
      });
      expect(round(requestRows(id)[0].costUsd)).toBe(3);
      expect(round(runRow(id).costUsd)).toBe(3);
    });

    it('ignores a malformed ai_model_prices setting and still records the run', () => {
      db.insert(schema.settings).values({ key: 'ai_model_prices', value: '{not json' }).run();
      const id = startRun();
      logger.endCall(id, 'success', {
        inputTokens: 1_000_000, outputTokens: 0,
        requests: [{ model: 'claude-sonnet-5-5', inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }],
      });
      expect(round(runRow(id).costUsd)).toBe(2);
    });
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
