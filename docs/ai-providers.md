# AI providers

DarkRide talks to language models through a provider catalog and four wire dialects.
Provider facts (URLs, auth, defaults) live in `shared/lib/ai-provider-catalog.ts`. Wire
behaviour lives in `backend/services/ai/dialects/`.

## Supported providers

| Type | Dialect | Default base URL | Notes |
|---|---|---|---|
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | Prompt caching is on for chat. Max and Team plan API credits apply to this type, not to Claude Code. |
| `gemini` | Gemini `generateContent` | `https://generativelanguage.googleapis.com` | Gemini 3.x function calling needs thought signatures, which are not supported yet. Use a 2.5 model. |
| `ollama` | Ollama `/api/chat` | `http://localhost:11434` | No key. |
| `openrouter` | OpenAI chat completions | `https://openrouter.ai/api/v1` | |
| `openai` | OpenAI chat completions | `https://api.openai.com/v1` | A model must be chosen. |
| `mistral` | OpenAI chat completions | `https://api.mistral.ai/v1` | A model must be chosen. |
| `codestral` | OpenAI chat completions + FIM | `https://api.mistral.ai/v1` | Keys issued for the Codestral host need Base URL `https://codestral.mistral.ai/v1`. |
| `openai-compatible` | OpenAI chat completions | none (required) | LM Studio, vLLM, llama.cpp server, Together, Groq, DeepSeek, and similar. A bare host gets `/v1` appended. |
| `claude-cli` | local `claude` binary | n/a | Uses the server's Claude CLI login. |

## Base URLs

A Base URL must be `http` or `https`, with no credentials, query string, or fragment. A bare
host (`http://localhost:1234`) gets the provider's default path appended. Link-local and cloud
metadata addresses are rejected. Loopback and private-network addresses are allowed.
Redirects are not followed, because a redirect could forward the API key to another host.
DNS rebinding is not addressed: a hostname that resolves to a different address at request
time is not re-checked, so only grant provider-editing access to people you trust.

Changing a saved provider's type or Base URL clears its stored key unless a new key is
supplied in the same request.

## Errors and fallback

Models in a tier are tried in priority order. The router moves to the next model when a call
fails **before any output** with one of: rate limit (429), exhausted credits or spend limit,
provider overload (502, 503, 529), a rejected key (401, 403), or a connection failure. After
output has started, errors are surfaced instead, because falling back would duplicate text.
Credit and key failures cool down every model that uses the same provider entry.

## Adding a provider

For an OpenAI-compatible API, add one entry to `AI_PROVIDER_CATALOG`:

```ts
{
  id: 'groq', label: 'Groq', shortName: 'Groq', kind: 'http', dialect: 'openai-chat',
  defaultBaseUrl: 'https://api.groq.com/openai/v1', defaultPath: '/openai/v1', baseUrl: 'optional',
  auth: { scheme: 'bearer', required: true, label: 'API Key' },
  rateLimitScheme: 'none', listModels: { path: '/models' }, capabilities: { tools: true },
},
```

Then add one row to the golden table in
`backend/services/ai/__tests__/conformance.test.ts` (id, expected URL, expected auth header).
The conformance suite checks request shape, streaming, error classification, and key
redaction for every catalog entry. Nothing else changes: the settings form, model listing,
connection test, and router all read the catalog.

A provider with a different wire format needs a new dialect implementing the `Dialect`
interface in `backend/services/ai/dialect.ts`, with recorded fixtures for text, tool calls,
usage, errors, and truncation.

## Live checks

`npm run test:ai-live` runs real requests against every provider whose key is in the
environment (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`MISTRAL_API_KEY`, `CODESTRAL_API_KEY`, `OLLAMA_BASE_URL`). It spends tokens, is never run in
CI, and prints no response bodies.

## Known limits

- Anthropic `thinking` blocks and Gemini thought signatures are not carried between tool
  turns, so models that think lose their earlier reasoning at each tool step.
- The tiered research/write path does not fall back across models.
- The built-in agent assumes a 200k-token context window when deciding to compact.
