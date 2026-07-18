# Traffic List Perf + Live-Feed Fix — Design

Date: 2026-07-16
Branch: `feat/traffic-list-perf`
Backlog: `docs/specs/2026-07-11-traffic-capture-ux-review.md` (P1 "Virtualize the list; raise/soften the 500-row cap")

## Outcome (what measurably changes)

1. **Render cost is bounded by viewport, not row count.** With N captured rows in the
   list, DOM `<tr>` nodes stay ~= visible rows (a couple dozen) instead of N. Measurable:
   node count in the traffic `<tbody>` stays flat as entries grow; scroll stays smooth at
   5000 rows where 500 already janks today.
2. **You never silently lose live traffic.** On the global Traffic page, entries captured
   while you've paged away from page 0 are surfaced by a "N new — back to live" banner
   instead of being dropped with no hint (`Traffic.tsx:260`).
3. **History depth rises 10x.** `TrafficInspector` `MAX_ENTRIES` 500 → 5000 — you keep more
   of a capture session in view, and the DOM no longer pays for it.

## Non-goals

- No change to server-side pagination/sort/filter contracts (`/v1/traffic/list`).
- No infinite-scroll rewrite of the global page's Prev/Next pagination. Offset paging
  still serves sorted/filtered historical browsing; the live-loss is fixed with a banner
  (the Chrome-DevTools / Burp model), not by removing pagination.
- No change to `TrafficDetailPanel`, filters, replay, or interception.

## Piece 1 — Virtualize the row list (`TrafficTable`)

`TrafficTable`'s `<tbody>` maps one `<tr>` per entry (`TrafficTable.tsx:851`). This is the
shared render path for both the global Traffic page and the per-device `TrafficInspector`,
so virtualizing here fixes both surfaces at once.

**Library:** `@tanstack/react-virtual` 3.14.6. Headless (no CSS/markup baggage — reuses our
existing table styles), explicitly peers React 19, ~one dependency (`virtual-core`),
actively maintained. Nothing comparable exists in the repo already. Rejected `react-window`
(class-based, less active, awkward with semantic tables) and hand-rolled windowing
(reinvents measurement/overscan for no benefit).

**Approach — spacer rows (preserve the real `<table>`):**
- Rows are uniform fixed height (~39px: `td` padding 10px×2 + ~18px line). `TrafficDetailPanel`
  renders separately (`TrafficTable.tsx:932`), not as an inline-expand row, so there are no
  variable-height rows in `<tbody>`.
- The scroll container is the existing `.traffic-table-wrap` (`tableWrapRef`), and `thead`
  is already `position: sticky; top: 0`. Both stay as-is.
- `useVirtualizer({ count: displayEntries.length, getScrollElement: () => tableWrapRef.current,
  estimateSize: () => 39, overscan: 12, measureElement: <ref> })`. `measureElement`
  self-corrects the estimate from real row height, so the 39px is only a first-paint guess.
- `<tbody>` renders: a leading spacer `<tr>` with one `<td colSpan={COL_COUNT}>` of height =
  `virtualItems[0].start`, then only the virtual rows (each `data-index`, `ref=measureElement`),
  then a trailing spacer `<tr>` of height = `totalSize - virtualItems.at(-1).end`. `colSpan`
  spacers keep native column sizing (driven by `thead` th widths) intact.
- **Auto-scroll (live mode):** the existing effect (`TrafficTable.tsx:419`) sets
  `scrollTop = scrollHeight`. Replace with `rowVirtualizer.scrollToIndex(displayEntries.length - 1)`
  guarded by the same `liveMode && autoScroll` condition. (Inspector appends newest at the
  bottom, so "scroll to last" is correct there.)
- **Small-list fast path:** when `displayEntries.length <= 50` render the plain (non-virtual)
  path — avoids measurement flicker on tiny lists and keeps the common global-page 50-row
  page visually identical. One `if` at the `<tbody>` level; both paths emit the same `<tr>`.

**Selection / test-id stability:** each rendered `<tr>` keeps `key={entry.id}` and
`data-testid={`traffic-row-${entry.id}`}`. Playwright/RTL still find rows by id — but only
rows in the virtual window exist in the DOM. Tests that assert on a specific row must ensure
it's scrolled into view (or use the ≤50 fast path). Covered in Testing below.

## Piece 2 — Global-page live-feed fix (`Traffic.tsx`)

Today `traffic-entry` messages append only when `page === 0` (`Traffic.tsx:260`); paged away,
they're dropped. Fix with a **jump-to-live banner** (best-UX answer, matches Chrome DevTools
Network panel + Burp HTTP history):

- Add `pendingLiveCount` state. In the `traffic-entry` handler:
  - If `page === 0` **and** the list is in default live order (`sortBy === 'capturedAt'`,
    `sortDir === 'desc'`, no active `serverSearch`) → prepend as today.
  - Otherwise → `setPendingLiveCount(c => c + 1)` and do **not** mutate `entries`. `total`
    still increments so "Page X of Y" stays honest.
