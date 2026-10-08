import { vi } from 'vitest';
import type { AiStreamEvent } from '../../../shared/types/ai-chat';

const encoder = new TextEncoder();

export interface ResponseInit2 { status?: number; headers?: Record<string, string> }

export function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

export function sseBody(events: Array<{ event?: string; data: string }>): string {
  return events
    .map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${e.data}\n\n`)
    .join('');
}

export function sseResponse(events: Array<{ event?: string; data: string }>, init: ResponseInit2 = {}): Response {
  return new Response(sseBody(events), {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...init.headers },
  });
}

/** Deliver raw chunks one at a time (for split-chunk and CRLF cases). */
export function chunkedResponse(chunks: string[], init: ResponseInit2 = {}): Response {
  return new Response(bodyFromChunks(chunks), {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...init.headers },
  });
}

export function ndjsonResponse(lines: unknown[], init: ResponseInit2 = {}): Response {
  return new Response(lines.map((l) => JSON.stringify(l) + '\n').join(''), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/x-ndjson', ...init.headers },
  });
}

export function jsonResponse(body: unknown, init: ResponseInit2 = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

type StreamKind = 'anthropic' | 'gemini' | 'ollama' | 'openai-chat';
// A table, not a switch: the kinds 'anthropic', 'gemini' and 'ollama' equal provider ids, and the AST guard
// (Task 19) flags `case '<provider id>'` outside the catalog and the dialects.
const OK_STREAMS: Record<StreamKind, () => Response> = {
  anthropic: () => sseResponse([
    { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3 } } }) },
    { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }) },
    { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) },
    { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
  ]),
  gemini: () => sseResponse([{ data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }) }]),
  ollama: () => ndjsonResponse([{ message: { content: 'ok' } }, { done: true, prompt_eval_count: 3, eval_count: 2 }]),
  'openai-chat': () => sseResponse([
    { data: JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) },
    { data: JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }) },
    { data: '[DONE]' },
  ]),
};

/**
 * A minimal VALID success stream (text "ok", 3 tokens in, 2 out) for each wire format.
 * Use it whenever a test only cares about the request that was sent: an invalid stream
 * would make the parser throw before the assertions run.
 */
export const okStream = (kind: StreamKind): Response => OK_STREAMS[kind]();

export async function collect(iter: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const out: AiStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

export interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  /** Parsed JSON body, or undefined when the request had none. */
  body: any;
}

export function callHeader(call: FetchCall, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(call.headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Replace global fetch. `handler` runs per call and must return a NEW Response
 * each time (bodies are single-use). Call vi.unstubAllGlobals() in afterEach.
 */
export function stubFetch(handler: (call: FetchCall, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (input: any, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    const raw = init.headers as any;
    if (raw instanceof Headers) raw.forEach((v, k) => { headers[k] = v; });
    else if (raw) Object.assign(headers, raw);
    let body: any;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const call: FetchCall = { url: String(input), init, headers, body };
    calls.push(call);
    const signal = init.signal as AbortSignal | undefined | null;
    const abortReason = () => signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
    if (signal?.aborted) throw abortReason();
    const result = Promise.resolve(handler(call, calls.length - 1));
    if (!signal) return result;
    // Like real fetch, reject when the caller aborts while the response is pending.
    return Promise.race([
      result,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(abortReason()), { once: true })),
    ]);
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}
