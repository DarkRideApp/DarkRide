// Paid, opt-in lane: runs real requests against each provider whose credentials are in the environment.
// It is excluded from the default test run and from CI. Run it deliberately with `npm run test:ai-live`.
//
// A provider's suite runs only when its variable is set; every other suite is skipped, so with nothing set
// the whole file skips and no request is made.
//
//   ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY, CODESTRAL_API_KEY
//   OLLAMA_BASE_URL            (no key; a local or LAN server)
//   AI_LIVE_<PROVIDER>_MODEL   pins the model, for example AI_LIVE_OPENAI_MODEL. Required for openai and mistral,
//                              which have no catalog default. Worth setting for openrouter, whose default routes
//                              to a model that may not support tools.
//
// Failures print only this layer's redacted error text. Nothing here logs a key, a request, or an upstream body;
// assertion messages carry event-type counts only.
import { describe, it, expect } from 'vitest';
import { createProvider } from '../../backend/services/ai/registry';
import { listModels } from '../../backend/services/ai/provider-ops';
import { getProviderDescriptor } from '../../shared/lib/ai-provider-catalog';
import type {
  AiStreamEvent, AiStreamToolUseEvent, AiStreamUsageEvent, AiToolDefinition,
} from '../../shared/types/ai-chat';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

interface LiveTarget { id: string; key?: string; baseUrl?: string; model?: string; needsKey: boolean }

const LIVE: LiveTarget[] = [
  { id: 'anthropic', key: env('ANTHROPIC_API_KEY'), model: env('AI_LIVE_ANTHROPIC_MODEL'), needsKey: true },
  { id: 'gemini', key: env('GEMINI_API_KEY'), model: env('AI_LIVE_GEMINI_MODEL'), needsKey: true },
  { id: 'openai', key: env('OPENAI_API_KEY'), model: env('AI_LIVE_OPENAI_MODEL'), needsKey: true },
  { id: 'openrouter', key: env('OPENROUTER_API_KEY'), model: env('AI_LIVE_OPENROUTER_MODEL'), needsKey: true },
  { id: 'mistral', key: env('MISTRAL_API_KEY'), model: env('AI_LIVE_MISTRAL_MODEL'), needsKey: true },
  { id: 'codestral', key: env('CODESTRAL_API_KEY'), model: env('AI_LIVE_CODESTRAL_MODEL'), needsKey: true },
  { id: 'ollama', baseUrl: env('OLLAMA_BASE_URL'), model: env('AI_LIVE_OLLAMA_MODEL'), needsKey: false },
];

const WEATHER: AiToolDefinition = {
  name: 'get_weather',
  description: 'Get the weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  context: [],
};

async function drain(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

/** Event-type counts for assertion messages. Never includes event content. */
const shape = (events: AiStreamEvent[]): string => {
  const n = (type: AiStreamEvent['type']) => events.filter((e) => e.type === type).length;
  return `text:${n('text')} tool_use:${n('tool_use')} usage:${n('usage')}`;
};

const usageOf = (events: AiStreamEvent[]): AiStreamUsageEvent[] =>
  events.filter((e): e is AiStreamUsageEvent => e.type === 'usage');

// Roughly 10k tokens of text that differs on every run, so the first call below is a cache miss and the second
// can only be a hit if caching works. Well above any model's minimum cacheable prompt length.
const NONCE = Date.now().toString(36);
const FILLER = Array.from({ length: 800 }, (_, i) => `DarkRide cache probe ${NONCE} sentence number ${i + 1}.`).join(' ');

const FENCE = '```';
const nonEmptyUnfenced = (o: string): boolean => o.trim().length > 0 && !o.includes(FENCE);

const COMPLETION_CASES: Array<{ prefix: string; suffix: string; check: (out: string) => boolean }> = [
  { prefix: 'function add(a: number, b: number) {\n  return ', suffix: ';\n}', check: (o) => /a\s*\+\s*b/.test(o) },
  { prefix: 'const items = [1, 2, 3].map(x => ', suffix: ');', check: nonEmptyUnfenced },
  { prefix: 'if (', suffix: ') {\n  console.log("ok");\n}', check: nonEmptyUnfenced },
  { prefix: 'import { ', suffix: " } from 'fs';", check: nonEmptyUnfenced },
  { prefix: 'const o = { a: 1, ', suffix: ' };', check: nonEmptyUnfenced },
  { prefix: 'async function f() {\n  const r = await ', suffix: ';\n  return r;\n}', check: nonEmptyUnfenced },
  { prefix: 'for (let i = 0; i < ', suffix: '; i++) {}', check: nonEmptyUnfenced },
  { prefix: 'const s = "hello', suffix: '";', check: (o) => !o.includes(FENCE) },
];

const BRACKETS: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];

