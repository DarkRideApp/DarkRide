import { describe, it, expect } from 'vitest';
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW_TOKENS } from './ai-model-context';

describe('contextWindowFor', () => {
  it.each([
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ])('%s has a 1M-token window', (model) => {
    expect(contextWindowFor(model)).toBe(1_000_000);
  });

  it.each([
    'anthropic/claude-opus-5-5',
    'us.anthropic.claude-sonnet-4-6-v1:0',
    'claude-opus-5-5@20261001',
    'Claude-Sonnet-5.5',
  ])('reads the model out of the spelling %s', (model) => {
    expect(contextWindowFor(model)).toBe(1_000_000);
  });

  it('keeps the 200K window for a Claude model that has no 1M window', () => {
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('assumes 200K for a model it does not know, so compaction starts early rather than late', () => {
    expect(contextWindowFor('gpt-5')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowFor('some/local-model')).toBe(200_000);
  });

  it('assumes 200K when there is no model id', () => {
    expect(contextWindowFor(undefined)).toBe(200_000);
    expect(contextWindowFor(null)).toBe(200_000);
    expect(contextWindowFor('')).toBe(200_000);
    expect(contextWindowFor('   ')).toBe(200_000);
  });
});
