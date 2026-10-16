import { asc, eq, gte } from 'drizzle-orm';
import { aiCallLog, aiCallRequest } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { priceFor, type ModelPrice } from '../../shared/lib/ai-model-pricing';
import { percentile, purposeOf } from './ai-usage-report';

/**
 * What a 1-hour prompt cache would have cost next to the 5-minute one, replayed over recorded requests.
 *
 * The cache lifetime runs from the start of the request that last wrote or read an entry, so a request hits
 * when it starts no later than the lifetime after the start of the request before it in the same conversation.
 * A hit reads the earlier prompt at the cache-read rate and writes only the tokens added since; a miss writes the
 * whole prompt. The 1-hour write costs twice the input rate and the 5-minute write 1.25 times, so the longer
 * lifetime only pays where gaps between requests run past five minutes. Output tokens cost the same either way
 * and are left out, so the figures compare the two lifetimes and are not a bill.
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The 1-hour cache write is billed at this multiple of the input rate. */
const ONE_HOUR_WRITE_MULTIPLE = 2;

export interface WhatIfRequest {
  startedAtMs: number;
  model: string | null;
  /** Total prompt tokens of the request, including cache reads and writes. */
  inputTokens: number;
}

export interface WhatIfRun {
  id: number;
  startedAtMs: number;
  /** Runs of one chat user on one page and context share a key. */
  conversationKey: string;
  purpose: string;
  requests: WhatIfRequest[];
}

export interface TtlWhatIfRow {
  purpose: string;
  requests: number;
  /** Requests that had an earlier request in the same conversation to read from. */
  followUps: number;
  /** Follow-ups that started more than five minutes after the request before them. */
  pastFiveMinutes: number;
  /** Follow-ups that started more than an hour after it. */
  pastOneHour: number;
  gapP50Seconds: number | null;
  gapP90Seconds: number | null;
  fiveMinuteUsd: number;
  oneHourUsd: number;
  /** Positive when the 1-hour cache would have been cheaper. */
  oneHourSavingUsd: number;
  /** Requests whose model has no known price; they are left out of both costs. */
  unpricedRequests: number;
  recommendation: '1h' | '5m';
}

export interface TtlWhatIfReport {
  rows: TtlWhatIfRow[];
  total: Pick<TtlWhatIfRow, 'requests' | 'followUps' | 'fiveMinuteUsd' | 'oneHourUsd' | 'oneHourSavingUsd' | 'unpricedRequests'>;
}

/** Rates for a request whose prompt has this many tokens (a model can charge more for a long prompt). */
function ratesFor(price: ModelPrice, inputTokens: number) {
  const tier = price.longPrompt && inputTokens > price.longPrompt.thresholdTokens ? price.longPrompt : price;
  return { cacheRead: tier.cacheRead, write5m: tier.cacheWrite5m, write1h: tier.input * ONE_HOUR_WRITE_MULTIPLE };
}

/** Cost in USD of one request's prompt under a cache lifetime. `previous` is null for the first request. */
function promptCost(req: WhatIfRequest, previous: WhatIfRequest | null, price: ModelPrice, lifetimeMs: number, oneHour: boolean): number {
  const rates = ratesFor(price, req.inputTokens);
  const write = oneHour ? rates.write1h : rates.write5m;
  const input = Math.max(0, req.inputTokens);
  const hit = previous !== null && req.startedAtMs - previous.startedAtMs <= lifetimeMs;
  if (!hit) return (input * write) / 1_000_000;
  const read = Math.min(input, Math.max(0, previous.inputTokens));
  return (read * rates.cacheRead + (input - read) * write) / 1_000_000;
}

interface Chain { requests: WhatIfRequest[] }

/**
 * Splits runs into conversations. A run is its own conversation unless it is a chat run that continues the
 * previous chat run of the same user, page and context: a continued chat starts with its whole history, so its
 * first prompt is longer than the last prompt of the run before it, and a new chat on the same page is not.
 */
