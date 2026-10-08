import { describe, it, expect } from 'vitest';
import { providerFormShape, providerTypeOptions, providerNeedsKeyBadge, validateProviderForm } from './ai-provider-form';

describe('providerFormShape', () => {
  it('anthropic shows a required key and an optional base url with the default as placeholder', () => {
    expect(providerFormShape('anthropic')).toMatchObject({
      showKey: true, keyRequired: true, keyLabel: 'API Key', keyTestId: 'provider-api-key-input',
      showBaseUrl: true, baseUrlRequired: false, baseUrlPlaceholder: 'https://api.anthropic.com', isCli: false, modelRequired: false,
    });
  });
  it('ollama hides the key and shows base url', () => {
    expect(providerFormShape('ollama')).toMatchObject({ showKey: false, showBaseUrl: true });
  });
  it('openai-compatible: optional key, required base url, model required', () => {
    expect(providerFormShape('openai-compatible')).toMatchObject({ showKey: true, keyRequired: false, showBaseUrl: true, baseUrlRequired: true, modelRequired: true });
  });
  it('claude-cli keeps the oauth testid, hides base url, is cli', () => {
    expect(providerFormShape('claude-cli')).toMatchObject({ showKey: true, keyRequired: false, keyLabel: 'OAuth Token', keyTestId: 'provider-oauth-token-input', showBaseUrl: false, isCli: true, modelRequired: false });
  });
  it('an unknown stored type falls back to a permissive shape instead of throwing', () => {
    expect(providerFormShape('legacy-thing')).toMatchObject({ showKey: true, showBaseUrl: true, isCli: false });
  });
});

describe('providerTypeOptions', () => {
  it('lists every catalog entry with its label, claude-cli included', () => {
    const o = providerTypeOptions();
    expect(o.find((x) => x.value === 'gemini')).toEqual({ value: 'gemini', label: 'Google Gemini' });
    expect(o.map((x) => x.value)).toContain('openai-compatible');
    expect(o.map((x) => x.value)).toContain('claude-cli');
  });
});

describe('providerNeedsKeyBadge', () => {
  it('only when a key is required and missing', () => {
    expect(providerNeedsKeyBadge('anthropic', false)).toBe(true);
    expect(providerNeedsKeyBadge('anthropic', true)).toBe(false);
    expect(providerNeedsKeyBadge('ollama', false)).toBe(false);
    expect(providerNeedsKeyBadge('openai-compatible', false)).toBe(false);
    expect(providerNeedsKeyBadge('claude-cli', false)).toBe(false);
  });
});

describe('validateProviderForm', () => {
  it('requires a base url for openai-compatible', () => {
    expect(validateProviderForm('openai-compatible', '')).toEqual({ ok: false, error: expect.stringMatching(/required/i) });
    expect(validateProviderForm('openai-compatible', 'http://localhost:1234')).toEqual({ ok: true });
  });
  it('flags a malformed url', () => {
    expect(validateProviderForm('ollama', 'localhost:11434')).toEqual({ ok: false, error: expect.stringMatching(/http/) });
    expect(validateProviderForm('ollama', '')).toEqual({ ok: true });
  });
});
