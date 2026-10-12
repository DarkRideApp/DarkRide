/**
 * AI tool confirmation E2E
 *
 * A tool that changes configuration asks the user before it runs. "Allow for this conversation" must stop the prompt
 * for that tool for the rest of that conversation, and for no other conversation. Drives real chat runs through
 * provider, agent, WebSocket and the chat drawer against a local stub of the Anthropic Messages API on 127.0.0.1.
 *
 * The stub answers the first request of every run with a call to delete_intercept_rule on a rule that does not exist,
 * so running it changes nothing, and answers the follow-up that carries the tool result with a plain reply. It records
 * what each tool call returned, which tells a tool that ran from one the user refused. No real API key is used.
 *
 * Run: npx playwright test tests/e2e/ai-tool-confirm.spec.ts --retries=2
 */

import { test, expect, type Browser, type APIRequestContext, type Page } from '@playwright/test';
import http from 'http';
import type { AddressInfo } from 'net';
import { loginAsAdmin, waitForBackend, apiLogin, API_BASE, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';

const PROVIDER_NAME = 'E2E Tool Confirm Stub';
const MODEL_NAME = 'E2E Tool Confirm';
// A model id no other AI spec uses: the usage-monitor spec attributes runs to itself by model id and start time.
const MODEL_ID = 'claude-opus-4-6';
const PLACEHOLDER_KEY = 'sk-test-placeholder';
const GATED_TOOL = 'delete_intercept_rule';
/** Each run gets its own reply text, so a test can tell it from an earlier run's anywhere in the chat. */
const replyFor = (turn: number): string => `Stub reply for tool confirmation run ${turn}.`;

interface StubRequest {
  /** Text of the tool result this request carries, or null for the request that asks for the tool call. */
  toolResult: string | null;
}

let server: http.Server;
let port = 0;
const requests: StubRequest[] = [];

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The tool result in the last message of an Anthropic request, as text, or null when the last message has none. */
function toolResultText(body: any): string | null {
  const last = Array.isArray(body?.messages) ? body.messages[body.messages.length - 1] : null;
  if (!last || !Array.isArray(last.content)) return null;
  const block = last.content.find((b: any) => b?.type === 'tool_result');
  if (!block) return null;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map((part: any) => part?.text ?? '').join('');
  return '';
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
      try { body = JSON.parse(raw); } catch { /* answered below as a request that asks for the tool */ }
      const toolResult = toolResultText(body);
      requests.push({ toolResult });
      // Runs so far: every run begins with exactly one request that asks for the tool.
      const turn = requests.filter((r) => r.toolResult === null).length;

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sse(res, 'message_start', {
        type: 'message_start',
        message: { id: `msg_stub_${requests.length}`, type: 'message', role: 'assistant', model: MODEL_ID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
      });
      if (toolResult === null) {
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_stub_${requests.length}`, name: GATED_TOOL, input: {} } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":999999}' } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
      } else {
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: replyFor(turn) } });
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

/** Remove this spec's model, then its provider (the provider DELETE answers 409 while a model uses it). Safe when nothing exists. */
async function cleanup(browser: Browser): Promise<void> {
  const ctx = await browser.newContext();
  try {
    const csrf = await apiLogin(ctx.request, ADMIN_USERNAME, ADMIN_PASSWORD);
    const headers = { 'X-CSRF-Token': csrf };

    const modelsRes = await ctx.request.get(`${API_BASE}/v1/ai/models`);
    expect(modelsRes.ok()).toBe(true);
    const models: Array<{ id: number; name: string; providerName: string | null }> = (await modelsRes.json()).data ?? [];
    for (const m of models) {
      if (m.providerName === PROVIDER_NAME || m.name === MODEL_NAME) {
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

/** Type a message into the drawer and send it. */
async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('ai-chat-input').fill(text);
  const sendButton = page.getByTestId('ai-chat-send-btn');
  await expect(sendButton).toBeEnabled({ timeout: 5_000 });
  await sendButton.click();
}

test.describe('AI tool confirmation', () => {
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

  test('Allow for this conversation silences the prompt for that tool in that conversation only', async ({ page, browser }) => {
    test.setTimeout(180_000);
    requests.length = 0;

    const api = await browser.newContext();
    try {
      const csrf = await apiLogin(api.request, ADMIN_USERNAME, ADMIN_PASSWORD);

      const provider = await postJson(api.request, csrf, 'post', '/v1/ai/providers', {
        name: PROVIDER_NAME, type: 'anthropic', apiKey: PLACEHOLDER_KEY, baseUrl: `http://127.0.0.1:${port}`,
      });
      const model = await postJson(api.request, csrf, 'post', '/v1/ai/models', {
        name: MODEL_NAME, providerId: provider.id, model: MODEL_ID,
      });
      // The chat routes through the High tier, which takes the first model in the list.
      const allModels: Array<{ id: number }> = (await (await api.request.get(`${API_BASE}/v1/ai/models`)).json()).data;
      await postJson(api.request, csrf, 'put', '/v1/ai/models/reorder', { ids: [model.id, ...allModels.map((m) => m.id).filter((id) => id !== model.id)] });

      await loginAsAdmin(page);
      // Own page context, so other specs' dashboard chat is untouched. Not /ui/traffic: it redirects to /ui/network, which chats as dashboard.
      await page.goto('/ui/devices');
      await page.waitForLoadState('networkidle');
      await page.getByTestId('ai-chat-fab').click();
      await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
      // Start from an empty conversation: the database outlives a retry.
      await page.getByTestId('ai-chat-new-btn').click();

      const card = page.getByTestId('ai-chat-confirm');
      // Find replies by their text: a conversation reloaded from the database numbers its messages differently.
      const chat = page.getByTestId('ai-chat-messages');

      // ── First call in a conversation: the user is asked, and allows it for the conversation ──
      await send(page, 'Delete intercept rule 999999');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText(GATED_TOOL);
      await page.getByTestId('ai-chat-confirm-allow-conversation').click();
      await expect(card).toHaveCount(0);
      await expect(chat).toContainText(replyFor(1), { timeout: 30_000 });
      // The tool ran once the user allowed it.
      expect(requests.at(-1)?.toolResult).toContain('Rule not found');

      // ── Same conversation, same tool: a prompt would hold the run, so a reply inside this wait means nobody was asked ──
      await send(page, 'Delete intercept rule 999998');
      await expect(chat).toContainText(replyFor(2), { timeout: 30_000 });
      await expect(card).toHaveCount(0);
      expect(requests.at(-1)?.toolResult).toContain('Rule not found');

      // ── A new conversation starts over: the user is asked again, and a denial stops the tool ──
      await page.getByTestId('ai-chat-new-btn').click();
      await send(page, 'Delete intercept rule 999997');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('ai-chat-confirm-deny').click();
      await expect(card).toHaveCount(0);
      await expect(chat).toContainText(replyFor(3), { timeout: 30_000 });
      expect(requests.at(-1)?.toolResult).toContain('denied by user');
    } finally {
      await api.close();
    }
  });
});
