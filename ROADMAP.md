# DarkRide Roadmap

*Last updated: 2026-07-11*

---

## Completed

### Core Platform
- **Android device management** — ADB discovery, live screen streaming, remote touch/swipe/tap, hardware buttons, extended device properties
- **TypeScript automation engine** — full `DeviceAPI` (click, setText, waitFor, screenshot, httpGet, scroll, DOM queries), rule system with priority ordering, session history with logs + screenshots + traffic per run
- **HTTPS traffic capture** — mitmproxy + WireGuard transparent proxy, TLS fingerprint spoofing (Chrome 120 Android), NordVPN SOCKS5 proxy integration, per-device profiles
- **Frida integration** — gadget injection, re-signing, script library (26+ built-in scripts across 6 categories: cert pinning, root detection, integrity, anti-debugging, emulator detection, analytics bypass), controlled spawn mode
- **APK analysis** — multi-source acquisition (ADB pull, Play Store, manual upload), jadx decompilation, security findings scanner, React Native/Hermes bundle analysis, Flutter class/method extraction, version diffing with AI summaries
- **AI agent** — multi-provider (Anthropic, Gemini, OpenRouter, Ollama, Codestral), 40+ context-aware tools, tiered model routing, context compaction
- **AI model tiers** — declarative tier definitions, per-conversation routing, rate-limit-aware fallbacks, configurable per-user defaults
- **MCP server** — expose every DarkRide tool to AI agents (Claude Code, etc.) via Model Context Protocol with OAuth-based auth flow
- **Authentication & authorisation** — multi-user with 23 area-level scopes, cookie sessions, API keys with scope intersection, built-in password provider (Argon2id), progressive lockout, claim-URL user onboarding, admin user management
- **CLI** — `darkride plugin list/create/dev`, `darkride admin create`
- **Host & device terminal** — real shell PTY in the browser, multi-session device and host shells
- **Notification system** — Discord, Slack, Telegram, email, webhooks with per-event routing and quiet hours
- **Background job scheduler** — cron-based, plugin-contributed jobs
- **Cloud storage sync** — S3/B2/R2 with LRU eviction, background upload queue
- **API Catalogue** — auto-discovery of HTTP endpoints from captured traffic, normalised paths, hostname grouping, sample storage
- **Protocol decoders** — extensible decoder system; plugins implement specific protocols (HTTP, WebSocket, and custom binary formats)
- **MQTT decoder plugin** — decodes MQTT control packets (CONNECT, PUBLISH, SUBSCRIBE, etc.) carried over WebSocket frames into structured payloads in the Traffic UI
- **BlipSync decoder plugin** — decodes the BlipSync binary protocol over WebSocket frames into structured payloads in the Traffic UI
- **Settings & Restart UX** — vertical sidebar layout for Settings, server-side restart-required state, persistent warning banner, always-available Restart Server entry, plugin-contributed settings entries, legacy URL redirects

