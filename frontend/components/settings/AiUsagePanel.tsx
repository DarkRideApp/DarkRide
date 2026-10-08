import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { SectionCard } from './SettingsShared';
import type {
  AiUsageByPurpose, AiUsageDay, AiUsageResponse, AiUsageRun,
} from '../../../shared/types/ai-usage';

const WINDOWS = [7, 30, 90] as const;
const DEFAULT_WINDOW = 30;
/** A day with any cost at all stays at least this tall (percent), so it does not vanish next to a big day. */
const MIN_VISIBLE_BAR_PERCENT = 2;
/** Longest date range the by-day strip will fill with empty days; beyond this it only draws days that have data. */
const MAX_FILLED_DAYS = 400;

const EMPTY_MESSAGE =
  'No AI runs recorded in this window yet. Usage is recorded for chat, APK analysis, diff analysis and plugin AI runs; inline completion is not included.';

// ── Formatting ───────────────────────────────────────────────────────────

const NA = 'n/a';

/** The browser's language, so numbers and dates follow the user's locale. Read on every call so it can change. */
function userLocale(): string | undefined {
  try {
    return typeof navigator !== 'undefined' && navigator.language ? navigator.language : undefined;
  } catch {
    return undefined;
  }
}

function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(userLocale(), options).format(value);
}

function formatCount(value: number | null | undefined): string {
  return value == null ? NA : formatNumber(value);
}

function formatTurns(value: number | null | undefined): string {
  return value == null ? NA : formatNumber(value, { maximumFractionDigits: 1 });
}

function formatPercent(rate: number | null | undefined): string {
  return rate == null ? NA : formatNumber(rate, { style: 'percent', maximumFractionDigits: 1 });
}

