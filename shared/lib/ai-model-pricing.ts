/**
 * Estimated per-model token prices, used to put an approximate dollar figure on each AI request.
 *
 * Rates are USD per million tokens, taken from Anthropic's pricing page
 * (https://platform.claude.com/docs/en/about-claude/pricing), fetched 2026-10-08. They are estimates:
 * they ignore batch discounts, fast mode, data-residency multipliers and negotiated pricing. A model that is
 * not in the table has no price, and its cost is reported as `null`, never as zero.
 *
 * Cache writes are priced at the 5-minute rate because requests use the default 5-minute cache TTL.
 * Cache reads are not always 0.1x of input: Fable 5.1 and Mythos 5.1 read at 0.025x, Opus 5.5 and
 * Sonnet 5.5 at 0.05x, so each model carries its own read rate.
 *
 * An install can add or replace prices with the `ai_model_prices` setting: a JSON object keyed by model id,
 * each value `{ input, output, cacheRead, cacheWrite }` in USD per million tokens.
 */

export interface ModelPrice {
  /** Uncached prompt tokens. */
  input: number;
  output: number;
  /** Prompt tokens served from the cache. */
  cacheRead: number;
  /** Prompt tokens written to the cache with the 5-minute TTL. */
  cacheWrite5m: number;
  /** Higher rates that apply to the whole request once the prompt is over `thresholdTokens`. */
  longPrompt?: { thresholdTokens: number; input: number; output: number; cacheRead: number; cacheWrite5m: number };
}

/** One entry of the `ai_model_prices` setting, as stored. */
export interface ModelPriceOverride {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ModelPriceOverrides = Record<string, ModelPriceOverride>;

const p = (input: number, output: number, cacheWrite5m: number, cacheRead: number): ModelPrice => ({
  input, output, cacheWrite5m, cacheRead,
});

/** Keyed by normalised model id (see `normalizeModelId`). */
const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': p(10, 50, 12.5, 0.25),
  'claude-mythos-5-1': p(10, 50, 12.5, 0.25),
  'claude-opus-5-5': p(4, 20, 5, 0.2),
  'claude-sonnet-5-5': p(2, 10, 2.5, 0.1),
  // Haiku 5.5 is priced by prompt length: a prompt over 100,000 tokens pays the higher rates.
  'claude-haiku-5-5': {
    ...p(0.1, 0.5, 0.125, 0.01),
    longPrompt: { thresholdTokens: 100_000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheRead: 0.05 },
  },
  'claude-fable-5': p(10, 50, 12.5, 1),
  'claude-mythos-5': p(10, 50, 12.5, 1),
  'claude-opus-5': p(5, 25, 6.25, 0.5),
  'claude-opus-4-8': p(5, 25, 6.25, 0.5),
  'claude-opus-4-7': p(5, 25, 6.25, 0.5),
  'claude-opus-4-6': p(5, 25, 6.25, 0.5),
  'claude-opus-4-5': p(5, 25, 6.25, 0.5),
  'claude-opus-4-1': p(15, 75, 18.75, 1.5),
  'claude-opus-4': p(15, 75, 18.75, 1.5),
  'claude-opus-4-0': p(15, 75, 18.75, 1.5),
  'claude-sonnet-5': p(2, 10, 2.5, 0.2),
  'claude-sonnet-4-6': p(3, 15, 3.75, 0.3),
  'claude-sonnet-4-5': p(3, 15, 3.75, 0.3),
  'claude-sonnet-4': p(3, 15, 3.75, 0.3),
  'claude-sonnet-4-0': p(3, 15, 3.75, 0.3),
  'claude-haiku-4-5': p(1, 5, 1.25, 0.1),
  'claude-3-5-haiku': p(0.8, 4, 1, 0.08),
  'claude-haiku-3-5': p(0.8, 4, 1, 0.08),
};

/**
 * Reduce the many spellings of one model to the table key: lower case, no provider prefix
 * (`anthropic/`, `us.anthropic.`), no dated snapshot (`-20250514`, `@20250514`), no version tag (`-v1:0`),
 * no context marker (`[1m]`), and dashes instead of dots (`4.5` -> `4-5`).
 */
export function normalizeModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@.*$/, '')
    .replace(/^.*anthropic[./]/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\./g, '-');
}

function isRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isOverride(v: unknown): v is ModelPriceOverride {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return isRate(o.input) && isRate(o.output) && isRate(o.cacheRead) && isRate(o.cacheWrite);
}

/**
 * Read the `ai_model_prices` setting. Accepts the raw string or a parsed object. Invalid JSON, a non-object,
 * or an entry without four finite non-negative rates is ignored; this never throws.
 */
export function parseModelPriceOverrides(raw: unknown): ModelPriceOverrides {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ModelPriceOverrides = {};
  for (const [model, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isOverride(entry)) continue;
    out[model] = { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite };
  }
  return out;
}

/** Check a proposed `ai_model_prices` value. Returns an error message, or `null` when it is acceptable. */
export function validateModelPriceOverrides(raw: string): string | null {
  if (!raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'ai_model_prices must be valid JSON';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'ai_model_prices must be a JSON object keyed by model id';
  }
  for (const [model, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isOverride(entry)) {
      return `ai_model_prices["${model}"] needs input, output, cacheRead and cacheWrite as non-negative numbers (USD per million tokens)`;
    }
  }
  return null;
}

/**
 * The price for a model: an override first (by exact id, then by normalised id), then the built-in table.
 * Returns `null` when the model has no known price.
 */
export function priceFor(modelId: string | null | undefined, overrides?: unknown): ModelPrice | null {
  if (!modelId || !modelId.trim()) return null;
  const normalized = normalizeModelId(modelId);
  if (overrides !== undefined && overrides !== null) {
    const parsed = parseModelPriceOverrides(overrides);
    const hit = parsed[modelId] ?? parsed[normalized]
      ?? Object.entries(parsed).find(([k]) => normalizeModelId(k) === normalized)?.[1];
    if (hit) return { input: hit.input, output: hit.output, cacheRead: hit.cacheRead, cacheWrite5m: hit.cacheWrite };
  }
  const known = PRICES[normalized];
  return known ? { ...known } : null;
}

export interface CostInput {
  model?: string | null;
  /** Total prompt tokens, including cache reads and writes. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/**
 * Estimated cost of one request in USD, or `null` when the model has no known price.
 * Uncached input is the total prompt minus cache reads and writes, floored at zero.
 */
export function estimateCostUsd(req: CostInput, overrides?: unknown): number | null {
  const price = priceFor(req.model, overrides);
  if (!price) return null;
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(req.inputTokens);
  const cacheRead = n(req.cacheReadTokens);
  const cacheWrite = n(req.cacheWriteTokens);
  const output = n(req.outputTokens);
  const rates = price.longPrompt && input > price.longPrompt.thresholdTokens ? price.longPrompt : price;
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  return (uncached * rates.input + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite5m + output * rates.output) / 1_000_000;
}
