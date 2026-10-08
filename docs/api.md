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

`GET /v1/traffic/list` query parameters. All filters run in SQL and combine with AND; `total` counts every matching row.

| Param | Meaning |
|-------|---------|
| `limit`, `offset` | Page size (default 50) and offset |
| `deviceId`, `sessionId` | Scope to one device or capture session |
| `sortBy`, `sortDir` | `capturedAt` (default), `requestMethod`, `requestUrl`, `responseStatus`, `durationMs`, `bodySize`; `asc` / `desc` |
| `search` | Substring over URL, bodies and headers |
| `hostname`, `path` | Host substring or regex; path regex (tree navigator) |
| `methodInclude`, `methodExclude` | Comma list of `GET POST PUT DELETE GQL PROTO CONNECT OPTIONS WS DNS TLS_FAIL`. GET/POST exclude GraphQL and protobuf; `TLS_FAIL` is a CONNECT with status 0 |
| `statusCodes` | Comma list of exact codes. Takes priority over `statusGroups` |
| `statusGroups` | Comma list of `1xx`..`5xx` |
| `contentTypes` | Comma list of `json html js css image font xml other`. `other` is everything else, including GraphQL and WebSocket |
| `size` | `gt100kb`, `hasBody` or `empty`, measured on the original response size (binary and truncated bodies report their real size) |
| `urlFilter` | Case-insensitive RE2 regex on the URL; a pattern that doesn't compile matches as a substring |
| `method`, `status`, `type` | Legacy single-value filters (one method, one status century, `http`/`websocket`) |

Classification comes from `shared/lib/traffic-classify.ts`, the same code the Traffic table uses, and is stored per row at capture time. Unknown values in the comma lists are ignored.

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
| POST | /v1/capture/stop | Stop traffic capture. Optional `sessionId`: returns 409 without stopping if that isn't the device's live session |
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

Allowed keys: `nordvpn_username`, `nordvpn_password`, `anthropic_api_key`, `gemini_api_key`, `openrouter_api_key`, `codestral_api_key`, `ai_provider`, `ollama_base_url`, `ollama_model`, `openrouter_model`, `ai_chat_provider`, `ai_chat_model`, `document_store_url`, `document_store_headers`, `frida_default_version`

