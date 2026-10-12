# Architecture

DarkRide is a self-hosted Android device automation and instrumentation platform. This document describes the system architecture and key design decisions. For developer workflow (running locally, adding migrations, testing) see [`development.md`](development.md). For plugin authoring see [`plugins/README.md`](plugins/README.md).

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Frontend (React, Vite)                         │
│  Core pages + plugin-contributed pages, nav, settings, decoders, …   │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ HTTP + WebSocket (REST-over-WS)
┌──────────────────────────────────┴───────────────────────────────────┐
│                       Backend (Express + WS, Node 24)                  │
│   API ─► Services ─► Database (SQLite + Drizzle, WAL)                 │
│   │                                                                    │
│   │   ┌──── Plugin system ────────────────────────────────────┐      │
│   │   │  Discovery → register() → start() → stop()             │      │
│   │   │  ctx surface: db, api, tools, jobs, settings, hooks,   │      │
│   │   │               files, peer<T>, cloudStorage, runner, …  │      │
│   │   │  Core never name-references a plugin.                  │      │
│   │   └────────────────────────────────────────────────────────┘      │
└──┬──────────────┬──────────────┬─────────────────────────────────────┘
   │              │              │
   ▼              ▼              ▼
 ADB          Python         mitmproxy
(devices)     Bridge         (WireGuard)
```

The backend runs as a single Node.js process. All core + plugin API endpoints register on a shared Express router and are also available over WebSocket via the `restapi` action. Plugins are auto-discovered at boot from `plugins/<name>/` (in-tree workspace plugins) and `data/installed-plugins/node_modules/@*/plugin-*/` (managed installs from the Marketplace).

## Database

SQLite via better-sqlite3 (synchronous) with Drizzle ORM. WAL mode enabled for concurrent reads.

### Tables

The core schema lives in `backend/db/schema.ts` (~49 tables grouped by domain). Plugin tables live alongside core under the `plugin_<slug>__<table>` naming convention and are owned by their plugin.

| Domain | Representative tables |
|---|---|
| Devices + sessions | `devices`, `automations`, `automation_sessions`, `screenshots` |
| Traffic | `captured_traffic`, `websocket_messages`, `saved_traffic`, `blocked_domains`, `hidden_domains`, `intercept_rules`, `client_certs` |
| API catalogue | `api_endpoints`, `api_endpoint_groups`, `api_endpoint_sessions`, `api_endpoint_query_params` |
| APK analysis | `tracked_apps`, `apk_versions`, `apk_contents`, `apk_diff_reports`, `analysis_jobs`, `apk_notes`, `injected_apks` |
| Frida | `frida_scripts`, `frida_releases` |
| Proxies + credentials | `proxies`, `credentials`, `settings` |
| AI | `ai_conversations`, `ai_providers`, `ai_models`, `ai_tiers`, `ai_call_log` |
| Notifications + jobs | `notification_channels`, `notification_history`, `notification_queue`, `job_config` |
| Cloud storage | `cloud_files`, `db_size_snapshots` |
| Plugins | `plugin_state`, `plugin_sources`, `plugin_migrations`, `plugin_installs`, `trusted_signing_keys` |
| Auth | `users`, `sessions`, `api_keys`, `password_reset_tokens` |
| System | `system_state` |

Browse the full schema in `backend/db/schema.ts` — every table is a single Drizzle `sqliteTable()` declaration with inline comments.

### Migrations

SQL files in `migrations/`. Multi-statement migrations use `--> statement-breakpoint` between statements (required by better-sqlite3's `prepare()`).

Commands:
- `npm run db:generate` -- generate migration from schema changes
- `npm run db:migrate` -- apply pending migrations
- `npm run db:studio` -- open visual DB browser

### Pruning

`backend/db/prune.ts` runs daily at 3 AM. Deletes automation sessions, screenshots (files + DB rows), captured traffic, WebSocket messages, and injected APKs older than `PRUNE_DAYS` (default: 7, except injected APKs which use a 3-day TTL). Pinned sessions and their related data are excluded. Delete order respects FK constraints.

## Device Management

`DeviceManager` (singleton) monitors USB-connected devices via `adb track-devices`. Each device gets:

- Automatic model/manufacturer/SDK detection on connect
- A Python bridge process (ports 9100-9199)
- scrcpy-server JAR pushed for H.264 live stream; minicap (API < 33) + minitouch pushed for touch input and legacy fallback
- Standby after 60s inactivity (screen off + ATX stop)
- Busy tracking for automations, capture, and Frida sessions (10-min timeout with 2-min warning)

### Setup Flow

On first connect (or version change), the device goes through setup:
1. Push scrcpy-server JAR + minicap (API < 33) + minitouch binaries (architecture-matched)
2. Push ATX agent for uiautomator2
3. Install WireGuard app (if rooted)
4. Install mitmproxy CA certificate (if rooted)
5. Generate WireGuard keypair and tunnel config

## ADB Proxy

`AdbProxyService` (`backend/services/adb-proxy/`) lets other machines run `adb connect` against Android devices attached to this host. It is off by default.

- **One port per device.** Each online Android device gets a persistent TCP port from a configurable range (default 6500 to 6599), stored in `adb_proxy_devices`. The port speaks the ADB wire protocol as a device would, one connection per client. The service follows `DeviceManager` through a small `DeviceDirectory` interface (`device-directory.ts`) and, while the proxy is on, also compares its own device list with it every 5 seconds (it does no background work while off). The same check retries a device whose port another process holds, and a device that found the range full once a port is free. A port is taken back only when a device without one needs it and the range is full: the offline device whose port row is oldest loses it, and a device with proxying disabled never does. The service ignores devices that are its own listeners (`adb connect` to a proxy port from the same host).
- **Authentication.** A client must prove it holds its adb key by signing a token issued on that connection. A key it offers is honoured only when a signature it already sent on this connection verifies under that key, so a public key alone never authenticates and never creates a request. A proven key that is approved gets in. A denied or revoked key is closed. An unknown key becomes an in-memory pending request, shown live in Settings → ADB Proxy and held for up to 5 minutes, and the client stays `unauthorized` meanwhile. An admin with `core.adb-proxy:manage` denies it; approving also needs `core.devices:shell`, because an approved key gets a shell on every proxied device. Decisions are stored in `adb_proxy_keys`.
- **Forwarding.** Each client stream becomes a fresh connection to the host's ADB server (`ANDROID_ADB_SERVER_ADDRESS` and `ANDROID_ADB_SERVER_PORT`, default `127.0.0.1:5037`): `host:transport:<serial>`, then the service string. Services starting with `host`, and `reverse:`, `tcpip:` and `usb:`, are refused with `CLSE`. The proxy advertises a maximum payload of 256 KiB. A session closes when the ADB server refuses the transport for its device, after a `reboot` service ends, and after a `root:` or `unroot:` service whose output says adbd is restarting (a production build refuses `root:` and the session stays open).
- **Abuse limits.** Unauthenticated sockets are capped per source address and in total, and pending requests are capped and rate limited per source address. A connection keeps its unauthenticated slot and its 10 second deadline until the proxy sends `CNXN`, so the device banner fetch is covered; concurrent sessions for one device share a single banner fetch, and its result is kept for 5 seconds. The per-key session caps count sessions that are still finishing and are checked before the banner is fetched. Log lines that a peer without an approved key can provoke share one rate-limited budget. The numbers are in the user guide.
- **Live updates.** The service pushes its full status snapshot as an `adb-proxy` message on a filtered WebSocket channel, after any change including a stream opening or closing, coalesced to one message per 50 ms. Only clients that held `core.adb-proxy:read` when they subscribed receive it. The page counts elapsed times itself from a shared one-second clock (`useNow`).

REST endpoints live in `backend/api/adb-proxy.ts` and the page in `frontend/pages/settings/AdbProxyPage.tsx`. User guide: [`adb-proxy.md`](adb-proxy.md). Design: [`specs/2026-10-11-adb-proxy-design.md`](specs/2026-10-11-adb-proxy-design.md).

## Python Bridge

Each device gets its own Python process running `python/bridge.py`. Communication is via JSON-RPC over HTTP (localhost:PORT/rpc).

Responsibilities:
- uiautomator2 device control (tap, swipe, getText, waitFor, DOM queries)
- Frida CLI management (spawn, attach, message relay)
- Frida Gadget APK injection (via frida_tools.apk.inject)

The bridge is started on-demand by `PythonBridgeManager` and reused across automation runs.

## HTTPS Traffic Capture

### WireGuard Tunnel

Each device gets a unique WireGuard tunnel. mitmproxy runs in WireGuard mode (`--mode wireguard`), creating a virtual TUN interface. Traffic routing uses `ip rule` + custom routing table 51820.

Key details:
- Server IP auto-detected (prefers 192.168.x.x to avoid VPN interfaces)
- One mitmdump process per device during capture
- `flow.request.host` returns IPs in WireGuard mode -- use `flow.request.pretty_url` for hostnames
- `flow.kill()` unreliable in WireGuard -- use `flow.response = http.Response.make(403)` instead

### mitmproxy Bridge

`python/mitmproxy_bridge.py` hooks into mitmproxy to forward traffic to the Node.js backend via webhook. Features:

- Request/response capture with headers and bodies
- WebSocket traffic capture (registered from 101 responses, not `websocket_start` which doesn't exist in mitmproxy 12.x)
- Domain blocklist enforcement
- Real-time traffic interception hooks for automations (`device.http.hook()`)
- TLS fingerprint spoofing (Chrome 120 Android profile via `tls_start_server` hook)
- NordVPN SOCKS5 upstream proxy (monkey-patches `loop.sock_connect` in the `running()` hook)

### Proxy Chain

For NordVPN routing: mitmproxy -> local HTTP CONNECT bridge (`socks-proxy-server.ts`) -> SOCKS5 (NordVPN). The bridge is needed because mitmproxy doesn't support SOCKS5 upstream natively.

## Automation Engine

### Compiler

`AutomationCompiler` compiles TypeScript automation code to JavaScript using the TypeScript compiler API. Automations run in a Node.js VM sandbox with the `DeviceAPI` injected as context.

### Runner

`AutomationRunner` executes automations sequentially per device (parallel across devices). Each run:
1. Wakes the device
2. Optionally starts HTTPS capture
3. Compiles and executes the automation in a VM sandbox
4. Captures screenshots, logs, and traffic into a session
5. Puts the device back to sleep

### Rule System

Automations can be flagged as "rules" with a priority. Rules run automatically when triggered by conditions (e.g., popup detection) during other automation runs.

### Scheduling

`AutomationScheduler` uses cron expressions to trigger automations on a schedule. Managed via the API.

## Frida Integration

### Rooted Devices

1. Push frida-server binary to device (version-matched to Python frida package)
2. Start frida-server via ADB
3. Spawn or attach to apps with JavaScript hooks via the `frida` CLI
4. Message relay through the Python bridge

### Non-Rooted Devices (Gadget Mode)

1. Pull source APK from device (Apps page)
2. Inject Frida Gadget .so into APK (via `frida_tools.apk.inject`)
3. Sign with auto-generated debug keystore
4. Install injected APK on device
5. Attach by app name (`frida -n appName`)

Injected APKs are cached for 3 days keyed on `(packageName, versionCode, fridaVersion)`.

`FridaReleaseManager` syncs releases from GitHub and manages both frida-server and frida-gadget binaries.

## Frontend

React SPA built with Vite. Key pages:

- **Dashboard** -- device overview with status indicators
- **Device View** -- live screen stream, touch input, hardware buttons, DOM capture
- **Automations** -- Monaco editor with TypeScript, session history, live log
- **Sessions** -- recorded automation runs with timeline and timestamped screenshots
- **Traffic** -- filterable request list, detail view, WebSocket frames
- **Frida IDE** -- script editor, app selector, gadget mode for non-rooted devices
- **Apps** -- tracked app versions, APK pull/install, gadget injection, Play Store fetcher
- **APK Analysis** -- static analysis findings, React Native bundle viewer, version diffs, AI review
- **Plugins** -- one workspace (Installed and Discover tabs) to browse the marketplace, install, update, enable, and uninstall plugins; signature + content verification on install

Communication with backend uses both REST (fetch) and WebSocket (for real-time updates and REST-over-WS).

## Plugin System

Plugins are first-class citizens, not afterthoughts. The plugin model is documented in depth at [`plugins/README.md`](plugins/README.md) and the topic-specific guides under [`plugins/`](plugins/); the architectural shape:

- **Discovery.** At boot, `backend/plugins/discover.ts` scans `plugins/<name>/` for in-tree workspace plugins and `data/installed-plugins/node_modules/@*/plugin-*/` for managed installs (Marketplace, CLI, or `DARKRIDE_PLUGIN_DIRS`). Each plugin exports a `definePlugin({...})` default.
- **Lifecycle.** `register(ctx)` is synchronous, declarative metadata only (nav, pages, settings keys, tools, jobs, hooks). `start(ctx)` is async — services, peer wiring, route registration, scheduled jobs. `stop(ctx)` is best-effort cleanup.
- **`ctx` surface.** Plugins get `ctx.db<Schema>()` (typed Drizzle over their own tables), `ctx.api(api => ...)` for HTTP + WS-REST endpoints, `ctx.tools([...])` for AI/MCP/automation-callable tools, `ctx.jobs([...])` for cron, `ctx.settings` for KV persistence, `ctx.hooks.{define,on,emit}` for pub/sub, `ctx.files()` for namespaced file storage, `ctx.cloudStorage` for S3-compatible backends, `ctx.peer<T>('other-plugin')` for cross-plugin RPC.
- **Per-plugin migrations.** Each plugin owns its own `migrations/` directory with its own journal; `applyMigrations(sqlite, [coreFolder, ...pluginFolders])` runs core first, then each loaded plugin's folder in topological-dependency order. Shared `__drizzle_migrations` table with sha256-keyed dedup.
- **Trust model.** Published plugins ship npm tarballs signed with Ed25519. The signed manifest pins `npmShasum` and (optionally) `gitRef`. The install handler verifies the signature against `trusted_signing_keys`, installs via `npm install`, then re-verifies the on-disk integrity against the pin — mismatch rolls the install back.
- **Frontend.** Vite globs `plugins/*/frontend/plugin.ts` (and managed-install equivalents) at build time. Plugins call `pluginRegistry.registerPages/Nav/Settings/Commands/Decoders/UiContributions(...)` from `@darkrideapp/plugin-sdk/react` to contribute UI.
- **No name coupling.** `backend/index.ts` contains zero plugin-name string literals. The host doesn't know which plugins exist until discovery runs.