/** Four decimals under a dollar, two from a dollar up; a nonzero amount never shows as $0.0000. */
function formatUsd(value: number | null | undefined): string {
  if (value == null) return NA;
  if (value > 0 && value < 0.00005) return '<$0.0001';
  const decimals = value >= 0.99995 || value === 0 ? 2 : 4;
  return `$${formatNumber(value, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(userLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** `YYYY-MM-DD` as a local calendar day, or null when it is not one. Built from parts so no timezone shifts it. */
function parseDay(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDay(key: string, style: 'long' | 'short'): string {
  const date = parseDay(key);
  if (!date) return key;
  const options: Intl.DateTimeFormatOptions = style === 'long'
    ? { dateStyle: 'medium' }
    : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(userLocale(), options).format(date);
}

function unpricedText(count: number): string {
  return count === 1
    ? '1 run includes a model with no known price'
    : `${count} runs include models with no known price`;
}

function runsText(count: number): string {
  return count === 1 ? '1 run' : `${count} runs`;
}

// ── Response handling ────────────────────────────────────────────────────

function isUsage(value: any): value is AiUsageResponse {
  return !!value && typeof value === 'object'
    && !!value.totals && typeof value.totals === 'object' && typeof value.totals.runs === 'number';
}

/** The usage payload, or a short reason it could not be used. Accepts the payload bare or inside `{ success, data }`. */
function readUsage(res: { status?: number; body?: any }): { data: AiUsageResponse } | { error: string } {
  const body = res?.body;
  const status = typeof res?.status === 'number' ? res.status : 200;
  if (status >= 400 || body?.success === false) {
    return { error: typeof body?.error === 'string' && body.error ? body.error : `HTTP ${status}` };
  }
  const payload = isUsage(body) ? body : isUsage(body?.data) ? body.data : null;
  if (!payload) return { error: 'Unexpected response from the server' };
  return {
    data: {
      ...payload,
      byPurpose: Array.isArray(payload.byPurpose) ? payload.byPurpose : [],
      byDay: Array.isArray(payload.byDay) ? payload.byDay : [],
      recentRuns: Array.isArray(payload.recentRuns) ? payload.recentRuns : [],
    },
  };
}

// ── By-day buckets ───────────────────────────────────────────────────────

interface DayBucket {
  date: string;
  runs: number;
  tokens: number;
  /** Sum over the day's priced purposes; null when none of them had a price. */
  costUsd: number | null;
}

/** One bucket per calendar day (purposes added up), oldest first, with quiet days between active ones filled in. */
function bucketDays(rows: AiUsageDay[]): DayBucket[] {
  const byDate = new Map<string, DayBucket>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? { date: row.date, runs: 0, tokens: 0, costUsd: null };
    bucket.runs += row.runs;
    bucket.tokens += row.inputTokens + row.outputTokens;
    if (row.costUsd != null) bucket.costUsd = (bucket.costUsd ?? 0) + row.costUsd;
    byDate.set(row.date, bucket);
  }
  const sorted = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length < 2) return sorted;

  const first = parseDay(sorted[0].date);
  const last = parseDay(sorted[sorted.length - 1].date);
  if (!first || !last) return sorted;
  const spanDays = Math.round((last.getTime() - first.getTime()) / 86_400_000);
  if (spanDays > MAX_FILLED_DAYS) return sorted;

  const filled: DayBucket[] = [];
  for (let d = new Date(first); d.getTime() <= last.getTime(); d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    filled.push(byDate.get(key) ?? { date: key, runs: 0, tokens: 0, costUsd: null });
  }
  return filled;
}

// ── Styles ───────────────────────────────────────────────────────────────

const mutedSmall: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)' };
const subHeading: React.CSSProperties = { fontSize: 12, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-primary)' };
const numberCell: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
// `cursor: default` switches off the host's sortable-header hover, these headers do not sort.
const plainHeader: React.CSSProperties = { cursor: 'default' };
const plainNumberHeader: React.CSSProperties = { cursor: 'default', textAlign: 'right', whiteSpace: 'nowrap' };

// ── Panel ────────────────────────────────────────────────────────────────

interface PanelState {
  data: AiUsageResponse | null;
  loading: boolean;
  error: string | null;
}

export function AiUsagePanel() {
  const { connected, sendRestApi } = useWebSocket();
  const [days, setDays] = useState<number>(DEFAULT_WINDOW);
  const [state, setState] = useState<PanelState>({ data: null, loading: true, error: null });
  // Each request takes a number; only the newest one may write state, so a slow reply for a
  // window the user already left cannot overwrite the current one.
  const latestRequest = useRef(0);

  const load = useCallback(async (windowDays: number) => {
    const mine = ++latestRequest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await sendRestApi('GET', `/v1/ai/usage/report?days=${windowDays}`);
      if (mine !== latestRequest.current) return;
      const result = readUsage(res);
      setState('data' in result
        ? { data: result.data, loading: false, error: null }
        : { data: null, loading: false, error: result.error });
    } catch (err: any) {
      if (mine !== latestRequest.current) return;
      setState({ data: null, loading: false, error: err?.message || 'Request failed' });
    }
  }, [sendRestApi]);

  useEffect(() => {
    if (!connected) return;
    void load(days);
    // Leaving the window (or unmounting) retires the request still in flight.
    return () => { latestRequest.current += 1; };
  }, [connected, days, load]);

  const { data, loading, error } = state;

  return (
    <SectionCard
      id="ai-usage"
      title="AI usage"
      description="Cost, tokens and cache use of recent AI runs. Costs are estimates from a price table."
    >
      <div data-testid="ai-usage-panel">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <select
            className="form-input"
            aria-label="Usage window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ fontSize: 12, padding: '1px 6px', height: 26, width: 'auto' }}
            data-testid="ai-usage-window"
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>Last {w} days</option>
            ))}
          </select>
        </div>

        {loading && (
          <div role="status" data-testid="ai-usage-loading" style={{ ...mutedSmall, padding: '4px 0 8px' }}>
            Loading AI usage...
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="ai-usage-error"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '8px 12px', borderRadius: 6, fontSize: 12,
              background: 'rgba(239,68,68,0.08)', color: 'var(--status-error, #ef4444)',
            }}
          >
            <span>Could not load AI usage: {error}</span>
            <button type="button" className="btn btn-sm" onClick={() => void load(days)}>Retry</button>
          </div>
        )}

        {data && !error && (
          <div aria-busy={loading} style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.15s' }}>
            {data.totals.runs === 0 ? (
              <div data-testid="ai-usage-empty" style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
                {EMPTY_MESSAGE}
              </div>
            ) : (
              <UsageContent data={data} />
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ── Content ──────────────────────────────────────────────────────────────

function UsageContent({ data }: { data: AiUsageResponse }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SummaryCards totals={data.totals} />
      {data.byPurpose.length > 0 && <ByPurposeTable rows={data.byPurpose} />}
      {data.byDay.length > 0 && <ByDayChart rows={data.byDay} />}
      {data.recentRuns.length > 0 && <RecentRunsTable runs={data.recentRuns} />}
    </div>
  );
}

function SummaryCards({ totals }: { totals: AiUsageResponse['totals'] }) {
  // The summary sits inside the section's own card, so these are plain tiles (the host's stat typography
  // without a second bordered card); every tile gets the same value colour instead of the first-child accent.
  const value: React.CSSProperties = { fontSize: 22, color: 'var(--text-primary)' };
  const tile: React.CSSProperties = { background: 'var(--bg-secondary)', borderRadius: 6 };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
      <div className="stat-card" style={tile} data-testid="ai-usage-total-runs">
        <div className="stat-value" style={value}>{formatCount(totals.runs)}</div>
        <div className="stat-label">Runs</div>
        <div className="stat-detail">{formatCount(totals.failedRuns)} failed</div>
      </div>
      <div className="stat-card" style={tile} data-testid="ai-usage-total-tokens">
        <div className="stat-value" style={value}>{formatCount(totals.inputTokens)}</div>
        <div className="stat-label">Tokens in</div>
        <div className="stat-detail">{formatCount(totals.outputTokens)} out</div>
      </div>
      <div className="stat-card" style={tile} data-testid="ai-usage-cache-hit-rate">
        <div className="stat-value" style={value}>{formatPercent(totals.cacheHitRate)}</div>
        <div className="stat-label">Cache hit rate</div>
        <div className="stat-detail">
          {formatCount(totals.cacheReadTokens)} read, {formatCount(totals.cacheWriteTokens)} written
        </div>
      </div>
      <div className="stat-card" style={tile} data-testid="ai-usage-cost">
        <div className="stat-value" style={value}>{formatUsd(totals.costUsd)}</div>
        <div className="stat-label">Estimated cost</div>
        <div className="stat-detail" data-testid="ai-usage-estimate-note">estimate</div>
        {totals.unpricedRuns > 0 && (
          <div className="stat-detail" data-testid="ai-usage-unpriced-note">{unpricedText(totals.unpricedRuns)}</div>
        )}
      </div>
    </div>
  );
}

function ByPurposeTable({ rows }: { rows: AiUsageByPurpose[] }) {
  return (
    <div>
      <h5 style={subHeading}>By purpose</h5>
      <div className="table-card" style={{ overflowX: 'auto' }} data-testid="ai-usage-by-purpose">
        <table className="data-table" data-density="compact">
          <thead>
            <tr>
              <th style={plainHeader}>Purpose</th>
              <th style={plainNumberHeader}>Runs</th>
              <th style={plainNumberHeader}>Est. cost</th>
              <th style={plainNumberHeader}>Median cost / run</th>
              <th style={plainNumberHeader}>P90 cost / run</th>
              <th style={plainNumberHeader}>Median turns</th>
              <th style={plainNumberHeader}>Cache hit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.purpose} data-testid={`ai-usage-purpose-${row.purpose}`}>
                <td title={row.purpose}>{row.label}</td>
                <td style={numberCell}>
                  {formatCount(row.runs)}
                  {row.failedRuns > 0 && <span style={{ ...mutedSmall, marginLeft: 6 }}>{row.failedRuns} failed</span>}
                </td>
                <td style={numberCell}>
                  {formatUsd(row.costUsd)}
                  {row.costUsd != null && row.unpricedRuns > 0 && (
                    <span title={unpricedText(row.unpricedRuns)} style={{ ...mutedSmall, marginLeft: 6 }}>partial</span>
                  )}
                </td>
                <td style={numberCell}>{formatUsd(row.medianCostUsd)}</td>
                <td style={numberCell}>{formatUsd(row.p90CostUsd)}</td>
                <td style={numberCell}>{formatTurns(row.medianTurns)}</td>
                <td style={numberCell}>{formatPercent(row.cacheHitRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ByDayChart({ rows }: { rows: AiUsageDay[] }) {
  const buckets = bucketDays(rows);
  // Cost is the point of the monitor; tokens only stand in when no day has a price at all.
  const byCost = buckets.some((b) => b.costUsd != null);
  const amount = (b: DayBucket) => (byCost ? (b.costUsd ?? 0) : b.tokens);
  const peak = buckets.reduce((max, b) => Math.max(max, amount(b)), 0);
  const caption = byCost ? 'Estimated cost per day' : 'Tokens per day';
  const peakText = byCost ? formatUsd(peak) : `${formatCount(peak)} tokens`;

  const heightPercent = (b: DayBucket): string => {
    const value = amount(b);
    if (peak <= 0 || value <= 0) return '0%';
    const percent = Math.max((value / peak) * 100, MIN_VISIBLE_BAR_PERCENT);
    return `${Math.round(percent * 10) / 10}%`;
  };

  const label = (b: DayBucket): string => {
    const date = formatDay(b.date, 'long');
    if (b.runs === 0) return `${date}: no runs`;
    const value = byCost
      ? (b.costUsd == null ? 'cost n/a' : formatUsd(b.costUsd))
      : `${formatCount(b.tokens)} tokens`;
    return `${date}: ${value}, ${runsText(b.runs)}`;
  };

  return (
    <div data-testid="ai-usage-by-day">
      <h5 style={subHeading}>By day</h5>
      <div style={{ ...mutedSmall, marginBottom: 6 }}>{caption} (busiest day {peakText})</div>
      <div
        role="group"
        aria-label={caption}
        data-testid="ai-usage-day-strip"
        style={{ display: 'flex', alignItems: 'stretch', gap: 2, height: 96, overflowX: 'auto', paddingBottom: 2 }}
      >
        {buckets.map((b) => (
          <div
            key={b.date}
            role="img"
            aria-label={label(b)}
            title={label(b)}
            data-testid="ai-usage-day-bar"
            style={{
              flex: '1 0 8px', minWidth: 8, maxWidth: 28,
              display: 'flex', alignItems: 'flex-end',
              background: 'var(--bg-secondary)', borderRadius: 2,
            }}
          >
            <div
              aria-hidden="true"
              data-testid="ai-usage-day-fill"
              style={{ width: '100%', height: heightPercent(b), background: 'var(--accent)', borderRadius: 2 }}
            />
          </div>
        ))}
      </div>
      <div style={{ ...mutedSmall, display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span>{formatDay(buckets[0].date, 'short')}</span>
        <span>{formatDay(buckets[buckets.length - 1].date, 'short')}</span>
      </div>
    </div>
  );
}

function outcomeBadgeClass(outcome: NonNullable<AiUsageRun['outcome']>): string {
  if (outcome === 'success') return 'badge-success';
  if (outcome === 'error') return 'badge-error';
  return 'badge-warning';
}

function fallbackText(requests: number): string {
  return requests === 1
    ? '1 request was served after a model was skipped or failed'
    : `${requests} requests were served after a model was skipped or failed`;
}

function RecentRunsTable({ runs }: { runs: AiUsageRun[] }) {
  return (
    <div>
      <h5 style={subHeading}>Recent runs</h5>
      <div className="table-card" style={{ overflowX: 'auto' }} data-testid="ai-usage-runs">
        <table className="data-table" data-density="compact">
          <thead>
            <tr>
              <th style={plainHeader}>Time</th>
              <th style={plainHeader}>Purpose</th>
              <th style={plainHeader}>Models</th>
              <th style={plainNumberHeader}>Turns</th>
              <th style={plainNumberHeader}>Tool calls</th>
              <th style={plainNumberHeader}>Tokens in</th>
              <th style={plainNumberHeader}>Tokens out</th>
              <th style={plainNumberHeader}>Cache read</th>
              <th style={plainNumberHeader}>Cache write</th>
              <th style={plainNumberHeader}>Est. cost</th>
              <th style={plainHeader}>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} data-testid={`ai-usage-run-${run.id}`}>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(run.startedAt)}</td>
                <td>{run.label}</td>
                <td style={{ overflowWrap: 'anywhere' }}>
                  {run.models.length > 0 ? run.models.join(', ') : NA}
                  {run.fallbackRequests > 0 && (
                    <span
                      className="badge badge-warning badge-sm"
                      data-testid="ai-usage-run-fallback"
                      title={fallbackText(run.fallbackRequests)}
                      style={{ marginLeft: 6 }}
                    >
                      fallback
                    </span>
                  )}
                </td>
                <td style={numberCell}>{formatCount(run.turns)}</td>
                <td style={numberCell}>{formatCount(run.toolCalls)}</td>
                <td style={numberCell}>{formatCount(run.inputTokens)}</td>
                <td style={numberCell}>{formatCount(run.outputTokens)}</td>
                <td style={numberCell}>{formatCount(run.cacheReadTokens)}</td>
                <td style={numberCell}>{formatCount(run.cacheWriteTokens)}</td>
                <td style={numberCell}>{formatUsd(run.costUsd)}</td>
                <td>
                  {run.outcome == null ? NA : (
                    <span
                      className={`badge badge-sm ${outcomeBadgeClass(run.outcome)}`}
                      data-testid="ai-usage-run-outcome"
                      title={run.error || undefined}
                    >
                      {run.outcome}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
