import { describe, it, expect, beforeEach } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { buildUsageReport, percentile } from './ai-usage-report';

type Db = ReturnType<typeof createTestDb>;

// A fixed local-time clock, so day bucketing does not depend on the machine's timezone.
const NOW = new Date(2026, 9, 8, 12, 0, 0);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

interface RunInput {
  startedAt: Date;
  endedAt?: Date | null;
  identityType?: 'user' | 'core-service' | 'plugin' | 'plugin-acting-for-user';
  service?: string | null;
  plugin?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  turns?: number | null;
  toolCalls?: number | null;
  outcome?: 'success' | 'error' | 'aborted' | null;
  error?: string | null;
}

interface RequestInput {
  model?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number | null;
  fallbacks?: Array<{ model: string; error: string }> | null;
}

describe('buildUsageReport', () => {
  let db: Db;
  let userId: number;

  function addRun(run: RunInput, requests: RequestInput[] = []): number {
    const id = (db as any).insert(schema.aiCallLog).values({
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      identityType: run.identityType ?? 'user',
      actorUserId: userId,
      onBehalfOfService: run.service ?? null,
      onBehalfOfPlugin: run.plugin ?? null,
      effectiveScopes: [],
      inputTokens: run.inputTokens ?? null,
      outputTokens: run.outputTokens ?? null,
      turns: run.turns ?? null,
      toolCalls: run.toolCalls ?? null,
      outcome: run.outcome ?? null,
      error: run.error ?? null,
    }).returning({ id: schema.aiCallLog.id }).get().id as number;
    requests.forEach((r, i) => {
      (db as any).insert(schema.aiCallRequest).values({
        callId: id,
        seq: i,
        startedAt: run.startedAt,
        model: r.model === undefined ? 'claude-sonnet-4-5' : r.model,
        providerType: 'anthropic',
        inputTokens: r.input ?? 0,
        outputTokens: r.output ?? 0,
        cacheReadTokens: r.cacheRead ?? 0,
        cacheWriteTokens: r.cacheWrite ?? 0,
        costUsd: r.cost === undefined ? null : r.cost,
        fallbacks: r.fallbacks ?? null,
      }).run();
    });
    return id;
  }

  function report(days = 30, limit = 50) {
    return buildUsageReport(db as any, { days, limit, now: NOW });
  }

  beforeEach(() => {
    db = createTestDb([schema.users, schema.aiCallLog, schema.aiCallRequest]);
    const now = new Date();
    userId = (db as any).insert(schema.users).values({
      username: 'alice', providerId: 'core.password', scopes: [], createdAt: now, updatedAt: now,
    }).returning({ id: schema.users.id }).get().id;
  });

  it('returns zeroed totals and empty lists for an empty database', () => {
    const r = report();
    expect(r.days).toBe(30);
    expect(r.generatedAt).toBe(NOW.toISOString());
    expect(r.totals).toEqual({
      runs: 0, failedRuns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cacheHitRate: null, costUsd: null, unpricedRuns: 0,
    });
    expect(r.byPurpose).toEqual([]);
    expect(r.byDay).toEqual([]);
    expect(r.recentRuns).toEqual([]);
  });

  it('sums a priced run from its request rows', () => {
    const started = new Date(NOW.getTime() - HOUR);
    const id = addRun(
      {
        startedAt: started, endedAt: new Date(started.getTime() + 42_000), turns: 2, toolCalls: 3,
        outcome: 'success', inputTokens: 1, outputTokens: 1,
      },
      [
        { input: 1000, output: 100, cacheRead: 0, cacheWrite: 800, cost: 0.01 },
        { input: 1200, output: 50, cacheRead: 800, cacheWrite: 0, cost: 0.005 },
      ],
    );
    const r = report();
    expect(r.totals.runs).toBe(1);
    expect(r.totals.inputTokens).toBe(2200);
    expect(r.totals.outputTokens).toBe(150);
    expect(r.totals.cacheReadTokens).toBe(800);
    expect(r.totals.cacheWriteTokens).toBe(800);
    expect(r.totals.cacheHitRate).toBeCloseTo(800 / 2200);
    expect(r.totals.costUsd).toBeCloseTo(0.015);
    expect(r.totals.unpricedRuns).toBe(0);
    expect(r.recentRuns).toHaveLength(1);
    const run = r.recentRuns[0];
    expect(run).toMatchObject({
      id, startedAt: started.toISOString(), durationMs: 42_000, purpose: 'chat', label: 'Chat',
      models: ['claude-sonnet-4-5'], turns: 2, toolCalls: 3, inputTokens: 2200, outputTokens: 150,
      cacheReadTokens: 800, cacheWriteTokens: 800, outcome: 'success', error: null, fallbackRequests: 0,
    });
    expect(run.costUsd).toBeCloseTo(0.015);
  });

  it('counts a run with any unpriced request as unpriced and keeps the priced part of its cost', () => {
    addRun({ startedAt: new Date(NOW.getTime() - HOUR) }, [
      { input: 100, cost: 0.02 },
      { input: 100, model: 'local-model', cost: null },
    ]);
    addRun({ startedAt: new Date(NOW.getTime() - 2 * HOUR) }, [{ input: 50, cost: 0.03 }]);
    const r = report();
    expect(r.totals.runs).toBe(2);
    expect(r.totals.unpricedRuns).toBe(1);
    expect(r.totals.costUsd).toBeCloseTo(0.05);
    expect(r.recentRuns[0].costUsd).toBeCloseTo(0.02);
    expect(r.recentRuns[0].models).toEqual(['claude-sonnet-4-5', 'local-model']);
  });

  it('gives a run whose requests are all unpriced a null cost', () => {
    addRun({ startedAt: new Date(NOW.getTime() - HOUR) }, [{ input: 100, model: 'local-model', cost: null }]);
    const r = report();
    expect(r.recentRuns[0].costUsd).toBeNull();
    expect(r.totals.costUsd).toBeNull();
    expect(r.totals.unpricedRuns).toBe(1);
    expect(r.byPurpose[0].costUsd).toBeNull();
    expect(r.byPurpose[0].medianCostUsd).toBeNull();
  });

  it('falls back to the call log token columns for a run without request rows', () => {
    addRun({ startedAt: new Date(NOW.getTime() - HOUR), inputTokens: 500, outputTokens: 70, outcome: 'error' });
    addRun({ startedAt: new Date(NOW.getTime() - 2 * HOUR), inputTokens: null, outputTokens: null });
    const r = report();
    expect(r.totals.inputTokens).toBe(500);
    expect(r.totals.outputTokens).toBe(70);
    expect(r.totals.cacheReadTokens).toBe(0);
    expect(r.totals.costUsd).toBeNull();
    expect(r.totals.unpricedRuns).toBe(2);
    expect(r.totals.failedRuns).toBe(1);
    expect(r.recentRuns[0]).toMatchObject({ models: [], costUsd: null, inputTokens: 500, durationMs: null });
    expect(r.recentRuns[1]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('includes a run exactly at the window start and excludes one a second earlier', () => {
    const cutoff = NOW.getTime() - 7 * DAY;
    const inside = addRun({ startedAt: new Date(cutoff) });
    addRun({ startedAt: new Date(cutoff - 1000) });
    const r = report(7);
    expect(r.days).toBe(7);
    expect(r.totals.runs).toBe(1);
    expect(r.recentRuns.map(x => x.id)).toEqual([inside]);
  });

  it('buckets days by the server-local calendar date across midnight', () => {
    addRun({ startedAt: new Date(2026, 9, 7, 23, 59, 0) }, [{ input: 10, output: 1, cost: 0.1 }]);
    addRun({ startedAt: new Date(2026, 9, 8, 0, 1, 0) }, [{ input: 20, output: 2, cost: 0.2 }]);
    addRun({ startedAt: new Date(2026, 9, 8, 0, 2, 0), identityType: 'core-service', service: 'apk-analyzer' });
    const r = report();
    expect(r.byDay).toEqual([
      { date: '2026-10-07', purpose: 'chat', runs: 1, inputTokens: 10, outputTokens: 1, costUsd: expect.closeTo(0.1) },
      { date: '2026-10-08', purpose: 'apk-analysis', runs: 1, inputTokens: 0, outputTokens: 0, costUsd: null },
      { date: '2026-10-08', purpose: 'chat', runs: 1, inputTokens: 20, outputTokens: 2, costUsd: expect.closeTo(0.2) },
    ]);
  });

  it('maps every identity type to a purpose', () => {
    const t = NOW.getTime() - HOUR;
    addRun({ startedAt: new Date(t - 1000), identityType: 'core-service', service: 'apk-analyzer' });
    addRun({ startedAt: new Date(t - 2000), identityType: 'core-service', service: 'apk-diff-engine' });
    addRun({ startedAt: new Date(t - 3000), identityType: 'core-service', service: 'map-tiler' });
    addRun({ startedAt: new Date(t - 4000), identityType: 'plugin', plugin: 'couchbase' });
    addRun({ startedAt: new Date(t - 5000), identityType: 'plugin-acting-for-user', plugin: 'couchbase' });
    addRun({ startedAt: new Date(t - 6000), identityType: 'user' });
    addRun({ startedAt: new Date(t - 7000), identityType: 'core-service', service: null });
    addRun({ startedAt: new Date(t - 8000), identityType: 'plugin', plugin: null });
    const r = report();
    expect(r.recentRuns.map(x => [x.purpose, x.label])).toEqual([
      ['apk-analysis', 'APK analysis'],
      ['apk-diff', 'APK diff'],
      ['service:map-tiler', 'Service: map-tiler'],
      ['plugin:couchbase', 'Plugin: couchbase'],
      ['plugin:couchbase', 'Plugin: couchbase'],
      ['chat', 'Chat'],
      ['other', 'Other'],
      ['other', 'Other'],
    ]);
    const couchbase = r.byPurpose.find(p => p.purpose === 'plugin:couchbase')!;
    expect(couchbase.runs).toBe(2);
    expect(couchbase.label).toBe('Plugin: couchbase');
  });

  it('sorts purposes by cost descending with unpriced purposes last, then by runs', () => {
    const t = NOW.getTime() - HOUR;
    addRun({ startedAt: new Date(t), identityType: 'user' }, [{ cost: 0.1 }]);
    addRun({ startedAt: new Date(t), identityType: 'core-service', service: 'apk-analyzer' }, [{ cost: 0.5 }]);
    addRun({ startedAt: new Date(t), identityType: 'plugin', plugin: 'a' });
    addRun({ startedAt: new Date(t), identityType: 'plugin', plugin: 'b' });
    addRun({ startedAt: new Date(t), identityType: 'plugin', plugin: 'b' });
    expect(report().byPurpose.map(p => p.purpose)).toEqual(['apk-analysis', 'chat', 'plugin:b', 'plugin:a']);
  });

  it('computes median and p90 cost and median turns per purpose', () => {
    const t = NOW.getTime() - HOUR;
    for (let i = 1; i <= 10; i++) {
      addRun({ startedAt: new Date(t - i * 1000), turns: i }, [{ cost: i / 100 }]);
    }
    // An unpriced run with no turns must not move the cost or turn percentiles.
    addRun({ startedAt: new Date(t - 20_000) }, [{ model: 'local-model', cost: null }]);
    const chat = report().byPurpose[0];
    expect(chat.runs).toBe(11);
    expect(chat.medianCostUsd).toBeCloseTo(0.05);
    expect(chat.p90CostUsd).toBeCloseTo(0.09);
    expect(chat.medianTurns).toBe(5);
    expect(chat.unpricedRuns).toBe(1);
  });

  it('handles percentile edge cases with nearest rank', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([3, 1], 0.5)).toBe(1);
    expect(percentile([3, 1], 0.9)).toBe(3);
    const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(ten, 0.5)).toBe(5);
    expect(percentile(ten, 0.9)).toBe(9);
  });

  it('gives a single priced run the same median and p90', () => {
    addRun({ startedAt: new Date(NOW.getTime() - HOUR), turns: 4 }, [{ cost: 0.25 }]);
    const chat = report().byPurpose[0];
    expect(chat.medianCostUsd).toBeCloseTo(0.25);
    expect(chat.p90CostUsd).toBeCloseTo(0.25);
    expect(chat.medianTurns).toBe(4);
  });

  it('lists recent runs newest first and honours the limit', () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(addRun({ startedAt: new Date(NOW.getTime() - (5 - i) * HOUR) }));
    const r = report(30, 3);
    expect(r.recentRuns.map(x => x.id)).toEqual([ids[4], ids[3], ids[2]]);
    // The limit only trims the run list; totals still cover the whole window.
    expect(r.totals.runs).toBe(5);
  });

  it('counts requests that were served after a fallback', () => {
    addRun({ startedAt: new Date(NOW.getTime() - HOUR) }, [
      { cost: 0.01, fallbacks: [{ model: 'claude-opus-4-1', error: 'rate limited' }] },
      { cost: 0.01, fallbacks: [] },
      { cost: 0.01, fallbacks: null },
      { cost: 0.01, model: 'claude-haiku-4-5', fallbacks: [{ model: 'a', error: 'x' }, { model: 'b', error: 'y' }] },
    ]);
    const run = report().recentRuns[0];
    expect(run.fallbackRequests).toBe(2);
    expect(run.models).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5']);
  });

  it('truncates long errors to 500 characters', () => {
    addRun({ startedAt: new Date(NOW.getTime() - HOUR), outcome: 'error', error: 'x'.repeat(2000) });
    addRun({ startedAt: new Date(NOW.getTime() - 2 * HOUR), outcome: 'error', error: 'short' });
    const r = report();
    expect(r.recentRuns[0].error).toHaveLength(500);
    expect(r.recentRuns[1].error).toBe('short');
  });
});
