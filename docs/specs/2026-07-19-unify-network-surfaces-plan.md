# Network Workspace (unify surfaces) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One `/ui/network` workspace unifying Traffic, Intercept, Repeater, and API Catalogue behind a scope selector (All devices / device / capture session), replacing four nav entries. One reviewable PR.

**Architecture:** A `NetworkScopeContext` holds `{ kind, deviceId?, sessionId? }`, URL-synced via `?scope=` and `?pane=`. `NetworkWorkspace` renders a `ScopeBar` + pane tabs; each pane reuses the existing surface component, scoped where meaningful. Old routes redirect into the workspace.

**Tech Stack:** React 19 + react-router, TypeScript, Vitest/RTL, Playwright.

## Global Constraints

- Stacked on `feat/traffic-host-tree` (Traffic has the tree). Base the eventual PR on main after #40 merges.
- Session ids are integers (`automationSessions.id`); capture sessions are automation sessions with `triggerType='capture'`.
- Reuse existing endpoints: `/v1/device/list`, `/v1/automation/sessions?triggerType=capture`, `/v1/automation/session/:id/export/{har,zip}`, `/v1/traffic/list` + `/v1/traffic/tree` (both take `deviceId`+`sessionId`).
- Frontend gate `npm run test:frontend`; single file `npx vitest run --config vitest.config.frontend.ts <path>`.
- TDD; no em dashes / AI-vocab.

---

### Task 1: NetworkScopeContext + URL sync

**Files:** Create `frontend/components/network/NetworkScopeContext.tsx`; Test `.../NetworkScopeContext.test.tsx`.

**Interfaces:** `type NetworkScope = { kind: 'all' } | { kind: 'device'; deviceId: string } | { kind: 'session'; sessionId: number }`. `useNetworkScope(): { scope, setScope }`. `parseScopeParam(s: string|null): NetworkScope` / `scopeToParam(scope): string|undefined` (`device:<id>`, `session:<n>`, all→undefined). Provider `NetworkScopeProvider` syncs to `useSearchParams` `scope`.

- [ ] Write failing test: `parseScopeParam('device:abc')` → `{kind:'device',deviceId:'abc'}`; `parseScopeParam('session:5')` → `{kind:'session',sessionId:5}`; `parseScopeParam(null)`/`'all'` → `{kind:'all'}`; `scopeToParam` round-trips; bad input → all.
- [ ] Run → fail. Implement pure helpers + a context/provider that reads/writes `?scope=`. Run → pass. Commit.

### Task 2: derive scope props (deviceId/sessionId) helper

**Files:** add `scopeToTrafficParams(scope): { deviceId?: string; sessionId?: number }` to the same file; test it.

- [ ] Test: session scope → `{sessionId}`; device scope → `{deviceId}`; all → `{}`. Implement. Commit (fold into Task 1 commit if small).

### Task 3: Make Traffic scope-aware

**Files:** Modify `frontend/pages/Traffic.tsx` (add optional props `scopeDeviceId?: string|null`, `scopeSessionId?: number|null`, default null; thread into `fetchTraffic` params (`deviceId`/`sessionId`) and pass `sessionId` to `TrafficTree`); Test in `Traffic.test.tsx`.

- [ ] Test: rendering `<Traffic scopeSessionId={7} />` makes the `/v1/traffic/list` call include `sessionId=7`; default (no props) omits it. (Add a `renderPage` variant passing props.)
- [ ] Run → fail. Add props + thread through. Also pass `sessionId={scopeSessionId}` to `<TrafficTree>`. Run → pass. Commit.

### Task 4: ScopeBar

**Files:** Create `frontend/components/network/ScopeBar.tsx`; Test `.../ScopeBar.test.tsx`.

**Interfaces:** `ScopeBar({ ws, scope, onScopeChange })`. Loads devices (`/v1/device/list`) + capture sessions (`/v1/automation/sessions?triggerType=capture&limit=100`). Renders: a scope-kind segmented control (All / Device / Session) with the relevant dropdown; when `kind==='session'` shows Export HAR (`window.open('/v1/automation/session/<id>/export/har')`), Export ZIP, and a "Copy link" button that writes `location.origin + '/ui/network?scope=session:<id>'` to clipboard.

