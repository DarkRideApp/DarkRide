import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type {
  AiUsageResponse, AiUsageTotals, AiUsageByPurpose, AiUsageDay, AiUsageRun,
} from '../../../../shared/types/ai-usage';
import { AiUsagePanel } from '../AiUsagePanel';
import { AISection } from '../AISection';

// ── Fixtures ─────────────────────────────────────────────────────────────

const totals = (over: Partial<AiUsageTotals> = {}): AiUsageTotals => ({
  runs: 12,
  failedRuns: 3,
  inputTokens: 1_234_567,
  outputTokens: 45_678,
  cacheReadTokens: 900_000,
  cacheWriteTokens: 120_000,
  cacheHitRate: 0.753,
  costUsd: 0.4286,
  unpricedRuns: 0,
  ...over,
});

const purpose = (over: Partial<AiUsageByPurpose> = {}): AiUsageByPurpose => ({
  ...totals(),
  purpose: 'apk-analysis',
  label: 'APK analysis',
  medianCostUsd: 0.0042,
  p90CostUsd: 0.0191,
  medianTurns: 4,
  ...over,
});

const day = (over: Partial<AiUsageDay> = {}): AiUsageDay => ({
  date: '2026-10-01',
  purpose: 'apk-analysis',
  runs: 1,
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.25,
  ...over,
});

const run = (over: Partial<AiUsageRun> = {}): AiUsageRun => ({
  id: 1,
  startedAt: '2026-10-07T10:15:00.000Z',
  durationMs: 1200,
  purpose: 'apk-analysis',
  label: 'APK analysis',
  models: ['claude-sonnet-4-5'],
  turns: 4,
  toolCalls: 7,
  inputTokens: 120_000,
  outputTokens: 3_500,
  cacheReadTokens: 90_000,
  cacheWriteTokens: 10_000,
  costUsd: 0.0421,
  outcome: 'success',
  error: null,
  fallbackRequests: 0,
  ...over,
});

const usage = (over: Partial<AiUsageResponse> = {}): AiUsageResponse => ({
  days: 30,
  generatedAt: '2026-10-08T09:00:00.000Z',
  totals: totals(),
  byPurpose: [purpose()],
  byDay: [day()],
  recentRuns: [run()],
  ...over,
});

const emptyUsage = (days = 30): AiUsageResponse => usage({
  days,
  totals: totals({ runs: 0, failedRuns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, costUsd: null }),
  byPurpose: [],
  byDay: [],
  recentRuns: [],
});

// ── Harness ──────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Promise<Reply> => Promise.resolve({ status: 200, body });

function makeWs(
  handler: (path: string) => Promise<Reply>,
  over: Partial<WebSocketContextValue> = {},
): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn((_method: string, path: string) => handler(path).then((r) => ({ type: 'restapi', id: 'u', ...r }))),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
    setOnApiError: vi.fn(),
    ...over,
  } as any;
}

function renderPanel(ws: WebSocketContextValue) {
  return render(
    <WebSocketContext.Provider value={ws}>
      <AiUsagePanel />
    </WebSocketContext.Provider>,
  );
}

