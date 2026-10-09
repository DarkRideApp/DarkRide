/**
 * AI usage monitor E2E
 *
 * Drives real chat runs through the whole path (provider, router, agent, call log, usage report, Settings
 * panel) against a local stub of the Anthropic Messages API on 127.0.0.1, then checks what the report
 * endpoint and the "AI usage" card in Settings > AI show for them.
 *
 * The stub streams Anthropic-style SSE. Its first answer reports a cache write and every later answer a
 * cache read, so the cache hit rate is a real percentage. The model id has a known price, so the cost is
 * priced. A second model whose requests always answer 429 is put in front of the first for one run, so
 * that run is served after a fallback.
 *
 * No real API key is used: the key is a literal placeholder and every request the backend makes for this
 * provider lands on the stub started below.
 *
 * Run: npx playwright test tests/e2e/ai-usage-monitor.spec.ts --retries=2
 */

import { test, expect, type Browser, type APIRequestContext, type Page } from '@playwright/test';
import http from 'http';
import type { AddressInfo } from 'net';
import { loginAsAdmin, waitForBackend, apiLogin, API_BASE, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';
import type { AiUsageResponse, AiUsageRun } from '../../shared/types/ai-usage';

const PROVIDER_NAME = 'E2E Usage Stub';
const GOOD_MODEL_NAME = 'E2E Usage Haiku';
const FAILING_MODEL_NAME = 'E2E Usage Rate Limited';
/** Priced in shared/lib/ai-model-pricing.ts, so runs on it get a cost. */
const GOOD_MODEL_ID = 'claude-haiku-5-5';
/** Every request for this model id is answered with a 429. */
const FAILING_MODEL_ID = 'claude-sonnet-5-5';
const PLACEHOLDER_KEY = 'sk-test-placeholder';
const REPLY_TEXT = 'Stub reply from the usage monitor test.';

// Token counts the stub reports for each answered request.
const UNCACHED_INPUT = 500;
const CACHED_PREFIX = 20_000;
const OUTPUT = 40;

// Haiku 5.5 rates in USD per million tokens (short prompts): input, cache write (5 minute), cache read, output.
const HAIKU = { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 };

interface StubRequest {
  model: string;
  stream: boolean;
  status: number;
  usage?: { input: number; cacheWrite: number; cacheRead: number; output: number };
}

let server: http.Server;
let port = 0;
const requests: StubRequest[] = [];
let answered = 0;

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Answer one Messages request: the first one writes the cache, every later one reads it. */
function answer(res: http.ServerResponse, model: string, stream: boolean): StubRequest['usage'] {
  const first = answered === 0;
  answered += 1;
  const usage = {
    input: UNCACHED_INPUT,
    cacheWrite: first ? CACHED_PREFIX : 0,
    cacheRead: first ? 0 : CACHED_PREFIX,
    output: OUTPUT,
  };
  const startUsage = {
    input_tokens: usage.input,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
    output_tokens: 1,
  };
  const id = `msg_stub_${answered}`;

  if (!stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: REPLY_TEXT }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { ...startUsage, output_tokens: usage.output },
    }));
    return usage;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: startUsage },
  });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY_TEXT } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
  return usage;
}

function startStub(): Promise<void> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
        return;
      }
      let body: any = {};
      try { body = JSON.parse(raw); } catch { /* answered below as a normal request */ }
      const model = String(body.model ?? '');
      const stream = body.stream === true;

      if (model === FAILING_MODEL_ID) {
        requests.push({ model, stream, status: 429 });
        res.statusCode = 429;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Stub rate limit for the fallback test' } }));
        return;
      }
      const usage = answer(res, model, stream);
      requests.push({ model, stream, status: 200, usage });
    });
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as AddressInfo).port;
    resolve();
  }));
}

/** Estimated cost in USD of answered stub requests, with the same formula as the price table. */
function expectedCost(answeredRequests: StubRequest[]): number {
  let sum = 0;
  for (const r of answeredRequests) {
    const u = r.usage!;
    sum += (u.input * HAIKU.input + u.cacheWrite * HAIKU.cacheWrite + u.cacheRead * HAIKU.cacheRead + u.output * HAIKU.output) / 1e6;
  }
  return sum;
}