function conversations(runs: WhatIfRun[]): Map<string, Chain[]> {
  const byPurpose = new Map<string, Chain[]>();
  const open = new Map<string, { chain: Chain; lastInput: number }>();
  const ordered = [...runs].sort((a, b) => a.startedAtMs - b.startedAtMs || a.id - b.id);
  for (const run of ordered) {
    if (run.requests.length === 0) continue;
    const requests = [...run.requests].sort((a, b) => a.startedAtMs - b.startedAtMs);
    const continuing = run.purpose === 'chat' ? open.get(run.conversationKey) : undefined;
    let chain: Chain;
    if (continuing && requests[0].inputTokens > continuing.lastInput) {
      chain = continuing.chain;
      chain.requests.push(...requests);
    } else {
      chain = { requests };
      const list = byPurpose.get(run.purpose) ?? [];
      list.push(chain);
      byPurpose.set(run.purpose, list);
    }
    if (run.purpose === 'chat') open.set(run.conversationKey, { chain, lastInput: requests[requests.length - 1].inputTokens });
  }
  return byPurpose;
}

export function simulateCacheTtl(runs: WhatIfRun[], overrides?: unknown): TtlWhatIfReport {
  const rows: TtlWhatIfRow[] = [];
  for (const [purpose, chains] of conversations(runs)) {
    let requests = 0, followUps = 0, pastFive = 0, pastHour = 0, unpriced = 0, five = 0, hour = 0;
    const gaps: number[] = [];
    for (const chain of chains) {
      // The cache is per model, so each request is compared with the last earlier request on the same model.
      const lastByModel = new Map<string, WhatIfRequest>();
      for (const req of chain.requests) {
        requests++;
        const price = priceFor(req.model, overrides);
        const previous = lastByModel.get(req.model ?? '') ?? null;
        if (previous) {
          const gap = req.startedAtMs - previous.startedAtMs;
          followUps++;
          gaps.push(gap / 1000);
          if (gap > FIVE_MINUTES_MS) pastFive++;
          if (gap > ONE_HOUR_MS) pastHour++;
        }
        lastByModel.set(req.model ?? '', req);
        if (!price) { unpriced++; continue; }
        five += promptCost(req, previous, price, FIVE_MINUTES_MS, false);
        hour += promptCost(req, previous, price, ONE_HOUR_MS, true);
      }
    }
    rows.push({
      purpose, requests, followUps, pastFiveMinutes: pastFive, pastOneHour: pastHour,
      gapP50Seconds: percentile(gaps, 0.5), gapP90Seconds: percentile(gaps, 0.9),
      fiveMinuteUsd: five, oneHourUsd: hour, oneHourSavingUsd: five - hour, unpricedRequests: unpriced,
      recommendation: five - hour > 0 ? '1h' : '5m',
    });
  }
  rows.sort((a, b) => b.fiveMinuteUsd - a.fiveMinuteUsd || a.purpose.localeCompare(b.purpose));
  const sum = (pick: (r: TtlWhatIfRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  return {
    rows,
    total: {
      requests: sum((r) => r.requests), followUps: sum((r) => r.followUps),
      fiveMinuteUsd: sum((r) => r.fiveMinuteUsd), oneHourUsd: sum((r) => r.oneHourUsd),
      oneHourSavingUsd: sum((r) => r.oneHourSavingUsd), unpricedRequests: sum((r) => r.unpricedRequests),
    },
  };
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function formatUsd(value: number): string {
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  const text = Math.abs(value).toFixed(digits);
  return value < 0 && Number(text) !== 0 ? `-$${text}` : `$${text}`;
}

/** The report as plain text for a terminal: a table with one row per purpose, then what to read from it. */
export function formatWhatIf(report: TtlWhatIfReport, opts: { days: number }): string {
  if (report.rows.length === 0) return `No AI requests recorded in the last ${opts.days} days.\n`;

  const header = ['purpose', 'requests', 'follow-ups', '>5 min', '>1 h', 'gap p50', 'gap p90', '5-minute', '1-hour', 'saving', 'use'];
  const cells = (label: string, r: Pick<TtlWhatIfRow, 'requests' | 'followUps' | 'fiveMinuteUsd' | 'oneHourUsd' | 'oneHourSavingUsd'> & Partial<TtlWhatIfRow>): string[] => [
    label, String(r.requests), String(r.followUps),
    r.pastFiveMinutes === undefined ? '' : String(r.pastFiveMinutes),
    r.pastOneHour === undefined ? '' : String(r.pastOneHour),
    r.pastFiveMinutes === undefined ? '' : formatDuration(r.gapP50Seconds ?? null),
    r.pastFiveMinutes === undefined ? '' : formatDuration(r.gapP90Seconds ?? null),
    formatUsd(r.fiveMinuteUsd), formatUsd(r.oneHourUsd), formatUsd(r.oneHourSavingUsd),
    r.recommendation ?? '',
  ];
  const table = [
    header,
    ...report.rows.map((r) => cells(r.purpose, r)),
    cells('total', report.total),
  ];
  const widths = header.map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const line = (row: string[]) => row
    .map((cell, c) => (c === 0 || c === row.length - 1 ? cell.padEnd(widths[c]) : cell.padStart(widths[c])))
    .join('  ')
    .trimEnd();

  const out = [
    `Prompt cache lifetime, 5 minutes against 1 hour, over the last ${opts.days} days of recorded AI requests.`,
    'The figures cover prompt tokens only (output costs the same either way) and are estimates from the price table.',
    '',
    line(header),
    ...table.slice(1, -1).map(line),
    line(table[table.length - 1]),
    '',
    'follow-ups: requests with an earlier request in the same conversation to read from. >5 min and >1 h count the follow-ups',
    'that started that long after the one before. use: 1h means the 1-hour cache would have cost less over this period.',
    'Runs do not record which chat they belong to, so chat runs are joined when a later run starts with a longer prompt than',
    'the earlier one ended with.',
  ];
  if (report.total.unpricedRequests > 0) {
    const n = report.total.unpricedRequests;
    out.push('', `${n} request${n === 1 ? ' uses' : 's use'} a model with no known price and ${n === 1 ? 'is' : 'are'} left out of the costs (the ai_model_prices setting adds prices).`);
  }
  return out.join('\n') + '\n';
}

/** Reads the recorded runs of the last `days` days. Pure reads; the only clock is the injected `now`. */
export function loadWhatIfRuns(db: AppDatabase, opts: { days: number; now: Date }): WhatIfRun[] {
  const cutoff = new Date(opts.now.getTime() - opts.days * DAY_MS);
  const runRows = db.select({
    id: aiCallLog.id,
    startedAt: aiCallLog.startedAt,
    identityType: aiCallLog.identityType,
    actorUserId: aiCallLog.actorUserId,
    service: aiCallLog.onBehalfOfService,
    plugin: aiCallLog.onBehalfOfPlugin,
    pageContext: aiCallLog.pageContext,
    contextId: aiCallLog.contextId,
  }).from(aiCallLog).where(gte(aiCallLog.startedAt, cutoff)).all();

  const requestRows = db.select({
    callId: aiCallRequest.callId,
    startedAt: aiCallRequest.startedAt,
    model: aiCallRequest.model,
    inputTokens: aiCallRequest.inputTokens,
  })
    .from(aiCallRequest)
    .innerJoin(aiCallLog, eq(aiCallRequest.callId, aiCallLog.id))
    .where(gte(aiCallLog.startedAt, cutoff))
    .orderBy(asc(aiCallRequest.callId), asc(aiCallRequest.seq))
    .all();

  const byRun = new Map<number, WhatIfRequest[]>();
  for (const r of requestRows) {
    const list = byRun.get(r.callId) ?? [];
    list.push({ startedAtMs: r.startedAt.getTime(), model: r.model, inputTokens: r.inputTokens });
    byRun.set(r.callId, list);
  }
  return runRows.map((row) => ({
    id: row.id,
    startedAtMs: row.startedAt.getTime(),
    conversationKey: `${row.identityType}|${row.actorUserId}|${row.pageContext ?? ''}|${row.contextId ?? ''}`,
    purpose: purposeOf(row.identityType, row.service, row.plugin).purpose,
    requests: byRun.get(row.id) ?? [],
  }));
}