The AI keys in that list (`ai_provider`, `anthropic_api_key`, `gemini_api_key`, `openrouter_api_key`, `codestral_api_key`, `ollama_base_url`, `ollama_model`, `openrouter_model`, `ai_chat_provider`, `ai_chat_model`) are deprecated in favour of provider entries and model rows; see [ai-providers.md](ai-providers.md#deprecated-settings). `/v1/ai/complete` reads them only when the `Low` tier has no usable model.

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

## AI Providers and Models

Providers hold a type, an API key, and a Base URL. Models pick a provider, a model id, and a tier. Both are managed in Settings → AI. Reads need the `core.settings:read` scope; writes and tests need `core.settings:write`. Successful responses carry `"success": true` and usually `data`; errors are `{ "success": false, "error": "..." }` with the status shown below. See [ai-providers.md](ai-providers.md) for the provider types and their rules.

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/ai/providers | List providers |
| POST | /v1/ai/providers | Create a provider |
| PUT | /v1/ai/providers/:id | Update a provider |
| DELETE | /v1/ai/providers/:id | Delete a provider that no model uses |
| GET | /v1/ai/providers/:id/models | List the models the provider offers |
| POST | /v1/ai/providers/:id/test | Test the connection |
| GET | /v1/ai/models | List model rows in priority order |
| POST | /v1/ai/models | Create a model row |
| PUT | /v1/ai/models/reorder | Set priority by array position (`{ "ids": [3, 1, 2] }`) |
| PUT | /v1/ai/models/:id | Update a model row |
| PUT | /v1/ai/models/:id/toggle | Flip `enabled` |
| DELETE | /v1/ai/models/:id | Delete a model row |
| POST | /v1/ai/models/:id/test | Test one model |
| GET | /v1/ai/rate-limits | Cooldown state and last-seen rate-limit headers per model |

### Providers

A provider is returned as `{ id, name, type, hasApiKey, baseUrl, createdAt, updatedAt }`. The stored key is never returned: `hasApiKey` says whether one is saved. `type` is one of `anthropic`, `gemini`, `ollama`, `openrouter`, `codestral`, `mistral`, `openai`, `openai-compatible`, `claude-cli`. `baseUrl` is `null` when the default is used.

Request fields: `name`, `type`, `apiKey`, `baseUrl`. `name` and `type` are required on create and optional on update.

- `apiKey`: omit to keep the stored key. `""` or `null` removes it. A key is trimmed and must be printable ASCII.
- `baseUrl`: `null` or `""` means the default. The stored value is normalised (trailing slashes removed, a bare host gets the type's default path). `claude-cli` ignores it.
- On update, changing `type` or the effective Base URL clears the stored key unless the same request sends a new `apiKey`. Every successful update clears the cooldowns of the provider's models.

| Status | `error` | When |
|--------|---------|------|
| 400 | `name and type are required` | create without `name` or `type` |
| 400 | `name must be a non-empty string` | `name` is blank or not a string |
| 400 | `Invalid type. Must be one of: anthropic, gemini, ollama, openrouter, codestral, mistral, openai, openai-compatible, claude-cli` | unknown `type` |
| 400 | `apiKey must be a string` | `apiKey` is not a string |
| 400 | `API key is empty. Paste the key, or remove the saved one explicitly.` | `apiKey` is only whitespace |
| 400 | `API key contains control characters. Re-copy it without line breaks.` | line break, NUL, or other control character |
| 400 | `API key contains spaces, invisible characters, or characters outside plain ASCII. Re-copy it from the provider.` | any other character outside printable ASCII |
| 400 | `baseUrl must be a string or null` | `baseUrl` has another type |
| 400 | `Base URL must be a full http or https URL, for example http://localhost:11434` | `baseUrl` does not parse |
| 400 | `Base URL must start with http:// or https://` | another scheme |
| 400 | `Base URL must not contain credentials. Put the key in the API Key field.` | user or password in the URL |
| 400 | `Base URL must not contain a query string` | `?` in the URL |
| 400 | `Base URL must not contain a fragment` | `#` in the URL |
| 400 | `Base URL points at a link-local or metadata address, which is not allowed` | blocked address |
| 400 | `Base URL is required for OpenAI-compatible` | no Base URL on an `openai-compatible` provider |
| 404 | `Provider not found` | unknown `:id` |
| 409 | `Cannot delete provider: <n> model(s) still reference it` | delete while models use the provider |

On update, `baseUrl` is validated only when it changed or the `type` changed, so re-posting an old stored value does not block a rename.

`POST /v1/ai/providers/:id/test` and `GET /v1/ai/providers/:id/models` answer 200 even when the provider fails. A test returns `{ "success": true, "model": "<model used>" }` (`"<n> models"` when it listed instead of generating, `"claude-cli"` for the CLI) or `{ "success": false, "error": "..." }`. A listing returns `{ "success": true, "data": [{ "id", "name" }] }` or `{ "success": false, "error": "...", "data": [] }`. A test gives up after 15 s with `<Name> did not respond within 15s`; a listing allows each page 15 s and follows at most 10 pages.

### Models

A model is returned as `{ id, name, provider, providerId, providerName, model, enabled, priority, cooldownMinutes, tierId, tierName, createdAt, updatedAt }`. `model` is `null` when the provider's default model is used.

Create takes `name` and `providerId` (required), and optionally `model`, `enabled` (default `true`), `cooldownMinutes` (default 10), and `tierId` (default: the `High` tier, also when `null`). A new row goes to the end of the priority order. A blank `model` is stored as `null`.

| Status | `error` | When |
|--------|---------|------|
| 400 | `name and providerId are required` | create without `name` or `providerId` |
| 400 | `name must be a non-empty string` | `name` is blank or not a string |
| 400 | `Provider not found` | `providerId` does not exist |
| 400 | `OpenAI has no default model. Choose a model.` (or `Mistral`, `OpenAI-compatible`) | a blank `model` on a provider of that type. Checked on every update too |
| 400 | `ids must be an array` | reorder without an `ids` array |
| 404 | `Model not found` | unknown `:id` |

`POST /v1/ai/models/:id/test` sends a one-turn generation capped at 16 output tokens (`claude-cli` runs a version and tool check instead) and answers 200 with `{ "success": true, "model": "..." }` or `{ "success": false, "error": "..." }`. A model with no linked provider returns `Model has no linked provider`; a missing provider returns `Linked provider not found`.

`GET /v1/ai/rate-limits` returns one entry per model: `modelId`, `modelName`, `provider`, `inCooldown`, `cooldownEndsAt` (ms since epoch or `null`), and the last-seen `requestsLimit`, `requestsRemaining`, `requestsReset`, `tokensLimit`, `tokensRemaining`, `tokensReset` (`null` where the provider sends none).

## AI Completion

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/ai/complete | Code completion for automation scripts |

Request body: `{ "prefix": "...", "suffix": "..." }`. At least one must be non-empty; a missing one counts as an empty string. The request uses the enabled models of the `Low` tier only, never another tier, with the fallback described in [ai-providers.md](ai-providers.md#errors-and-fallback). If the `Low` tier has no usable model, it falls back to the deprecated AI settings keys. Output is capped at 256 tokens.

Success: `200` with `{ "success": true, "data": { "completion": "..." } }`. `completion` can be an empty string.

| Status | `error` | When |
|--------|---------|------|
| 400 | `prefix or suffix is required` | both are empty or missing |
| 400 | `No AI provider configured` | no usable `Low` tier model and no `ai_provider` setting |
| 400 | `Unknown AI provider: <type>` | the `ai_provider` setting is not `anthropic`, `gemini`, `ollama`, `openrouter`, or `codestral` |
| 400 | `<Name> API key not configured` | the `ai_provider` setting names Anthropic, Gemini, OpenRouter, or Codestral and its key setting is empty |
| 502 | the provider's message, key masked | the provider failed, for example `OpenAI API error (400): <provider message>`. When every `Low` tier model failed or is cooling down: `All AI models are rate-limited or unavailable:` and one `<model>: <reason>` line per model |
| 500 | `Inline completion failed` | any other error. The detail goes to the server log only |

If the client disconnects, the upstream request is cancelled and nothing is written.

## AI Usage

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/ai/usage/report | Token, cache and estimated cost totals for recorded agent runs |
| GET | /v1/ai/usage | Older per-conversation token summary (`?pageContext=`, `?from=`, `?to=` in ms) |

`GET /v1/ai/usage/report` needs the `core.settings:read` scope. The Usage panel in Settings → AI reads it. The rest of this section describes it.

`GET /v1/ai/usage` is a separate, older endpoint: it sums the input and output tokens stored on chat conversations and returns `{ totalInputTokens, totalOutputTokens, conversationCount, byContext, conversations }`. It has no cache tokens, costs or agent runs.

Query parameters, both optional:

- `days`: window length, an integer from 1 to 90 (default 30). A run is included when it started at or after now minus `days` × 24 hours.
- `limit`: number of entries in `recentRuns`, an integer from 1 to 200 (default 50). Totals always cover the whole window.

Success: `200` with `{ "success": true, "data": { ... } }`, where `data` is an `AiUsageResponse` from [`shared/types/ai-usage.ts`](../shared/types/ai-usage.ts):

- `days`, `generatedAt` (ISO 8601).
- `totals`: `runs`, `failedRuns` (outcome `error`), `inputTokens` (prompt tokens including cache reads and writes), `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate` (`cacheReadTokens / inputTokens`, `null` with no input), `costUsd`, `unpricedRuns`.
- `byPurpose`: the same totals per purpose plus `purpose`, `label`, `medianCostUsd`, `p90CostUsd` (per run, over priced runs only) and `medianTurns`. Percentiles use the nearest-rank method, so the median of two runs is the lower one. Sorted by cost, highest first, with purposes that have no priced run last, then by run count.
- `byDay`: one entry per local calendar day and purpose (`date` as `YYYY-MM-DD` in the server's timezone, `purpose`, `runs`, `inputTokens`, `outputTokens`, `costUsd`), oldest day first.
- `recentRuns`: newest first. Each has `id`, `startedAt`, `durationMs` (`null` while running), `purpose`, `label`, `models` (distinct model ids in first-use order), `turns`, `toolCalls`, the four token counts, `costUsd`, `outcome` (`success`, `error`, `aborted` or `null`), `error` (cut to 500 characters) and `fallbackRequests` (requests served after one or more models were skipped or failed).

Purpose keys:

| `purpose` | `label` | Runs |
|-----------|---------|------|
| `apk-analysis` | APK analysis | core service `apk-analyzer` |
| `apk-diff` | APK diff | core service `apk-diff-engine` |
| `service:<name>` | Service: &lt;name&gt; | any other core service |
| `plugin:<name>` | Plugin: &lt;name&gt; | a plugin, or a plugin acting for a user |
| `chat` | Chat | a user's own chat |
| `other` | Other | anything else |

Notes:

- Costs are estimates in USD from a built-in price table ([`shared/lib/ai-model-pricing.ts`](../shared/lib/ai-model-pricing.ts)). A request on a model with no known price has a `null` cost, never zero. A run with any such request counts in `unpricedRuns`, and its `costUsd` covers only its priced requests. Add or replace prices with the `ai_model_prices` setting: a JSON object keyed by model id, each value `{ "input", "output", "cacheRead", "cacheWrite" }` in USD per million tokens.
- Tokens are what providers billed, including requests whose output the agent discarded and context compaction requests.
- Inline completion (`POST /v1/ai/complete`) is not included: it records no usage.
- Only runs recorded after usage recording shipped have per-request detail. Older runs report their stored input and output totals, zero cache tokens, no models and a `null` cost, and count as unpriced.

| Status | `error` | When |
|--------|---------|------|
| 400 | `days must be an integer from 1 to 90` | `days` is empty, repeated, not a whole number, or out of range |
| 400 | `limit must be an integer from 1 to 200` | `limit` is empty, repeated, not a whole number, or out of range |

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