const usagePaths = (ws: WebSocketContextValue) =>
  (ws.sendRestApi as any).mock.calls.filter((c: any[]) => String(c[1]).startsWith('/v1/ai/usage/report')).map((c: any[]) => c[1]);

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('AiUsagePanel: loading and window', () => {
  it('shows the AI usage heading and requests the 30 day window by default', async () => {
    const ws = makeWs(() => ok(usage()));
    renderPanel(ws);
    const panel = screen.getByTestId('ai-usage-panel');
    expect(screen.getByRole('heading', { name: 'AI usage' })).toBeInTheDocument();
    expect(panel.closest('#section-ai-usage')).not.toBeNull();
    await waitFor(() => expect(usagePaths(ws)).toEqual(['/v1/ai/usage/report?days=30']));
    expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/ai/usage/report?days=30');
    expect((screen.getByTestId('ai-usage-window') as HTMLSelectElement).value).toBe('30');
  });

  it('offers 7, 30 and 90 day windows', async () => {
    renderPanel(makeWs(() => ok(usage())));
    await screen.findByTestId('ai-usage-total-runs');
    const values = Array.from((screen.getByTestId('ai-usage-window') as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toEqual(['7', '30', '90']);
  });

  it('shows a loading message while the first request is pending', async () => {
    let release: (r: Reply) => void = () => {};
    const ws = makeWs(() => new Promise<Reply>((resolve) => { release = resolve; }));
    renderPanel(ws);
    expect(screen.getByTestId('ai-usage-loading')).toHaveTextContent(/loading/i);
    expect(screen.queryByTestId('ai-usage-total-runs')).toBeNull();
    await act(async () => { release({ status: 200, body: usage() }); });
    expect(screen.queryByTestId('ai-usage-loading')).toBeNull();
    expect(screen.getByTestId('ai-usage-total-runs')).toBeInTheDocument();
  });

  it('does not request anything until the socket is connected', async () => {
    const ws = makeWs(() => ok(usage()), { connected: false });
    renderPanel(ws);
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.sendRestApi).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-usage-loading')).toBeInTheDocument();
  });

  it('refetches with the new window when the selector changes', async () => {
    const ws = makeWs((path) => ok(usage({ days: Number(new URL(path, 'http://x').searchParams.get('days')) })));
    renderPanel(ws);
    await screen.findByTestId('ai-usage-total-runs');

    fireEvent.change(screen.getByTestId('ai-usage-window'), { target: { value: '7' } });
    await waitFor(() => expect(usagePaths(ws)).toEqual(['/v1/ai/usage/report?days=30', '/v1/ai/usage/report?days=7']));

    fireEvent.change(screen.getByTestId('ai-usage-window'), { target: { value: '90' } });
    await waitFor(() => expect(usagePaths(ws)).toEqual([
      '/v1/ai/usage/report?days=30', '/v1/ai/usage/report?days=7', '/v1/ai/usage/report?days=90',
    ]));
    expect((screen.getByTestId('ai-usage-window') as HTMLSelectElement).value).toBe('90');
  });

  it('ignores a slow response for a window the user has already left', async () => {
    const pending: Record<string, (r: Reply) => void> = {};
    const ws = makeWs((path) => new Promise<Reply>((resolve) => { pending[path] = resolve; }));
    renderPanel(ws);
    await waitFor(() => expect(pending['/v1/ai/usage/report?days=30']).toBeDefined());
    fireEvent.change(screen.getByTestId('ai-usage-window'), { target: { value: '7' } });
    await waitFor(() => expect(pending['/v1/ai/usage/report?days=7']).toBeDefined());

    await act(async () => { pending['/v1/ai/usage/report?days=7']({ status: 200, body: usage({ days: 7, totals: totals({ runs: 7 }) }) }); });
    await act(async () => { pending['/v1/ai/usage/report?days=30']({ status: 200, body: usage({ days: 30, totals: totals({ runs: 30 }) }) }); });

    expect(screen.getByTestId('ai-usage-total-runs')).toHaveTextContent('7');
    expect(screen.getByTestId('ai-usage-total-runs')).not.toHaveTextContent('30');
  });

  it('accepts the response wrapped in a success envelope', async () => {
    renderPanel(makeWs(() => ok({ success: true, data: usage() })));
    expect(await screen.findByTestId('ai-usage-total-runs')).toHaveTextContent('12');
  });
});

describe('AiUsagePanel: summary cards', () => {
  it('renders runs with the failed count, tokens, cache hit rate and estimated cost from the fixture', async () => {
    renderPanel(makeWs(() => ok(usage())));
    const runs = await screen.findByTestId('ai-usage-total-runs');
    expect(runs).toHaveTextContent('12');
    expect(runs).toHaveTextContent('3 failed');

    const tokens = screen.getByTestId('ai-usage-total-tokens');
    expect(tokens).toHaveTextContent('1,234,567');
    expect(tokens).toHaveTextContent('45,678');

    const cache = screen.getByTestId('ai-usage-cache-hit-rate');
    expect(cache).toHaveTextContent('75.3%');
    expect(cache).toHaveTextContent('900,000');
    expect(cache).toHaveTextContent('120,000');

    expect(screen.getByTestId('ai-usage-cost')).toHaveTextContent('$0.4286');
  });

  it('shows n/a for a null cache hit rate and a null cost', async () => {
    renderPanel(makeWs(() => ok(usage({ totals: totals({ cacheHitRate: null, costUsd: null, unpricedRuns: 12 }) }))));
    expect(await screen.findByTestId('ai-usage-cache-hit-rate')).toHaveTextContent('n/a');
    expect(screen.getByTestId('ai-usage-cost')).toHaveTextContent('n/a');
    expect(screen.getByTestId('ai-usage-cost')).not.toHaveTextContent('$');
  });

  it('labels the cost an estimate, and notes unpriced runs only when there are some', async () => {
    renderPanel(makeWs(() => ok(usage({ totals: totals({ unpricedRuns: 2 }) }))));
    const cost = await screen.findByTestId('ai-usage-cost');
    expect(cost).toHaveTextContent(/estimate/i);
    expect(cost).toHaveTextContent('2 runs include models with no known price');
  });

  it('words the unpriced note correctly for a single run', async () => {
    renderPanel(makeWs(() => ok(usage({ totals: totals({ unpricedRuns: 1 }) }))));
    expect(await screen.findByTestId('ai-usage-cost')).toHaveTextContent('1 run includes a model with no known price');
  });

  it('shows no unpriced note when every run was priced, but still says estimate', async () => {
    renderPanel(makeWs(() => ok(usage({ totals: totals({ unpricedRuns: 0 }) }))));
    const cost = await screen.findByTestId('ai-usage-cost');
    expect(cost).toHaveTextContent(/estimate/i);
    expect(cost).not.toHaveTextContent(/no known price/i);
  });

  it('formats money by size: four decimals under a dollar, two above, and never a misleading zero', async () => {
    const rows = [
      purpose({ purpose: 'a', label: 'Small', costUsd: 0.0042, medianCostUsd: 0.00001, p90CostUsd: 0 }),
      purpose({ purpose: 'b', label: 'Medium', costUsd: 12.3456, medianCostUsd: 0.9999, p90CostUsd: 1 }),
      purpose({ purpose: 'c', label: 'Large', costUsd: 1234.5, medianCostUsd: null, p90CostUsd: null }),
    ];
    renderPanel(makeWs(() => ok(usage({ byPurpose: rows }))));
    const table = await screen.findByTestId('ai-usage-by-purpose');
    const money = (key: string) => within(within(table).getByTestId(`ai-usage-purpose-${key}`))
      .getAllByRole('cell').slice(2, 5).map((c) => c.textContent);
    expect(money('a')).toEqual(['$0.0042', '<$0.0001', '$0.00']);
    expect(money('b')).toEqual(['$12.35', '$0.9999', '$1.00']);
    expect(money('c')).toEqual(['$1,234.50', 'n/a', 'n/a']);
  });

  it('does not round a sub-dollar amount up to a four decimal $1.0000', async () => {
    const rows = [purpose({ purpose: 'a', label: 'Edge', costUsd: 0.999961 })];
    renderPanel(makeWs(() => ok(usage({ byPurpose: rows }))));
    const row = await screen.findByTestId('ai-usage-purpose-a');
    expect(within(row).getAllByRole('cell')[2].textContent).toBe('$1.00');
  });

  it('follows the browser locale for number grouping', async () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('de-DE');
    renderPanel(makeWs(() => ok(usage())));
    expect(await screen.findByTestId('ai-usage-total-tokens')).toHaveTextContent('1.234.567');
  });
});