### Plugin Platform
- **Plugin lifecycle architecture** — every plugin defines `register(ctx)` / `start(ctx)` / `stop(ctx)`; core wiring is plugin-agnostic
- **PluginContext (`ctx`) surface** — typed access to host services: `ctx.db()`, `ctx.cloudStorage`, `ctx.notify()`, `ctx.runner`, `ctx.fileSync`, `ctx.files()`, `ctx.pluginDir`, `ctx.exposeService<T>()`, `ctx.peer<T>()` for cross-plugin APIs
- **Per-plugin migrations** — each plugin owns its `migrations/` folder with its own journal; host applies core migrations then each enabled plugin's; content-based dedup via shared `__drizzle_migrations` table
- **Plugin SDK package** — `@darkrideapp/plugin-sdk` with typed React subpath (`@darkrideapp/plugin-sdk/react`), `definePlugin()`, `pluginRegistry`, hooks (`useWebSocket`, `useAuth`, `useRestartRequired`, `usePluginRegistrySnapshot`), components (`SettingsNav`, `RestartBanner`, `StatCard`, `PageHeader`, etc.), test harness (`createPluginTestHarness`)
- **Plugin management UI** — marketplace browser with verification badges, signed publisher trust, install / uninstall / update flows, version tracking with update notifications, per-plugin settings pages, enable/disable without uninstall, configurable plugin sources
- **Plugin signing & verification** — Ed25519 keypair signing, trusted publisher keys, marketplace verification status (`verified` / `unsigned` / `untrusted`)
- **Plugin extraction model** — plugins live in their own repos, publish to npm-compatible registries (npmjs.com or self-hosted Gitea), install via `npm install --legacy-peer-deps` into a managed prefix outside the host repo
- **Plugin file storage** — `ctx.files()` API replaces ad-hoc per-plugin cloud-storage code; backed by host cloud-sync layer
- **Extension points** — 15 surfaces a plugin can contribute to: nav, pages, routes, DB tables, AI tools, AI tool contexts, scopes, auth providers, jobs, settings, commands, notifications, protocol decoders, hooks, UI slots
- **Plugin marketplace sources** — configurable registries, per-source auth tokens, license verification, install-from-URL fallback

### Commercial
- **Pro tier (Stripe Checkout)** [PRO] — $99/yr subscription, JWS-signed licence tokens with periodic refresh, gated features via licence verifier

### iOS Support (Phase 1)
- **Device discovery** — pymobiledevice3 via USB, auto-pairing
- **HTTPS traffic capture** — WireGuard config + QR code generation, reuses existing mitmproxy infrastructure
- **Platform-aware database** — `devices.platform` (android | ios), `devices.ios_version`

---

## Short-Term

### Customisable Dashboard

The current Dashboard is one-size-fits-all and ships fixed sections. The next step is letting users (and plugins) decide what they see:

- **Dashboard widget contribution API** — `core:dashboard:widgets` slot so plugins register stat cards, activity tables, and health alerts. Removes the need for the host to hardcode any plugin-specific UI.
- **Per-user layouts** — reorder, hide, resize widgets. Persisted per user. Likely backed by a grid library.
- **Plugin-contributed activity feeds** — each plugin can publish a "Recent activity" widget without touching host code, so the dashboard surfaces become whatever the installed plugin set actually contributes

### Plugin Ecosystem Polish

The marketplace works end-to-end but has rough edges around dependency surfacing, recovery flows, and the restart loop:

- **Surface plugin dependencies in the marketplace** — show "Requires: X, Y" on cards when a plugin declares peer-plugin deps. Block installs that would create unmet dependencies, or auto-install transitive plugin deps with consent.
- **Reinstall affordance for missing plugins** — when a plugin appears in the installed list but its files have vanished from disk (renamed npm package, extracted from workspace, etc.), the marketplace currently offers no "Reinstall" path. Should ship a non-destructive reinstall button that preserves the plugin's data.
- **Confirmation dialog for destructive plugin actions** — "Remove leftover state" silently drops the plugin's database tables and on-disk file storage. Should enumerate exactly what will be destroyed and require an explicit confirmation; default to non-destructive cleanup.
- **MCP permission grant without a second restart** — when a plugin registers MCP tools for the first time, accepting the permission prompt currently requires a second server restart to fully activate. Fix by either deferring MCP server init until after consent or live-reloading the tool registry on grant.
- **Restart waits for in-flight work** — Restart Server should pause until running automations, capture sessions, and background jobs reach a safe checkpoint, with a visible status of what's still busy. Provide an "Override and restart now" escape hatch for the impatient case.
- **Progress-aware plugin install + load screens** — match the pattern of the Python env setup screen. During a marketplace install, surface the npm install phase, migration phase, and frontend rebuild phase as discrete steps with bytes-downloaded / migrations-applied / build-progress where available. During server startup, the StartupScreen should name the current plugin being loaded (e.g. "Loading 3 of 6: <plugin-name>") rather than a generic spinner. Both flows broadcast WS events the screen can subscribe to.

