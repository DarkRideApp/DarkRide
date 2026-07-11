# Traffic Capture UX — Review & Backlog

*Date: 2026-07-11. Author: Claude (tech director / lead design), reviewed against Charles / Burp / HTTPToolkit.*

This doc records the findings of a full review of DarkRide's traffic-capture UI/UX and the
prioritized work that came out of it. It is the canonical backlog for this area; the
`ROADMAP.md` "Traffic Capture UX" section points here.

## How the interface flows today

Capture is spread across five nav destinations plus a per-device tab:

- **Per-device `Capture` tab** (`frontend/pages/DeviceView.tsx:1276` `CaptureTab`) — where capture is
  started/stopped. Idle form: proxy mode (none / HTTP rotation / NordVPN SOCKS5) + TLS profile
  (Chrome / OkHttp / default), then a 4-subsystem boot readout (Proxy → Cert → Tunnel → Test),
  then a live `TrafficTable` for that device.
- **`/ui/traffic` Traffic page** (`frontend/pages/Traffic.tsx`) — global Live/Saved view, paginated 50/page.
- **`/ui/request-builder`** (`frontend/pages/RequestBuilder.tsx`) — Postman-style form; the "Repeat/Replay" target.
- **`/ui/proxied-requests`** ("HTTP Requests") — server-side request history.
- **`/ui/api-catalogue`** — endpoint catalogue.
- **Intercept rules** — under `Automations` (`frontend/pages/Automations.tsx:183`), not in Traffic.

The core table (`TrafficTable.tsx`) + bottom-docked `TrafficDetailPanel.tsx` (tabs: Headers /
Payload / Preview / Cookies / Frames) is shared by the device tab, the global page, and the API
explorer. The detail panel is strong: GraphQL detect + pretty-print, schemaless protobuf/gRPC
decode, inline image preview, copy-as-cURL/Fetch, and rule attribution.

## Strengths (keep / lean into)

- **Best-in-class mobile capture setup.** WireGuard tunnel + auto cert injection + TLS-profile
  spoofing + 4-step subsystem health. Charles/Burp/HTTPToolkit make you do proxy+cert+pinning by
  hand. This is the reason the tool exists and it beats the incumbents for the mobile case.
- **Protocol-aware decoding** (GraphQL, protobuf/gRPC, images inline) — matches HTTPToolkit, beats stock Burp.
- **HAR + ZIP export** bundling screenshots + logs.
- **Live streaming** with optimistic pending-request rows; **WebSocket frame viewer** with direction filter.

