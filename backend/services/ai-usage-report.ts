import { asc, desc, eq, gte, sql } from 'drizzle-orm';
import { aiCallLog, aiCallRequest } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type {
  AiUsageByPurpose,
  AiUsageDay,
  AiUsageResponse,
  AiUsageRun,
  AiUsageTotals,
} from '../../shared/types/ai-usage';

/**
 * Aggregates recorded agent runs (`ai_call_log`) and their model requests (`ai_call_request`) into the
 * `GET /v1/ai/usage` report. Pure reads plus arithmetic: the only clock is the injected `now`.
 *
 * A run's tokens and cost come from its request rows. Runs recorded before per-request logging existed (or
 * runs that never got a usage event) have no request rows; they fall back to the run's own input/output token
 * columns, count zero cache tokens, and have no cost, so they are counted as unpriced.
 */

const MAX_ERROR_LENGTH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageReportOptions {
  /** Window length: runs that started at or after `now - days * 24h` are included. */
  days: number;
  /** Number of runs returned in `recentRuns`. Totals always cover the whole window. */
  limit: number;
  now: Date;
}

type IdentityType = (typeof aiCallLog.$inferSelect)['identityType'];

/** Maps a run's identity to the purpose key and label shown in the report. */
export function purposeOf(
  identityType: IdentityType | string,
  service: string | null,
  plugin: string | null,
): { purpose: string; label: string } {
  if (identityType === 'core-service' && service) {
    if (service === 'apk-analyzer') return { purpose: 'apk-analysis', label: 'APK analysis' };
    if (service === 'apk-diff-engine') return { purpose: 'apk-diff', label: 'APK diff' };
    return { purpose: `service:${service}`, label: `Service: ${service}` };
  }
  if ((identityType === 'plugin' || identityType === 'plugin-acting-for-user') && plugin) {
    return { purpose: `plugin:${plugin}`, label: `Plugin: ${plugin}` };
  }
  if (identityType === 'user') return { purpose: 'chat', label: 'Chat' };
  return { purpose: 'other', label: 'Other' };
}

/**
 * Nearest-rank percentile: the smallest value with at least `p` of the values at or below it. For two
 * values the median is the lower one. Returns null for an empty list.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

/** Local calendar date of a timestamp, `YYYY-MM-DD`, in the server's timezone. */
function localDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function parseFallbackCount(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return 0;
    }
  }
  return Array.isArray(value) ? value.length : 0;
}

/** Adds a nullable cost to a nullable running total; null only while nothing priced has been added. */
function addCost(total: number | null, cost: number | null): number | null {
  if (cost === null) return total;
  return (total ?? 0) + cost;
}

interface RunFacts {
  run: AiUsageRun;
  /** Local calendar date of `startedAt`. */
  date: string;
  unpriced: boolean;
}

interface RequestAgg {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  anyUnpriced: boolean;
  models: string[];
  fallbackRequests: number;
}

function emptyTotals(): AiUsageTotals {
  return {
    runs: 0,
    failedRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: null,
    costUsd: null,
    unpricedRuns: 0,
  };
}

function addRunToTotals(t: AiUsageTotals, f: RunFacts): void {
  t.runs += 1;
  if (f.run.outcome === 'error') t.failedRuns += 1;
  t.inputTokens += f.run.inputTokens;
  t.outputTokens += f.run.outputTokens;
  t.cacheReadTokens += f.run.cacheReadTokens;
  t.cacheWriteTokens += f.run.cacheWriteTokens;
  t.costUsd = addCost(t.costUsd, f.run.costUsd);
  if (f.unpriced) t.unpricedRuns += 1;
}

function finishTotals(t: AiUsageTotals): void {
  t.cacheHitRate = t.inputTokens > 0 ? t.cacheReadTokens / t.inputTokens : null;
}

