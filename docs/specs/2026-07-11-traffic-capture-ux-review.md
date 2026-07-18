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

- `[x]` **Interactive interception ("breakpoints").** Pause a matching request/response in-flight,
  edit it, forward or drop. Today's "Intercept" is rule-based auto-modify only; the header even
  mislabels passive capture as "Live Intercepting". This is the #1 functional gap.
  Design contract below. *(Landed on `feat/traffic-capture-ux`: `intercept-hold-store` +
  `intercept-live` API + `InterceptHoldPanel`; long-poll hold, fail-open, addon-visible armed
  config, no migration. Rule-based intercept untouched. Follow-up: relabel the passive "Live
  Intercepting" header pill now that real interception exists.)*
- `[x]` **In-place, tunnel-routed replay (Repeater).** *(Landed on `feat/traffic-capture-ux`:
  `ReplayDrawer` slide-over + `response-diff` util; backend `captureSession` proxy source + ported
  `shared/lib/tls-profiles.ts`; `ActiveCapture.getEgress`. Replaces the navigate-away flow, shows an
  original-vs-new status/header/body diff, and routes replays through the capture session's egress +
  a replicated cipher profile — Option 1 in the design contract below. `normal`-proxy-mode sessions
  fall back to direct egress with an explicit note since the rotating proxy isn't recorded.)*
  Deferred: byte-exact emulator routing (Option A) and on-device Frida replay (Option C).
- `[x]` **Real per-request timing.** *(Landed on `feat/traffic-capture-ux`: forwarded mitmproxy
  timestamps, `durationMs`/`timings` columns via migration 0097, sortable Duration column,
  detail-panel timing waterfall, and real HAR timings replacing the zeroed ones.)* No latency was
  captured before — `CapturedTrafficEntry`
  (`shared/types/api.ts:191`) has no duration field and HAR export hardcodes `time:0` /
  zeroed `timings` (`backend/services/session-export.ts`). mitmproxy flows already carry
  `timestamp_start`/`timestamp_end`; forward them. Add `durationMs` (+ DNS/connect/TLS/TTFB if
  available), a sortable Duration column, and a timing waterfall in the detail panel.
  Design contract below. *(Queued — Wave 2, Opus.)*

### P1 — high value, medium effort

- `[x]` **Deep filter + search.** Backend `/v1/traffic/list` already supports `search`
  (LIKE over URL+headers+body), `hostname`/`path` regex, `method`, `status`, `type` — the UI only
  exposed a client-side host regex + method toggles + status groups. *(Landed on
  `feat/traffic-capture-ux`: full-text server search, content-type/size/exact-status filters, saved
  presets, active-filter chips, selection survives filter changes. Also fixed the Host/URL box being
  a no-op on the global page. Follow-up: client-side filters (content-type/size/multi-group status)
  narrow only the fetched 50-row page — push those predicates server-side.)*
- `[x]` **E2E infra fix (found en route).** WS origin allowlist only accepted Vite 5173 but E2E runs
  on 5199, so every WS-dependent Playwright spec hung and timed out. Fixed in `playwright.config.ts`.
- `[ ]` **Host/path tree view.** Charles's tree (endpoints grouped by domain) is a top RE feature
  and DarkRide is flat-table-only. Add a collapsible host → path tree alongside the table.
  (Partially served by the separate API Catalogue page — consider unifying.)
- `[ ]` **Unify the surface.** Fold the per-device Capture live view, the global Traffic page, and
  Intercept into one workspace with a device/scope selector, so replay and interception happen
  without page hops. Five nav entries for one workflow is the root of most friction.
- `[x]` **Virtualize the list; raise/soften the 500-row cap** (`TrafficInspector.tsx:9` `MAX_ENTRIES`).
  Also fix that the global page stops appending live entries when not on page 0
  (`Traffic.tsx:249`) — under heavy capture you lose the live feed by paging.
  *(Landed on `feat/traffic-list-perf`: `@tanstack/react-virtual` spacer-row
  virtualization in `TrafficTable` (uniform row height measured once; DOM rows
  bounded to the viewport; lists ≤50 keep the plain path); inspector cap
  500→5000; and a jump-to-live banner on the global page — live entries
  captured while paged away / in a custom sort / during a search are buffered
  and one-click recoverable instead of silently dropped. Gate: TrafficTable +
  TrafficInspector + Traffic tests; E2E: `tests/e2e/traffic-list-perf.spec.ts`.)*

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

### In-place, tunnel-routed replay (P0) — design locked 2026-07-11

Design pass done (grounded in a codebase investigation of the replay/egress/TLS plumbing).
Two parts:

**Part 1 — In-place Repeater UI (no architectural fork).** Replace the "navigate to RequestBuilder via
sessionStorage" replay flow with an in-context **slide-over Repeater drawer** opened by the existing
Replay/Repeat buttons. Keeps the captured original visible; edit method/url/headers/body; Send;
show the new response beside the original with an **original-vs-new diff** (status / headers / body).
Surface the server-side replay history (`proxied-request-service` already keeps 200 entries) instead
of RequestBuilder's volatile 20-item in-session list. Keep RequestBuilder as the standalone ad-hoc
page. Build the Repeater as a self-contained component; touch `TrafficDetailPanel`/`TrafficTable`
minimally (only the replay-trigger handler) to stay decoupled from the timing/filter changes.

**Part 2 — "Replay via capture session" routing (chosen: Option 1, uniform).** The investigation
found: replay today goes through `proxied-request-service` (server-side proxy pool, no device
context, plain Node OpenSSL JA3); per-session egress (`proxyMode`/`proxyCountry`/`tlsProfile`) is
NOT persisted or retained (only in the spawned mitmdump args); physical devices use WireGuard mode
with **no proxy port** to route through (so routing through the live mitmproxy only works for
docker-android emulators); and mitmproxy's own TLS spoof is **cipher-list-level** via pyOpenSSL, not
byte-exact JA3.

Decision: replicate the session's egress + TLS profile in the server request path — uniform across
physical devices and emulators, and matching the fidelity capture itself achieves. Steps:
1. Surface egress: add `proxyMode`/`proxyCountry`/`tlsProfile` (+ resolved SOCKS target) to
   `ActiveCapture` in `capture-session-manager.ts` at start-time (cheap, in-memory) and a
   `getEgress(deviceId)` accessor. The `activeSessions` map is keyed by `deviceId` — a captured
   entry carries `deviceId`, so the lookup is direct.
2. Extend `ProxiedHttpRequest` (type + validator in `backend/api/proxied-requests.ts`) with a new
   proxy source `{ type: 'captureSession', deviceId }` and a `tlsProfile` field.
3. In `proxied-request-service.resolveProxy`, handle `captureSession`: look up the device's live
   egress and build the same agent (reuse the nordvpn/proxyId/inline logic already there).
4. Apply the TLS profile in `doSingleRequest`: port the chrome/okhttp cipher lists from
   `python/mitmproxy_bridge.py` into a shared TS constants module and set `ciphers`/`sigalgs`/
   `ecdhCurve`/ALPN on the `https.request` options. Document the caveat: cipher-list parity, not
   byte-exact JA3 (Node/OpenSSL can't control GREASE/extension order) — same limitation the capture
   session has.
5. UI default: when the entry's device is actively capturing, default "Send via" to
   `Capture session (device egress + TLS)`, else Direct.

Deferred: **Option A** (route through the live mitmproxy proxy port — byte-exact, emulators only) can
layer on later as a fidelity upgrade when an emulator proxy port is available (requires persisting
that port, which is currently discarded). **Option C** (on-device Frida injection — app's genuine TLS
stack + signing + pinning) is the highest-fidelity path but needs per-target scripts and is a much
larger build; future work. The `/v1/frida/spawn/:deviceId` injection channel exists; a replay script
does not.

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
