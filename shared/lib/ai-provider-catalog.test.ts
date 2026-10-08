import { describe, it, expect } from 'vitest';
import {
  AI_PROVIDER_CATALOG, AI_PROVIDER_IDS, getProviderDescriptor, isKnownProviderType,
  isCliProvider, normalizeBaseUrl, sameEffectiveBaseUrl,
} from './ai-provider-catalog';

const d = (id: string) => getProviderDescriptor(id)!;

describe('catalog invariants', () => {
  it('has unique ids', () => {
    expect(new Set(AI_PROVIDER_IDS).size).toBe(AI_PROVIDER_IDS.length);
  });
  it('every http provider names a dialect, every cli provider does not', () => {
    for (const p of AI_PROVIDER_CATALOG) {
      if (p.kind === 'http') expect(p.dialect, p.id).toBeTruthy();
      else expect('dialect' in p && (p as any).dialect, p.id).toBeFalsy();
    }
  });
  it('baseUrl hidden only for cli; required has no default URL', () => {
    for (const p of AI_PROVIDER_CATALOG) {
      if (p.baseUrl === 'hidden') expect(p.kind).toBe('cli');
      if (p.baseUrl === 'required') expect((p as any).defaultBaseUrl).toBeUndefined();
    }
  });
  it('contains the legacy ids unchanged', () => {
    for (const id of ['anthropic', 'gemini', 'ollama', 'openrouter', 'codestral', 'claude-cli']) {
      expect(isKnownProviderType(id), id).toBe(true);
    }
  });
  it('claude-cli is the only cli provider and has default model sonnet', () => {
    expect(isCliProvider('claude-cli')).toBe(true);
    expect(isCliProvider('anthropic')).toBe(false);
    expect(d('claude-cli').defaultModel).toBe('sonnet');
  });
  it('every default base URL is itself a valid base URL and survives normalisation unchanged', () => {
    for (const p of AI_PROVIDER_CATALOG) {
      const url = (p as any).defaultBaseUrl as string | undefined;
      if (!url) continue;
      const r = normalizeBaseUrl(p as any, url);
      expect(r.ok, p.id).toBe(true);
      expect((r as any).url, p.id).toBe(url);
    }
  });
  it('golden values', () => {
    expect(d('anthropic')).toMatchObject({ defaultBaseUrl: 'https://api.anthropic.com', dialect: 'anthropic-messages', defaultModel: 'claude-sonnet-5-5', defaultMaxOutputTokens: 16000 });
    expect(d('gemini')).toMatchObject({ dialect: 'gemini-generate', defaultModel: 'gemini-2.5-flash' });
    expect(d('ollama')).toMatchObject({ defaultBaseUrl: 'http://localhost:11434', defaultModel: 'llama3.1', headersTimeoutMs: 180000 });
    expect(d('codestral')).toMatchObject({ defaultBaseUrl: 'https://api.mistral.ai/v1', defaultModel: 'codestral-latest' });
    expect(d('openai')).toMatchObject({ maxTokensParam: 'max_completion_tokens', sendStop: false });
    expect(d('openai-compatible')).toMatchObject({ baseUrl: 'required', defaultPath: '/v1', streamUsage: 'try' });
  });
});

