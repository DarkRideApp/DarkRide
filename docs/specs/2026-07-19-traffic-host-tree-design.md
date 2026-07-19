# Traffic Host/Path Tree — Design

Date: 2026-07-19
Branch: `feat/traffic-host-tree`
Backlog: P1 "Host/path tree view" in `docs/specs/2026-07-11-traffic-capture-ux-review.md`

## Outcome

Charles/Burp show captured traffic grouped as a collapsible host → path tree; DarkRide's Traffic
page is flat-table-only. Add a collapsible tree panel beside the table: top level is hostnames
(with request counts) across ALL captured traffic, expanding a host lazily lists its paths.
Clicking a host or path filters the main table to it. Measurable: you can find "every request to
`api.foo.com/checkout`" in two clicks instead of scrolling/paging a 50-row window.

## Why server-side aggregation (not client grouping)

The global Traffic page is server-paginated (50 rows/page), so grouping the loaded rows client-side
would only ever reflect the current page — useless as a navigator. `captured_traffic.hostname` is a
stored, indexed column (written at ingest, `traffic.ts:269`), so a hostname `GROUP BY` is cheap and
covers the whole DB. Paths aren't stored decomposed, so path grouping is done in JS over the rows
for a single hostname (bounded).

## Backend — `GET /v1/traffic/tree`

- **Hosts mode** (no `hostname` param): `SELECT hostname, COUNT(*) AS count FROM captured_traffic
  [WHERE sessionId = ?] GROUP BY hostname ORDER BY count DESC`. Returns
  `{ success, data: { hosts: Array<{ hostname: string; count: number }> } }`. Null/empty hostnames
  are bucketed under `'(unknown)'`.
- **Paths mode** (`?hostname=<h>`): load up to 2000 rows for that hostname
  (`WHERE hostname = ? [AND sessionId = ?] ORDER BY capturedAt DESC LIMIT 2000`), derive
  `path = new URL(requestUrl).pathname` (fallback to the raw url on parse failure), group by path.
  Returns `{ success, data: { paths: Array<{ path: string; count: number; latestId: number }> } }`
  ordered by count desc. `latestId` = the newest captured id for that path (lets a click select a
  concrete row). If >2000 rows exist for the host, set `data.truncated = true` so the UI can say so
  (no silent cap).
- `requires: ['core.traffic:read']`. Optional `sessionId` query param mirrors `/list` for the
  per-device inspector.

## Frontend — `TrafficTree.tsx`

- Props: `{ ws, sessionId?, activeHost?, onSelectHost(hostname), onSelectPath(hostname, path, latestId) }`.
- Fetches hosts on mount / when `sessionId` changes. Each host row: disclosure caret + hostname +
  count badge. Expanding fetches that host's paths once (cached in a `Map<hostname, paths>`),
  shows a spinner while loading, then the path rows (path + count).
- Clicking a host calls `onSelectHost(hostname)`; clicking a path calls
  `onSelectPath(hostname, path, latestId)`. The active host is highlighted.
- Keyboard/aria: caret buttons are real `<button>`s with `aria-expanded`; the tree is a `role="tree"`
  with `role="treeitem"` rows.
- Empty state: "No traffic captured yet."

## Wiring into `Traffic.tsx`

- A "Tree" toggle button in the subheader shows/hides a left `TrafficTree` panel (persist the
  open/closed choice to `localStorage: darkride:traffic-tree-open`). Layout: flex row — tree panel
  (fixed ~260px, collapsible) + the existing table.
- `onSelectHost(hostname)` sets the existing client-side host filter text (`filters.text` path via a
  new `hostFilter` prop on TrafficTable) AND the server `search` is left alone — reuse the current
  host-filter box behavior so the table narrows immediately.
- `onSelectPath(hostname, path, latestId)` sets the host filter to the hostname, and selects the
  `latestId` row (`setSelectedId`) so the detail panel opens on a concrete request.
- The inspector (`TrafficInspector`) can adopt the same panel later; out of scope here to keep the
  PR focused on the global page.

## Testing

- **Backend** `traffic-tree.test.ts` (supertest): seed rows across 2 hosts + multiple paths; hosts
  mode returns both with correct counts ordered desc; paths mode for one host returns its paths with
  counts + a real `latestId`; `sessionId` filter narrows; unknown-host bucket; `truncated` flag when
  >2000.
- **Frontend** `TrafficTree.test.tsx`: renders hosts with counts; expanding a host fetches + shows
  paths; clicking host/path fires the right callback; empty state.
- **Traffic.test.tsx**: Tree toggle shows/hides the panel; selecting a host from the tree narrows
  the table (host-filter input reflects it).
- **E2E** `tests/e2e/traffic-host-tree.spec.ts`: ingest rows on 2 hosts, open the tree, expand a
  host, click a path, assert the table narrowed + detail opened.

## Out of scope (flagged)

- Tree in the per-device inspector (same component, later).
- Merging with the API Catalogue page (that's the separate "unify the nav surfaces" P1 — see its
  own design doc).
- Regex/glob path patterns (API Catalogue's job).