describe('AiUsagePanel: by purpose', () => {
  it('lists label, runs, cost, median and p90 cost per run, median turns and cache hit rate', async () => {
    const rows = [
      purpose({
        purpose: 'apk-analysis', label: 'APK analysis', runs: 8, failedRuns: 1, costUsd: 0.31,
        medianCostUsd: 0.0042, p90CostUsd: 0.0191, medianTurns: 4.5, cacheHitRate: 0.8,
      }),
      purpose({
        purpose: 'chat', label: 'Chat', runs: 4, failedRuns: 0, costUsd: null,
        medianCostUsd: null, p90CostUsd: null, medianTurns: null, cacheHitRate: null, unpricedRuns: 4,
      }),
    ];
    renderPanel(makeWs(() => ok(usage({ byPurpose: rows }))));
    const table = await screen.findByTestId('ai-usage-by-purpose');

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      'Purpose', 'Runs', 'Est. cost', 'Median cost / run', 'P90 cost / run', 'Median turns', 'Cache hit',
    ]);

    const apk = within(table).getByTestId('ai-usage-purpose-apk-analysis');
    expect(within(apk).getByText('APK analysis')).toBeInTheDocument();
    const apkCells = within(apk).getAllByRole('cell').map((c) => c.textContent);
    expect(apkCells[1]).toContain('8');
    expect(apkCells[1]).toContain('1 failed');
    expect(apkCells[2]).toContain('$0.3100');
    expect(apkCells[3]).toBe('$0.0042');
    expect(apkCells[4]).toBe('$0.0191');
    expect(apkCells[5]).toBe('4.5');
    expect(apkCells[6]).toBe('80%');

    const chat = within(table).getByTestId('ai-usage-purpose-chat');
    const chatCells = within(chat).getAllByRole('cell').map((c) => c.textContent);
    expect(chatCells.slice(2)).toEqual(['n/a', 'n/a', 'n/a', 'n/a', 'n/a']);
  });

  it('marks a purpose cost as partial when some of its runs have no known price', async () => {
    const rows = [purpose({ purpose: 'chat', label: 'Chat', costUsd: 0.05, unpricedRuns: 2 })];
    renderPanel(makeWs(() => ok(usage({ byPurpose: rows }))));
    const row = await screen.findByTestId('ai-usage-purpose-chat');
    expect(row).toHaveTextContent('$0.0500');
    expect(within(row).getByTitle('2 runs include models with no known price')).toBeInTheDocument();
  });
});