/** Totals of answered stub requests, in the report's accounting (input includes cache reads and writes). */
function expectedTokens(answeredRequests: StubRequest[]) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of answeredRequests) {
    const u = r.usage!;
    t.input += u.input + u.cacheRead + u.cacheWrite;
    t.output += u.output;
    t.cacheRead += u.cacheRead;
    t.cacheWrite += u.cacheWrite;
  }
  return t;
}

/**
 * Remove the models and the provider this spec created. Models go first, since the provider DELETE answers
 * 409 while a model still references it. Deletes need the CSRF header or they return 403 and the rows leak
 * into later specs. Safe when nothing exists. There is no API to delete call-log rows, so the assertions
 * below only look at runs on this spec's model id that started after the spec did.
 */
async function cleanup(browser: Browser): Promise<void> {
  const ctx = await browser.newContext();
  try {
    const csrf = await apiLogin(ctx.request, ADMIN_USERNAME, ADMIN_PASSWORD);
    const headers = { 'X-CSRF-Token': csrf };

    const modelsRes = await ctx.request.get(`${API_BASE}/v1/ai/models`);
    expect(modelsRes.ok()).toBe(true);
    const models: Array<{ id: number; name: string; providerName: string | null }> = (await modelsRes.json()).data ?? [];
    for (const m of models) {
      if (m.providerName === PROVIDER_NAME || m.name === GOOD_MODEL_NAME || m.name === FAILING_MODEL_NAME) {
        const del = await ctx.request.delete(`${API_BASE}/v1/ai/models/${m.id}`, { headers });
        expect(del.ok(), `delete model ${m.id}: ${del.status()}`).toBe(true);
      }
    }

    const providersRes = await ctx.request.get(`${API_BASE}/v1/ai/providers`);
    expect(providersRes.ok()).toBe(true);
    const providers: Array<{ id: number; name: string }> = (await providersRes.json()).data ?? [];
    for (const p of providers) {
      if (p.name === PROVIDER_NAME) {
        const del = await ctx.request.delete(`${API_BASE}/v1/ai/providers/${p.id}`, { headers });
        expect(del.ok(), `delete provider ${p.id}: ${del.status()}`).toBe(true);
      }
    }
  } finally {
    await ctx.close();
  }
}

async function postJson(request: APIRequestContext, csrf: string, method: 'post' | 'put', path: string, data: unknown) {
  const res = await request[method](`${API_BASE}${path}`, { data, headers: { 'X-CSRF-Token': csrf } });
  const body = await res.json();
  expect(res.ok() && body.success, `${method.toUpperCase()} ${path}: ${res.status()} ${JSON.stringify(body)}`).toBe(true);
  return body.data;
}

async function getReport(request: APIRequestContext, days: number): Promise<AiUsageResponse> {
  const res = await request.get(`${API_BASE}/v1/ai/usage/report?days=${days}`);
  expect(res.ok(), `usage report: ${res.status()}`).toBe(true);
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.data as AiUsageResponse;
}

/** Send one chat message through the drawer and wait for the stub's reply to render as message `index + 1`. */
async function chat(page: Page, index: number, text: string): Promise<void> {
  const input = page.getByTestId('ai-chat-input');
  await input.fill(text);
  const send = page.getByTestId('ai-chat-send-btn');
  await expect(send).toBeEnabled({ timeout: 5_000 });
  await send.click();
  await expect(page.getByTestId(`ai-chat-message-${index}`)).toContainText(text, { timeout: 15_000 });
  await expect(page.getByTestId(`ai-chat-message-${index + 1}`)).toContainText(REPLY_TEXT, { timeout: 30_000 });
}

/** This spec's runs: on its model id and started after it began, oldest first. */
function ownRuns(report: AiUsageResponse, since: number): AiUsageRun[] {
  return report.recentRuns
    .filter((r) => r.models.includes(GOOD_MODEL_ID) && Date.parse(r.startedAt) >= since)
    .sort((a, b) => a.id - b.id);
}

