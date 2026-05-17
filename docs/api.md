# API Reference

All endpoints are available via HTTP REST and via WebSocket (using the `restapi` action). Base URL: `http://localhost:3000`.

## Devices

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/device/list | List all devices with status |
| GET | /v1/device/view/:id | Get device details |
| PUT | /v1/device/:id | Update device fields |
| POST | /v1/device/setup/:id | Trigger device setup |
| POST | /v1/device/command/:id | Run command (restart, sleep, wake, unlock, stopall) |
| GET | /v1/device/screenshot/:id | Take screenshot, return as base64 |
| POST | /v1/device/screenshot/:id | Take screenshot and save to session |
| POST | /v1/device/shell/:id | Execute ADB shell command |
| GET | /v1/device/dom/:id | Capture UI hierarchy |

## Proxies

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/proxy/list | List all proxies |
| POST | /v1/proxy/add | Add new proxy |
| GET | /v1/proxy/view/:id | View proxy details |
| PUT | /v1/proxy/update/:id | Update proxy |
| DELETE | /v1/proxy/delete/:id | Remove proxy |
| POST | /v1/proxy/enable/:id | Enable proxy |
| POST | /v1/proxy/disable/:id | Disable proxy |

## Traffic

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/traffic/list | List traffic with filtering and pagination |
| GET | /v1/traffic/view/:id | Full request/response detail |
| GET | /v1/traffic/search | Find latest request matching URL pattern |
| POST | /v1/traffic/ingest | Webhook from mitmproxy |
| POST | /v1/traffic/intercept | Real-time traffic interception hook |
| POST | /v1/traffic/request-started | Notify request started (pending) |
| GET | /v1/traffic/rules | List filter rules |
| POST | /v1/traffic/rules | Add filter rule |
| DELETE | /v1/traffic/rules/:id | Remove filter rule |
| POST | /v1/traffic/ws-start | Open WebSocket connection entry |
| POST | /v1/traffic/ws-message | Record a WebSocket frame |
| POST | /v1/traffic/ws-end | Close WebSocket connection |
| GET | /v1/traffic/ws-messages/:trafficId | List WebSocket frames for a connection |

### Saved Traffic

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/traffic/saved | List or search saved traffic (?url=pattern) |
| GET | /v1/traffic/saved/latest | Get most recent match (?url=pattern required) |
| DELETE | /v1/traffic/saved/:id | Delete saved entry |
| DELETE | /v1/traffic/saved | Delete all saved traffic |

## Capture

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/capture/start | Start traffic capture for a device |
| POST | /v1/capture/stop | Stop traffic capture |
| GET | /v1/capture/status/:deviceId | Get capture status |

## Automations

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/automation/list | List automations (filter: ?isRule, ?isCaptureRule) |
| POST | /v1/automation/create | Create automation |
| GET | /v1/automation/view/:id | Get automation details |
| PUT | /v1/automation/update/:id | Update automation |
| DELETE | /v1/automation/delete/:id | Delete automation |
| POST | /v1/automation/enable/:id | Enable automation |
| POST | /v1/automation/disable/:id | Disable automation |
| POST | /v1/automation/run/:id | Trigger automation manually |
| GET | /v1/automation/run/:id/:passcode | External trigger (GET) |
| POST | /v1/automation/run/:id/:passcode | External trigger (POST) |
| POST | /v1/automation/validate | Validate automation code |
| GET | /v1/automation/types | Get TypeScript type definitions for editor |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/automation/sessions | List sessions (with limit, offset, filters) |
| GET | /v1/automation/sessions/:id | Sessions for a specific automation |
| GET | /v1/automation/session/:sessionId | Full session detail |
| PATCH | /v1/automation/session/:sessionId | Update session (name, isPinned) |
| GET | /v1/automation/session/:sessionId/export/har | Export as HAR file |
| GET | /v1/automation/session/:sessionId/export/zip | Export as ZIP archive |

### Schedules

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/automation/schedules | List all active schedules |
| GET | /v1/automation/schedule/:id | Get schedule for automation |
| PUT | /v1/automation/schedule/:id | Set schedule (cron) |
| DELETE | /v1/automation/schedule/:id | Remove schedule |
| GET | /v1/automation/queue | Get automation queue |