describe('AiUsagePanel: by day', () => {
  const bars = () => within(screen.getByTestId('ai-usage-by-day')).getAllByTestId('ai-usage-day-bar');
  const fills = () => within(screen.getByTestId('ai-usage-by-day')).getAllByTestId('ai-usage-day-fill');

  it('adds up purposes for the same date and scales bars to the most expensive day', async () => {
    const byDay = [
      day({ date: '2026-10-01', purpose: 'apk-analysis', costUsd: 0.25, runs: 2 }),
      day({ date: '2026-10-01', purpose: 'chat', costUsd: 0.25, runs: 1 }),
      day({ date: '2026-10-02', purpose: 'chat', costUsd: 0.25, runs: 1 }),
    ];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    await screen.findByTestId('ai-usage-by-day');
    expect(bars()).toHaveLength(2);
    expect(fills().map((f) => f.style.height)).toEqual(['100%', '50%']);
  });

  it('gives every bar an accessible label with the date, the value and the run count', async () => {
    const byDay = [
      day({ date: '2026-10-01', costUsd: 0.5, runs: 3 }),
      day({ date: '2026-10-02', costUsd: 0.25, runs: 1 }),
    ];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    await screen.findByTestId('ai-usage-by-day');
    const [first, second] = bars();
    expect(first).toHaveAttribute('role', 'img');
    expect(first).toHaveAttribute('aria-label', 'Oct 1, 2026: $0.5000, 3 runs');
    expect(second).toHaveAttribute('aria-label', 'Oct 2, 2026: $0.2500, 1 run');
    expect(first).toHaveAttribute('title', 'Oct 1, 2026: $0.5000, 3 runs');
  });

  it('puts days in date order and shows quiet days between active ones as empty bars', async () => {
    const byDay = [
      day({ date: '2026-10-04', costUsd: 0.5, runs: 2 }),
      day({ date: '2026-10-01', costUsd: 0.5, runs: 1 }),
    ];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    await screen.findByTestId('ai-usage-by-day');
    expect(bars().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Oct 1, 2026: $0.5000, 1 run',
      'Oct 2, 2026: no runs',
      'Oct 3, 2026: no runs',
      'Oct 4, 2026: $0.5000, 2 runs',
    ]);
    expect(fills().map((f) => f.style.height)).toEqual(['100%', '0%', '0%', '100%']);
  });

  it('draws a day with an unknown cost as an empty bar labelled n/a while other days are priced', async () => {
    const byDay = [
      day({ date: '2026-10-01', costUsd: 0.5, runs: 1 }),
      day({ date: '2026-10-02', costUsd: null, runs: 1 }),
    ];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    await screen.findByTestId('ai-usage-by-day');
    expect(bars()[1]).toHaveAttribute('aria-label', 'Oct 2, 2026: cost n/a, 1 run');
    expect(fills()[1].style.height).toBe('0%');
  });

  it('sums a partly priced day over its priced purposes', async () => {
    const byDay = [
      day({ date: '2026-10-01', purpose: 'a', costUsd: 0.25 }),
      day({ date: '2026-10-01', purpose: 'b', costUsd: null }),
    ];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    await screen.findByTestId('ai-usage-by-day');
    expect(bars()[0].getAttribute('aria-label')).toContain('$0.2500');
  });

  it('falls back to tokens when no day has a known cost', async () => {
    const byDay = [
      day({ date: '2026-10-01', costUsd: null, inputTokens: 3000, outputTokens: 1000, runs: 2 }),
      day({ date: '2026-10-02', costUsd: null, inputTokens: 1000, outputTokens: 1000, runs: 1 }),
    ];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    await screen.findByTestId('ai-usage-by-day');
    expect(bars()[0]).toHaveAttribute('aria-label', 'Oct 1, 2026: 4,000 tokens, 2 runs');
    expect(fills().map((f) => f.style.height)).toEqual(['100%', '50%']);
    expect(screen.getByTestId('ai-usage-by-day')).toHaveTextContent(/tokens per day/i);
  });

  it('shows the date once when there is only one day', async () => {
    renderPanel(makeWs(() => ok(usage({ byDay: [day({ date: '2026-10-01' })] }))));
    const chart = await screen.findByTestId('ai-usage-by-day');
    expect(bars()).toHaveLength(1);
    expect(within(chart).getAllByText('Oct 1')).toHaveLength(1);
  });

  it('labels the first and last day under the strip when there are several', async () => {
    const byDay = [day({ date: '2026-10-01' }), day({ date: '2026-10-03' })];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    const chart = await screen.findByTestId('ai-usage-by-day');
    expect(within(chart).getAllByText('Oct 1')).toHaveLength(1);
    expect(within(chart).getAllByText('Oct 3')).toHaveLength(1);
  });

  it('keeps the date labels inside the scrolling strip, so they stay under the first and last bar', async () => {
    const byDay = Array.from({ length: 30 }, (_, i) => day({ date: `2026-09-${String(i + 1).padStart(2, '0')}` }));
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    const strip = (await screen.findByTestId('ai-usage-by-day')).querySelector('[data-testid="ai-usage-day-strip"]') as HTMLElement;
    expect(within(strip).getByText('Sep 1')).toBeInTheDocument();
    expect(within(strip).getByText('Sep 30')).toBeInTheDocument();
  });

  it('shrinks the strip to its bars when there are few days, and lets it fill the card when there are many', async () => {
    const widthFor = async (count: number) => {
      const byDay = Array.from({ length: count }, (_, i) => day({ date: `2026-08-${String(i + 1).padStart(2, '0')}` }));
      const { unmount } = renderPanel(makeWs(() => ok(usage({ byDay }))));
      const strip = (await screen.findByTestId('ai-usage-by-day')).querySelector('[data-testid="ai-usage-day-strip"]') as HTMLElement;
      const result = { maxWidth: parseInt(strip.style.maxWidth, 10), width: strip.style.width };
      unmount();
      return result;
    };
    const few = await widthFor(3);
    const many = await widthFor(30);
    expect(few.width).toBe('100%');
    expect(few.maxWidth).toBeLessThan(many.maxWidth);
    expect(many.maxWidth).toBeGreaterThan(400);
  });

  it('caps the width of a bar so a single day is not drawn as a wide block', async () => {
    renderPanel(makeWs(() => ok(usage())));
    await screen.findByTestId('ai-usage-by-day');
    const widest = parseInt(bars()[0].style.maxWidth, 10);
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThanOrEqual(36);
  });

  it('keeps a day with a tiny but nonzero cost visible', async () => {
    const byDay = [
      day({ date: '2026-10-01', costUsd: 1 }),
      day({ date: '2026-10-02', costUsd: 0.0001 }),
    ];
    renderPanel(makeWs(() => ok(usage({ byDay }))));
    await screen.findByTestId('ai-usage-by-day');
    expect(fills().map((f) => f.style.height)).toEqual(['100%', '2%']);
  });

  it('says what the bars measure when costs are known', async () => {
    renderPanel(makeWs(() => ok(usage())));
    expect(await screen.findByTestId('ai-usage-by-day')).toHaveTextContent(/estimated cost per day/i);
  });

  it('stays readable for 90 days: one bar per day inside a horizontally scrollable strip', async () => {
    const byDay = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(2026, 6, 11 + i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return day({ date, costUsd: 0.01 * ((i % 5) + 1) });
    });
    renderPanel(makeWs(() => ok(usage({ days: 90, byDay }))));
    const chart = await screen.findByTestId('ai-usage-by-day');
    expect(bars()).toHaveLength(90);
    const strip = within(chart).getByTestId('ai-usage-day-strip');
    expect(strip.style.overflowX).toBe('auto');
  });
});

