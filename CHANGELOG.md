# Changelog

All notable user-facing changes to DarkRide are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Plugin SDK 1.5.0** — `ctx.documentStore` (`DocStoreApi`: `putDoc`/`getDoc`) is now available to plugins as a typed handle over the host Document Store. Accessible from `start()` — throws if accessed during `register()`. Includes an in-memory test fixture `createInMemoryDocStore` exported from `@darkrideapp/plugin-sdk/test-utils`. Non-breaking minor bump (1.4.0 → 1.5.0).

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