/**
 * For each bracket pair, the completion must not close more than it opens, and any opener it leaves open must be
 * closed by the suffix. The suffix already supplies the closers the surrounding code needs, so a completion that
 * repeats one of them is wrong.
 */
const balanced = (out: string, suffix: string): boolean => {
  const count = (text: string, ch: string): number => text.split(ch).length - 1;
  return BRACKETS.every(([open, close]) => {
    const openLeft = count(out, open) - count(out, close);
    return openLeft >= 0 && openLeft <= count(suffix, close);
  });
};

for (const p of LIVE) {
  const d = getProviderDescriptor(p.id);
  if (!d) throw new Error(`Provider ${p.id} is not in the catalog`);
  // A provider with no catalog default model (openai, mistral) is only exercised when a model is named.
  const enabled = (p.needsKey ? !!p.key : !!p.baseUrl) && (!!d.defaultModel || !!p.model);
  const make = () => createProvider(p.id, { apiKey: p.key, baseUrl: p.baseUrl, model: p.model });

  describe.skipIf(!enabled)(`live: ${p.id}`, () => {
    it('lists at least one model', async () => {
      const models = await listModels({ type: p.id, apiKey: p.key ?? null, baseUrl: p.baseUrl ?? null });
      expect(models.length).toBeGreaterThan(0);
    });

    it('streams a short reply with usage', async () => {
      // The budget leaves room for models that spend output tokens on reasoning before the one-word answer.
      const events = await drain(make().createStreamingRequest(
        [{ role: 'user', content: 'Reply with the single word: pong' }], '', [], { maxOutputTokens: 1024 },
      ));
      expect(events.some((e) => e.type === 'text'), `no text event (${shape(events)})`).toBe(true);
      const input = usageOf(events).reduce((n, e) => n + e.inputTokens, 0);
      expect(input, `no input tokens reported (${shape(events)})`).toBeGreaterThan(0);
    });

    it('produces a tool call from an instruction (no forced tool_choice) and completes a two-round loop', async () => {
      const prompt = 'Use the get_weather tool for Paris. Do not answer in text before calling it.';
      const first = await drain(make().createStreamingRequest([{ role: 'user', content: prompt }], '', [WEATHER]));
      const call = first.find((e): e is AiStreamToolUseEvent => e.type === 'tool_use');
      if (!call) throw new Error(`model did not call the tool (${shape(first)})`);
      expect(typeof call.input.city).toBe('string');
      const second = await drain(make().createStreamingRequest([
        { role: 'user', content: prompt },
        { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] },
        { role: 'tool_result', toolUseId: call.id, content: 'Sunny, 21C' },
      ], '', [WEATHER]));
      expect(second.some((e) => e.type === 'text'), `no text after the tool result (${shape(second)})`).toBe(true);
    });

    it.skipIf(d.dialect !== 'anthropic-messages')('anthropic prompt caching reports cached tokens on the second identical call', async () => {
      const ask = () => drain(make().createStreamingRequest(
        [{ role: 'user', content: 'Say ok.' }], FILLER, [], { maxOutputTokens: 512 },
      ));
      await ask();
      const second = await ask();
      const cached = usageOf(second).reduce((n, e) => n + (e.cachedInputTokens ?? 0), 0);
      expect(cached, `no cached input tokens on the second call (${shape(second)})`).toBeGreaterThan(0);
    });

    it('inline completion: at least 7 of 8 cases pass deterministic checks', async () => {
      let pass = 0;
      for (const c of COMPLETION_CASES) {
        const out = await make().complete({
          prefix: c.prefix,
          suffix: c.suffix,
          systemPrompt: 'You complete code at <CURSOR>. Return ONLY the inserted code, no markdown fences.',
          maxOutputTokens: 256,
          stopSequences: ['\n\n\n'],
          temperature: 0,
        });
        if (c.check(out) && balanced(out, c.suffix)) pass++;
      }
      expect(pass, `${pass} of ${COMPLETION_CASES.length} completion cases passed`).toBeGreaterThanOrEqual(7);
    }, 300_000);
  });
}
