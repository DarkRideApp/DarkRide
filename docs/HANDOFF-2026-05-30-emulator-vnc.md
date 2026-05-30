# Handoff — Emulator VNC streaming (feature/emulator-support)

**Last updated:** 2026-05-30
**Author session:** Opus 4.7 (1M context), running remotely against `/home/cube/projects/darkride`
**Reason for handoff:** dev-loop iteration on the user's Windows + Docker Desktop machine is faster than push/pull cycles. Run me locally next.

---

## Read this first

Paste this whole file into a fresh Claude Code session on the dev machine as the opening message, with a one-line ask at the bottom like *"continue from here — current issue is X"*. The doc is structured so the new Claude can be useful within ~30s of reading it.

---

## Project & branch

- **DarkRide** — AGPL mobile RE / traffic-analysis toolkit. TypeScript backend + React frontend + Python bridge (Frida / mitmproxy).
- **Branch:** `feature/emulator-support` — docker-android emulator provider + Phase 1 VNC streaming. Several other earlier-emulator-related commits also live on this branch.
- **Default branch:** `main`. Do not switch branches unless the user explicitly asks.
- **Operating env:** user runs `npm run dev` on Windows host, Docker Desktop with WSL2 backend exposing `/dev/kvm` to containers. Backend listens on `:3000`, Vite on `:5173` (proxies `/ws*` and `/v1/*` to `:3000`).

---

## What's been built (Phase 1 — emulator VNC streaming, complete)

Spec: `docs/superpowers/specs/2026-05-29-emulator-vnc-streaming-design.md` (gitignored — local only)
Plan: `docs/superpowers/plans/2026-05-29-emulator-vnc-streaming.md` (gitignored — local only, has the original 10-task TDD checklist)

The pipeline, in one sentence: **noVNC RFB in the browser → DarkRide-authed WebSocket at `/ws/vnc?serial=...` → backend TCP bridge → budtmo container's raw VNC on `127.0.0.1:5900`.**

Key code locations:
- `backend/services/providers/docker-android.ts` — binds `5900/tcp` to loopback host port, exposes `getVncEndpoint(id)` returning `{host, port}`, declares `videoTransport: 'vnc'`. Sets `SCREEN_WIDTH=1080`, `SCREEN_HEIGHT=2400`, `EMULATOR_ADDITIONAL_ARGS=-no-skin` for the budtmo container.
- `backend/websocket/vnc-proxy.ts` — `createVncBridge(ws, serial, deps)` byte-pipe. Tested with EventEmitter mocks.
- `backend/websocket/index.ts` — shared HTTP upgrade router so `/ws` + `/ws/vnc` can coexist on one HTTP server (the canonical `noServer: true` pattern; two `WebSocketServer({server,path})` instances would conflict at `abortHandshake`).
- `backend/api/video-transport.ts` — `GET /v1/devices/:serial/video-transport` resolver. Returns `{transport: 'vnc', wsPath}` if the matched instance's provider declares vnc.
- `frontend/lib/video/VncViewer.tsx` — thin noVNC RFB wrapper, callback refs to avoid re-mount storms, listener cleanup on teardown, `[VncViewer <serial>]` console logging for diagnostics.
- `frontend/pages/DeviceView.tsx` — fetches `/video-transport` on mount, conditionally renders `<VncViewer>` vs existing `<DeviceViewer>` (scrcpy).
- `packages/plugin-sdk/src/types/device-providers.ts` — `DeviceProvider.videoTransport?` and `getVncEndpoint?` optional fields.

After type changes in the SDK: **`npm run build -w @darkrideapp/plugin-sdk`** before re-running tests that import via the package name.

---

## Recent commits (feature/emulator-support, newest first)