export function buildUsageReport(db: AppDatabase, opts: UsageReportOptions): AiUsageResponse {
  const { days, limit, now } = opts;
  const cutoff = new Date(now.getTime() - days * DAY_MS);

  const runRows = db.select({
    id: aiCallLog.id,
    startedAt: aiCallLog.startedAt,
    endedAt: aiCallLog.endedAt,
    identityType: aiCallLog.identityType,
    service: aiCallLog.onBehalfOfService,
    plugin: aiCallLog.onBehalfOfPlugin,
    inputTokens: aiCallLog.inputTokens,
    outputTokens: aiCallLog.outputTokens,
    turns: aiCallLog.turns,
    toolCalls: aiCallLog.toolCalls,
    outcome: aiCallLog.outcome,
    error: aiCallLog.error,
  })
    .from(aiCallLog)
    .where(gte(aiCallLog.startedAt, cutoff))
    .orderBy(desc(aiCallLog.startedAt), desc(aiCallLog.id))
    .all();

  // Read fallbacks as raw text so one malformed value cannot fail the whole report.
  const requestRows = db.select({
    callId: aiCallRequest.callId,
    model: aiCallRequest.model,
    input: aiCallRequest.inputTokens,
    output: aiCallRequest.outputTokens,
    cacheRead: aiCallRequest.cacheReadTokens,
    cacheWrite: aiCallRequest.cacheWriteTokens,
    cost: aiCallRequest.costUsd,
    fallbacks: sql<string | null>`${aiCallRequest.fallbacks}`,
  })
    .from(aiCallRequest)
    .innerJoin(aiCallLog, eq(aiCallRequest.callId, aiCallLog.id))
    .where(gte(aiCallLog.startedAt, cutoff))
    .orderBy(asc(aiCallRequest.callId), asc(aiCallRequest.seq), asc(aiCallRequest.id))
    .all();

  const byRun = new Map<number, RequestAgg>();
  for (const r of requestRows) {
    let agg = byRun.get(r.callId);
    if (!agg) {
      agg = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, anyUnpriced: false,
        models: [], fallbackRequests: 0,
      };
      byRun.set(r.callId, agg);
    }
    agg.input += r.input ?? 0;
    agg.output += r.output ?? 0;
    agg.cacheRead += r.cacheRead ?? 0;
    agg.cacheWrite += r.cacheWrite ?? 0;
    if (r.cost === null || r.cost === undefined) agg.anyUnpriced = true;
    else agg.cost = addCost(agg.cost, r.cost);
    if (r.model && !agg.models.includes(r.model)) agg.models.push(r.model);
    if (parseFallbackCount(r.fallbacks) > 0) agg.fallbackRequests += 1;
  }

  const facts: RunFacts[] = runRows.map(row => {
    const { purpose, label } = purposeOf(row.identityType, row.service, row.plugin);
    const agg = byRun.get(row.id);
    const startedAt = row.startedAt;
    const endedAt = row.endedAt;
    const run: AiUsageRun = {
      id: row.id,
      startedAt: startedAt.toISOString(),
      durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
      purpose,
      label,
      models: agg ? agg.models : [],
      turns: row.turns ?? null,
      toolCalls: row.toolCalls ?? null,
      inputTokens: agg ? agg.input : (row.inputTokens ?? 0),
      outputTokens: agg ? agg.output : (row.outputTokens ?? 0),
      cacheReadTokens: agg ? agg.cacheRead : 0,
      cacheWriteTokens: agg ? agg.cacheWrite : 0,
      costUsd: agg ? agg.cost : null,
      outcome: row.outcome ?? null,
      error: row.error === null || row.error === undefined ? null : row.error.slice(0, MAX_ERROR_LENGTH),
      fallbackRequests: agg ? agg.fallbackRequests : 0,
    };
    return { run, date: localDate(startedAt), unpriced: !agg || agg.anyUnpriced };
  });

  const totals = emptyTotals();
  const purposes = new Map<string, { totals: AiUsageTotals; label: string; costs: number[]; turns: number[] }>();
  const dayBuckets = new Map<string, AiUsageDay>();

  for (const f of facts) {
    addRunToTotals(totals, f);

    let p = purposes.get(f.run.purpose);
    if (!p) {
      p = { totals: emptyTotals(), label: f.run.label, costs: [], turns: [] };
      purposes.set(f.run.purpose, p);
    }
    addRunToTotals(p.totals, f);
    if (f.run.costUsd !== null) p.costs.push(f.run.costUsd);
    if (f.run.turns !== null) p.turns.push(f.run.turns);

    const key = `${f.date}\u0000${f.run.purpose}`;
    let d = dayBuckets.get(key);
    if (!d) {
      d = { date: f.date, purpose: f.run.purpose, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
      dayBuckets.set(key, d);
    }
    d.runs += 1;
    d.inputTokens += f.run.inputTokens;
    d.outputTokens += f.run.outputTokens;
    d.costUsd = addCost(d.costUsd, f.run.costUsd);
  }
  finishTotals(totals);

  const byPurpose: AiUsageByPurpose[] = [...purposes.entries()].map(([purpose, p]) => {
    finishTotals(p.totals);
    return {
      ...p.totals,
      purpose,
      label: p.label,
      medianCostUsd: percentile(p.costs, 0.5),
      p90CostUsd: percentile(p.costs, 0.9),
      medianTurns: percentile(p.turns, 0.5),
    };
  });
  byPurpose.sort((a, b) => {
    if (a.costUsd !== b.costUsd) {
      if (a.costUsd === null) return 1;
      if (b.costUsd === null) return -1;
      return b.costUsd - a.costUsd;
    }
    if (a.runs !== b.runs) return b.runs - a.runs;
    return a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : 0;
  });

  const byDay = [...dayBuckets.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : 0;
  });

  return {
    days,
    generatedAt: now.toISOString(),
    totals,
    byPurpose,
    byDay,
    recentRuns: facts.slice(0, limit).map(f => f.run),
  };
}
