# AI providers

DarkRide talks to language models through a provider catalog and four wire dialects.
Provider facts (URLs, auth, defaults) live in `shared/lib/ai-provider-catalog.ts`. Wire
behaviour lives in `backend/services/ai/dialects/`.

Providers and models are managed in Settings → AI. A provider holds a type, an API key, and
an optional Base URL. A model row picks a provider, a model id, and a tier.

## Supported providers

| Type | Dialect | Default base URL | Default model | Notes |
|---|---|---|---|---|
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | `claude-sonnet-5-5` | Chat and agent requests use prompt caching. Inline completion and connection tests do not. See [Claude plans and API credits](#claude-plans-and-api-credits). |
| `gemini` | Gemini `generateContent` | `https://generativelanguage.googleapis.com` | `gemini-2.5-flash` | Gemini 3.x function calling needs thought signatures, which are not supported yet. Use a 2.5 model. |
| `ollama` | Ollama `/api/chat` | `http://localhost:11434` | `llama3.1` | No key. Waits up to 180 s for response headers (60 s for the other types). |
| `openrouter` | OpenAI chat completions | `https://openrouter.ai/api/v1` | `openrouter/auto` | `openrouter/auto` lets OpenRouter choose the model for each request. Choose a model to pin one. |
| `openai` | OpenAI chat completions | `https://api.openai.com/v1` | none | A model must be chosen. Sends `max_completion_tokens` and no stop sequences. |
| `mistral` | OpenAI chat completions + FIM | `https://api.mistral.ai/v1` | none | A model must be chosen. Inline completion uses fill-in-the-middle (FIM) when the model id starts with `codestral`. |
| `codestral` | OpenAI chat completions + FIM | `https://api.mistral.ai/v1` | `codestral-latest` | Inline completion uses FIM when the model id starts with `codestral`. Keys issued for the Codestral host need Base URL `https://codestral.mistral.ai/v1`. |
| `openai-compatible` | OpenAI chat completions | none (required) | none | LM Studio, vLLM, llama.cpp server, LiteLLM, and hosted services with an OpenAI-style API. A model must be chosen and a Base URL is required. The key is optional. A bare host gets `/v1` appended, so enter the full URL if the API lives under a different path. |
| `claude-cli` | local `claude` binary | n/a | `sonnet` | Runs Claude Code with the server's Claude CLI login, or with a `setup-token` OAuth token saved on the provider. Not used for inline completion. See [Claude plans and API credits](#claude-plans-and-api-credits). |

### Claude plans and API credits

The `anthropic` type calls the Claude API with a Claude Console API key. Claude Max and Team
plans include monthly credits for the Claude API
([Anthropic's description](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)).
Those credits pay for `anthropic` calls made with a key from the Console organization linked
to the plan. They do not cover Claude Code, so they do not pay for `claude-cli`. When the
credits run out, Anthropic answers "Your credit balance is too low", which the router treats
as exhausted credits and moves on to the next model.

### Request details by dialect

- **Anthropic Messages**: sends `anthropic-version: 2023-06-01`. Omits `x-api-key` when no key
  is set and omits `system` when the system prompt is empty. `max_tokens` is 16000 unless the
  caller sets one. Never sends `temperature`, `top_p`, `top_k`, `thinking`, or `tool_choice`.
  Reported input tokens include cache reads and writes. A model refusal is shown as a message
  instead of an empty reply.
- **Gemini**: the key goes in the `x-goog-api-key` header, never the URL. Omits
  `systemInstruction` when the system prompt is empty. Tool results carry the real function
  name. `thought` parts are not shown, and thinking tokens count as output tokens. An invalid
  key (HTTP 400 `API_KEY_INVALID`) is treated as a rejected key.
- **Ollama**: tool-call arguments are sent as a JSON object.
- **OpenAI chat completions** (`openai`, `openrouter`, `mistral`, `codestral`,
  `openai-compatible`): token usage is requested with `stream_options.include_usage`. `openai`
  and `openrouter` always send it. The other three send it too, and if the server rejects the
  option the request is retried once without it, and the server is remembered until DarkRide
  restarts.

## Base URLs

The Base URL field is shown for every type except `claude-cli`. Leave it empty to use the
default. A Base URL is checked when you save it and again before each request.

- It must be `http` or `https`, with no credentials, query string, or fragment.
- Trailing slashes are removed. A URL with a path is used as entered. A bare host
  (`http://localhost:1234`) gets the type's default path appended: `/v1` for `openai`,
  `mistral`, `codestral`, and `openai-compatible`, `/api/v1` for `openrouter`. `anthropic`,
  `gemini`, and `ollama` have no default path.
- `openai-compatible` requires one.
- Loopback and private-network addresses are allowed, because local servers are a main use.
- Link-local and cloud metadata addresses are rejected. Exactly: the hostnames
  `metadata.google.internal` and `metadata` (with or without a trailing dot), the IPv4 range
  `169.254.0.0/16` (the decimal, hex, and octal spellings of these are converted to dotted
  form by the URL parser and rejected too), IPv6 link-local `fe80::/10`, the AWS IPv6 metadata
  address `fd00:ec2::254`, and IPv4-mapped `169.254.x.x` (`::ffff:169.254.x.x`).

## Security notes

- **Redirects are not followed.** A redirect could forward the API key to another host. A
  provider that answers with one fails with `<Name> answered with a redirect. Redirects are
  not followed because they could forward the API key. Use the final URL as Base URL.`
- **DNS rebinding is not addressed.** A hostname that resolves to a different address at
  request time is not re-checked.
- **Some metadata encodings are not blocked.** The Base URL check does not reject NAT64
  `64:ff9b::a9fe:a9fe`, IPv4-compatible `::a9fe:a9fe`, `::ffff:0:a9fe:a9fe`, 6to4
  `2002:a9fe:a9fe::`, the `instance-data` and `metadata.goog` host aliases, or other clouds'
  metadata addresses such as `100.100.100.200` (Alibaba Cloud) and `192.0.0.192` (Oracle
  Cloud). Provider editing decides which addresses the server contacts, so only grant it
  (`core.settings:write`) to people you trust.
- **Changing a provider's type or effective Base URL clears its stored key** unless the same
  request supplies a new key. "Effective" means what a request would use: leaving the field
  empty and entering the default URL are the same, so re-saving the default keeps the key.
- **Keys are trimmed and must be printable ASCII.** A key with an inner space, a control or
  invisible character, or a non-ASCII character is rejected on save. The API never returns a
  stored key, only `hasApiKey`. Provider error messages mask the key and any URL credentials.
- **Names are validated.** A provider or model name must be a non-empty string. It is trimmed.

## Errors and fallback

Provider failures fall into seven classes:

| Class | Typical cause |
|---|---|
| Rate limit | HTTP 429, or 402 with a `Retry-After` header |
| Exhausted credits or quota | HTTP 402, an `insufficient_quota` error, Anthropic's "credit balance is too low", a Gemini per-day quota |
| Overload | HTTP 502, 503, 529, 408 |
| Rejected key | HTTP 401; for Gemini also a 403 with status `PERMISSION_DENIED` (a leaked, disabled or restricted key) and a 400 `API_KEY_INVALID` |
| Permission denied | any other HTTP 403: a moderation or guardrail block, a key without access to one model, a region or organisation restriction |
| Refusal | the model declined the request: an Anthropic `refusal` stop (for example its cyber safeguard), a Gemini safety or prompt block, an OpenAI-style `content_filter` |
| Connection | network failure, no response headers in time, a redirect, a dropped connection while a response is being read or streamed |

Models in a tier are tried in priority order. The router moves to the next model when a call
fails with one of these seven classes **before any output has been produced**. After text or a
tool call has been produced, the error is surfaced instead, because falling back would
duplicate output. Any other error, such as a 400 or 404, is surfaced immediately. A 403 is not
treated as a rejected key because most providers use it for a blocked request or a model the
key may not use, which says nothing about the other models on the credential. It falls back to
the next model and starts no cooldown, since it is often specific to one prompt. A caller
cancel is never a provider failure: no fallback and no cooldown. A failure that was already in
flight when you saved the provider does not start a cooldown either.

A refusal is about the request, not the model, so it falls back to the next model and starts no
cooldown. If every model that was tried refused, the request fails with the first model's own
message (for Anthropic it names the category and, for `cyber`, the Cyber Verification Program)
instead of the generic "rate-limited or unavailable" text. A refusal that arrives after the model
has already started answering keeps the partial answer and adds the message, as before.

APK analysis and APK diff runs go through the same fallback: each tier of the run is served by
the router, so a refusal or a rate limit on the first model moves the run to the next model of the
tier instead of ending it. When a run still fails, the APK page gets an "AI Analysis Failed" note
with the reason.

Cooldowns last the model's cooldown minutes (default 10):

- A rate limit or a connection failure cools down only that model.
- Exhausted credits and a rejected key belong to the credential, so every model on the same
  provider entry cools down.
- Overload, permission denied and refusals start no cooldown. A key that is refused on every model
  therefore costs one failed request per model on each call.
- Saving a provider clears the cooldowns of its models, so a corrected key works at once.

When every model has failed or is cooling down, the request fails with
`All AI models are rate-limited or unavailable:` followed by one line per model with its
reason.

Provider errors read `<Name> API error (<status>): <provider message>`. The message comes from
the response body, with the key and URL credentials masked, cut at 500 characters. For
Mistral and Codestral a rejected key adds a hint about the Codestral host.

## Timeouts

- Chat and completion requests fail with `<Name> did not respond within 60s` when no response
  headers arrive in time (180 s for Ollama). The limit covers the wait for headers only.
- The connection test and the model test have a 15 s limit for the whole request, body
  included, and fail with `<Name> did not respond within 15s`. Model listing applies the same
  15 s limit to each page and follows pagination for at most 10 pages (so up to 150 s in the
  worst case). A list over 50,000 models fails with `<Name> model list is too large`.
- A single streamed line longer than 8 MB fails with `<Name> sent a line longer than 8 MB`.

## Testing a provider

The provider test sends a one-turn generation capped at 16 output tokens when the type has a
default model and uses a key, because some APIs list models even with a bad key or no credit.
Otherwise (no default model, or a type with no key such as Ollama) it lists the models and
reports the count. A rate limit counts as success, since the key works. The model test sends
the same 16-token generation to the chosen model. `claude-cli` is tested by running
`claude --version`, and its model test also checks that the CLI can use tools.

## Inline completion

`POST /v1/ai/complete` completes from the enabled models of the `Low` tier and never from
another tier. The fallback and cooldown rules above apply. `claude-cli` models are skipped,
because the CLI has no HTTP completion. On a `mistral` or `codestral` provider a model whose
id starts with `codestral` uses FIM. Every other model gets a chat request with the cursor
marked `<CURSOR>` and no tools. Output is capped at 256 tokens and cut at the first run of
three newlines. If the Low tier has no usable model, the deprecated settings below apply.

## Usage and cost

Every agent run (chat, APK analysis, APK diff, and plugin AI runs) is recorded in `ai_call_log`,
and each model request inside a run in `ai_call_request`: the model id, the provider type,
prompt tokens (including cache), cache read and write tokens, output tokens, an estimated cost,
and the models that were skipped or failed before this one served the request. Billed requests
are what count, so a research-tier request whose output was thrown away after escalating to the
write model is recorded, and so is the summary request made when a long conversation is
compacted. Prompts and replies are not stored.

Settings → AI → "AI usage" shows this for the last 7, 30 or 90 days: totals, cache hit rate,
cost per purpose (chat, APK analysis, APK diff, each plugin), cost per day, and the most recent
runs with their models, turns, tool calls and fallbacks. The same data is available from
`GET /v1/ai/usage/report` (see `docs/api.md`).

Costs are estimates. The price table covers Anthropic models and comes from Anthropic's pricing
page (fetched 2026-10-08). It ignores batch discounts, fast mode and negotiated pricing, and it
prices cache writes at the 5-minute rate because requests use the default 5-minute cache. A
model with no price in the table, including an alias such as `sonnet` and any model on another
provider, shows `n/a`, never zero. To add or replace prices, set `ai_model_prices` to a JSON
object keyed by model id, each value `{ "input": 3, "output": 15, "cacheRead": 0.3,
"cacheWrite": 3.75 }` in USD per million tokens. An invalid value is rejected with a 400.

Not recorded: inline completion (the provider returns text only), requests cancelled before
their first output, and the per-request detail of runs from before this feature (their token
totals still count, their cost shows `n/a`).

## Deprecated settings

`ai_provider`, `anthropic_api_key`, `gemini_api_key`, `openrouter_api_key`,
`codestral_api_key`, `ollama_base_url`, `ollama_model`, and `openrouter_model` are the
settings from before providers and models existed. The UI does not write them and the
Settings API still accepts them. They are read in two places:

- `/v1/ai/complete`, only when the Low tier has no usable model (no enabled model, or only
  `claude-cli` models). The first use after a restart is logged as a deprecation notice.
  Supported values of `ai_provider` are `anthropic`, `gemini`, `ollama`, `openrouter`, and
  `codestral`. This path uses `claude-haiku-4-5-20251001` for Anthropic, `codestral-latest`
  on `https://codestral.mistral.ai/v1` for Codestral, and the catalog default model for
  Gemini. Ollama uses `ollama_base_url` and `ollama_model` (default `qwen2.5-coder:1.5b`),
  and OpenRouter uses `openrouter_model` (default `openrouter/auto`).
- A startup migration that copies them into provider entries (named `<Provider> (Settings)`)
  and, when no model rows exist yet, into model rows. The legacy chat settings
  `ai_chat_provider` and `ai_chat_model` are read by this migration only.

## Adding a provider

For an OpenAI-compatible API that takes a bearer token, add one entry to `AI_PROVIDER_CATALOG`:

```ts
{
  id: 'groq', label: 'Groq', shortName: 'Groq', kind: 'http', dialect: 'openai-chat',
  defaultBaseUrl: 'https://api.groq.com/openai/v1', defaultPath: '/openai/v1', baseUrl: 'optional',
  auth: { scheme: 'bearer', required: true, label: 'API Key' },
  rateLimitScheme: 'none', listModels: { path: '/models' }, capabilities: { tools: true },
},
```

Then add one row to the golden table in
`backend/services/ai/__tests__/conformance.test.ts`: the expected URL and auth header, plus a
`baseUrl` or `model` when the type has no default. The conformance suite checks request shape,
streaming, error classification, and key redaction for every catalog entry. Nothing else
changes: the settings form, model listing, connection test, and router all read the catalog.

Only the `openai-chat` dialect reads `auth.scheme`, and it sends a bearer token. The Anthropic
and Gemini dialects set their own key header and Ollama sends none, so a host that needs a
different auth header or a key in the query string needs a change in the dialect, plus a
golden-table row.

Keep provider ids out of comparisons everywhere except the catalog and the dialects. A test
(`backend/services/ai/__tests__/provider-branch-guard.test.ts`) catches direct comparisons such
as `type === 'openai'` or a `case 'gemini':`. It does not catch lookups through a table, a
`Set`, or a named constant, so treat it as a safety net and put provider-specific behaviour in
the catalog or a dialect.

If you only need to use a service yourself, the `openai-compatible` type works with no code
change. Add a catalog entry when the service should be its own type with its own defaults.

A provider with a different wire format needs a new dialect implementing the `Dialect`
interface in `backend/services/ai/dialect.ts`, registered in
`backend/services/ai/registry.ts` and added to `DialectId` in the catalog. Cover it with
fixtures for text, tool calls, usage, errors, and truncation.

## Live checks

`npm run test:ai-live` runs `tests/live/ai-providers.live.test.ts` through
`vitest.live.config.ts`. It makes real requests to every provider whose credentials are in the
environment: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`MISTRAL_API_KEY`, `CODESTRAL_API_KEY`, or `OLLAMA_BASE_URL` (no key). Set
`AI_LIVE_<PROVIDER>_MODEL`, for example `AI_LIVE_OPENAI_MODEL`, to pin the model. It is
required for `openai` and `mistral`, which have no default. With nothing set, every suite is
skipped and no request is made. The lane spends tokens, is excluded from `npm test` and from
CI, and prints no keys or response bodies.

## Known limits

- Anthropic `thinking` blocks and Gemini thought signatures are not carried between tool
  turns, so models that think lose their earlier reasoning at each tool step.
- The tiered research/write path does not fall back across models.
- The built-in agent assumes a 200k-token context window when deciding to compact.