## Prioritized backlog

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[b]` already built (pre-review).

### P0 — closes the biggest gaps vs Burp/Charles

- `[~]` **Interactive interception ("breakpoints").** Pause a matching request/response in-flight,
  edit it, forward or drop. Today's "Intercept" is rule-based auto-modify only; the header even
  mislabels passive capture as "Live Intercepting". This is the #1 functional gap.
  Design contract below. *(In progress — Wave 1, Opus.)*
- `[ ]` **In-place, tunnel-routed replay (Repeater).** Two problems: (1) "Repeat/Replay" navigates
  to a different page (`RequestBuilder`) via `sessionStorage`, losing context, with an ephemeral
  20-item history; (2) replay routes through `backend/services/proxied-request-service.ts` — the
  server-side proxy path — **not** the capturing device's tunnel/TLS-profile, so a replayed request
  egresses with none of the device context and can silently behave differently from what the app
  did. Fix: in-place request/response editor with original-vs-new response diff, and an option to
  send back through the capture session's egress + TLS profile. **Needs a short design pass on how
  to route "as device" (upstream egress + TLS profile vs true on-device injection) before build —
  do not implement blind.**
- `[ ]` **Real per-request timing.** No latency is captured anywhere — `CapturedTrafficEntry`
  (`shared/types/api.ts:191`) has no duration field and HAR export hardcodes `time:0` /
  zeroed `timings` (`backend/services/session-export.ts`). mitmproxy flows already carry
  `timestamp_start`/`timestamp_end`; forward them. Add `durationMs` (+ DNS/connect/TLS/TTFB if
  available), a sortable Duration column, and a timing waterfall in the detail panel.
  Design contract below. *(Queued — Wave 2, Opus.)*

### P1 — high value, medium effort

- `[~]` **Deep filter + search.** Backend `/v1/traffic/list` already supports `search`
  (LIKE over URL+headers+body), `hostname`/`path` regex, `method`, `status`, `type` — the UI only
  exposes a client-side host regex + method toggles + status groups. Surface full-text search,
  content-type filter, size/has-body filters, exact status codes, saved filter presets, and keep
  selection across filter changes. *(In progress — Wave 1, Sonnet.)*
- `[ ]` **Host/path tree view.** Charles's tree (endpoints grouped by domain) is a top RE feature
  and DarkRide is flat-table-only. Add a collapsible host → path tree alongside the table.
  (Partially served by the separate API Catalogue page — consider unifying.)
- `[ ]` **Unify the surface.** Fold the per-device Capture live view, the global Traffic page, and
  Intercept into one workspace with a device/scope selector, so replay and interception happen
  without page hops. Five nav entries for one workflow is the root of most friction.
- `[ ]` **Virtualize the list; raise/soften the 500-row cap** (`TrafficInspector.tsx:9` `MAX_ENTRIES`).
  Also fix that the global page stops appending live entries when not on page 0
  (`Traffic.tsx:249`) — under heavy capture you lose the live feed by paging.

### P2 — detail-panel depth for RE

- `[ ]` **Raw request/response wire view** (full raw HTTP incl. request line) — RE folks copy this constantly.
- `[ ]` **Search within a body**, collapsible JSON tree + syntax highlighting, hex view fallback for binary.
- `[ ]` **Auto-load full body** with a clear truncation indicator. Bodies truncate to 10 KB on the
  live broadcast (full body in DB up to a 1 MB Python cap; images 2 MB) — the live row you see is a
  truncated copy, and "Load Full Body" is a manual per-entry round-trip. Bodies over the Python cap
  are lost at capture time — surface that.
- `[ ]` **Render HTML responses** (not just source), and preview more MIME types (video/audio/font/PDF).

### P3 — polish / honesty / discoverability

- `[ ]` **"Clear" is view-only** on the Traffic page — it wipes local React state, not the DB, with
  no undo and no hint. Either label it or make it a real delete-with-confirm (as Saved traffic does).
- `[ ]` **Surface the blocklist** — "Block hostname" is one-way with no visible list from this view.
- `[ ]` **Expose "save this request" as a UI action** — Saved traffic currently requires knowing to
  call `req.save()`/`resp.save()` in an automation hook (undiscoverable).
- `[ ]` **Fix the TLS-spoofing discoverability** — it's a static pill whose tooltip points to another
  tab. Make the profile visible/settable closer to where capture is watched.
- `[ ]` **Column customization** — columns are fixed (Method, Host/Path, Status, Type, Size, Time).

## Design contracts for the in-flight items

### Interactive interception (P0)

Transport: **long-poll hold, no new sockets, no polling.**
- Python addon (`mitmproxy_bridge.py`) `request()`/`response()` hooks: if interception is armed and
  the flow matches, `await loop.run_in_executor(None, blocking_post)` to `POST /v1/intercept/hold`
  (must not block the asyncio loop; other flows keep flowing). Timeout ~300s → **fail open** (forward
  unmodified). Apply the returned `modified` (request: method/url/headers/body; response:
  status/headers/body) or drop via the project's reliable block pattern (`flow.kill()` is unreliable
  in WireGuard mode).
- Node: `backend/services/intercept-hold-store.ts` (in-memory `flowId -> {resolve, flow, phase}`,
  arm-state + optional match config, server timeout slightly shorter than the addon's) and
  `backend/api/intercept-live.ts` (`POST /hold` [addon, awaits resolution], `POST /resolve`
  `{flowId, action, modified?}` [UI], `GET/POST /armed`, `GET /held`). Broadcast `intercept-held` /
  `intercept-resolved` / `intercept-armed-changed`; add to `shared/types/websocket.ts` `ServerMessage`.
- Frontend: `frontend/components/intercept/InterceptHoldPanel.tsx` — queue + phase-aware editor +
  Forward / Forward-Modified / Drop; subscribe to the WS events, hydrate via `GET /held`. Arm toggle
  + held-count indicator in `Traffic.tsx`.
- Fail modes to handle: addon timeout, WS drop mid-hold, capture stop while held, two UIs resolving
  the same flow. In-memory only — no DB migration.

### Real per-request timing (P0)

- Python addon: forward `flow.request.timestamp_start`, `flow.response.timestamp_end` (and the
  intermediate TLS/connect timestamps mitmproxy exposes) on the `/ingest` payload.
- Backend: add `durationMs` (and optional timing breakdown) to the `capturedTraffic` schema
  (`backend/db/schema.ts`) via a Drizzle migration — remember the journal `when` must exceed the
  MAX prior `when`, and multi-statement migrations need `--> statement-breakpoint`. Populate on
  ingest (`backend/api/traffic.ts`). Fix HAR export to emit real timings.
- Frontend: add `durationMs` to `CapturedTrafficEntry` (`shared/types/api.ts`), a sortable Duration
  column in `TrafficTable.tsx`, and a timing waterfall in `TrafficDetailPanel.tsx`.

## Notes / constraints discovered

- Ingest is fire-and-forget HTTP POST (Python → Node); the browser hop is the WebSocket.
- A capture session *is* an automation session (`triggerType:'capture'`); all captured traffic is
  tied to a `sessionId`.
- Traffic WS channels are filtered channels — only subscribed clients get the high-frequency bytes.
- Replay currently blocks private/internal IPs (SSRF guard) via the proxied-request path.
