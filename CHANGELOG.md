# Changelog

All notable user-facing changes to DarkRide are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Plugin SDK 1.5.0** — `ctx.documentStore` (`DocStoreApi`: `putDoc`/`getDoc`) is now available to plugins as a typed handle over the host Document Store. Accessible from `start()` — throws if accessed during `register()`. Includes an in-memory test fixture `createInMemoryDocStore` exported from `@darkrideapp/plugin-sdk/test-utils`. Non-breaking minor bump (1.4.0 → 1.5.0).
- **AI providers** are now defined by a catalog and four wire dialects. New provider types: `openai`, `mistral`, and `openai-compatible` (any OpenAI-style server, for example LM Studio, vLLM, or a gateway). See `docs/ai-providers.md`.
- **Fallback to the next model on more failures.** Within a tier, the router tries the next model when a call fails with a rate limit, exhausted credits or spend limit, provider overload, a rejected key (401; for Gemini also a 403 `PERMISSION_DENIED`), or a connection error (including a connection that drops while the reply is streaming), and only before any output has been produced. A 403 from any other provider also falls back to the next model but starts no cooldown, because it usually means a blocked request or a model the key may not use. A caller cancel is never treated as a provider failure. Exhausted credits and a rejected key put every model on the same provider into cooldown. A rate limit or connection error cools down only that model, and overload starts no cooldown. Saving a provider clears the cooldowns of its models.
- Anthropic chat and agent requests use prompt caching, which cuts the cost of long agent sessions. Inline completion and connection tests do not use it.
- `npm run test:ai-live` runs real requests against each provider whose API key is set in the environment. It is opt-in and never runs in `npm test` or CI.
- **AI usage panel** in Settings → AI and `GET /v1/ai/usage/report`. Every agent run now records each model request (model, tokens, cache reads and writes, fallbacks) and an estimated cost, so you can see spend and cache hit rate per purpose (chat, APK analysis, APK diff, plugins), per day and per run. Costs come from a price table for Anthropic models and show `n/a` for unpriced models; override prices with the `ai_model_prices` setting. Inline completion is not included. A new migration adds the `ai_call_request` table.

### Changed

- Anthropic: blank-model rows now default to `claude-sonnet-5-5`; `max_tokens` is 16000; a model refusal is shown as a message instead of an empty reply. Requests no longer send `temperature`, no longer send an empty `x-api-key` header when no key is set, and omit an empty system prompt. Reported input tokens now include cached tokens.
- Gemini: the API key is sent in the `x-goog-api-key` header instead of the URL; default model is `gemini-2.5-flash` (Google shut down 2.0 Flash on 2026-06-01). Tool results now carry the real function name, thinking tokens count as output tokens, `thought` parts are not shown, and an empty system prompt is omitted. Tool calls are replayed with the ids Google sent, and Gemini 3 turns carry Google's documented placeholder thought signature so multi-step tool use is accepted (real signatures are not kept yet). Safety, recitation and other unexpected stops now show a message instead of an empty reply, and a reply that is cut off before any text is an error.
- OpenRouter: blank-model rows now default to `openrouter/auto`.
- OpenRouter and Gemini now honour the Base URL field. Existing stored values for these two types are cleared by a one-time migration because they were never used.
- Ollama: tool-call arguments are sent as a JSON object instead of a string.
- Codestral now uses `api.mistral.ai/v1` for chat, test, model listing, and FIM, and blank-model rows default to `codestral-latest` (was `mistral-large-latest`). If your key was issued for the Codestral host, set Base URL to `https://codestral.mistral.ai/v1`. A stored Base URL that has a path is used as entered; only a bare host gets `/v1` appended.
- OpenAI-style providers (`openai`, `openrouter`, `mistral`, `codestral`, `openai-compatible`) report token usage through `stream_options`. If a Mistral, Codestral, or OpenAI-compatible server rejects the option, the request is retried once without it.
- The Base URL field is now shown for every provider type except Claude CLI (it was Ollama only) and is validated: `http` or `https` only, no credentials, query string, or fragment, and link-local and cloud metadata addresses are rejected. OpenAI-compatible requires one.
- Editing a provider's Base URL or type clears its saved API key unless you enter a new one. API keys are trimmed and must be printable ASCII, and provider and model names must not be blank.
- Redirects are no longer followed when calling providers, so a redirect cannot forward the API key to another host. A redirect now fails with an error that says so: `<Name> answered with a redirect. Redirects are not followed because they could forward the API key. Use the final URL as Base URL.`
- Provider errors read `<Name> API error (<status>): <provider message>`, with the API key masked.
- Requests fail with `<Name> did not respond within 60s` when no response headers arrive in 60 s (Ollama: 180 s). The connection test, model test, and model listing give up after 15 s with `<Name> did not respond within 15s`.
- Inline code completion (`/v1/ai/complete`) now uses the enabled models of the `Low` tier only, with the fallback above, and skips Claude CLI models. Installs without a usable `Low` tier model keep working through the old settings keys, which are deprecated. A provider error returns 502 with a redacted message (it was 500 for a network failure). An unexpected error returns 500 with the fixed message `Inline completion failed`. A client that disconnects cancels the upstream request and gets no response. On Gemini models that think by default, completion turns thinking down so the 256-token budget is not spent before any text.
- OpenAI-style streams: a tool call cut off by the output limit now fails with an output-limit error instead of running with empty arguments. A content-filter stop shows a message, Mistral's `model_length` stop is handled like an output limit, and a single streamed line over 8 MB is rejected. A model list over 50,000 entries is rejected.
- A model whose provider has no default (OpenAI, Mistral, OpenAI-compatible) must be chosen explicitly. Saving a blank model for one of these is rejected with 400 and a message such as `OpenAI has no default model. Choose a model.`

