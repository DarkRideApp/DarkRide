# Traffic Capture UX — P3 Polish Sweep — Design

Date: 2026-07-16
Branch: `feat/traffic-p3-polish` (stacked on `feat/traffic-list-perf` / PR #37 — shares TrafficTable + Traffic.tsx edits)
Backlog: P3 tier of `docs/specs/2026-07-11-traffic-capture-ux-review.md`

## Outcome

Close the five P3 "polish / honesty / discoverability" items. Each is small and mostly
independent. Scope decisions below were made autonomously (Cube away) and are flagged for
review — two forks were deliberately kept conservative.

## Item 1 — "Clear" honesty (`Traffic.tsx`, `TrafficTable.tsx`)

**Defect:** the Traffic subheader "Clear" button calls `handleClear` which wipes local React
state only (`setEntries([])`), not the DB, with no undo and no hint — it reads as "delete my
captured data" but isn't.

**Fix (chosen: relabel):** rename to **"Clear view"** with `title="Clears the current view only —
captured traffic stays in the database."`. Same for the inspector's live-mode clear control so
the wording is consistent. Frontend-only, zero destructive risk.

**Deliberately NOT done:** adding a destructive `DELETE /v1/traffic` that truncates
`captured_traffic`. That is a new irreversible capability, not a bugfix, and deserves explicit
sign-off. Saved-traffic already has a real delete-with-confirm for data that matters. Flagged
as a possible follow-up.

## Item 2 — Surface the blocklist (`BlocklistPanel.tsx` new, `Traffic.tsx`)

**Defect:** "Block hostname" is one-way; there's no visible list of what's blocked and no unblock
from this view.

**Fix:** backend already has full CRUD (`GET /v1/blocklist/list`, `POST /v1/blocklist/add`,
`DELETE /v1/blocklist/remove/:id`). Add a **"Blocked (N)"** button in the Traffic subheader
actions that opens a small popover panel (`BlocklistPanel`) listing each blocked domain with an
"Unblock" (×) button. The panel fetches the list on open and after any unblock; N is the count.
When N is 0 the button still shows ("Blocked (0)") so the feature is discoverable. Frontend-only.

- Component boundary: `BlocklistPanel` takes `ws` (for REST) + `onClose`; owns its own
  list state and fetch. Reusable from any view that imports it.

## Item 3 — "Save this request" UI action (`TrafficDetailPanel.tsx`, new `POST /v1/traffic/saved`)

**Defect:** saving traffic requires knowing to call `req.save()` / `resp.save()` in an automation
hook — undiscoverable from the UI.

**Fix:**
- Backend: new `POST /v1/traffic/saved` with body `{ id }`. Loads the `capturedTraffic` row by id,
  maps to `SavedTrafficEntry` (url, method, request/response headers+body, deviceId), calls the
  existing `SavedTrafficStore.save()` (which upserts, latest-wins per url+method). Returns
  `{ success, data: { saved: true } }`; 404 if the id isn't found; `requires: ['core.traffic:manage']`
  to match the other saved-traffic mutations. Server loads by id rather than trusting a
  client-supplied body.
- Frontend: add a **"Save"** action button in `TrafficDetailPanel` next to Repeat/Block (uses the
  existing `ActionButton` copy-feedback pattern for a "Saved ✓" confirmation). Wire a new
  `onSave?: (entry) => void` prop down from `TrafficTable` → `Traffic.tsx`/`TrafficInspector`,
  which POSTs `{ id: entry.id }`.

## Item 4 — TLS-pill discoverability (`Traffic.tsx`)

**Defect:** the pill is a static badge whose tooltip points to another tab; on the global page
(which aggregates multiple devices) there is no single profile to set here, so it implies a
control that doesn't live here.

**Fix (chosen: honest copy):** reword the pill to read **"TLS spoofing · per device"** with
`title="Each device can pose as Chrome 120 Android, OkHttp, or stock. Set the profile on that
device's Capture tab."` — informational, no implied global setter.

**Deliberately NOT done:** a live per-device profile summary ("Chrome ×2, OkHttp ×1"). No endpoint
lists active capture sessions with their `tlsProfile` (only per-device `GET /v1/capture/status/:id`),
so it needs a new backend endpoint + polling. Flagged as a follow-up; the correct home for a
*setter* is the device Capture tab, not the global page.

## Item 5 — Column customization (`TrafficTable.tsx`, `trafficUtils.ts`)

**Defect:** the 7 columns (Method, Host/Path, Status, Type, Size, Duration, Time) are fixed.

**Fix (chosen: show/hide + persist):** a **"Columns"** menu button in the filter bar that opens a
dropdown of checkboxes, one per column. Toggling hides/shows that column in both the `<thead>`
(sortable and non-sortable branches) and the body rows. Host/Path is non-hideable (the list is
useless without it) — its checkbox is disabled/checked. Selection persists to `localStorage`
under `darkride:traffic-columns` via helpers in `trafficUtils.ts`
(`loadColumnPrefs()` / `saveColumnPrefs()`), mirroring the existing filter-preset persistence.

**Interaction with virtualization:** the spacer `<tr>` `colSpan` becomes the count of *visible*
columns instead of a hard-coded 7. `renderRow` conditionally renders each `<td>` on its column's
visibility. A `COLUMNS` descriptor array (key, label, width, sortKey?) drives both the header and
the body so they can't drift.

**Deliberately NOT done:** drag-reorder and drag-resize. Gold-plating for a P3; can be layered on
the same `COLUMNS` + prefs foundation later.

## Files touched

- `frontend/pages/Traffic.tsx` — Clear-view label, TLS-pill copy, Blocked button + panel wiring, onSave.
- `frontend/components/traffic/TrafficInspector.tsx` — Clear-view label, onSave wiring.
- `frontend/components/traffic/TrafficTable.tsx` — Columns menu, visible-column rendering, dynamic colSpan.
- `frontend/components/traffic/TrafficDetailPanel.tsx` — Save action button + onSave prop.
- `frontend/components/traffic/BlocklistPanel.tsx` — new popover component.
- `frontend/components/traffic/trafficUtils.ts` — `COLUMNS`, `loadColumnPrefs`/`saveColumnPrefs`.
- `frontend/styles.css` — blocklist panel + columns menu styles.
- `backend/api/saved-traffic.ts` — `POST /v1/traffic/saved`.
- `shared/types/api.ts` — save-request response type if needed.

## Testing

**Gate (Vitest, jsdom + supertest):**
- `saved-traffic.test.ts` (backend): `POST /v1/traffic/saved` with a real captured id persists via
  the store; unknown id → 404; missing id → 400; requires `core.traffic:manage`.
- `TrafficTable.test.tsx`: Columns menu toggles a column out of `<thead>` and rows; Host/Path
  cannot be hidden; prefs round-trip through localStorage (load reflects a saved set); dynamic
  colSpan on the virtualized spacer equals visible-column count.
- `TrafficDetailPanel.test.tsx`: Save button calls `onSave(entry)`; shows the saved confirmation.
- `BlocklistPanel.test.tsx`: renders fetched domains, unblock calls `DELETE .../remove/:id` and
  refreshes; empty state.
- `Traffic.test.tsx`: Clear button reads "Clear view"; Blocked (N) button opens the panel; TLS
  pill copy asserts the new text.
- `trafficUtils.test.ts`: `loadColumnPrefs`/`saveColumnPrefs` defaults + persistence + Host/Path
  always present.

**E2E (`tests/e2e/traffic-p3.spec.ts`):** ingest a row → open detail → Save → switch to the Saved
tab and see it; block a host → open Blocked panel → unblock → gone; hide the Size column via the
Columns menu → reload → still hidden (localStorage).

**Evals:** N/A — deterministic UI + a CRUD endpoint, no LLM in the path. Stated, not faked.

## Review flags (decided autonomously, easy to revisit)

1. "Clear" → relabel only (no destructive delete-all-captured endpoint).
2. TLS pill → copy only (no live per-device summary endpoint).
3. Columns → show/hide + persist only (no reorder/resize).