- Render a sticky banner above the table when `pendingLiveCount > 0`:
  `"{n} new request(s) captured — Back to live"`. Click → `setPage(0)`, reset sort to
  `capturedAt`/`desc`, clear `serverSearch` is **not** forced (keep the user's search; just
  refetch page 0 with current params), `setPendingLiveCount(0)`, refetch. The banner works
  in any sort/search mode because "back to live" = jump to newest page-0 of the current query.
- When `fetchTraffic` completes for `page === 0`, reset `pendingLiveCount` to 0 (fresh head
  already includes them).

This keeps offset pagination (good for sorted/filtered historical browsing) while making the
live-loss visible and one-click recoverable.

## Piece 3 — Raise the inspector cap

`TrafficInspector.tsx:9` `MAX_ENTRIES` 500 → 5000. The `slice(-MAX_ENTRIES)` trim stays as
the JS-heap/WS-frame-map backstop; only the DOM cost changed (now viewport-bounded), so the
cap can rise 10x safely. Document the number's rationale in a comment.

## Data flow (unchanged contracts)

- Global page: `/v1/traffic/list?limit=50&offset=…&sort…&filter…` → offset pages, plus live
  `traffic-entry` WS prepend on page 0 (or banner otherwise).
- Inspector: `/v1/traffic/list?sessionId=…&limit=2000` (static) or live WS append, capped at
  5000, rendered through the same virtualized `TrafficTable`.

## Error / edge handling

- Empty list / loading / filtered-to-zero: virtualizer `count = 0` → only spacers (height 0);
  existing empty-state message path (`TrafficTable` emptyMessage) is unchanged.
- Window resize / container height change: `@tanstack/react-virtual` observes the scroll
  element; overscan absorbs it. No manual recompute.
- Filter/sort change shrinking the list below the current scroll: virtualizer clamps to
  `totalSize`; selection-stability effect (`TrafficTable.tsx:407`) already clears a
  dropped selection.
- `scrollToIndex` on an empty list: guarded by `displayEntries.length > 0`.

## Testing

**Gate (deterministic, local, <2s) — Vitest + RTL:**
- `TrafficTable`: with 2000 entries, `<tbody>` renders far fewer `<tr data-testid=traffic-row-*>`
  than 2000 (windowing proof); leading+trailing spacer heights sum with rendered rows to the
  full scroll height; ≤50 entries uses the non-virtual path (all rows present). jsdom has no
  layout, so drive the virtualizer with a mocked `getBoundingClientRect`/`scrollHeight` on the
  container (tanstack's documented jsdom test pattern) — assert the window count is bounded and
  scroll offset maps to the right `data-index` range.
- Auto-scroll: appending an entry in live mode calls `scrollToIndex(last)` (spy) — not raw
  `scrollTop`.
- `Traffic.tsx`: `traffic-entry` while `page>0` increments the banner count and does NOT push
  into `entries`; banner click resets to page 0 + refetches + clears count; while `page===0`
  default order it prepends (existing behavior preserved). Extend `frontend/pages/Traffic.test.tsx`.
- `TrafficInspector`: cap is 5000 — pushing 5001 entries keeps 5000, drops the oldest.

**E2E (Playwright) — `tests/e2e/traffic-list-perf.spec.ts`:**
- Seed >200 rows via capture fixture; assert the DOM row count in `[data-testid=traffic-table]`
  stays bounded (< total) while the list is scrollable to the last row.
- Page to page 2 on the global page, push a live entry via the fixture, assert the
  "back to live" banner appears with the right count and clicking it returns to page 0 with the
  new entry visible.

**Evals:** this is deterministic UI plumbing (no LLM call in the path), so the "eval" lane is
N/A per the two-lanes rule — the gate + E2E tests are the proof. Noted explicitly rather than
fabricating an eval.

## Files touched

- `frontend/package.json` — add `@tanstack/react-virtual`.
- `frontend/components/traffic/TrafficTable.tsx` — virtualized `<tbody>`, scrollToIndex.
- `frontend/pages/Traffic.tsx` — pendingLiveCount + banner + handler branch.
- `frontend/components/traffic/TrafficInspector.tsx` — cap 500→5000.
- `frontend/components/traffic/TrafficTable.test.tsx`, `frontend/pages/Traffic.test.tsx`,
  `frontend/components/traffic/TrafficInspector.test.tsx` (new if absent) — gate tests.
- `tests/e2e/traffic-list-perf.spec.ts` — E2E.
- `frontend/styles.css` — banner style, spacer-row helper if needed.
- `docs/specs/2026-07-11-traffic-capture-ux-review.md`, `ROADMAP.md` — mark item landed.
