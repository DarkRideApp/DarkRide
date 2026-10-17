# AI providers

DarkRide talks to language models through a provider catalog and four wire dialects.
Provider facts (URLs, auth, defaults) live in `shared/lib/ai-provider-catalog.ts`. Wire
behaviour lives in `backend/services/ai/dialects/`.

Providers and models are managed in Settings → AI. A provider holds a type, an API key, and
an optional Base URL. A model row picks a provider, a model id, and a tier.

## Supported providers

| Type | Dialect | Default base URL | Default model | Notes |
|---|---|---|---|---|
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | `claude-sonnet-5-5` | Chat and agent requests use prompt caching. Inline completion caches only its system prompt (the code around the cursor changes on every call), and connection tests do not use caching. See [Claude plans and API credits](#claude-plans-and-api-credits). |
| `gemini` | Gemini `generateContent` | `https://generativelanguage.googleapis.com` | `gemini-2.5-flash` | Thought signatures are kept with the conversation and sent back, which function calling on Gemini 3 and later (Gemini 4 included) requires; see [Provider data on stored messages](#provider-data-on-stored-messages). |
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
  Reported input tokens include cache reads and writes. A model refusal before any output is an
  error the router falls back on; a refusal after the model has started answering ends the stream
  with a `refusal` event and the output of that turn is discarded (see Errors and fallback).
- **Gemini**: the key goes in the `x-goog-api-key` header, never the URL. Omits
  `systemInstruction` when the system prompt is empty. Tool results carry the real function
  name. `thought` parts are not shown, and thinking tokens count as output tokens. An invalid
  key (HTTP 400 `API_KEY_INVALID`) is treated as a rejected key. Inline completion limits
  thinking so the 256-token budget is not spent on it: a budget of 0 on 2.5 Flash and
  Flash-Lite, 128 on 2.5 Pro, and level `low` on Gemini 3 and later (Gemini 4 cannot turn
  thinking off). Chat and agent requests set no thinking option. "Gemini 3 and later" is
  decided by the model id: a number of 3 or more right after `gemini-` (`gemini-3.8-flash`,
  `gemini-4-argon`). Aliases such as `gemini-flash-latest` have no number, so they are
  treated as older models; choose the versioned id (for example `gemini-3.8-flash`) to get
  the Gemini 3 handling.
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
has already started answering cannot fall back, because the caller may already hold output. For
Anthropic, which says to treat output from a refused stream as incomplete, the text and tool calls
of that turn are dropped: the stored and shown turn is the refusal message alone, no tool call of
that turn runs, and later turns never replay it. A tiered run counts a refused research turn as
final (no escalation to the write tier) and a refused write turn as declining to write. A refused
context-compaction summary is dropped and the conversation keeps its full history. Inline
completion treats a refusal after partial output like one before any output and tries the next
model. Gemini and OpenAI-style providers still keep the partial answer and add the message. In a
background run the message is just text, so such a run is not recorded as failed.

Within one run, a model that refused is not asked again by that run's later requests, and the
research and write providers of a tiered run share that memory. Refusals start no cooldown, so
without it a run whose context holds the refused content would pay for a refused request on
every turn. The next run starts fresh.

APK analysis and APK diff runs go through the same fallback: each tier of the run is served by
the router, so a refusal or a rate limit on the first model moves the run to the next model of the
tier instead of ending it. The fallback only helps when the tier holds more than one enabled
model. If the write tier declines a write the research model asked for, the research model's write
is used, as when a write model declines for any other reason. Tiered runs now respect cooldowns,
like chat: a model cooled down by inline completion is skipped.

When an APK analysis run fails, the APK page gets one "AI Analysis Failed" note with the latest
reason, and a later run that completes removes it. The APK diff summary only logs a failure and
does not write a note.

Anthropic bills a refusal before any output only in the `bio`, `frontier_llm` and
`reasoning_extraction` categories. The usage monitor does not record the tokens of a refused
attempt that fell back, so a refusal in one of those categories is billed but not counted there.

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
three newlines. `prefix` and `suffix` must be strings, and together at most 100,000 characters;
otherwise the request is refused with 400 or 413 before any provider is called. If the Low tier
has no usable model, the deprecated settings below apply.

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

### Would a 1-hour prompt cache be cheaper?

Requests use Anthropic's 5-minute prompt cache. A 1-hour cache writes at twice the input price
instead of 1.25 times, so it only pays when the gaps between requests in one conversation run
past five minutes, which happens in a chat you come back to. `scripts/ai-cache-ttl-whatif.ts`
replays the recorded requests under both lifetimes and prints, per purpose, how many follow-up
requests came more than five minutes and more than an hour after the one before, the two
prompt costs, and which lifetime wins:

```bash
npx tsx scripts/ai-cache-ttl-whatif.ts --days 30
npx tsx scripts/ai-cache-ttl-whatif.ts --db /path/to/copy-of-darkride.db
```

It reads the database (`DATABASE_PATH`, or `--db`) and nothing else: it changes nothing and
makes no AI request, so it is safe to run while the server is up. The figures cover prompt
tokens only, use the price table above, and leave out requests on a model with no price. Runs do
not record which chat they belong to, so chat runs of one user on one page are joined when a
later run starts with a longer prompt than the earlier one ended with. There is no setting for a
1-hour cache yet; this report is what decides whether one is worth adding.

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
  rateLimitScheme: 'none', listModels: { path: '/models' },
},
```

Then add one row to the golden table in
`backend/services/ai/__tests__/conformance.test.ts`: the expected URL and auth header, plus a
`baseUrl` or `model` when the type has no default. The conformance suite checks request shape,
streaming, error classification, and key redaction for every catalog entry. Nothing else
changes: the settings form, model listing, connection test, and router all read the catalog.

Every dialect sends the key through `authHeaders` in `backend/services/ai/http.ts`, which reads
`auth.scheme`: `bearer` sends `Authorization: Bearer <key>`, `x-api-key` and `x-goog-api-key`
send the key in a header of that name, and `none` sends nothing. A host that needs another
header name or a key in the query string needs a new scheme in `authHeaders` or a change in
the dialect, plus a golden-table row.

Keep provider ids out of comparisons everywhere except the catalog and the dialects. A test
(`backend/services/ai/__tests__/provider-branch-guard.test.ts`) catches direct comparisons such
as `type === 'openai'` or a `case 'gemini':`, `includes`, `indexOf` and `Set.has` with a
provider id, and lookups such as `({ openai: 1 })[type]` or `table['openai']`. It skips test
files, `__tests__` and `test-utils` directories, and `test-helpers.ts`. It does not catch an id
held in a named constant or table, `startsWith` or a regular expression on an id, or an id
passed to a catalog function such as `getProviderDescriptor('claude-cli')`, so treat it as a
safety net and put provider-specific behaviour in the catalog or a dialect.

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

## Provider data on stored messages

Some responses carry data a provider wants back on a later turn. The dialect attaches it to the
text or tool call it arrived with as `providerData` (`{ dialect, model, data }`), and it is stored
with the conversation. Only the dialect named in `dialect` reads it, and only when the request
is for the model that wrote it: another model, another dialect, or history that has none behaves
as before. A turn's text block keeps the last data its text events carried, and a tool call keeps
its own. The browser never gets it: the conversation endpoints leave it out. Compaction replaces
the history with new messages, so the data goes with the blocks it belonged to.

Gemini uses it for thought signatures. A response puts the signature on the first function call
of a step (Gemini 3 and later require it back) and on the last part of an answer without calls (optional),
and while streaming that part can have empty text. The dialect keeps each one and sends it back in
the part it came from. A first function call with no stored signature still gets Google's documented
placeholder, as does one whose signature was written for a different model, for example after a
fallback or when the compaction request runs on another model of the tier.

## Context compaction

When a turn's prompt reaches 55% of the context window, the agent asks the model for a summary of the run so
far and carries on from that summary in place of the history. The window is the model's: 1M tokens for the
current Claude models (`shared/lib/ai-model-context.ts`), 200K for any other model and for a request whose
provider does not report the model, so an unlisted model compacts early, never late. A run that several
models served is measured against the smallest, because the router can send the next request to any of them.
The percentage shown in the chat and on the APK analysis page uses the same window.

The summary request carries the run's system prompt and tools, because Anthropic does not accept tool calls
in the history of a request that defines no tools, and so that the request extends the prefix the run has
already cached. The instruction tells the model not to call a tool. A reply that calls one anyway is
discarded and the history is kept, as it is for a refusal or an error.

## Known limits

- Anthropic `thinking` blocks are not carried between tool turns, so models that think lose
  their earlier reasoning at each tool step. The API rejects a thinking block that is sent back
  after anything before it changed (the system prompt, the tool list or an earlier message) on
  accounts created on or after 2026-08-31, and the agent changes the tool list when it loads
  more tools and rewrites the history when it compacts. Sending them needs a way to know the
  history is unchanged, so they are dropped, which the API allows.
- The tiered research/write path does not fall back across models.
- The built-in agent knows the context window of the current Claude models only. A model of another
  provider with a longer window is taken to have 200K tokens and compacts earlier than it needs to.
- Haiku 5.5 charges higher rates for a prompt over 100K tokens, and the agent does not compact it until 55%
  of its 1M window.