describe('AiUsagePanel: recent runs', () => {
  it('shows time, purpose, models, cost, turns and tool calls, tokens, cache and outcome for a run, with cost right after models', async () => {
    const runs = [run({
      id: 41, label: 'APK analysis', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
      turns: 4, toolCalls: 7, inputTokens: 120_000, outputTokens: 3_500,
      cacheReadTokens: 90_000, cacheWriteTokens: 10_000, costUsd: 0.0421, outcome: 'success',
    })];
    renderPanel(makeWs(() => ok(usage({ recentRuns: runs }))));
    const table = await screen.findByTestId('ai-usage-runs');

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      'Time', 'Purpose', 'Models', 'Est. cost', 'Turns / tools', 'Tokens in / out', 'Cache read / written', 'Outcome',
    ]);

    const when = new Date('2026-10-07T10:15:00.000Z');
    const expectedDate = when.toLocaleDateString('en-US', { dateStyle: 'medium' });
    const expectedTime = when.toLocaleTimeString('en-US', { timeStyle: 'short' });
    const cellElements = within(within(table).getByTestId('ai-usage-run-41')).getAllByRole('cell');
    const cells = cellElements.map((c) => c.textContent);
    expect(cells[0]).toContain(expectedDate);
    expect(cells[0]).toContain(expectedTime);
    expect(cellElements[0]).toHaveAttribute('title', when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }));
    expect(cells[1]).toBe('APK analysis');
    expect(cells[2]).toBe('claude-sonnet-4-5, claude-haiku-4-5');
    expect(cells[3]).toBe('$0.0421');
    expect(cells[4]).toBe('4 / 7');
    expect(cells[5]).toBe('120,000 / 3,500');
    expect(cells[6]).toBe('90,000 / 10,000');
    expect(cells[7]).toBe('success');
    expect(cells).toHaveLength(8);
  });

  it('explains the merged column headers in their tooltips', async () => {
    renderPanel(makeWs(() => ok(usage())));
    const table = await screen.findByTestId('ai-usage-runs');
    expect(within(table).getByRole('columnheader', { name: 'Turns / tools' })).toHaveAttribute('title', 'Model turns / tool calls');
    expect(within(table).getByRole('columnheader', { name: 'Tokens in / out' })).toHaveAttribute('title', 'Tokens sent / tokens received');
    expect(within(table).getByRole('columnheader', { name: 'Cache read / written' })).toHaveAttribute('title', 'Tokens read from the cache / tokens written to the cache');
  });

  it('shows n/a for a run recorded before turns, tool calls or cost were tracked', async () => {
    const runs = [run({ id: 5, turns: null, toolCalls: null, costUsd: null, outcome: null, models: [] })];
    renderPanel(makeWs(() => ok(usage({ recentRuns: runs }))));
    const cells = within(await screen.findByTestId('ai-usage-run-5')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[2]).toBe('n/a');
    expect(cells[3]).toBe('n/a');
    expect(cells[4]).toBe('n/a');
    expect(cells[7]).toBe('n/a');
  });

  it('shows what is known when only one of turns and tool calls was recorded', async () => {
    const runs = [run({ id: 6, turns: 3, toolCalls: null })];
    renderPanel(makeWs(() => ok(usage({ recentRuns: runs }))));
    const cells = within(await screen.findByTestId('ai-usage-run-6')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[4]).toBe('3 / n/a');
  });

  it('keeps the model list on one line with the full list in a tooltip, and the fallback marker unbroken', async () => {
    const runs = [
      run({ id: 11, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'], fallbackRequests: 2 }),
      run({ id: 12, models: [] }),
    ];
    renderPanel(makeWs(() => ok(usage({ recentRuns: runs }))));
    const row = await screen.findByTestId('ai-usage-run-11');
    const list = within(row).getByText('claude-sonnet-4-5, claude-haiku-4-5');
    expect(list).toHaveAttribute('title', 'claude-sonnet-4-5, claude-haiku-4-5');
    expect(list.style.whiteSpace).toBe('nowrap');
    expect(list.style.textOverflow).toBe('ellipsis');
    expect(list.style.overflow).toBe('hidden');
    expect(within(row).getByTestId('ai-usage-run-fallback').style.whiteSpace).toBe('nowrap');
    // A run with no recorded models has nothing to put in a tooltip.
    expect(within(within(screen.getByTestId('ai-usage-run-12')).getAllByRole('cell')[2]).queryByTitle(/./)).toBeNull();
  });

  it('marks only the runs that were served after a fallback', async () => {
    const runs = [
      run({ id: 1, fallbackRequests: 0 }),
      run({ id: 2, fallbackRequests: 3 }),
    ];
    renderPanel(makeWs(() => ok(usage({ recentRuns: runs }))));
    await screen.findByTestId('ai-usage-runs');
    expect(within(screen.getByTestId('ai-usage-run-1')).queryByText('fallback')).toBeNull();
    const marker = within(screen.getByTestId('ai-usage-run-2')).getByText('fallback');
    expect(marker).toHaveAttribute('title', '3 requests were served after a model was skipped or failed');
  });

  it('uses singular wording in the fallback tooltip for one request', async () => {
    renderPanel(makeWs(() => ok(usage({ recentRuns: [run({ id: 9, fallbackRequests: 1 })] }))));
    const marker = await within(await screen.findByTestId('ai-usage-run-9')).findByText('fallback');
    expect(marker).toHaveAttribute('title', '1 request was served after a model was skipped or failed');
  });

  it('puts the error text in the outcome tooltip', async () => {
    const runs = [
      run({ id: 7, outcome: 'error', error: 'Rate limit exceeded' }),
      run({ id: 8, outcome: 'aborted', error: null }),
      run({ id: 9, outcome: 'success', error: null }),
    ];
    renderPanel(makeWs(() => ok(usage({ recentRuns: runs }))));
    await screen.findByTestId('ai-usage-runs');
    const failed = within(screen.getByTestId('ai-usage-run-7')).getByTestId('ai-usage-run-outcome');
    expect(failed).toHaveTextContent('error');
    expect(failed).toHaveAttribute('title', 'Rate limit exceeded');
    const aborted = within(screen.getByTestId('ai-usage-run-8')).getByTestId('ai-usage-run-outcome');
    expect(aborted).toHaveTextContent('aborted');
    expect(aborted).not.toHaveAttribute('title');
    const fine = within(screen.getByTestId('ai-usage-run-9')).getByTestId('ai-usage-run-outcome');
    expect(fine).not.toHaveAttribute('title');
  });

  it('renders error text as text, not markup', async () => {
    const runs = [run({ id: 3, outcome: 'error', error: '<img src=x onerror=alert(1)>' })];
    renderPanel(makeWs(() => ok(usage({ recentRuns: runs }))));
    const outcome = await within(await screen.findByTestId('ai-usage-run-3')).findByTestId('ai-usage-run-outcome');
    expect(outcome).toHaveAttribute('title', '<img src=x onerror=alert(1)>');
    expect(within(screen.getByTestId('ai-usage-runs')).queryByRole('img')).toBeNull();
  });
});