## Apps

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/device/apps/:deviceId | List installed third-party apps |
| GET | /v1/device/app-icon/:deviceId/:packageName | Get app icon as base64 PNG |
| POST | /v1/device/pull-apk/:deviceId | Pull APK from device and save |
| POST | /v1/apps/track | Start tracking a package |
| DELETE | /v1/apps/track/:id | Stop tracking |
| GET | /v1/apps/tracked | List tracked apps with latest version |
| GET | /v1/apps/versions/:trackedAppId | List APK versions for tracked app |
| GET | /v1/apps/download/:versionId | Download APK file |
| POST | /v1/apps/install/:deviceId | Install APK version onto device |
| POST | /v1/apps/trigger-scan | Trigger APK version scan |

## Frida

### Scripts

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/frida/scripts | List scripts (?targetApp filter) |
| GET | /v1/frida/scripts/:id | Get script |
| POST | /v1/frida/scripts | Create script |
| PUT | /v1/frida/scripts/:id | Update script |
| DELETE | /v1/frida/scripts/:id | Delete script |

### Releases

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/frida/releases | List releases |
| POST | /v1/frida/releases/sync | Sync from GitHub |
| POST | /v1/frida/releases/:version/download | Download version |
| DELETE | /v1/frida/releases/:version | Delete version |

### Device Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/frida/status/:deviceId | Frida server status |
| POST | /v1/frida/start/:deviceId | Start frida-server on device |
| POST | /v1/frida/stop/:deviceId | Stop frida-server |
| POST | /v1/frida/spawn/:deviceId | Spawn/attach to app with script |
| GET | /v1/frida/apps/:deviceId | List apps on device |
| GET | /v1/frida/messages/:deviceId | Get Frida script messages |

### Gadget (Non-Rooted)

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/frida/gadget/inject | Inject gadget into APK |
| GET | /v1/frida/gadget/injected | List cached injected APKs |
| DELETE | /v1/frida/gadget/injected/:id | Delete injected APK |
| POST | /v1/frida/gadget/install/:deviceId | Install injected APK on device |

## Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/settings/list | List all settings |
| GET | /v1/settings/:key | Get setting |
| PUT | /v1/settings/:key | Update setting |

Allowed keys: `nordvpn_username`, `nordvpn_password`, `anthropic_api_key`, `gemini_api_key`, `openrouter_api_key`, `codestral_api_key`, `ai_provider`, `ollama_base_url`, `ollama_model`, `openrouter_model`, `document_store_url`, `document_store_headers`, `frida_default_version`

## Credentials

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/credentials/list | List credentials (?appId filter) |
| POST | /v1/credentials/add | Create credential |
| PUT | /v1/credentials/update/:id | Update credential |
| DELETE | /v1/credentials/delete/:id | Delete credential |

## Blocklist / Hiddenlist

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/blocklist/list | List blocked domains |
| POST | /v1/blocklist/add | Block domain |
| DELETE | /v1/blocklist/remove/:id | Unblock domain |
| GET | /v1/hiddenlist/list | List hidden domains |
| POST | /v1/hiddenlist/add | Hide domain |
| DELETE | /v1/hiddenlist/remove/:id | Unhide domain |

## Proxied Requests

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/proxied-request | Submit HTTP request |
| GET | /v1/proxied-request/job/:id | Poll async job status |
| POST | /v1/proxied-request/batch | Submit batch of requests |
| GET | /v1/proxied-request/status | Service status |
| GET | /v1/proxied-request/history | Request history (?limit=N) |

## AI Completion

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/ai/complete | Code completion for automation scripts |

Providers: Anthropic, Gemini, Ollama, OpenRouter, Codestral. Configure via Settings API.

## Plugin Endpoints

Plugins can register their own REST endpoints using `ctx.api()` in their `start()` hook. Endpoints added this way are available over both HTTP and the WebSocket-REST transport (the `restapi` action), exactly like core endpoints. For full details see [docs/plugins/backend.md — API Endpoints](plugins/backend.md#api-endpoints).

## WebSocket

Connect to `ws://localhost:3000/ws`. Messages use JSON with an `action` field.

All REST endpoints can be called over WebSocket using:
```json
{
  "action": "restapi",
  "id": "unique-request-id",
  "method": "GET",
  "path": "/v1/device/list",
  "body": {}
}
```

### Broadcast Messages

The server pushes these messages to all connected clients:

| Type | Description |
|------|-------------|
| traffic-entry | New HTTP/WebSocket traffic captured |
| traffic-request-started | Request started (pending state) |
| ws-frame | WebSocket frame received/sent |
| ws-connection-closed | WebSocket connection closed |
| session-status | Automation session status update |
| session-log | Live automation log entry |