describe('normalizeBaseUrl', () => {
  const ok = (id: string, input: string | null | undefined) => {
    const r = normalizeBaseUrl(d(id), input);
    if (!r.ok) throw new Error(r.error);
    return r.url;
  };
  const bad = (id: string, input: string) => {
    const r = normalizeBaseUrl(d(id), input);
    expect(r.ok).toBe(false);
    return (r as any).error as string;
  };

  it('empty means use the default', () => {
    expect(ok('anthropic', '')).toBeNull();
    expect(ok('anthropic', '   ')).toBeNull();
    expect(ok('anthropic', undefined)).toBeNull();
  });
  it('trims, drops trailing slashes, keeps an explicit path', () => {
    expect(ok('anthropic', '  https://proxy.test/ ')).toBe('https://proxy.test');
    expect(ok('openai-compatible', 'http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
    expect(ok('openai-compatible', 'https://gw.test/custom/path')).toBe('https://gw.test/custom/path');
  });
  it('appends defaultPath to a bare host only', () => {
    expect(ok('openai-compatible', 'http://localhost:1234')).toBe('http://localhost:1234/v1');
    expect(ok('codestral', 'https://api.mistral.ai')).toBe('https://api.mistral.ai/v1');
    expect(ok('ollama', 'http://host:11434')).toBe('http://host:11434');
  });
  it('lowercases scheme and host, keeps IPv6 brackets', () => {
    expect(ok('ollama', 'HTTP://Example.COM:11434')).toBe('http://example.com:11434');
    expect(ok('ollama', 'http://[::1]:11434')).toBe('http://[::1]:11434');
  });
  it('rejects non-http schemes and schemeless hosts', () => {
    expect(bad('ollama', 'ftp://x.test')).toMatch(/http/);
    expect(bad('ollama', 'localhost:11434')).toMatch(/http/);
  });
  it('rejects credentials, query, and fragment (including a bare ? or #)', () => {
    expect(bad('ollama', 'https://user:pw@host.test')).toMatch(/credentials/);
    expect(bad('ollama', 'https://host.test/?key=abc')).toMatch(/query/);
    expect(bad('ollama', 'https://host.test/?')).toMatch(/query/);      // URL.search is '' for a bare ?
    expect(bad('ollama', 'https://host.test/#x')).toMatch(/fragment/);
    expect(bad('ollama', 'https://host.test/#')).toMatch(/fragment/);
  });
  it('rejects link-local and metadata hosts but allows loopback and RFC1918', () => {
    bad('ollama', 'http://169.254.169.254/latest');
    bad('ollama', 'http://[fe80::1]:11434');
    bad('ollama', 'http://[::ffff:a9fe:a9fe]/');       // IPv4-mapped 169.254.169.254
    bad('ollama', 'http://[fd00:ec2::254]/');          // AWS IPv6 metadata
    bad('ollama', 'http://metadata.google.internal');
    expect(ok('ollama', 'http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(ok('ollama', 'http://192.168.1.20:11434')).toBe('http://192.168.1.20:11434');
  });
  it('rejects trailing-dot (absolute FQDN) forms of blocked hosts', () => {
    bad('ollama', 'http://metadata.google.internal./');
    bad('ollama', 'http://metadata.google.internal../');
    bad('ollama', 'http://metadata./');
    bad('ollama', 'http://METADATA.GOOGLE.INTERNAL./');
    bad('ollama', 'http://169.254.169.254./latest');
    bad('ollama', 'http://[::ffff:a9fe:a9fe]./');       // not a valid URL; must stay rejected either way
    bad('ollama', 'http://[::ffff:169.254.169.254]/');
  });
  it('still accepts an ordinary host written with a trailing dot', () => {
    const r = normalizeBaseUrl(d('ollama'), 'http://localhost.:11434');
    expect(r.ok).toBe(true);
    expect(ok('ollama', 'http://example.com.:11434')).toBe('http://example.com.:11434');
  });
});

describe('sameEffectiveBaseUrl', () => {
  it('treats null and the default as equal, and ignores trailing slashes', () => {
    expect(sameEffectiveBaseUrl(d('anthropic'), null, 'https://api.anthropic.com/')).toBe(true);
    expect(sameEffectiveBaseUrl(d('anthropic'), 'https://a.test', 'https://b.test')).toBe(false);
  });
  it('an invalid legacy stored value compares as its raw trimmed text', () => {
    expect(sameEffectiveBaseUrl(d('ollama'), 'localhost:11434', 'localhost:11434')).toBe(true);
    expect(sameEffectiveBaseUrl(d('ollama'), 'localhost:11434', 'http://localhost:11434')).toBe(false);
  });
});
