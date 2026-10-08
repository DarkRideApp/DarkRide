import { spawn } from 'child_process';
import {
  getProviderDescriptor, isCliProvider, type AiProviderDescriptor,
} from '../../../shared/lib/ai-provider-catalog';
import { ClaudeCliProvider } from '../claude-cli-provider';
import { AiProviderError, RateLimitError } from './errors';
import { classifyHttpError, sendBuilt, sendChat } from './http';
import { readJson, resolveContext } from './provider';
import { getDialect } from './registry';
import type { DialectContext } from './dialect';

export type TestResult = { success: true; model: string } | { success: false; error: string };
export interface ProviderRow { type: string; apiKey: string | null; baseUrl: string | null }

const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const CLI_MISSING = 'Claude CLI not found or not working';
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function httpDescriptor(row: ProviderRow): AiProviderDescriptor {
  const d = getProviderDescriptor(row.type);
  if (!d || d.kind !== 'http' || !d.dialect) throw new AiProviderError(`Unknown provider type: ${row.type}`);
  return d;
}

function ctxFor(row: ProviderRow, model: string): DialectContext {
  // Ids are never synthesised here: listing and the probe do not parse tool calls.
  return resolveContext(httpDescriptor(row), { apiKey: row.apiKey, baseUrl: row.baseUrl, model }, () => 'unused');
}

function requireKey(d: AiProviderDescriptor, row: ProviderRow): void {
  if (d.auth.required && !row.apiKey?.trim()) throw new AiProviderError(`No ${d.shortName} API key configured`, { provider: d.id });
}

// A failed listing's body only feeds a 500-character message and a few classifier patterns, so it is read
// bounded: at most 64 KB and 10 s. Mirrors the transport's own reader for chat requests, including dropping a
// possibly cut-off key from the tail when the read stops early.
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 10_000;

async function readErrorBody(res: Response, apiKey?: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ERROR_BODY_TIMEOUT_MS); });
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout') break;
      if (next.done) { complete = true; break; }
      const chunk = next.value.subarray(0, MAX_ERROR_BODY_BYTES - bytes);
      bytes += chunk.length;
      text += decoder.decode(chunk, { stream: true });
    }
    if (bytes >= MAX_ERROR_BODY_BYTES) complete = true;   // the size cap is a deliberate stop, not a cut-off
    text += decoder.decode();
  } catch { /* keep what was read */ }
  finally {
    clearTimeout(timer);
    reader.cancel().catch(() => { /* already closed */ });
  }
  if (!complete && apiKey && apiKey.length >= 6) text = text.slice(0, Math.max(0, text.length - (apiKey.length - 1)));
  return text;
}

/**
 * List a provider's models: the descriptor's static list, or the listing endpoint, following pagination for at
 * most 10 pages. A failed listing is classified like any other request, so a bad key reads as a typed AuthError
 * with the provider's hint, and a 200 that is not JSON is an AiProviderError rather than a SyntaxError.
 */
export async function listModels(row: ProviderRow): Promise<{ id: string; name: string }[]> {
  const d = getProviderDescriptor(row.type);
  if (!d?.listModels) return [];
  if ('static' in d.listModels) return d.listModels.static.map((m) => ({ id: m.id, name: m.name }));
  if (d.kind !== 'http' || !d.dialect) return [];
  requireKey(d, row);
  const dialect = getDialect(d.dialect);
  if (!dialect.buildListModels || !dialect.parseModels) return [];
  const ctx = ctxFor(row, d.defaultModel ?? 'unused');
  const all: { id: string; name: string }[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const built = dialect.buildListModels(ctx, page);
    const res = await sendBuilt({ ...built, body: undefined }, ctx, AbortSignal.timeout(REQUEST_TIMEOUT_MS), 'GET');
    if (!res.ok) throw classifyHttpError(dialect, ctx, res.status, res.headers, await readErrorBody(res, ctx.apiKey));
    const parsed = dialect.parseModels(await readJson(res, d));
    all.push(...parsed.models);
    if (!parsed.next) break;
    page = parsed.next;
  }
  return all;
}

function cliVersionOk(apiKey: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    const env = apiKey ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: apiKey } : undefined;
    let child: ReturnType<typeof spawn>;
    try { child = spawn('claude', ['--version'], { env }); }
    catch { resolve(false); return; }
    const timer = setTimeout(() => { child.kill(); resolve(false); }, REQUEST_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * One tiny streaming request. Only the HTTP outcome is judged: the body is cancelled unread, so a truncated,
 * odd, or empty stream cannot fail the test, and no parser runs.
 */
async function probe(row: ProviderRow, model: string): Promise<void> {
  const d = httpDescriptor(row);
  const { res } = await sendChat(getDialect(d.dialect!), ctxFor(row, model), {
    messages: [{ role: 'user', content: 'hi' }], systemPrompt: '', tools: [], maxOutputTokens: 16, cache: false,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { stream: true });
  await res.body?.cancel().catch(() => undefined);
}

/** Generation result: a 2xx or a rate limit (the key works, the account is just busy) is success. */
async function probeResult(row: ProviderRow, model: string): Promise<TestResult> {
  try {
    await probe(row, model);
    return { success: true, model };
  } catch (err) {
    if (err instanceof RateLimitError) return { success: true, model };
    return { success: false, error: message(err) };
  }
}

/**
 * Test a provider's connection. With a default model and a credential, a one-turn generation, because some
 * APIs list models even with a bad key or no credit. Otherwise (no default model, or no auth at all, such as a
 * local Ollama whose default model may not be pulled) a listing, reporting the model count.
 */
export async function testProvider(row: ProviderRow): Promise<TestResult> {
  const d = getProviderDescriptor(row.type);
  if (!d) return { success: false, error: `Unknown provider type: ${row.type}` };
  if (isCliProvider(row.type)) {
    return (await cliVersionOk(row.apiKey)) ? { success: true, model: 'claude-cli' } : { success: false, error: CLI_MISSING };
  }
  try { requireKey(d, row); } catch (e) { return { success: false, error: message(e) }; }

  if (d.defaultModel && d.auth.scheme !== 'none') return probeResult(row, d.defaultModel);
  try {
    const models = await listModels(row);
    return { success: true, model: `${models.length} models` };
  } catch (err) {
    return { success: false, error: message(err) };
  }
}

/** Test one model row: a one-turn generation capped at 16 output tokens, or the CLI's version and tool self-test. */
export async function testModel(row: ProviderRow, modelRow: { model: string | null }): Promise<TestResult> {
  const d = getProviderDescriptor(row.type);
  if (!d) return { success: false, error: `Unknown provider: ${row.type}` };
  if (isCliProvider(row.type)) {
    const token = row.apiKey ?? undefined;
    const version = await ClaudeCliProvider.getVersion(token);
    if (!version) return { success: false, error: CLI_MISSING };
    const tool = await ClaudeCliProvider.testToolUse(token, modelRow.model || d.defaultModel || 'sonnet');
    if (!tool.ok) return { success: false, error: tool.reason || 'Claude CLI cannot use tools' };
    return { success: true, model: modelRow.model || 'claude-cli' };
  }
  try { requireKey(d, row); } catch (e) { return { success: false, error: message(e) }; }
  const model = modelRow.model || d.defaultModel;
  if (!model) return { success: false, error: `No model selected for ${d.label}. Choose a model in the model settings.` };
  return probeResult(row, model);
}
