# Environment Variables

DarkRide is configured via environment variables. Copy `.env.example` to `.env` and customize.

## Server

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | HTTP server port |
| HOST | 127.0.0.1 | Bind address. Set to `0.0.0.0` to expose to network — auth is enabled, but see [SECURITY.md](../SECURITY.md) for the hardening checklist + known gaps before doing so |
| DATA_ROOT | ./data | Root for all runtime data (DB, screenshots, APKs, plugin storage, etc.). Override to point at a separate disk or mount. |
| DATABASE_PATH | ./data/darkride.db | SQLite database file path |
| SCREENSHOT_PATH | ./data/screenshots | Screenshot storage directory |
| PRUNE_DAYS | 7 | Days of data to retain before auto-cleanup |
| NODE_ENV | - | Set to `production` to serve frontend static files |
| DEBUG_LOGS | - | Set to any value to enable verbose logging |
| TRUST_PROXY | - | Set when behind a reverse proxy (Traefik, nginx). Values: hop count (e.g. `1`), `loopback`, `linklocal`, `uniquelocal`, or a comma-separated IP/subnet list. |
| WEBSOCKET_ALLOWED_ORIGINS | - | Comma-separated extra Origins allowed for `/ws` upgrades on top of the same-host + Vite-dev-port defaults. Needed when the backend sits behind a reverse proxy that re-writes Host. Example: `WEBSOCKET_ALLOWED_ORIGINS=https://darkride.example.com,https://staging.darkride.example.com`. See [SECURITY.md](../SECURITY.md#websocket-origin-allowlist). |
| DARKRIDE_PLUGINS | (all) | Comma-separated list of plugin names to load. Only those plugins (plus any required dependencies) will start. Useful when iterating on one plugin without spinning up unrelated external service deps. Example: `DARKRIDE_PLUGINS=kitchen-sink npm run dev`. |
| DARKRIDE_PLUGIN_DIRS | (unset) | Path-delimited list of extra directories to scan for plugins (use `:` on Linux/macOS, `;` on Windows). Falls back to scanning `plugins/` when unset. See [installing-plugins.md](installing-plugins.md). |

## Bootstrap

Used only on the very first run, to create the initial admin account without going through the bootstrap-token UI:

| Variable | Default | Description |
|----------|---------|-------------|
| DARKRIDE_BOOTSTRAP_ADMIN_USERNAME | - | Username for the auto-created admin user (typically `admin`). |
| DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD | - | Password for that user. Once any admin exists, both vars are ignored on subsequent boots. |

## Network

| Variable | Default | Description |
|----------|---------|-------------|
| WG_SERVER_IP | auto-detected | WireGuard server endpoint IP. Auto-detects LAN IP (prefers 192.168.x.x). Override if auto-detection picks the wrong interface. |
| MITMPROXY_DATA | (unset) | Override mitmproxy working directory (certificates, scripts, state) |

## Data Directories

These are created automatically on startup:

| Path | Purpose |
|------|---------|
| data/darkride.db | SQLite database |
| data/screenshots/ | Device screenshots and session captures |
| data/apks/ | Downloaded APK files from tracked apps |
| data/apks-injected/ | Frida Gadget injected APK cache (3-day TTL) |
| data/frida-server/ | Downloaded Frida server and gadget binaries |
| data/wireguard/ | Per-device WireGuard tunnel configurations |
| data/darkride-debug.keystore | Auto-generated debug keystore for APK signing |
| data/blocklist.json | Domain blocklist |
| data/hiddenlist.json | Domain hiddenlist |

## AI Provider Settings

AI providers and models are configured in the app (Settings → AI), not through environment variables. The setting keys below are deprecated. They are still read in two places: `/v1/ai/complete`, as a fallback when the `Low` tier has no usable model, and a startup migration that copies them into providers and models. See [ai-providers.md](ai-providers.md#deprecated-settings).

| Setting Key | Description |
|-------------|-------------|
| ai_provider | Provider for the `/v1/ai/complete` fallback and the startup migration: anthropic, gemini, ollama, openrouter, codestral |
| ai_chat_provider | Read by the startup migration only |
| ai_chat_model | Read by the startup migration only |
| anthropic_api_key | Anthropic API key |
| gemini_api_key | Google Gemini API key |
| openrouter_api_key | OpenRouter API key |
| codestral_api_key | Codestral API key |
| ollama_base_url | Ollama server URL (e.g., http://localhost:11434) |
| ollama_model | Ollama model name |
| openrouter_model | OpenRouter model identifier |

The opt-in live test lane (`npm run test:ai-live`) is the one place AI keys come from the environment (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `CODESTRAL_API_KEY`, `OLLAMA_BASE_URL`, and `AI_LIVE_<PROVIDER>_MODEL` to pin a model). The server never reads them. See [ai-providers.md](ai-providers.md#live-checks).

## NordVPN Settings

| Setting Key | Description |
|-------------|-------------|
| nordvpn_username | NordVPN service username |
| nordvpn_password | NordVPN service password |
