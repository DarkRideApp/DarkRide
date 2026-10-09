/**
 * AI refusal fallback E2E
 *
 * When a model declines a request (Anthropic's `refusal` stop, for example the cyber safeguard), the router
 * must try the next model in the tier, and when every model declines the user must be told why instead of
 * seeing a silent empty reply. Drives real chat runs through provider, router, agent and the chat drawer
 * against a local stub of the Anthropic Messages API on 127.0.0.1.
 *
 * The stub answers every request for REFUSING_MODEL_ID with a refusal stop and every request for
 * GOOD_MODEL_ID with a normal reply. No real API key is used.
 *
 * Run: npx playwright test tests/e2e/ai-refusal-fallback.spec.ts --retries=2
 */

import { test, expect, type Browser, type APIRequestContext, type Page } from '@playwright/test';
import http from 'http';
import type { AddressInfo } from 'net';
import { loginAsAdmin, waitForBackend, apiLogin, API_BASE, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';

const PROVIDER_NAME = 'E2E Refusal Stub';
const REFUSING_MODEL_NAME = 'E2E Refusing';
const GOOD_MODEL_NAME = 'E2E Refusal Fallback';
// Model ids no other AI spec uses: the usage-monitor spec attributes runs to itself by model id and start time, so sharing
// an id with it would make this spec's runs count as that spec's.
const REFUSING_MODEL_ID = 'claude-sonnet-4-6';
const GOOD_MODEL_ID = 'claude-opus-5-5';
const PLACEHOLDER_KEY = 'sk-test-placeholder';
const REPLY_TEXT = 'Stub reply from the refusal fallback test.';
const REFUSAL_TEXT = 'Claude declined this request (category: cyber).';

interface StubRequest { model: string; refused: boolean }

let server: http.Server;
let port = 0;
const requests: StubRequest[] = [];

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
      const refused = model === REFUSING_MODEL_ID;
      requests.push({ model, refused });

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sse(res, 'message_start', {
        type: 'message_start',
        message: { id: `msg_stub_${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
      });
      if (refused) {
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }, usage: { output_tokens: 0 } });
      } else {
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY_TEXT } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
      }
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as AddressInfo).port;
    resolve();
  }));
}

/**
 * Remove the models and the provider this spec created. Models go first, since the provider DELETE answers
 * 409 while a model still references it. Deletes need the CSRF header or they return 403. Safe when nothing exists.
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
      if (m.providerName === PROVIDER_NAME || m.name === GOOD_MODEL_NAME || m.name === REFUSING_MODEL_NAME) {
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

/** Send one chat message through the drawer and wait for the assistant's message `index + 1` to show `expected`. */
async function chat(page: Page, index: number, text: string, expected: string): Promise<void> {
  const input = page.getByTestId('ai-chat-input');
  await input.fill(text);
  const send = page.getByTestId('ai-chat-send-btn');
  await expect(send).toBeEnabled({ timeout: 5_000 });
  await send.click();
  await expect(page.getByTestId(`ai-chat-message-${index}`)).toContainText(text, { timeout: 15_000 });
  await expect(page.getByTestId(`ai-chat-message-${index + 1}`)).toContainText(expected, { timeout: 30_000 });
}

test.describe('AI refusal fallback', () => {
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

  test('a refused request is served by the next model, and the user is told why when every model refuses', async ({ page, browser }) => {
    test.setTimeout(180_000);
    requests.length = 0;

    const api = await browser.newContext();
    try {
      const csrf = await apiLogin(api.request, ADMIN_USERNAME, ADMIN_PASSWORD);

      const provider = await postJson(api.request, csrf, 'post', '/v1/ai/providers', {
        name: PROVIDER_NAME, type: 'anthropic', apiKey: PLACEHOLDER_KEY, baseUrl: `http://127.0.0.1:${port}`,
      });
      const refusing = await postJson(api.request, csrf, 'post', '/v1/ai/models', {
        name: REFUSING_MODEL_NAME, providerId: provider.id, model: REFUSING_MODEL_ID,
      });
      const good = await postJson(api.request, csrf, 'post', '/v1/ai/models', {
        name: GOOD_MODEL_NAME, providerId: provider.id, model: GOOD_MODEL_ID,
      });
      // The chat routes through the High tier first: the refusing model goes first, the good one right behind it.
      const allModels: Array<{ id: number }> = (await (await api.request.get(`${API_BASE}/v1/ai/models`)).json()).data;
      const others = allModels.map((m) => m.id).filter((id) => id !== refusing.id && id !== good.id);
      await postJson(api.request, csrf, 'put', '/v1/ai/models/reorder', { ids: [refusing.id, good.id, ...others] });

      await loginAsAdmin(page);
      // The chat restores the latest conversation of its page context, and no API deletes one. Chat on a page the other
      // AI specs never use (the Proxies page has its own context), so this spec leaves their dashboard chat untouched.
      await page.goto('/ui/settings/proxies');
      await page.waitForLoadState('networkidle');
      await page.getByTestId('ai-chat-fab').click();
      await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
      // Playwright's database outlives a retry, and the chat restores the last conversation of its page context.
      // Start from an empty one so the message indexes below hold on every attempt.
      await page.getByTestId('ai-chat-new-btn').click();

      // ── The first model refuses; the second one answers, and the user sees that answer ──
      await chat(page, 0, 'First refusal fallback question', REPLY_TEXT);
      await expect(page.getByTestId('ai-chat-message-1')).not.toContainText('declined');
      expect(requests.map((r) => [r.model, r.refused])).toEqual([[REFUSING_MODEL_ID, true], [GOOD_MODEL_ID, false]]);

      // A refusal is about the request, not the model's health: nothing cools the refusing model down, so the
      // very next request tries it first again.
      await chat(page, 2, 'Second refusal fallback question', REPLY_TEXT);
      expect(requests.slice(2).map((r) => r.model)).toEqual([REFUSING_MODEL_ID, GOOD_MODEL_ID]);

      // ── Only the refusing model is left: the chat says so instead of ending silently ──
      const del = await api.request.delete(`${API_BASE}/v1/ai/models/${good.id}`, { headers: { 'X-CSRF-Token': csrf } });
      expect(del.ok(), `delete model ${good.id}: ${del.status()}`).toBe(true);
      requests.length = 0;
      await chat(page, 4, 'Third refusal fallback question', REFUSAL_TEXT);
      await expect(page.getByTestId('ai-chat-message-5')).toContainText('Cyber Verification Program');
      expect(requests.map((r) => [r.model, r.refused])).toEqual([[REFUSING_MODEL_ID, true]]);
    } finally {
      await api.close();
    }
  });
});
