import { describe, it, expect, beforeEach } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { formatWhatIf, loadWhatIfRuns, simulateCacheTtl, type WhatIfRequest, type WhatIfRun } from './ai-cache-ttl-whatif';

const M = 1_000_000;
const MIN = 60_000;
// A model priced so the arithmetic is easy: input 10, cache read 1, 5-minute write 12.5, so a 1-hour write is 20.
const PRICES = { 'test-model': { input: 10, output: 0, cacheRead: 1, cacheWrite: 12.5 } };

const req = (atMinute: number, inputTokens: number, model: string | null = 'test-model'): WhatIfRequest => ({
  startedAtMs: atMinute * MIN, model, inputTokens,
});
const run = (id: number, purpose: string, atMinute: number, requests: WhatIfRequest[], key = 'user|1|dashboard|'): WhatIfRun => ({
  id, startedAtMs: atMinute * MIN, conversationKey: key, purpose, requests,
});
const only = (runs: WhatIfRun[]) => {
  const report = simulateCacheTtl(runs, PRICES);
  expect(report.rows).toHaveLength(1);
  return report.rows[0];
};

describe('simulateCacheTtl', () => {
  it('prices a conversation whose requests are close together: both lifetimes read, and the 1-hour cold write costs more', () => {
    const row = only([run(1, 'apk-analysis', 0, [req(0, 1 * M), req(1, 1.2 * M), req(2, 1.5 * M)])]);
    // 5 minutes: 12.5 cold, then read 1.0 + write 0.2 at 12.5 = 3.5, then read 1.2 + write 0.3 at 12.5 = 4.95
    expect(row.fiveMinuteUsd).toBeCloseTo(20.95, 6);
    // 1 hour: 20 cold, then 1.0 + 0.2 at 20 = 5, then 1.2 + 0.3 at 20 = 7.2
    expect(row.oneHourUsd).toBeCloseTo(32.2, 6);
    expect(row.oneHourSavingUsd).toBeCloseTo(-11.25, 6);
    expect(row.recommendation).toBe('5m');
    expect([row.requests, row.followUps, row.pastFiveMinutes, row.pastOneHour]).toEqual([3, 2, 0, 0]);
  });

  it('prefers the 1-hour cache for a chat that continues after twenty minutes', () => {
    const row = only([
      run(1, 'chat', 0, [req(0, 1 * M)]),
      run(2, 'chat', 20, [req(20, 1.1 * M)]),
    ]);
    // 5 minutes: 12.5 cold, then the second prompt is a miss and is written whole: 1.1 * 12.5 = 13.75
    expect(row.fiveMinuteUsd).toBeCloseTo(26.25, 6);
    // 1 hour: 20 cold, then read 1.0 + write 0.1 at 20 = 3
    expect(row.oneHourUsd).toBeCloseTo(23, 6);
    expect(row.oneHourSavingUsd).toBeCloseTo(3.25, 6);
    expect(row.recommendation).toBe('1h');
    expect([row.followUps, row.pastFiveMinutes, row.pastOneHour]).toEqual([1, 1, 0]);
    expect(row.gapP50Seconds).toBe(1200);
  });

  it('counts a gap just under five minutes as a hit and just over as a miss, for the 5-minute lifetime', () => {
    const near = only([run(1, 'apk-analysis', 0, [req(0, 1 * M), req(4, 1 * M)])]);
    const far = only([run(1, 'apk-analysis', 0, [req(0, 1 * M), req(6, 1 * M)])]);
    expect(near.fiveMinuteUsd).toBeCloseTo(12.5 + 1, 6);       // cold write, then read the whole prompt
    expect(far.fiveMinuteUsd).toBeCloseTo(12.5 + 12.5, 6);     // cold write, then write it again
    expect(far.oneHourUsd).toBeCloseTo(20 + 1, 6);             // still inside the hour
  });

  it('treats a gap over an hour as a miss under both lifetimes', () => {
    const row = only([run(1, 'chat', 0, [req(0, 1 * M), req(90, 1 * M)])]);
    expect(row.fiveMinuteUsd).toBeCloseTo(25, 6);
    expect(row.oneHourUsd).toBeCloseTo(40, 6);
    expect(row.pastOneHour).toBe(1);
    expect(row.recommendation).toBe('5m');
  });

  it('never reads more than the earlier prompt held, even when a later prompt is shorter', () => {
    const row = only([run(1, 'apk-analysis', 0, [req(0, 2 * M), req(1, 1 * M)])]);
    // second request after a compaction: it reads at most its own 1.0 and writes nothing
    expect(row.fiveMinuteUsd).toBeCloseTo(2 * 12.5 + 1, 6);
  });

  describe('which requests share a cache', () => {
    it('chains chat runs of one user on one page when the later run starts with a longer prompt than the earlier one ended with', () => {
      const row = only([
        run(1, 'chat', 0, [req(0, 1 * M), req(1, 1.2 * M)]),
        run(2, 'chat', 30, [req(30, 1.5 * M)]),
      ]);
      expect(row.followUps).toBe(2);
      expect(row.pastFiveMinutes).toBe(1);
    });

    it('starts a new conversation when a chat run starts with a shorter prompt than the last one ended with', () => {
      const row = only([
        run(1, 'chat', 0, [req(0, 1 * M), req(1, 3 * M)]),
        run(2, 'chat', 30, [req(30, 0.1 * M)]),
      ]);
      expect(row.followUps).toBe(1);
      expect(row.pastFiveMinutes).toBe(0);
    });

    it('does not chain chat runs of different users, pages or contexts', () => {
      const row = only([
        run(1, 'chat', 0, [req(0, 1 * M)], 'user|1|dashboard|'),
        run(2, 'chat', 30, [req(30, 2 * M)], 'user|2|dashboard|'),
        run(3, 'chat', 60, [req(60, 3 * M)], 'user|1|traffic|'),
        run(4, 'chat', 90, [req(90, 4 * M)], 'user|1|dashboard|7'),
      ]);
      expect(row.followUps).toBe(0);
    });

    it('never chains the runs of an analysis, a diff or a plugin, which each start their own conversation', () => {
      const report = simulateCacheTtl([
        run(1, 'apk-analysis', 0, [req(0, 1 * M)], 'core-service|0|apk-analysis|42'),
        run(2, 'apk-analysis', 10, [req(10, 2 * M)], 'core-service|0|apk-analysis|42'),
        run(3, 'plugin:acme', 0, [req(0, 1 * M)], 'plugin|0||'),
        run(4, 'plugin:acme', 10, [req(10, 2 * M)], 'plugin|0||'),
      ], PRICES);
      expect(report.total.followUps).toBe(0);
    });

    it('keeps a separate cache per model: a request on a new model has nothing to read', () => {
      const row = only([run(1, 'chat', 0, [req(0, 1 * M, 'test-model'), req(1, 1 * M, 'test-model'), req(2, 1 * M, 'test-model')])]);
      const mixed = simulateCacheTtl(
        [run(1, 'chat', 0, [req(0, 1 * M, 'test-model'), req(1, 1 * M, 'test-model-b')])],
        { ...PRICES, 'test-model-b': { input: 10, output: 0, cacheRead: 1, cacheWrite: 12.5 } },
      ).rows[0];
      expect(row.followUps).toBe(2);
      expect(mixed.followUps).toBe(0);
      expect(mixed.fiveMinuteUsd).toBeCloseTo(25, 6);
    });

    it('sorts the requests of a run by start time before pairing them', () => {
      const row = only([run(1, 'apk-analysis', 0, [req(2, 1.5 * M), req(0, 1 * M), req(1, 1.2 * M)])]);
      expect(row.fiveMinuteUsd).toBeCloseTo(20.95, 6);
    });
  });

  describe('prices', () => {
    it('leaves a request with no known price out of both costs but still counts it and its gap', () => {
      const row = only([run(1, 'chat', 0, [req(0, 1 * M, 'no-such-model'), req(30, 1 * M, 'no-such-model')])]);
      expect(row.unpricedRequests).toBe(2);
      expect(row.fiveMinuteUsd).toBe(0);
      expect(row.oneHourUsd).toBe(0);
      expect(row.followUps).toBe(1);
      expect(row.pastFiveMinutes).toBe(1);
    });

    it('treats a request with no recorded model as unpriced', () => {
      const row = only([run(1, 'chat', 0, [req(0, 1 * M, null)])]);
      expect(row.unpricedRequests).toBe(1);
    });

    it('uses the higher rates of a model that charges more for a long prompt', () => {
      // Haiku 5.5, 200,000-token prompt: long-prompt input 0.5 and 5-minute write 0.625 per million; 1 hour is 2 x 0.5.
      const row = simulateCacheTtl([run(1, 'chat', 0, [req(0, 200_000, 'claude-haiku-5-5')])]).rows[0];
      expect(row.fiveMinuteUsd).toBeCloseTo(0.125, 9);
      expect(row.oneHourUsd).toBeCloseTo(0.2, 9);
    });
  });

  describe('report shape', () => {
    it('reports the median and 90th percentile gap in seconds', () => {
      const row = only([run(1, 'apk-analysis', 0, [req(0, 1 * M), req(1, 1 * M), req(3, 1 * M), req(10, 1 * M)])]);
      expect(row.gapP50Seconds).toBe(120);
      expect(row.gapP90Seconds).toBe(420);
    });

    it('has no gaps when nothing follows anything', () => {
      const row = only([run(1, 'chat', 0, [req(0, 1 * M)])]);
      expect(row.gapP50Seconds).toBeNull();
      expect(row.gapP90Seconds).toBeNull();
    });

    it('lists purposes by 5-minute cost, most expensive first, and totals them', () => {
      const report = simulateCacheTtl([
        run(1, 'chat', 0, [req(0, 1 * M)]),
        run(2, 'apk-analysis', 0, [req(0, 3 * M)], 'core-service|0|apk-analysis|1'),
      ], PRICES);
      expect(report.rows.map((r) => r.purpose)).toEqual(['apk-analysis', 'chat']);
      expect(report.total.requests).toBe(2);
      expect(report.total.fiveMinuteUsd).toBeCloseTo(12.5 + 37.5, 6);
      expect(report.total.oneHourUsd).toBeCloseTo(20 + 60, 6);
      expect(report.total.oneHourSavingUsd).toBeCloseTo(-30, 6);
    });

    it('ignores a run with no requests and returns an empty report for no runs', () => {
      expect(simulateCacheTtl([run(1, 'chat', 0, [])], PRICES).rows).toEqual([]);
      expect(simulateCacheTtl([], PRICES)).toEqual({
        rows: [],
        total: { requests: 0, followUps: 0, fiveMinuteUsd: 0, oneHourUsd: 0, oneHourSavingUsd: 0, unpricedRequests: 0 },
      });
    });
  });
});