describe('AiUsagePanel: empty and error states', () => {
  it('explains an empty window and keeps the window selector available', async () => {
    renderPanel(makeWs((path) => ok(emptyUsage(path.endsWith('=7') ? 7 : 30))));
    const empty = await screen.findByTestId('ai-usage-empty');
    expect(empty).toHaveTextContent(
      'No AI runs recorded in this window yet. Usage is recorded for chat, APK analysis, diff analysis and plugin AI runs; inline completion is not included.',
    );
    expect(screen.queryByTestId('ai-usage-by-purpose')).toBeNull();
    expect(screen.queryByTestId('ai-usage-runs')).toBeNull();
    expect(screen.queryByTestId('ai-usage-total-runs')).toBeNull();
    expect(screen.getByTestId('ai-usage-window')).toBeEnabled();
  });

  it('shows the error with a Retry button that reloads and recovers', async () => {
    let calls = 0;
    const ws = makeWs(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ status: 500, body: { success: false, error: 'database is locked' } }) : ok(usage());
    });
    renderPanel(ws);
    const error = await screen.findByTestId('ai-usage-error');
    expect(error).toHaveTextContent('database is locked');
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('alert')).toBe(error);
    expect(screen.queryByTestId('ai-usage-total-runs')).toBeNull();

    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('ai-usage-total-runs')).toHaveTextContent('12');
    expect(screen.queryByTestId('ai-usage-error')).toBeNull();
    expect(usagePaths(ws)).toEqual(['/v1/ai/usage/report?days=30', '/v1/ai/usage/report?days=30']);
  });

  it('shows the error when the request itself fails', async () => {
    renderPanel(makeWs(() => Promise.reject(new Error('Request timeout'))));
    expect(await screen.findByTestId('ai-usage-error')).toHaveTextContent('Request timeout');
  });

  it('falls back to the HTTP status when the failure carries no message', async () => {
    renderPanel(makeWs(() => Promise.resolve({ status: 503, body: null })));
    expect(await screen.findByTestId('ai-usage-error')).toHaveTextContent('HTTP 503');
  });

  it('treats a 200 with an unexpected body as an error instead of crashing', async () => {
    renderPanel(makeWs(() => ok({ success: true })));
    expect(await screen.findByTestId('ai-usage-error')).toHaveTextContent(/unexpected response/i);
  });

  it('retries with the window that is currently selected', async () => {
    let fail = true;
    const ws = makeWs(() => (fail
      ? Promise.resolve({ status: 500, body: { error: 'boom' } })
      : ok(usage({ days: 7 }))));
    renderPanel(ws);
    await screen.findByTestId('ai-usage-error');
    fireEvent.change(screen.getByTestId('ai-usage-window'), { target: { value: '7' } });
    await waitFor(() => expect(usagePaths(ws)).toContain('/v1/ai/usage/report?days=7'));
    await screen.findByTestId('ai-usage-error');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('ai-usage-total-runs');
    expect(usagePaths(ws).at(-1)).toBe('/v1/ai/usage/report?days=7');
  });
});