- [ ] Test: renders All/Device/Session controls; selecting a device from the dropdown fires `onScopeChange({kind:'device',deviceId})`; session mode shows Export HAR + Copy link; Copy link calls `navigator.clipboard.writeText` with the deep link (mock clipboard).
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task 5: Panes

**Files:** Create `frontend/components/network/panes/{TrafficPane,InterceptPane,RepeaterPane,CataloguePane}.tsx`. Tests: one `panes.test.tsx` asserting each renders its surface.

**Interfaces:** each pane takes `{ scope }` (and `ws` where needed).
- `TrafficPane`: `<Traffic scopeDeviceId={...} scopeSessionId={...} />` from `scopeToTrafficParams`.
- `InterceptPane`: renders `InterceptArmControl` + `InterceptHoldPanel` (existing) with a short explainer.
- `RepeaterPane`: renders `RequestBuilder` (existing).
- `CataloguePane`: renders `ApiCatalogue` (existing).

- [ ] Test: `TrafficPane` with a session scope renders the traffic table and the `/list` call carries `sessionId`; the other panes render their root testids. Implement (thin wrappers). Commit.

### Task 6: NetworkWorkspace shell + route + nav + redirects

**Files:** Create `frontend/pages/NetworkWorkspace.tsx`; Modify `frontend/App.tsx` (route `/ui/network`, redirects), `frontend/components/layout/AppLayout.tsx` (nav). Test `NetworkWorkspace.test.tsx`.

**Interfaces:** `NetworkWorkspace` wraps `NetworkScopeProvider`, renders `ScopeBar` + a pane tablist (`?pane=traffic|intercept|repeater|catalogue`, default traffic) + the active pane.

- [ ] Test: default renders the Traffic pane; clicking the "Intercept" tab shows the intercept pane and sets `?pane=intercept`; `?scope=session:3` preselects the session scope (ScopeBar reflects it). 
- [ ] Run → fail. Implement shell (lazy-load panes). Add route `<Route path="network" element={<NetworkWorkspace/>} />`. Redirect old routes: `/ui/traffic`→`/ui/network?pane=traffic`, `/ui/proxied-requests`+`/ui/request-builder`→`?pane=repeater`, `/ui/api-catalogue`→`?pane=catalogue` (use `<Navigate>` wrappers preserving query where trivial). In AppLayout, replace the four Network items with a single `{ to:'/ui/network', label:'Network', icon: Activity }`. Run → pass. Commit.

### Task 7: Device Capture tab deep link

**Files:** Modify `frontend/pages/DeviceView.tsx` (CaptureTab): add an "Open in Network" link → `/ui/network?scope=session:<captureSessionId>` (or `device:<id>` when no session). Test in the existing DeviceView test if present, else a small assertion.

- [ ] Test/imp: link present with correct href when capturing. Commit.

### Task 8: E2E + docs + gate

**Files:** Create `tests/e2e/network-workspace.spec.ts`; update backlog + ROADMAP.

- [ ] E2E: go to `/ui/network`; assert Traffic pane + ScopeBar; switch to Repeater tab (request builder visible); pick a session scope (seed one via ingest+capture or the sessions list) and assert Export HAR + Copy link appear; assert `/ui/traffic` redirects to the workspace.
- [ ] Mark "Unify the surface" `[x]` (framework landed; per-pane polish follow-up) in the review doc + ROADMAP.
- [ ] Full gate: `npm run test:frontend`, `npm run typecheck`, backend `npx vitest run` sanity. Push; open PR based on main (after #40) — or on `feat/traffic-host-tree` if #40 still open.

## Self-Review

Coverage: scope model → T1/T2; Traffic scoping → T3; scope bar + export/share → T4; panes → T5; shell+route+nav+redirects → T6; device deep link → T7; E2E+docs → T8. ✓
Types: `NetworkScope`, `useNetworkScope`, `scopeToParam`/`parseScopeParam`, `scopeToTrafficParams`, pane `{scope}` props consistent throughout.
Reuse: panes render existing `Traffic`/`RequestBuilder`/`ApiCatalogue`/intercept components — no rewrites; double PageHeaders on Repeater/Catalogue accepted for v1 (noted in PR as follow-up).