describe('formatWhatIf', () => {
  const report = () => simulateCacheTtl([
    run(1, 'chat', 0, [req(0, 1 * M)]),
    run(2, 'chat', 20, [req(20, 1.1 * M)]),
    run(3, 'apk-analysis', 0, [req(0, 1 * M), req(1, 1.2 * M), req(2, 1.5 * M)], 'core-service|0|apk-analysis|1'),
  ], PRICES);

  it('says what the figures cover and how far back they reach', () => {
    const text = formatWhatIf(report(), { days: 30 });
    expect(text).toContain('last 30 days');
    expect(text).toContain('prompt tokens only');
  });

  it('prints one row per purpose with its counts, gaps, both costs, the saving and the verdict', () => {
    const lines = formatWhatIf(report(), { days: 30 }).split('\n');
    const row = (purpose: string) => lines.find((l) => l.startsWith(purpose + ' '))!;
    expect(row('chat').split(/\s{2,}/).map((c) => c.trim())).toEqual(
      ['chat', '2', '1', '1', '0', '20m 00s', '20m 00s', '$26.25', '$23.00', '$3.25', '1h'],
    );
    expect(row('apk-analysis').split(/\s{2,}/).map((c) => c.trim())).toEqual(
      ['apk-analysis', '3', '2', '0', '0', '1m 00s', '1m 00s', '$20.95', '$32.20', '-$11.25', '5m'],
    );
  });

  it('ends with a total row', () => {
    const lines = formatWhatIf(report(), { days: 30 }).split('\n').filter(Boolean);
    expect(lines.find((l) => l.startsWith('total'))!.split(/\s{2,}/).map((c) => c.trim()).slice(0, 2)).toEqual(['total', '5']);
  });

  it('shows a dash where there are no gaps', () => {
    const text = formatWhatIf(simulateCacheTtl([run(1, 'chat', 0, [req(0, 1 * M)])], PRICES), { days: 7 });
    expect(text.split('\n').find((l) => l.startsWith('chat '))).toContain(' - ');
  });

  it('writes gaps of an hour or more as hours and minutes, and small costs with four decimals', () => {
    const text = formatWhatIf(simulateCacheTtl([run(1, 'chat', 0, [req(0, 100), req(125, 100)])], PRICES), { days: 7 });
    expect(text).toContain('2h 05m');
    // 5 minutes: two cold writes of 100 tokens at 12.5 per million; 1 hour: the same at 20; the saving is negative
    expect(text).toContain('$0.0025');
    expect(text).toContain('$0.0040');
    expect(text).toContain('-$0.0015');
  });

  it('writes costs of a cent or more with two decimals', () => {
    const text = formatWhatIf(simulateCacheTtl([run(1, 'chat', 0, [req(0, 2_000), req(125, 2_000)])], PRICES), { days: 7 });
    expect(text.split('\n').find((l) => l.startsWith('chat '))).toMatch(/\$0\.05\s+\$0\.08\s+-\$0\.03\s+5m$/);
  });

  it('warns about requests it could not price', () => {
    const text = formatWhatIf(simulateCacheTtl([run(1, 'chat', 0, [req(0, 1 * M, 'no-such-model')])], PRICES), { days: 7 });
    expect(text).toContain('1 request uses a model with no known price');
  });

  it('says so when nothing was recorded', () => {
    expect(formatWhatIf(simulateCacheTtl([]), { days: 7 })).toBe('No AI requests recorded in the last 7 days.\n');
  });
});

