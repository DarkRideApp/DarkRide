import { describe, it, expect } from 'vitest';
import { authHeaders } from '../http';
import { makeCtx } from '../test-ctx';
import { anthropicDialect } from '../dialects/anthropic-messages';
import { geminiDialect } from '../dialects/gemini-generate';
import { ollamaDialect } from '../dialects/ollama-chat';
import { openAiChatDialect } from '../dialects/openai-chat';
import { getProviderDescriptor, type AiProviderDescriptor } from '../../../../shared/lib/ai-provider-catalog';
import type { Dialect, DialectContext } from '../dialect';

const KEY = 'sk-test-placeholder';
type Scheme = AiProviderDescriptor['auth']['scheme'];

const EXPECTED: Record<Scheme, Record<string, string>> = {
  bearer: { Authorization: `Bearer ${KEY}` },
  'x-api-key': { 'x-api-key': KEY },
  'x-goog-api-key': { 'x-goog-api-key': KEY },
  none: {},
};

/** A context for `id` whose descriptor declares `scheme`, whatever the catalog says. */
function ctxWith(id: string, scheme: Scheme, over: Partial<DialectContext> = {}): DialectContext {
  const d = getProviderDescriptor(id)!;
  return makeCtx(id, { descriptor: { ...d, auth: { ...d.auth, scheme } }, ...over });
}

describe('authHeaders', () => {
  it.each(Object.entries(EXPECTED))('the %s scheme sends the key in its own header', (scheme, headers) => {
    expect(authHeaders(ctxWith('openai', scheme as Scheme))).toEqual(headers);
  });

  it.each(['bearer', 'x-api-key', 'x-goog-api-key', 'none'] as const)('sends nothing without a key (%s)', (scheme) => {
    expect(authHeaders(ctxWith('openai', scheme, { apiKey: undefined }))).toEqual({});
  });
});

const DIALECTS: [string, Dialect, string][] = [
  ['anthropic-messages', anthropicDialect, 'anthropic'],
  ['gemini-generate', geminiDialect, 'gemini'],
  ['ollama-chat', ollamaDialect, 'ollama'],
  ['openai-chat', openAiChatDialect, 'openai'],
];

describe.each(DIALECTS)('the %s dialect reads the catalog auth scheme', (_name, dialect, id) => {
  const req = { messages: [], systemPrompt: '', tools: [] };
  const AUTH_NAMES = ['authorization', 'x-api-key', 'x-goog-api-key'];
  const authOnly = (h: Record<string, string>) =>
    Object.fromEntries(Object.entries(h).filter(([k]) => AUTH_NAMES.includes(k.toLowerCase())));

  it.each(Object.entries(EXPECTED))('chat requests carry the %s scheme', (scheme, headers) => {
    const built = dialect.buildChat(ctxWith(id, scheme as Scheme), req, { stream: true });
    expect(authOnly(built.headers)).toEqual(headers);
  });

  it.each(Object.entries(EXPECTED))('model listing carries the %s scheme', (scheme, headers) => {
    const built = dialect.buildListModels!(ctxWith(id, scheme as Scheme));
    expect(authOnly(built.headers)).toEqual(headers);
  });

  it('sends no credential header when there is no key', () => {
    const ctx = ctxWith(id, getProviderDescriptor(id)!.auth.scheme, { apiKey: undefined });
    expect(authOnly(dialect.buildChat(ctx, req, { stream: true }).headers)).toEqual({});
  });
});

describe('catalog entries keep the header their dialect used to hard-code', () => {
  it.each([
    ['anthropic', { 'x-api-key': KEY }],
    ['gemini', { 'x-goog-api-key': KEY }],
    ['ollama', {}],
    ['openrouter', { Authorization: `Bearer ${KEY}` }],
    ['openai-compatible', { Authorization: `Bearer ${KEY}` }],
  ])('%s', (id, headers) => {
    expect(authHeaders(makeCtx(id))).toEqual(headers);
  });
});