```
72729ed fix(vnc): drop emulator skin + cap canvas height to viewport
20cec90 fix(devices): drop stale devices row when its emulator instance is deleted
51b90ba fix(docker-android): match Xvfb desktop to Pixel 8 native resolution
3d61fda fix(vnc-viewer): drop scaleViewport so the canvas renders at all
8576846 feat(vnc-viewer): log lifecycle events + handle credentialsrequired
1580f55 fix(devices): null FK refs in transaction so Forget doesn't trip SQLite FK
c2fdf4f feat(devices): add Forget button for stale orphaned device rows
63de8fb fix(devices): show instance card (with Start) for stopped emulators
6deaeba fix(vite): bump esbuild target to es2022 for @novnc/novnc top-level await
5af1dc6 fix(device-view): guard video-transport fetch + add scrcpy-path test
884bb59 feat(device-view): render VncViewer when transport=vnc
cad5269 fix(vnc-viewer): callback refs, listener cleanup, disjoint disc/error paths
0b1ec0e feat(frontend): VncViewer component (noVNC RFB wrapper)
a50a9c6 chore(deps): add @novnc/novnc for emulator VNC streaming
9c3bef6 fix(video-transport): drop redundant decodeURIComponent on path param
87e1577 feat(api): GET /v1/devices/:serial/video-transport
4cbfa4b fix(websocket): shared upgrade router for /ws + /ws/vnc
5ae0857 feat(websocket): mount /ws/vnc proxy alongside /ws
d33b586 fix(vnc-proxy): reject text frames, teardown on write fail, remove listeners on teardown
9948ef5 feat(websocket): VNC TCP↔WS bridge for emulator streaming
cff85e6 feat(docker-android): implement getVncEndpoint via container inspect
4331e2c feat(docker-android): bind 5900/tcp + declare videoTransport=vnc
b3dbbce feat(plugin-sdk): add videoTransport + getVncEndpoint to DeviceProvider
```

Older relevant work on the same branch (pre-VNC, earlier emulator infrastructure):
```
5af109c feat(devices): surface Stop/Delete on the device card when backed by a managed instance
d6c82f8 fix(device-manager): drop literal "..." wrapping on three adbShell callsites
c0e2ad3 fix(docker-android): always include /dev/kvm — host existsSync is wrong on Docker Desktop
```

Full list: `git log --oneline main..HEAD`.

---

## Currently debugging

The user reported that after `delete + recreate` of an emulator, the device-detail page falls back to **scrcpy polling** instead of using VNC. Working hypothesis (unverified):

- URL still has the **old** serial (e.g. `/ui/devices/localhost:32768/details`) because the user navigated to it before delete.
- New container got a different random host port (`localhost:32770` or whatever), so the URL serial no longer matches any instance row.
- `resolveVideoTransport` correctly returns `scrcpy` for an unknown serial → DeviceView renders `<DeviceViewer>` → scrcpy can't find the adb serial → falls back to polling.

Diagnostic curl (need session cookie from devtools → Application → Cookies):

```bash
curl -s "http://localhost:3000/v1/devices/<serial-from-URL>/video-transport" \
  -b 'darkride_sid=<cookie>' | jq
```

- `{"transport":"scrcpy"}` → resolver isn't matching the URL serial against any instance. Either URL is stale (most likely), or instance row's `serial` column hasn't been populated yet (only happens when `startInstance` resolves).
- `{"transport":"vnc","wsPath":"/ws/vnc?serial=..."}` → backend's fine, look at frontend gating in `DeviceView.tsx`.

When VNC IS working: visible in the **browser console** as `[VncViewer <serial>] connect event fired — RFB session established`. Backend prints `[vnc-proxy] vnc bridge <serial> → 127.0.0.1:<port> opened`.

---

## Known open ergonomics issues (not bugs, polish)

- The Xvfb desktop in budtmo is hardcoded to Pixel 8 dimensions (1080×2400). If the user ever adds a second device profile, `SCREEN_WIDTH`/`SCREEN_HEIGHT` need to be looked up from `EMULATOR_DEVICE` in `docker-android.ts`.
- `VncViewer` has no reconnect-on-drop. Deliberate Phase 1 decision (parent owns retry policy, matches `DeviceViewer`). If the user wants it, the cleanest place is a setInterval / exponential backoff in the parent.
- The reconciler doesn't currently sweep stale device rows. Today's fix removes the matching device row inline on instance delete; orphans from earlier emulator sessions still appear and can be cleared via the per-card **Forget** button (`DELETE /v1/device/:id`, which goes through `forgetDeviceRow` in `backend/services/forget-device.ts` to null FK refs in the three child tables).