### Deprecated

- The `ai_provider` setting and the per-provider settings `anthropic_api_key`, `gemini_api_key`, `openrouter_api_key`, `codestral_api_key`, `ollama_base_url`, `ollama_model`, and `openrouter_model`. `/v1/ai/complete` still honours them, but only when the `Low` tier has no usable model, and a startup migration copies them into providers and models. Configure providers and models in Settings → AI instead.

## [1.0.0] — 2026-05-17

Initial public release.

DarkRide is a self-hosted toolkit for Android device control, network traffic capture, APK analysis, and Frida instrumentation. See [README.md](README.md) for the full feature list and [docs/](docs/) for in-depth guides.

- **Device control** — H.264 live streaming via scrcpy + WebCodecs; adaptive bitrate; adb-screencap fallback; hardware buttons; per-device proxy and TLS profile.
- **TypeScript automation engine** — Monaco-edited scripts with full `DeviceAPI` typings; cron/HTTP triggers; popup-rule system; session history with logs, screenshots, and captured traffic; AI completion via multiple providers.
- **HTTPS traffic capture** — WireGuard transparent proxy + mitmproxy; auto SSL injection on rooted devices; filtering, block/hide lists; WebSocket capture with pluggable protocol decoders; TLS fingerprint spoofing.
- **Frida instrumentation** — In-browser IDE, script library, spawn/attach, live output; managed `frida-server` releases; Frida Gadget injection for non-rooted devices.
- **APK analysis** — Decompilation, resource extraction, React Native / Hermes bundle inspection, protobuf schema extraction, AI-powered version diffs, cross-device version tracking.
- **AI agent** — Page-aware chat with tool access; MCP server; auto-generated SKILL.md for the Claude Code CLI; REST tool invocation; `ctx.tools` from automation scripts.
- **Plugin system** — Plugins contribute nav, pages, API routes, AI tools, DB tables, jobs, settings, notification events, commands, protocol decoders, and plugin-to-plugin hooks. Signed manifest + content-pin verification on install; per-plugin migrations; npm-distributed.
- **iOS** — USB device discovery + HTTPS traffic capture work today. Screen control, automation, and Frida are Android-only — see [ROADMAP.md](ROADMAP.md) for the iOS work plan.

[Unreleased]: https://github.com/DarkRideApp/DarkRide/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/DarkRideApp/DarkRide/releases/tag/v1.0.0