test.describe('AI usage monitor', () => {
  test.beforeAll(async ({ browser }) => {
    await startStub();
    const ctx = await browser.newContext();
    await waitForBackend((await ctx.newPage()).request);
    await ctx.close();
    // A crashed earlier run may have left rows behind.
    await cleanup(browser);
  });

  test.afterAll(async ({ browser }) => {
    try {
      await cleanup(browser);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('chat runs are recorded with tokens, cache use, cost and fallbacks, and shown in Settings > AI', async ({ page, browser }) => {
    test.setTimeout(180_000);
    // Second-resolution timestamps in the call log can round down, so allow a little slack.
    const since = Date.now() - 2_000;
    requests.length = 0;
    answered = 0;

    const api = await browser.newContext();
    try {
      const csrf = await apiLogin(api.request, ADMIN_USERNAME, ADMIN_PASSWORD);
      const before = await getReport(api.request, 1);

      // ── Provider and model, pointed at the stub ──
      const provider = await postJson(api.request, csrf, 'post', '/v1/ai/providers', {
        name: PROVIDER_NAME, type: 'anthropic', apiKey: PLACEHOLDER_KEY, baseUrl: `http://127.0.0.1:${port}`,
      });
      const good = await postJson(api.request, csrf, 'post', '/v1/ai/models', {
        name: GOOD_MODEL_NAME, providerId: provider.id, model: GOOD_MODEL_ID,
      });
      // The chat routes through the High tier first, so the model must be the first usable one there.
      const allModels: Array<{ id: number; enabled: boolean; tierName: string | null }> =
        (await (await api.request.get(`${API_BASE}/v1/ai/models`)).json()).data;
      const others = allModels.filter((m) => m.id !== good.id).map((m) => m.id);
      await postJson(api.request, csrf, 'put', '/v1/ai/models/reorder', { ids: [good.id, ...others] });

      // ── Two chat runs in one conversation: the first writes the cache, the second reads it ──
      await loginAsAdmin(page);
      await page.goto('/ui/');
      await page.waitForLoadState('networkidle');
      await page.getByTestId('ai-chat-fab').click();
      await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });

      await chat(page, 0, 'First usage monitor question');
      const afterFirst = requests.length;
      await chat(page, 2, 'Second usage monitor question');
      const afterSecond = requests.length;

      // ── A third run served after a fallback: a rate-limited model goes in front of the good one ──
      const failing = await postJson(api.request, csrf, 'post', '/v1/ai/models', {
        name: FAILING_MODEL_NAME, providerId: provider.id, model: FAILING_MODEL_ID,
      });
      await postJson(api.request, csrf, 'put', '/v1/ai/models/reorder', { ids: [failing.id, good.id, ...others] });
      await chat(page, 4, 'Third usage monitor question');

      // The stub saw what the brief promised: answers with a cache write then cache reads, and at least one 429.
      const firstRunRequests = requests.slice(0, afterFirst).filter((r) => r.status === 200);
      const secondRunRequests = requests.slice(afterFirst, afterSecond).filter((r) => r.status === 200);
      const thirdRunRequests = requests.slice(afterSecond).filter((r) => r.status === 200);
      expect(firstRunRequests.length).toBeGreaterThanOrEqual(1);
      expect(secondRunRequests.length).toBeGreaterThanOrEqual(1);
      expect(thirdRunRequests.length).toBeGreaterThanOrEqual(1);
      expect(requests.slice(afterSecond).some((r) => r.model === FAILING_MODEL_ID && r.status === 429)).toBe(true);
      expect(requests.every((r) => r.stream)).toBe(true);

      // ── The report endpoint ──
      const report = await getReport(api.request, 1);
      const runs = ownRuns(report, since);
      expect(runs, JSON.stringify(report.recentRuns, null, 2)).toHaveLength(3);
      const [run1, run2, run3] = runs;

      for (const [run, served] of [[run1, firstRunRequests], [run2, secondRunRequests], [run3, thirdRunRequests]] as const) {
        const tokens = expectedTokens([...served]);
        expect(run.purpose).toBe('chat');
        expect(run.label).toBe('Chat');
        expect(run.outcome).toBe('success');
        expect(run.models).toEqual([GOOD_MODEL_ID]);
        expect(run.inputTokens).toBe(tokens.input);
        expect(run.outputTokens).toBe(tokens.output);
        expect(run.cacheReadTokens).toBe(tokens.cacheRead);
        expect(run.cacheWriteTokens).toBe(tokens.cacheWrite);
        expect(run.costUsd).not.toBeNull();
        expect(run.costUsd!).toBeGreaterThan(0);
        expect(run.costUsd!).toBeCloseTo(expectedCost([...served]), 9);
      }
      expect(run1.cacheWriteTokens).toBeGreaterThan(0);
      expect(run1.cacheReadTokens).toBe(0);
      expect(run2.cacheReadTokens).toBeGreaterThan(0);
      expect(run1.fallbackRequests).toBe(0);
      expect(run2.fallbackRequests).toBe(0);
      expect(run3.fallbackRequests).toBeGreaterThanOrEqual(1);

      const chatRow = report.byPurpose.find((p) => p.purpose === 'chat');
      expect(chatRow?.label).toBe('Chat');
      expect(chatRow!.runs).toBeGreaterThanOrEqual(3);
      expect(report.totals.runs).toBeGreaterThanOrEqual(before.totals.runs + 3);
      expect(report.totals.cacheReadTokens).toBeGreaterThan(0);
      expect(report.totals.cacheHitRate).not.toBeNull();
      expect(report.totals.costUsd).not.toBeNull();
      expect(report.totals.costUsd!).toBeGreaterThan(0);
      // Every request of these runs had a price, so none of them counts as unpriced.
      expect(report.totals.unpricedRuns).toBe(before.totals.unpricedRuns);

      // ── The older per-conversation summary keeps its shape ──
      const legacyRes = await api.request.get(`${API_BASE}/v1/ai/usage`);
      expect(legacyRes.ok(), `legacy usage: ${legacyRes.status()}`).toBe(true);
      const legacy = await legacyRes.json();
      expect(legacy.success).toBe(true);
      expect(Object.keys(legacy.data).sort()).toEqual(
        ['byContext', 'conversationCount', 'conversations', 'totalInputTokens', 'totalOutputTokens'],
      );
      expect(typeof legacy.data.totalInputTokens).toBe('number');
      expect(typeof legacy.data.totalOutputTokens).toBe('number');
      expect(legacy.data.conversationCount).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(legacy.data.byContext)).toBe(true);
      expect(Array.isArray(legacy.data.conversations)).toBe(true);
      expect(legacy.data.totals).toBeUndefined();

      // ── The Settings panel ──
      const sentFrames: string[] = [];
      page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload === 'string') sentFrames.push(f.payload); }));
      await page.goto('/ui/settings/ai');
      await page.waitForLoadState('networkidle');

      const panel = page.getByTestId('ai-usage-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByTestId('ai-usage-total-runs')).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByTestId('ai-usage-error')).toHaveCount(0);
      await expect(panel.getByTestId('ai-usage-empty')).toHaveCount(0);

      const runsText = (await panel.getByTestId('ai-usage-total-runs').locator('.stat-value').innerText()).replace(/[^\d]/g, '');
      expect(Number(runsText)).toBeGreaterThanOrEqual(3);
      await expect(panel.getByTestId('ai-usage-cache-hit-rate').locator('.stat-value')).toHaveText(/^\d[\d.,]*\s?%$/);
      await expect(panel.getByTestId('ai-usage-cost').locator('.stat-value')).toHaveText(/^\$\d/);
      await expect(panel.getByTestId('ai-usage-by-purpose').getByTestId('ai-usage-purpose-chat')).toContainText('Chat');

      const runsTable = panel.getByTestId('ai-usage-runs');
      for (const run of runs) {
        await expect(runsTable.getByTestId(`ai-usage-run-${run.id}`)).toContainText(GOOD_MODEL_ID);
      }
      await expect(runsTable.getByTestId(`ai-usage-run-${run3.id}`).getByTestId('ai-usage-run-fallback')).toBeVisible();
      await expect(runsTable.getByTestId(`ai-usage-run-${run1.id}`).getByTestId('ai-usage-run-fallback')).toHaveCount(0);

      // The card is taller than the default viewport and the page scrolls inside its own container, so a
      // taller window keeps the whole card, and the controls below, in view.
      await page.setViewportSize({ width: 1280, height: 2400 });
      await page.locator('#section-ai-usage').scrollIntoViewIfNeeded();

      // ── Switching the window to 7 days asks the server again and still shows the runs ──
      await panel.getByTestId('ai-usage-window').selectOption('7');
      await expect.poll(() => sentFrames.some((f) => f.includes('/v1/ai/usage/report?days=7')), { timeout: 10_000 }).toBe(true);
      await expect(panel.getByTestId('ai-usage-loading')).toHaveCount(0, { timeout: 10_000 });
      await expect(panel.getByTestId('ai-usage-error')).toHaveCount(0);
      await expect(panel.getByTestId('ai-usage-window')).toHaveValue('7');
      await expect(runsTable.getByTestId(`ai-usage-run-${run3.id}`)).toContainText(GOOD_MODEL_ID);
    } finally {
      await api.close();
    }
  });
});
