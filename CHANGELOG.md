# Changelog

All notable user-facing changes to DarkRide are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Plugin SDK 1.5.0** — `ctx.documentStore` (`DocStoreApi`: `putDoc`/`getDoc`) is now available to plugins as a typed handle over the host Document Store. Accessible from `start()` — throws if accessed during `register()`. Includes an in-memory test fixture `createInMemoryDocStore` exported from `@darkrideapp/plugin-sdk/test-utils`. Non-breaking minor bump (1.4.0 → 1.5.0).
- **AI providers** are now defined by a catalog and four wire dialects. New provider types: `openai`, `mistral`, and `openai-compatible` (any OpenAI-style server, for example LM Studio, vLLM, or a gateway). See `docs/ai-providers.md`.
- **Fallback on exhausted credits.** When a model's API credits or spend limit run out, or its provider is overloaded or unreachable, the next model in the tier is tried instead of the request failing.
- Anthropic requests use prompt caching, which cuts the cost of long agent sessions.

### Changed

- Anthropic: blank-model rows now default to `claude-sonnet-5-5`; `max_tokens` is 16000; a model refusal is shown as a message instead of an empty reply.
- Gemini: the API key is sent in a header instead of the URL; default model is `gemini-2.5-flash` (2.0 Flash has been shut down). Tool results now carry the real function name.
- OpenRouter and Gemini now honour the Base URL field. Existing stored values for these two types are cleared by a one-time migration because they were never used.
- Codestral now uses `api.mistral.ai/v1` for chat, test, model listing, and FIM. If your key was issued for the Codestral host, set Base URL to `https://codestral.mistral.ai/v1`.
- Editing a provider's Base URL or type clears its saved API key unless you enter a new one. Redirects are no longer followed when calling providers.
- Inline code completion (`/v1/ai/complete`) now uses models in the `Low` tier. Installs without one keep working through the old settings keys, which are deprecated.
- Reported input tokens now include cached tokens.
- A model whose provider has no default (OpenAI, Mistral, OpenAI-compatible) must be chosen explicitly; blank-model OpenRouter rows now default to `openrouter/auto`.

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