describe('loadWhatIfRuns', () => {
  type Db = ReturnType<typeof createTestDb>;
  const NOW = new Date(2026, 9, 16, 12, 0, 0);
  let db: Db;
  let userId: number;

  function addRun(startedAt: Date, extra: Record<string, unknown>, requests: Array<{ at: Date; seq: number; model: string | null; input: number }>): number {
    const id = (db as any).insert(schema.aiCallLog).values({
      startedAt, identityType: 'user', actorUserId: userId, effectiveScopes: [], ...extra,
    }).returning({ id: schema.aiCallLog.id }).get().id as number;
    for (const r of requests) {
      (db as any).insert(schema.aiCallRequest).values({
        callId: id, seq: r.seq, startedAt: r.at, model: r.model, providerType: 'anthropic', inputTokens: r.input,
      }).run();
    }
    return id;
  }

  beforeEach(() => {
    db = createTestDb([schema.users, schema.aiCallLog, schema.aiCallRequest]);
    const now = new Date();
    userId = (db as any).insert(schema.users).values({
      username: 'alice', providerId: 'core.password', scopes: [], createdAt: now, updatedAt: now,
    }).returning({ id: schema.users.id }).get().id;
  });

  it('returns the runs of the window with their requests in order, a purpose, and a conversation key', () => {
    const t0 = new Date(NOW.getTime() - 3600_000);
    const id = addRun(t0, { pageContext: 'traffic', contextId: '7' }, [
      { at: new Date(t0.getTime() + 20_000), seq: 1, model: 'claude-opus-5-5', input: 2000 },
      { at: t0, seq: 0, model: 'claude-opus-5-5', input: 1000 },
    ]);
    const runs = loadWhatIfRuns(db as any, { days: 7, now: NOW });
    expect(runs).toEqual([{
      id,
      startedAtMs: t0.getTime(),
      conversationKey: `user|${userId}|traffic|7`,
      purpose: 'chat',
      requests: [
        { startedAtMs: t0.getTime(), model: 'claude-opus-5-5', inputTokens: 1000 },
        { startedAtMs: t0.getTime() + 20_000, model: 'claude-opus-5-5', inputTokens: 2000 },
      ],
    }]);
  });

  it('names a service run by its purpose', () => {
    const t0 = new Date(NOW.getTime() - 3600_000);
    addRun(t0, { identityType: 'core-service', onBehalfOfService: 'apk-analyzer', pageContext: 'apk-analysis', contextId: '42' }, [
      { at: t0, seq: 0, model: 'claude-opus-5-5', input: 1000 },
    ]);
    const [only] = loadWhatIfRuns(db as any, { days: 7, now: NOW });
    expect(only.purpose).toBe('apk-analysis');
  });

  it('leaves out runs older than the window and keeps a run that has no requests recorded', () => {
    const old = new Date(NOW.getTime() - 10 * 24 * 3600_000);
    const recent = new Date(NOW.getTime() - 3600_000);
    addRun(old, {}, [{ at: old, seq: 0, model: 'claude-opus-5-5', input: 1 }]);
    const keep = addRun(recent, {}, []);
    const runs = loadWhatIfRuns(db as any, { days: 7, now: NOW });
    expect(runs.map((r) => r.id)).toEqual([keep]);
    expect(runs[0].requests).toEqual([]);
  });

  it('feeds the simulation end to end', () => {
    const t0 = new Date(NOW.getTime() - 3 * 3600_000);
    addRun(t0, { pageContext: 'dashboard' }, [{ at: t0, seq: 0, model: 'claude-opus-5-5', input: 100_000 }]);
    const t1 = new Date(t0.getTime() + 20 * 60_000);
    addRun(t1, { pageContext: 'dashboard' }, [{ at: t1, seq: 0, model: 'claude-opus-5-5', input: 110_000 }]);
    const report = simulateCacheTtl(loadWhatIfRuns(db as any, { days: 7, now: NOW }));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ purpose: 'chat', requests: 2, followUps: 1, pastFiveMinutes: 1, recommendation: '1h' });
  });
});
