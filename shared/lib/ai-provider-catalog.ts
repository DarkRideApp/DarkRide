// Pure data and helpers. No Node or backend imports: the frontend imports this file.

export type DialectId = 'openai-chat' | 'anthropic-messages' | 'gemini-generate' | 'ollama-chat';

export interface AiProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly shortName: string;
  readonly kind: 'http' | 'cli';
  readonly dialect?: DialectId;
  readonly defaultBaseUrl?: string;
  readonly defaultPath?: string;
  readonly baseUrl: 'hidden' | 'optional' | 'required';
  readonly auth: {
    readonly scheme: 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';
    readonly required: boolean;
    readonly label: string;
    readonly placeholder?: string;
  };
  readonly authHint?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly rateLimitScheme: 'anthropic' | 'x-ratelimit' | 'none';
  readonly defaultModel?: string;
  readonly defaultMaxOutputTokens?: number;
  readonly maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  readonly sendStop?: boolean;
  readonly streamUsage?: 'always' | 'try' | 'never';
  readonly headersTimeoutMs?: number;
  readonly listModels?:
    | { readonly path: string }
    | { readonly static: readonly { readonly id: string; readonly name: string }[] };
  readonly capabilities: {
    readonly tools: boolean;
    readonly fim?: { readonly path: string; readonly modelPattern: string };
  };
}

const MISTRAL_HINT =
  'If this key was issued for the Codestral host, set Base URL to https://codestral.mistral.ai/v1. ' +
  'If it is a La Plateforme key, the Mistral provider type also works.';

export const AI_PROVIDER_CATALOG = [
  {
    id: 'anthropic', label: 'Anthropic', shortName: 'Anthropic', kind: 'http', dialect: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com', baseUrl: 'optional',
    auth: { scheme: 'x-api-key', required: true, label: 'API Key', placeholder: 'sk-ant-...' },
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    rateLimitScheme: 'anthropic', defaultModel: 'claude-sonnet-5-5', defaultMaxOutputTokens: 16000,
    listModels: { path: '/v1/models' }, capabilities: { tools: true },
  },
  {
    id: 'gemini', label: 'Google Gemini', shortName: 'Gemini', kind: 'http', dialect: 'gemini-generate',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com', baseUrl: 'optional',
    auth: { scheme: 'x-goog-api-key', required: true, label: 'API Key' },
    rateLimitScheme: 'none', defaultModel: 'gemini-2.5-flash',
    listModels: { path: '/v1beta/models' }, capabilities: { tools: true },
  },
  {
    id: 'ollama', label: 'Ollama', shortName: 'Ollama', kind: 'http', dialect: 'ollama-chat',
    defaultBaseUrl: 'http://localhost:11434', baseUrl: 'optional',
    auth: { scheme: 'none', required: false, label: 'API Key' },
    rateLimitScheme: 'none', defaultModel: 'llama3.1', headersTimeoutMs: 180000,
    listModels: { path: '/api/tags' }, capabilities: { tools: true },
  },
  {
    id: 'openrouter', label: 'OpenRouter', shortName: 'OpenRouter', kind: 'http', dialect: 'openai-chat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1', defaultPath: '/api/v1', baseUrl: 'optional',
    auth: { scheme: 'bearer', required: true, label: 'API Key' },
    rateLimitScheme: 'x-ratelimit', defaultModel: 'openrouter/auto', streamUsage: 'always',
    listModels: { path: '/models' }, capabilities: { tools: true },
  },
  {
    id: 'codestral', label: 'Codestral', shortName: 'Codestral', kind: 'http', dialect: 'openai-chat',
    defaultBaseUrl: 'https://api.mistral.ai/v1', defaultPath: '/v1', baseUrl: 'optional',
    auth: { scheme: 'bearer', required: true, label: 'API Key' }, authHint: MISTRAL_HINT,
    rateLimitScheme: 'x-ratelimit', defaultModel: 'codestral-latest', streamUsage: 'try',
    listModels: { path: '/models' },
    capabilities: { tools: true, fim: { path: '/fim/completions', modelPattern: '^codestral' } },
  },
  {
    id: 'mistral', label: 'Mistral', shortName: 'Mistral', kind: 'http', dialect: 'openai-chat',
    defaultBaseUrl: 'https://api.mistral.ai/v1', defaultPath: '/v1', baseUrl: 'optional',
    auth: { scheme: 'bearer', required: true, label: 'API Key' }, authHint: MISTRAL_HINT,
    rateLimitScheme: 'x-ratelimit', streamUsage: 'try',
    listModels: { path: '/models' },
    capabilities: { tools: true, fim: { path: '/fim/completions', modelPattern: '^codestral' } },
  },
  {
    id: 'openai', label: 'OpenAI', shortName: 'OpenAI', kind: 'http', dialect: 'openai-chat',
    defaultBaseUrl: 'https://api.openai.com/v1', defaultPath: '/v1', baseUrl: 'optional',
    auth: { scheme: 'bearer', required: true, label: 'API Key', placeholder: 'sk-...' },
    rateLimitScheme: 'x-ratelimit', maxTokensParam: 'max_completion_tokens', sendStop: false, streamUsage: 'always',
    listModels: { path: '/models' }, capabilities: { tools: true },
  },
  {
    id: 'openai-compatible', label: 'OpenAI-compatible', shortName: 'OpenAI-compatible', kind: 'http', dialect: 'openai-chat',
    defaultPath: '/v1', baseUrl: 'required',
    auth: { scheme: 'bearer', required: false, label: 'API Key' },
    rateLimitScheme: 'none', streamUsage: 'try',
    listModels: { path: '/models' }, capabilities: { tools: true },
  },
  {
    id: 'claude-cli', label: 'Claude CLI', shortName: 'Claude CLI', kind: 'cli',
    baseUrl: 'hidden',
    auth: { scheme: 'bearer', required: false, label: 'OAuth Token', placeholder: 'CLAUDE_CODE_OAUTH_TOKEN from setup-token' },
    rateLimitScheme: 'none', defaultModel: 'sonnet',
    listModels: {
      static: [
        { id: 'opus', name: 'Claude Opus (Latest)' },
        { id: 'sonnet', name: 'Claude Sonnet (Latest)' },
        { id: 'haiku', name: 'Claude Haiku (Latest)' },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      ],
    },
    capabilities: { tools: true },
  },
] as const satisfies readonly AiProviderDescriptor[];