describe('AiUsagePanel: placement in the AI settings', () => {
  it('is its own card after the AI Models card, not nested inside it, with the same heading pattern', async () => {
    const ws = makeWs((path) => {
      if (path.startsWith('/v1/ai/usage/report')) return ok(usage());
      if (path === '/v1/ai/tiers') return ok([]);
      return ok({ success: true, data: [] });
    });
    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter>
            <AISection />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    );
    const panel = await screen.findByTestId('ai-usage-panel');
    const modelsCard = document.getElementById('section-ai-models') as HTMLElement;
    const usageCard = document.getElementById('section-ai-usage') as HTMLElement;
    expect(modelsCard).not.toBeNull();
    expect(usageCard).not.toBeNull();
    expect(usageCard.className).toContain('card');
    expect(modelsCard.contains(usageCard)).toBe(false);
    expect(usageCard.contains(modelsCard)).toBe(false);
    expect(usageCard.parentElement).toBe(modelsCard.parentElement);
    expect(modelsCard.compareDocumentPosition(usageCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(usageCard.contains(panel) || panel.contains(usageCard)).toBe(true);
    // Same heading level as the sibling cards (SectionCard renders an h3).
    expect(within(usageCard).getByRole('heading', { name: 'AI usage', level: 3 })).toBeInTheDocument();
    expect(within(modelsCard).queryByTestId('ai-usage-panel')).toBeNull();
  });

  it('appears in the AI section after the model list, and asks for the default window', async () => {
    const ws = makeWs((path) => {
      if (path.startsWith('/v1/ai/usage/report')) return ok(usage());
      if (path === '/v1/ai/tiers') return ok([]);
      return ok({ success: true, data: [] });
    });
    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter>
            <AISection />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    );
    const panel = await screen.findByTestId('ai-usage-panel');
    expect(panel.closest('#section-ai')).not.toBeNull();
    expect(screen.getByTestId('add-tier-btn').compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByTestId('ai-usage-total-runs')).toBeInTheDocument();
    expect(usagePaths(ws)).toEqual(['/v1/ai/usage/report?days=30']);
  });
});
