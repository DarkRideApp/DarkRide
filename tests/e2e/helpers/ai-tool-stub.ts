/**
 * A local stub of the Anthropic Messages API for specs that need the chat to call a tool.
 *
 * The first request of every run is answered with a call to `toolName`; the follow-up that carries the tool result is
 * answered with a plain reply. The stub records what each tool call returned, which tells a tool that ran from one the
 * user refused. No real API key is used.
 */

import { expect, type Browser, type APIRequestContext, type Page } from '@playwright/test';
import http from 'http';
import type { AddressInfo } from 'net';
import { loginAsAdmin, apiLogin, API_BASE, ADMIN_USERNAME, ADMIN_PASSWORD } from './auth';

const PLACEHOLDER_KEY = 'sk-test-placeholder';

export interface StubRequest {
  /** Text of the tool result this request carries, or null for the request that asks for the tool call. */
  toolResult: string | null;
}

export interface ToolCallStubOptions {
  modelId: string;
  toolName: string;
  /** The tool call's arguments, as JSON. */
  toolInput: unknown;
  /** The closing reply for the n-th run, unique per run so a test can tell it from an earlier one anywhere in the chat. */
  replyFor: (turn: number) => string;
}

export interface ToolCallStub {
  readonly requests: StubRequest[];
  readonly port: number;
  /** Hold the answer to the next request for `ms`, so a spec can interrupt a run. The request is recorded on arrival. */
  delayNext(ms: number): void;
  start(): Promise<void>;
  stop(): Promise<void>;
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

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createToolCallStub(options: ToolCallStubOptions): ToolCallStub {
  const requests: StubRequest[] = [];
  let server: http.Server;
  let port = 0;
  let nextDelayMs = 0;

  return {
    requests,
    get port() { return port; },
    delayNext(ms: number) { nextDelayMs = ms; },
    start() {
      server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', async () => {
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

          const delayMs = nextDelayMs;
          nextDelayMs = 0;
          if (delayMs > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delayMs);
              res.on('close', () => { clearTimeout(timer); resolve(); });
            });
            if (res.destroyed) return;
          }

          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          sse(res, 'message_start', {
            type: 'message_start',
            message: { id: `msg_stub_${requests.length}`, type: 'message', role: 'assistant', model: options.modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
          });
          if (toolResult === null) {
            sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_stub_${requests.length}`, name: options.toolName, input: {} } });
            sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(options.toolInput) } });
            sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
            sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
          } else {
            sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: options.replyFor(turn) } });
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
    },
    stop() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface StubFixtureNames {
  providerName: string;
  modelName: string;
}

async function postJson(request: APIRequestContext, csrf: string, method: 'post' | 'put', path: string, data: unknown) {
  const res = await request[method](`${API_BASE}${path}`, { data, headers: { 'X-CSRF-Token': csrf } });
  const body = await res.json();
  expect(res.ok() && body.success, `${method.toUpperCase()} ${path}: ${res.status()} ${JSON.stringify(body)}`).toBe(true);
  return body.data;
}

/** Add a provider that points at the stub and one model on it, and put the model first so the chat's High tier uses it. */
export async function addStubModel(api: APIRequestContext, csrf: string, names: StubFixtureNames, stub: { port: number; modelId: string }): Promise<void> {
  const provider = await postJson(api, csrf, 'post', '/v1/ai/providers', {
    name: names.providerName, type: 'anthropic', apiKey: PLACEHOLDER_KEY, baseUrl: `http://127.0.0.1:${stub.port}`,
  });
  const model = await postJson(api, csrf, 'post', '/v1/ai/models', {
    name: names.modelName, providerId: provider.id, model: stub.modelId,
  });
  const allModels: Array<{ id: number }> = (await (await api.get(`${API_BASE}/v1/ai/models`)).json()).data;
  await postJson(api, csrf, 'put', '/v1/ai/models/reorder', { ids: [model.id, ...allModels.map((m) => m.id).filter((id) => id !== model.id)] });
}

/** Remove a spec's model, then its provider (the provider DELETE answers 409 while a model uses it). Safe when nothing exists. */
export async function removeStubFixtures(browser: Browser, names: StubFixtureNames): Promise<void> {
  const ctx = await browser.newContext();
  try {
    const csrf = await apiLogin(ctx.request, ADMIN_USERNAME, ADMIN_PASSWORD);
    const headers = { 'X-CSRF-Token': csrf };

    const modelsRes = await ctx.request.get(`${API_BASE}/v1/ai/models`);
    expect(modelsRes.ok()).toBe(true);
    const models: Array<{ id: number; name: string; providerName: string | null }> = (await modelsRes.json()).data ?? [];
    for (const m of models) {
      if (m.providerName === names.providerName || m.name === names.modelName) {
        const del = await ctx.request.delete(`${API_BASE}/v1/ai/models/${m.id}`, { headers });
        expect(del.ok(), `delete model ${m.id}: ${del.status()}`).toBe(true);
      }
    }

    const providersRes = await ctx.request.get(`${API_BASE}/v1/ai/providers`);
    expect(providersRes.ok()).toBe(true);
    const providers: Array<{ id: number; name: string }> = (await providersRes.json()).data ?? [];
    for (const p of providers) {
      if (p.name === names.providerName) {
        const del = await ctx.request.delete(`${API_BASE}/v1/ai/providers/${p.id}`, { headers });
        expect(del.ok(), `delete provider ${p.id}: ${del.status()}`).toBe(true);
      }
    }
  } finally {
    await ctx.close();
  }
}

/** Log in, open the chat drawer on `path`, and start from an empty conversation: the database outlives a retry. */
export async function openFreshChat(page: Page, path: string): Promise<void> {
  await loginAsAdmin(page);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('ai-chat-fab').click();
  await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('ai-chat-new-btn').click();
}

/** Type a message into the drawer and send it. */
export async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByTestId('ai-chat-input').fill(text);
  const sendButton = page.getByTestId('ai-chat-send-btn');
  await expect(sendButton).toBeEnabled({ timeout: 5_000 });
  await sendButton.click();
}