export type AiProviderType = (typeof AI_PROVIDER_CATALOG)[number]['id'];
export const AI_PROVIDER_IDS: readonly AiProviderType[] = AI_PROVIDER_CATALOG.map((p) => p.id);

export function getProviderDescriptor(id: string): AiProviderDescriptor | undefined {
  return (AI_PROVIDER_CATALOG as readonly AiProviderDescriptor[]).find((p) => p.id === id);
}
export function isKnownProviderType(s: string): s is AiProviderType {
  return getProviderDescriptor(s) !== undefined;
}
export function isCliProvider(id: string): boolean {
  return getProviderDescriptor(id)?.kind === 'cli';
}

// ── Base URL normalisation ───────────────────────────────────────────

export type NormalizeResult = { ok: true; url: string | null } | { ok: false; error: string };

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata']);

/**
 * Remove every trailing occurrence of one character. A scan from the end, not a `/x+$/` regex: that
 * regex backtracks quadratically on a long run of `x` followed by something else, and this input is
 * user-supplied.
 */
function trimTrailing(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

function isBlockedHost(hostname: string): boolean {
  // Strip IPv6 brackets and trailing dots: `metadata.google.internal.` is the same host as without the dot.
  const host = trimTrailing(hostname.replace(/^\[|\]$/g, '').toLowerCase(), '.');
  if (METADATA_HOSTS.has(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.includes(':') && /^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (host === 'fd00:ec2::254') return true;                      // AWS IPv6 metadata endpoint
  if (/^::ffff:a9fe:[0-9a-f]{1,4}$/.test(host)) return true;      // IPv4-mapped 169.254.x.x (URL normalises to hex)
  return false;
}

export function normalizeBaseUrl(
  descriptor: AiProviderDescriptor,
  input: string | null | undefined,
): NormalizeResult {
  const raw = (input ?? '').trim();
  if (raw === '') return { ok: true, url: null };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'Base URL must be a full http or https URL, for example http://localhost:11434' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Base URL must not contain credentials. Put the key in the API Key field.' };
  }
  if (u.search || raw.includes('?')) {
    return { ok: false, error: 'Base URL must not contain a query string' };
  }
  if (u.hash || raw.includes('#')) {
    return { ok: false, error: 'Base URL must not contain a fragment' };
  }
  if (isBlockedHost(u.hostname)) {
    return { ok: false, error: 'Base URL points at a link-local or metadata address, which is not allowed' };
  }
  let path = trimTrailing(u.pathname, '/');
  if (path === '' && descriptor.defaultPath) path = descriptor.defaultPath;
  return { ok: true, url: `${u.origin}${path}` };
}

/** Compare two stored base URLs by what a request would actually use. */
export function sameEffectiveBaseUrl(
  descriptor: AiProviderDescriptor,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const eff = (v: string | null | undefined): string => {
    const r = normalizeBaseUrl(descriptor, v);
    if (r.ok) return r.url ?? descriptor.defaultBaseUrl ?? '';
    return (v ?? '').trim(); // invalid legacy value: compare as raw text
  };
  return eff(a) === eff(b);
}