---

## How to dev-loop here

User's machine (Windows host, Docker Desktop on WSL2):

```bash
# from the repo root
git checkout feature/emulator-support
git pull
npm install               # picks up any new deps, e.g. @novnc/novnc
npm run dev               # concurrently vite + tsx watch backend
```

The backend printing `[websocket] VNC proxy mounted at /ws/vnc` on startup means the proxy is live. Navigate to `http://localhost:5173/ui/devices` to test.

When dev iteration touches the VNC connection:
- Vite caches noVNC's prebundle in `node_modules/.vite/`. After bumping `@novnc/novnc` or the esbuild target: `rm -rf node_modules/.vite` (PowerShell: `Remove-Item -Recurse -Force node_modules\.vite`) and restart.
- Budtmo reads `EMULATOR_ADDITIONAL_ARGS`, `SCREEN_WIDTH`, `SCREEN_HEIGHT` at container start. Changes to those env vars require **delete + recreate** of the emulator, not just stop/start.

---

## Conventions on this branch

- **Commits:** `<type>(scope): <subject>` body wraps at ~72 cols. Always end with
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
  Subagent harnesses will sometimes flag this footer as "fabricated co-author" — it's a false positive; the user has authorized it as a project convention.
- **Tests:**
  - Backend: `npx vitest run [path]` (CJS, includes integration tests against real in-memory SQLite via `backend/test-utils/create-test-db.ts` + `applyMigrations`). Use this pattern when FK constraints matter — mocked-DB unit tests don't catch FK violations.
  - Frontend: `npx vitest run --config vitest.config.frontend.ts [path]` (jsdom).
  - Typecheck: `npx tsc -p tsconfig.json --noEmit` (backend only; frontend is checked via vitest's transform).
- **TDD + subagents** for substantial features (followed for Phase 1 here): brainstorming-skill → spec → writing-plans-skill → plan → subagent-driven-development-skill → per-task implementer + spec reviewer + code-quality reviewer. The skills' base directory is `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/`.
- **Memory:** persistent memory dir at `/home/cube/.claude/projects/-home-cube-projects-darkride/memory/` (THIS dev machine has its own). Check `MEMORY.md` there for cross-session notes. Don't recreate; just check.
- **The user's repo has `docs/superpowers/` gitignored** — specs and plans live there but aren't pushed. Authoring + reading is fine; just don't be surprised when `git status` is clean.

---

## Pending follow-ups (deferred, not blocking)

- **Phase 2 streaming rework** for non-emulator (USB/iOS) devices. The user's strong preference based on past experience: pipe scrcpy → ffmpeg → fragmented MP4 / MSE. The current scrcpy-direct-to-WebCodecs path has no jitter buffer and lags noticeably. Brainstorming-skill conversation about this is queued for after Phase 1 stabilizes.
- **Backend reconciler sweep** of stale device rows whose `instanceId` resolves to a non-running instance — would handle the orphan case for old sessions where today's inline cleanup wasn't yet in effect.
- **Multiple emulator device profiles** in the CreateEmulatorModal — currently hardcoded to Pixel 8.

---

## Final note for the new Claude

The user is technical, fast at iteration, and prefers terse, accurate updates over reassurance. Push back with technical reasoning when you disagree. When the user asks for evidence, give it (logs, code paths, test output) — don't speculate. The Phase 1 work was completed via the superpowers subagent-driven flow and has a high test density; matching that bar on follow-up changes is the expectation.

Good luck. Memory hint: most of the bugs above were caught by either (a) the code-quality reviewer subagent in code that already passed spec compliance, or (b) the user noticing a UX edge case on first real-emulator usage. Both review gates matter.