### WireGuard Auto-Provisioning on Devices

Currently a user wanting HTTPS capture has to manually install the WireGuard Android app on each device (from the Play Store) before connecting it. The host should handle this automatically:

- **Auto-fetch and cache** — on first need, download the official WireGuard Android APK from `download.wireguard.com` to a local cache (`data/wireguard-tools/`), verify a known checksum, keep the cached copy for subsequent devices
- **Install via ADB** — when adding a device, detect whether `com.wireguard.android` is installed; if not, `adb install` from the cache transparently
- **Pinned version** — track a known-good WireGuard APK version in code; bump it deliberately when newer releases are tested. Don't silently follow upstream.
- **Air-gapped path** — offer a "skip download, use this APK" flag for users running DarkRide on networks without outbound internet to wireguard.com

(Historically the APK was bundled in the repo — at ~17 MB and not used by any runtime code path, that bundling added weight without delivering the actual auto-install. This work makes good on the original intent.)

### Device Video Feed — Reliability & Polish

Live screen streaming works on most devices but is still uneven. Specific items:

- **Smoothness on slower hardware** — current encoder/decoder pipeline is laggy and glitchy on lower-end devices (FairPhone is the current baseline for "needs improvement"). Profile the H.264 / WebCodecs path, bound the keyframe cadence sensibly per device class.
- **Live-log drawer regression** — the device video used to render inline in the live-log drawer; somewhere in a recent refactor that broke. Restore.
- **General quality + stability refinements** — fewer dropped frames, faster recovery from network blips, better handling of orientation changes mid-stream.

<a id="video-streaming-reliability"></a>**Reliability workstreams 3–5** (planned follow-ups to the work captured in [`docs/video-streaming-reliability.md`](docs/video-streaming-reliability.md)):

- **GOP-aware backpressure.** Replace the per-frame drop logic with a state machine: on first drop, enter `awaiting-keyframe`, drop **all** frames (delta and keyframe both) until the buffer drains, then trigger a reset-video request and resume only on the next IDR. This is what guarantees the "never feed a broken reference chain" principle end-to-end.
- **SPS/PPS re-emission per IDR.** Backend prepends the cached SPS/PPS to every IDR on the wire (not just the first one or on rotation). Cost: ~50 bytes per IDR (negligible). Benefit: the frontend can reset its decoder at any moment and resync on the next KEYFRAME without coordination with the backend.
- **Metrics surfaced in UI.** Counters for gap count, keyframe-request rate, decoder-reset count, and dropped-frame count sent to the backend via the existing health channel and rendered in the device viewer's `VideoHealthIndicator`. Without this, every regression is invisible.

### APK Page UX Rework

The APK page has grown organically and is now messy and tricky to navigate. Restructure for clearer flow:

- **Tracked apps as the primary view** — clear app → versions → analysis hierarchy. Reduce the number of places you can land that look the same but show different scopes.
- **Better cross-linking** — clicking through to an analysis from a tracked app, an APK version, or a diff report should land you in the same consistent shape.
- **Less list-of-lists; more focused detail panels** — collapse incidental tables and lift the primary action (analyse, diff, download, push to device) into clearer affordances.
- **Drag-and-drop APK upload** — drop `.apk` files anywhere on the page to upload and analyse, instead of going through the file picker dialog.

### Script Git Storage [PRO]

Automations and Frida scripts currently live in SQLite rows on the host. For users running DarkRide alongside their normal dev workflow, that's a poor fit:

- **Back automations and Frida scripts with a git repo** — script bodies stored as files in a configurable working tree; each save is a commit; history viewable per script. Pairs naturally with the upcoming VS Code editing flow.
- **Branch / remote support** — optionally push the working tree to an external git remote (GitHub, Gitea) for backup and team review.
- **Migration path** — existing DB-stored scripts get exported to the git working tree on first enable; no data loss.

### Enterprise Auth Providers (Plan B)

