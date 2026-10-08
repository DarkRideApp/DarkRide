import { describe, it, expect } from 'vitest';
import {
  priceFor,
  estimateCostUsd,
  parseModelPriceOverrides,
  validateModelPriceOverrides,
  normalizeModelId,
} from './ai-model-pricing';

/** Round away float noise so exact-dollar assertions read cleanly. */
const r = (n: number | null) => (n === null ? null : Math.round(n * 1e9) / 1e9);

describe('priceFor', () => {
  it('returns the published per-MTok rates for current models', () => {
    expect(priceFor('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 });
    expect(priceFor('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.1 });
    expect(priceFor('claude-fable-5-1')).toMatchObject({ input: 10, output: 50, cacheWrite5m: 12.5, cacheRead: 0.25 });
    expect(priceFor('claude-mythos-5-1')).toMatchObject({ input: 10, output: 50, cacheWrite5m: 12.5, cacheRead: 0.25 });
    expect(priceFor('claude-haiku-5-5')).toMatchObject({ input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 });
  });

  it('uses the standard 0.1x cache-read rate on older models', () => {
    expect(priceFor('claude-fable-5')).toMatchObject({ input: 10, output: 50, cacheWrite5m: 12.5, cacheRead: 1 });
    expect(priceFor('claude-opus-5')).toMatchObject({ input: 5, output: 25, cacheWrite5m: 6.25, cacheRead: 0.5 });
    expect(priceFor('claude-opus-4-5')).toMatchObject({ input: 5, output: 25, cacheWrite5m: 6.25, cacheRead: 0.5 });
    expect(priceFor('claude-opus-4-1')).toMatchObject({ input: 15, output: 75, cacheWrite5m: 18.75, cacheRead: 1.5 });
    expect(priceFor('claude-sonnet-5')).toMatchObject({ input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.2 });
    expect(priceFor('claude-sonnet-4-6')).toMatchObject({ input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 });
    expect(priceFor('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5, cacheWrite5m: 1.25, cacheRead: 0.1 });
    expect(priceFor('claude-3-5-haiku')).toMatchObject({ input: 0.8, output: 4, cacheWrite5m: 1, cacheRead: 0.08 });
  });

  it('resolves dated snapshots and provider-prefixed ids to the same model', () => {
    expect(priceFor('claude-sonnet-4-20250514')).toMatchObject({ input: 3, output: 15 });
    expect(priceFor('claude-opus-4-20250514')).toMatchObject({ input: 15, output: 75 });
    expect(priceFor('claude-haiku-4-5-20251001')).toMatchObject({ input: 1, output: 5 });
    expect(priceFor('anthropic/claude-opus-4.5')).toMatchObject({ input: 5, output: 25 });
    expect(priceFor('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toMatchObject({ input: 3, output: 15 });
    expect(priceFor('claude-opus-5-5[1m]')).toMatchObject({ input: 4, output: 20 });
  });

  it('does not let a short id swallow a longer one', () => {
    expect(priceFor('claude-opus-4')!.input).toBe(15);
    expect(priceFor('claude-opus-4-8')!.input).toBe(5);
  });

  it('returns null for unknown models and empty ids', () => {
    expect(priceFor('gpt-4o')).toBeNull();
    expect(priceFor('llama3:8b')).toBeNull();
    expect(priceFor('')).toBeNull();
    expect(priceFor(undefined)).toBeNull();
  });

  it('prefers an override, by exact id or by normalised id', () => {
    const o = { 'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 } };
    expect(priceFor('gpt-4o', o)).toEqual({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite5m: 2.5 });
    const o2 = JSON.stringify({ 'claude-opus-5-5': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } });
    expect(priceFor('claude-opus-5-5-20261001', o2)).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.5 });
  });
});

describe('estimateCostUsd', () => {
  const base = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

  it('prices one million of each token class at the table rate (Opus 5.5)', () => {
    // 3M prompt tokens: 1M uncached ($4) + 1M cache read ($0.20) + 1M cache write ($5); 1M output ($20).
    const c = estimateCostUsd({ model: 'claude-opus-5-5', inputTokens: 3_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(r(c)).toBe(29.2);
  });

  it('matches the documented worked example shape (Opus 5, 40k of 50k cached, 15k out)', () => {
    // 10k x $5 + 40k x $0.50 + 15k x $25, per million = 0.05 + 0.02 + 0.375
    const c = estimateCostUsd({ ...base, model: 'claude-opus-5', inputTokens: 50_000, cacheReadTokens: 40_000, outputTokens: 15_000 });
    expect(r(c)).toBe(0.445);
  });

  it('uses the 2.5% cache-read rate on Fable 5.1 and 0.1x on Fable 5', () => {
    const args = { ...base, inputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
    expect(r(estimateCostUsd({ ...args, model: 'claude-fable-5-1' }))).toBe(0.25);
    expect(r(estimateCostUsd({ ...args, model: 'claude-fable-5' }))).toBe(1);
  });

  it('charges Haiku 5.5 the higher rates when the prompt is over 100,000 tokens', () => {
    const at = estimateCostUsd({ ...base, model: 'claude-haiku-5-5', inputTokens: 100_000, outputTokens: 1_000_000 });
    expect(r(at)).toBe(0.01 + 0.5);
    // 100,001 prompt tokens: 50,001 uncached at $0.50, 50,000 cache read at $0.05; 1M output at $2.50.
    const over = estimateCostUsd({ ...base, model: 'claude-haiku-5-5', inputTokens: 100_001, cacheReadTokens: 50_000, outputTokens: 1_000_000 });
    expect(r(over)).toBe(r(50_001 * 0.5 / 1e6 + 50_000 * 0.05 / 1e6 + 2.5));
    const overWrite = estimateCostUsd({ ...base, model: 'claude-haiku-5-5', inputTokens: 200_000, cacheWriteTokens: 200_000 });
    expect(r(overWrite)).toBe(0.125);
  });

  it('returns null, not zero, for an unknown model', () => {
    expect(estimateCostUsd({ ...base, model: 'mystery', inputTokens: 1000, outputTokens: 1000 })).toBeNull();
    expect(estimateCostUsd({ ...base, model: undefined, inputTokens: 1000 })).toBeNull();
  });

  it('returns zero for a known model with no tokens', () => {
    expect(estimateCostUsd({ ...base, model: 'claude-sonnet-5-5' })).toBe(0);
  });

  it('never prices uncached input below zero when cache counts exceed the total', () => {
    const c = estimateCostUsd({ ...base, model: 'claude-sonnet-5-5', inputTokens: 10, cacheReadTokens: 1_000_000 });
    expect(r(c)).toBe(0.1);
  });

  it('applies an override for a model the table does not know', () => {
    const c = estimateCostUsd({ ...base, model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000 },
      '{"gpt-4o":{"input":2.5,"output":10,"cacheRead":1.25,"cacheWrite":2.5}}');
    expect(r(c)).toBe(12.5);
  });
});

describe('parseModelPriceOverrides', () => {
  it('ignores invalid JSON, non-objects and bad entries without throwing', () => {
    expect(parseModelPriceOverrides('{nope')).toEqual({});
    expect(parseModelPriceOverrides('[]')).toEqual({});
    expect(parseModelPriceOverrides('42')).toEqual({});
    expect(parseModelPriceOverrides(null)).toEqual({});
    expect(parseModelPriceOverrides(undefined)).toEqual({});
    const parsed = parseModelPriceOverrides(JSON.stringify({
      good: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      missing: { input: 1, output: 2 },
      negative: { input: -1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      text: { input: '1', output: 2, cacheRead: 0.1, cacheWrite: 1 },
      inf: { input: 1e400, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      notObject: 5,
    }));
    expect(Object.keys(parsed)).toEqual(['good']);
  });

  it('accepts an already-parsed object', () => {
    expect(parseModelPriceOverrides({ m: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } })).toHaveProperty('m');
  });
});

describe('validateModelPriceOverrides', () => {
  it('accepts an empty value and a well-formed object', () => {
    expect(validateModelPriceOverrides('')).toBeNull();
    expect(validateModelPriceOverrides('{}')).toBeNull();
    expect(validateModelPriceOverrides('{"m":{"input":1,"output":2,"cacheRead":0.1,"cacheWrite":1.25}}')).toBeNull();
  });

  it('names the problem for malformed values', () => {
    expect(validateModelPriceOverrides('{nope')).toMatch(/JSON/);
    expect(validateModelPriceOverrides('[]')).toMatch(/object/);
    expect(validateModelPriceOverrides('{"m":{"input":1}}')).toMatch(/m/);
  });
});

describe('normalizeModelId', () => {
  it('strips provider prefixes, dated suffixes and context markers', () => {
    expect(normalizeModelId('anthropic/claude-opus-4.5')).toBe('claude-opus-4-5');
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('claude-sonnet-4@20250514')).toBe('claude-sonnet-4');
    expect(normalizeModelId('Claude-Opus-5-5[1m]')).toBe('claude-opus-5-5');
  });
});
