import { describe, it, expect } from 'vitest';
import {
  baseUrlRedirects, providerFormShape, providerTypeOptions, providerNeedsKeyBadge, savingClearsKey, validateProviderForm,
} from './ai-provider-form';

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

describe('baseUrlRedirects', () => {
  it('is false for the same URL, however it is written', () => {
    expect(baseUrlRedirects('ollama', 'http://localhost:11434', 'http://localhost:11434')).toBe(false);
    expect(baseUrlRedirects('ollama', 'http://localhost:11434', 'http://localhost:11434/')).toBe(false);
    expect(baseUrlRedirects('ollama', 'http://localhost:11434', '  http://localhost:11434  ')).toBe(false);
  });
  it('compares what a request would use: an empty URL is the default, and the default path is implied', () => {
    expect(baseUrlRedirects('ollama', null, 'http://localhost:11434')).toBe(false);
    expect(baseUrlRedirects('ollama', 'http://localhost:11434', '')).toBe(false);
    expect(baseUrlRedirects('openai', null, 'https://api.openai.com')).toBe(false);
    expect(baseUrlRedirects('openai', 'https://api.openai.com/v1', null)).toBe(false);
  });
  it('is true for another host, port or path', () => {
    expect(baseUrlRedirects('ollama', null, 'http://other:11434')).toBe(true);
    expect(baseUrlRedirects('ollama', 'http://localhost:11434', 'http://localhost:11435')).toBe(true);
    expect(baseUrlRedirects('openai', null, 'https://api.openai.com/other')).toBe(true);
  });
  it('is false when nothing was sent', () => {
    expect(baseUrlRedirects('ollama', 'http://localhost:11434', undefined)).toBe(false);
  });
  it('is always false for a type that never sends the URL anywhere', () => {
    expect(baseUrlRedirects('claude-cli', null, 'http://elsewhere')).toBe(false);
    expect(baseUrlRedirects('claude-cli', 'http://stale', null)).toBe(false);
  });
  it('compares trimmed text for a type the catalog no longer has', () => {
    expect(baseUrlRedirects('retired', 'http://a', ' http://a ')).toBe(false);
    expect(baseUrlRedirects('retired', null, '')).toBe(false);
    expect(baseUrlRedirects('retired', '', null)).toBe(false);
    expect(baseUrlRedirects('retired', 'http://a', 'http://b')).toBe(true);
    expect(baseUrlRedirects('retired', null, 'http://b')).toBe(true);
  });
  it('treats an invalid stored value as raw text', () => {
    expect(baseUrlRedirects('ollama', 'not a url', 'not a url')).toBe(false);
    expect(baseUrlRedirects('ollama', 'not a url', 'http://localhost:11434')).toBe(true);
  });
});

describe('savingClearsKey', () => {
  it('is true when the type changes, even for a type with no Base URL', () => {
    expect(savingClearsKey({ type: 'anthropic', baseUrl: null }, { type: 'gemini', baseUrl: null })).toBe(true);
    expect(savingClearsKey({ type: 'anthropic', baseUrl: null }, { type: 'claude-cli', baseUrl: null })).toBe(true);
  });
  it('is true when requests would go to another host or path', () => {
    expect(savingClearsKey({ type: 'ollama', baseUrl: null }, { type: 'ollama', baseUrl: 'http://other:11434' })).toBe(true);
  });
  it('is false for a rename-style save: same type, same effective URL', () => {
    expect(savingClearsKey({ type: 'ollama', baseUrl: 'http://localhost:11434' }, { type: 'ollama', baseUrl: 'http://localhost:11434' })).toBe(false);
    expect(savingClearsKey({ type: 'ollama', baseUrl: null }, { type: 'ollama', baseUrl: '' })).toBe(false);
    expect(savingClearsKey({ type: 'ollama', baseUrl: 'http://localhost:11434' }, { type: 'ollama', baseUrl: undefined })).toBe(false);
  });
  it('is false for a type that never sends the URL, whatever the form holds', () => {
    expect(savingClearsKey({ type: 'claude-cli', baseUrl: null }, { type: 'claude-cli', baseUrl: 'http://x' })).toBe(false);
  });
  it('follows the retired-type rule for a type the catalog no longer has', () => {
    expect(savingClearsKey({ type: 'retired', baseUrl: 'http://a' }, { type: 'retired', baseUrl: ' http://a' })).toBe(false);
    expect(savingClearsKey({ type: 'retired', baseUrl: 'http://a' }, { type: 'retired', baseUrl: 'http://b' })).toBe(true);
    expect(savingClearsKey({ type: 'retired', baseUrl: 'http://a' }, { type: 'anthropic', baseUrl: 'http://a' })).toBe(true);
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