The built-in password provider ships. Next is the plugin provider interface so enterprises can use their existing identity systems:

- **Plugin auth provider interface** — `ctx.authProviders()` extension point for LDAP, SAML, OIDC, OAuth2 plugins
- **Provider admin UX** — config form auto-rendered from plugin manifest, group → scope mapping table per provider
- **Marketplace trust enforcement for auth** — auth plugins must be signed by a trusted publisher
- **Licence validation** — JWT tokens with periodic marketplace refresh for paid plugins

### Capture Session UX Improvements

- **Rename active sessions** — rename a capture session while it's running (currently requires stopping first)
- **Export during capture** — download captured traffic as HAR/JSON while the session is still active
- **Session notes** — add notes/annotations to a capture session for later reference

### iOS Support — Phase 2: Screen Streaming & Remote Control

**Blocker:** Requires a one-time macOS session to compile WebDriverAgent and export signing certificates.

- Compile WDA, export `.p12` + provisioning profile (needs macOS)
- WDA install + launch via pymobiledevice3
- MJPEG stream consumer with WebSocket forwarding
- Touch/gesture input mapped to WDA REST API

### iOS Support — Phase 3: UI Hierarchy & Automation

**Depends on:** Phase 2 (WDA required)

- DOM capture via WDA `GET /source` with XML-to-DOMNode mapping
- Server-side element find via WDA `POST /element`
- iOS-native selectors: NSPredicate, class chain, accessibility ID
- Route automation API to iOS bridge based on `device.platform`

---

## Mid-Term

### Traffic Analysis Enhancements

Shipped: protobuf/gRPC auto-detection + schemaless decode, GraphQL detect + pretty-print,
rule-based live intercept (UI-managed match+action rules), and a Request Builder replay target.

Still open (protobuf `.proto` extraction from APK, GraphQL introspection schema, request chaining
with JSONPath extraction) folds into the Traffic Capture UX work below.

### Traffic Capture UX

Full review 2026-07-11 against Charles / Burp / HTTPToolkit. Prioritized backlog + design contracts
live in **`docs/specs/2026-07-11-traffic-capture-ux-review.md`** — that doc is canonical.

Headline items:

- **P0 — Interactive interception ("breakpoints")** *(landed on `feat/traffic-capture-ux`)* — pause a
  matching request/response in-flight, edit, forward or drop. Closes the biggest gap vs Burp/Charles;
  the old intercept was rule-based auto-modify only.
  - **Scoped intercept** *(landed on `feat/scoped-intercept`)* — arm intercept for a **list of match
    rules** (host glob / path glob / method, matched with OR) instead of every flow, via a scope-editor
    popover on the arm button + a plain-English summary + a scope chip, plus "Intercept this host"
    from the request detail panel. Backend/proxy honor `rules[]` (mitmproxy `_hold_matches` + JS mirror).
- **P0 — Real per-request timing** *(landed on `feat/traffic-capture-ux`)* — forwarded mitmproxy
  timestamps, Duration column + timing waterfall, real HAR timings (were zeroed).
- **P0 — In-place, tunnel-routed replay** *(landed on `feat/traffic-capture-ux`)* — in-context
  Repeater drawer with original-vs-new response diff, sent through the capture session's egress + a
  replicated TLS profile (uniform across physical devices and emulators). Byte-exact emulator routing
  and on-device Frida replay are deferred fidelity upgrades.
- **P1** — deep filter/search *(landed)*, virtualize the list + fix live-append past page 0 *(landed
  on `feat/traffic-list-perf`: `@tanstack/react-virtual` in TrafficTable, inspector cap 500→5000,
  jump-to-live banner)*, host/path tree view *(landed on `feat/traffic-host-tree`: TrafficTree panel
  + `GET /v1/traffic/tree`)*, unify the five nav surfaces into one workspace *(design pending)*.
- **P2** — raw wire view, in-body search + JSON tree + hex, auto-load-full-body, HTML render.
- **P3** *(landed on `feat/traffic-p3-polish`)* — honest "Clear view", visible blocklist w/ unblock, UI
  "Save request" (+ `POST /v1/traffic/saved`), per-device TLS-pill copy, show/hide column customization.
  Two kept conservative pending sign-off: no destructive delete-all-captured, no live TLS summary.

### Raw TCP Stream Capture

DarkRide captures HTTP/HTTPS traffic and WebSocket frames via mitmproxy. Many mobile protocols run over raw TCP rather than HTTP — MQTT (1883/8883), custom game protocols, proprietary binary protocols — and are currently invisible. Adding raw TCP capture would unlock a whole category of analysis and is the single biggest gap for the protocol-decoder plugin ecosystem (the MQTT decoder is WebSocket-only today because most MQTT traffic is raw TCP).

Multi-layer feature; build incrementally so each step is independently useful:

1. **mitmproxy + Python bridge** — enable the `tcp_message` hook (transparent/WireGuard mode already intercepts TCP, we just don't capture it); forward `tcp:open`/`tcp:data`/`tcp:close` to the Node backend with source/dest, direction, timestamp, bytes.
2. **Backend storage + API** — new `tcp_streams` table (mirrors `websocketMessages` for arbitrary TCP), endpoints to query/filter by device, port, protocol hint, time range.
3. **Frontend** — new traffic-inspector tab with hex/ASCII view, stream reassembly for full conversations.
4. **Decoder integration** — extend the `ProtocolDecoder` SDK interface so plugins declare which ports/patterns they recognize and decode TCP streams the same way they decode WebSocket frames.

Steps 1–2 are useful even without UI — they enable logging TCP traffic for ad-hoc analysis. The MQTT decoder, custom-protocol decoders, and any future gRPC-over-raw-TCP support all depend on this.

### Certificate Pinning Auto-Detection & Bypass

Unify mitmproxy error detection, APK analysis findings, and Frida into a seamless workflow:
- Detect TLS handshake failures indicating pinning
- Cross-reference with APK analysis (OkHttp, TrustManager, `network_security_config.xml`)
- One-click "Bypass pinning for this app" → inject gadget + apply Frida script + restart capture

### iOS Support — Phase 4-6

- **Phase 4:** iOS Safari TLS fingerprint profile, automated CA cert injection via profile install
- **Phase 5:** Frida gadget injection for iOS (FridaGadget.dylib, Mach-O patching, IPA re-signing with zsign)
- **Phase 6:** IPA install/uninstall/list, app launch/terminate via WDA, IPA analysis

### Emulated & Cloud Devices

Today the only path to a device is a USB-attached one. Many use cases (CI, demoing, single-device-but-multi-OS-version testing) don't need physical hardware:

- **"Add device" from the UI** — point-and-click flow to provision a new device entry, choose between physical/emulated/cloud, and walk through any device-specific setup
- **Emulated Android devices** — orchestrate local Android Emulator instances directly from DarkRide: pick an AVD, boot it, ADB connect automatically, lifecycle-manage with the rest of the device list
- **Cloud-hosted device support** [PRO] — integrate with one or more cloud device providers (Genymotion Cloud, BrowserStack App Live, AWS Device Farm or equivalent); credentials handled via the existing credentials store; same automation API regardless of where the device runs
- **Snapshot & reset** — emulated devices should support easy snapshot/restore so automations can run from a known state
- **AI assistant** — for selecting the right emulator / cloud device for a given task

### VS Code Editing for Scripts [PRO]

The in-browser Monaco editor covers most authoring, but power users want their real IDE — extensions, custom keybindings, AI completion of their choice, side-by-side files.

- **VS Code extension** — connect to a running DarkRide instance from VS Code; edit automations and Frida scripts in-place against the host's script storage (pairs with [Script Git Storage [PRO]](#script-git-storage-pro))
- **Live run + log streaming** — trigger a run from the editor, stream logs back into the VS Code output panel, jump to source on error
- **Workspace sync** — open the host's full script library as a VS Code workspace folder; changes round-trip through the host's storage layer
- **Auth via API key** — uses an existing scoped API key, no separate VS Code auth flow

### Team Invites [PRO]

The host already supports multiple users with scope-based RBAC, but creating new accounts today requires the admin to run `darkride admin create` or hand out claim URLs manually.

- **Invite link generation** — admin generates a single-use invite link from the UI; recipient lands on a claim page, sets a password, gets the assigned scopes
- **Bulk invite + role templates** — invite multiple addresses at once with a named role template (e.g. "QA engineer", "automation author") that maps to a preset scope bundle
- **Pending invitations management** — list, resend, revoke pending invites; track who invited whom
- **Email delivery** — uses the existing notification system's email transport (SMTP / SendGrid / etc.)

### AI Tooling for Automations

The AI agent already exposes 40+ tools but most are read-only or capture-oriented. The next push is letting the agent actively author and repair automations:

- **Authoring tools** — AI can scaffold a new TypeScript automation from a goal description, propose selectors based on a live DOM snapshot, suggest waitFor conditions from captured timing data
- **Patching tools** — AI can diagnose why an automation failed (selector drift, timing, network change), propose a patch, run it against a recorded session, and iterate
- **Rule generation** — AI can suggest capture-rule triggers and actions based on the user's stated intent and a sample of captured traffic
- **Safe-by-default** — AI-proposed changes land as a diff the user accepts/rejects, not as silent edits

### Advanced Automation

- **Automation debugger** — breakpoints, variable inspector, step-through, live DOM overlay
- **Visual recorder** — record touch interactions, generate TypeScript script
- **Multi-device orchestration** — run same automation across a device fleet
- **Headless CLI mode** — `darkride run --automation "name" --device SERIAL` for CI/CD

### Analysis & Intelligence

- **SDK & library fingerprinting** — detect bundled SDKs (Firebase, Adjust, OkHttp, etc.) and track changes across versions
- **Auto-generated API docs** — infer schemas from captured payloads, export as OpenAPI 3.0
- **API monitoring & regression** — schedule endpoint checks, alert on structural changes
- **Screenshot visual regression** — pixel-diff automation screenshots across runs

### Plugin Platform

- **Command palette contribution API** — `core:command-palette:entries` slot so plugins register palette commands (paired with the dashboard-widget work above)
- **Utility actions contribution API** — admin/maintenance actions plugins can surface in the Utilities page (backfills, repairs, exports) without the host hardcoding plugin names
- **`ctx.coreDb()` helper** — eliminate the remaining `as any` casts when plugins need to read host-owned tables

### Plugin ABI & Shared-Dependency Coupling

The current contract is: plugins put React, react-router-dom, lucide-react, `@darkrideapp/plugin-sdk`, better-sqlite3, drizzle-orm, and express in `peerDependencies`, mirror them in `devDependencies`, and the host's copies become the singletons at install time. It works, but it locks the host into never being able to bump those libraries without coordinated plugin updates — a React 19 → 20 jump means every plugin's peer-dep range needs widening + retest + republish before the host can move. Beta-author feedback has flagged that getting all these peer-deps right by hand is fiddly and brittle.

The current half-measure: `definition.darkride` is a semver range that the host could enforce at load. Today it logs a warning on mismatch; it could be made a hard refusal so a host ABI bump cleanly rejects incompatible plugins with an actionable error.

Three candidate directions, from least invasive to most:

1. **Make `definition.darkride` mandatory + hard-checked.** Host refuses to load plugins outside the declared ABI range; plugin authors get a single version field to manage. Pairs well with an SDK-supplied semver-range default in the `definePlugin` scaffold. **Cost:** small. **Win:** clean upgrade story but plugin authors still manage 7 peer-deps.

2. **Re-export everything via the SDK.** `@darkrideapp/plugin-sdk` becomes the only peer-dep for everything React-shaped. Plugins import React from `@darkrideapp/plugin-sdk/react`, router primitives from the same. SDK semver controls the contract — bumping React 19→20 means SDK 2.0.0, plugins update `^1` → `^2` on their own schedule. **Cost:** medium — SDK re-exports + plugin migration. **Win:** plugin package.json shrinks to one peer-dep; ABI compatibility is a single number.

3. **Module-federation-style runtime externals.** Host exposes its React/router/SDK on a known global (or via import-maps). Plugin Vite builds mark these as external. Plugins ship no React at all; tarballs only contain plugin-specific code. **Cost:** larger — Vite plugin for plugin authors + runtime resolver + tests. **Win:** the singleton invariant is enforced at the build/runtime level rather than relying on npm peer-dep semantics; zero risk of two-React installs even with bad authoring.

Recommended direction: ship (1) immediately (it's mostly already there), then build toward (2) over the next plugin-API season. (3) is a longer play worth it if the plugin ecosystem grows. Whichever path, the goal is: **the host can bump React / SDK / etc. without coordinating every plugin author's clock**.

---

## Long-Term

- IPA analysis pipeline (parallel to APK)
- Jailbroken iPhone support (frida-server, SSL Kill Switch)
- Data pipeline / webhook integration (automations as data sources)
- Export/import packages (portable bundles of automations, scripts, configs)
- Device fleet health dashboard
- App state snapshots and restore

---

## iOS Support — What's Blocking It

iOS support is split into phases because Apple's toolchain restrictions gate certain capabilities:

| Capability | Status | Blocker |
|---|---|---|
| Device discovery (USB) | ✅ Working | None — pymobiledevice3 handles this |
| HTTPS traffic capture | ✅ Working | None — WireGuard + mitmproxy, same as Android |
| Screen streaming | ⏳ Phase 2 | WebDriverAgent requires macOS to compile |
| Remote control (touch/swipe) | ⏳ Phase 2 | WDA required |
| UI automation | ⏳ Phase 3 | WDA required |
| Frida instrumentation | ⏳ Phase 5 | IPA re-signing requires signing certs from Mac |
| App management | ⏳ Phase 6 | Signing certs required |

**The core blocker is a one-time macOS session** (1-2 hours on a borrowed or rented Mac) to compile WebDriverAgent and export signing certificates. Once those artifacts are generated, all subsequent iOS work can happen on Linux. This is an Apple ecosystem restriction, not a DarkRide limitation.

Traffic capture and device discovery work TODAY on iOS — connect an iPhone via USB, scan the QR code for the WireGuard config, and capture HTTPS traffic. No macOS required for that.

**Want to help unblock iOS?** If you have a Mac and want to contribute, this is one of the highest-impact things you can do: compile WDA, test it with DarkRide's existing Phase 2 code (MJPEG streaming, touch input, and WDA install/launch are already implemented), and document the steps. See the [contributing guide](CONTRIBUTING.md) or open a discussion.

---

## Architecture

| Component | Stack |
|-----------|-------|
| Backend | TypeScript, Express, better-sqlite3, Drizzle ORM |
| Frontend | React 19, Vite, Monaco Editor, xterm.js |
| Device Bridges | Python JSON-RPC (Android: bridge.py, iOS: ios_bridge.py) |
| Traffic Proxy | mitmproxy (Python) + WireGuard |
| AI | Multi-provider (Anthropic, Gemini, OpenRouter, Ollama) |
| Auth | Cookie sessions, Argon2id, scoped API keys, OAuth/MCP |
| Plugins | `@darkrideapp/plugin-sdk` (Ed25519-signed, marketplace-distributed), 15 extension points, npm-compatible registry workflow |
| Storage | Local SQLite + optional cloud sync (S3/B2/R2) |
| Tests | Vitest (backend + frontend), Playwright (E2E) |

**Test coverage:** ~3400 backend + ~950 frontend + ~200 Python tests
