# Traffic List Perf + Live-Feed Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Virtualize the traffic row list so DOM cost is bounded by viewport, fix the global-page live-feed loss with a jump-to-live banner, and raise the inspector history cap 500→5000.

**Architecture:** `TrafficTable`'s `<tbody>` is the shared render path for both the global Traffic page and the per-device `TrafficInspector`. Virtualize it once with `@tanstack/react-virtual` using the spacer-row technique (keeps the real `<table>`, native column widths, sticky `<thead>`). Add a `pendingLiveCount` banner to `Traffic.tsx` so entries captured while paged away are surfaced, not dropped. Raise `MAX_ENTRIES` in `TrafficInspector`.

**Tech Stack:** React 19, TypeScript, `@tanstack/react-virtual` 3.14.6, Vitest + React Testing Library (jsdom), Playwright.

## Global Constraints

- Frontend gate tests run with: `npm run test:frontend` (config `vitest.config.frontend.ts`, jsdom). Single file: `npx vitest run --config vitest.config.frontend.ts <path>`.
- TDD mandatory: failing test first, confirm it fails, then implement. No exceptions.
- New dep must be added to `frontend/package.json` and installed; commit the lockfile.
- No changes to server contracts (`/v1/traffic/list`), `TrafficDetailPanel`, filters, replay, or interception.
- Column count in the table is **7** (Method, Host/Path, Status, Type, Size, Duration, Time) — spacer rows use `colSpan={7}`.
- No em dashes / AI-vocab in code comments or copy.

---

### Task 1: Add `@tanstack/react-virtual` and virtualize the `TrafficTable` body

**Files:**
- Modify: `frontend/package.json` (add dependency)
- Modify: `frontend/components/traffic/TrafficTable.tsx` (lines 850-931 `<tbody>`, plus a virtualizer hook near line 389 where `displayEntries` is defined and the `tableWrapRef` at line 162)
- Test: `frontend/components/traffic/TrafficTable.test.tsx`

**Interfaces:**
- Consumes: existing `displayEntries: TrafficEntry[]` (memo at `TrafficTable.tsx:389`), `tableWrapRef` (`:162`), the per-row `<tr>` JSX (`:877-930`).
- Produces: a `<tbody>` that renders a top spacer `<tr data-testid="traffic-vspacer-top">`, only the windowed data rows, and a bottom spacer `<tr data-testid="traffic-vspacer-bottom">`. Data rows keep `key={entry.id}` and `data-testid={`traffic-row-${entry.id}`}`. When `displayEntries.length <= VIRTUALIZE_THRESHOLD` (50) it renders all rows with no spacers (fast path).

- [ ] **Step 1: Install the dependency**

Run:
```bash
cd frontend && npm install @tanstack/react-virtual@3.14.6 && cd ..
```
Expected: `frontend/package.json` gains `"@tanstack/react-virtual": "^3.14.6"` under dependencies; lockfile updates.

- [ ] **Step 2: Write the failing test — windowing bounds the rendered rows**

Add to `frontend/components/traffic/TrafficTable.test.tsx`:

```tsx
describe('TrafficTable — virtualization', () => {
  const makeN = (n: number): TrafficEntry[] =>
    Array.from({ length: n }, (_, i) => makeEntry({ id: i + 1, requestUrl: `https://h.example/${i}` }));

  it('renders far fewer row nodes than entries when the list is large', () => {
    render(<TrafficTable entries={makeN(2000)} />);
    const rows = screen.getAllByTestId(/^traffic-row-\d+$/);
    expect(rows.length).toBeLessThan(200);
    expect(rows.length).toBeGreaterThan(0);
    // spacers present in virtual mode
    expect(screen.getByTestId('traffic-vspacer-top')).toBeInTheDocument();
    expect(screen.getByTestId('traffic-vspacer-bottom')).toBeInTheDocument();
  });

  it('renders all rows and no spacers for small lists (fast path)', () => {
    render(<TrafficTable entries={makeN(20)} />);
    expect(screen.getAllByTestId(/^traffic-row-\d+$/).length).toBe(20);
    expect(screen.queryByTestId('traffic-vspacer-top')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficTable.test.tsx -t virtualization`
Expected: FAIL — 2000 rows all render (no windowing) and `traffic-vspacer-top` is not found.

- [ ] **Step 4: Add the virtualizer hook**

Near the top of `TrafficTable.tsx`, add the import:
```tsx
import { useVirtualizer } from '@tanstack/react-virtual';
```

After the `displayEntries` memo (`:389-398`), add:
```tsx
const VIRTUALIZE_THRESHOLD = 50;
const virtualizeOn = displayEntries.length > VIRTUALIZE_THRESHOLD;
const rowVirtualizer = useVirtualizer({
  count: virtualizeOn ? displayEntries.length : 0,
  getScrollElement: () => tableWrapRef.current,
  estimateSize: () => 39, // td padding 10px*2 + ~18px line; measureElement corrects it
  overscan: 12,
});
```

- [ ] **Step 5: Replace the `<tbody>` render**

Extract the existing per-entry `<tr>…</tr>` (`:877-930`) into a local `renderRow(entry, measureRef?)` that accepts an optional `ref` and `data-index` applied to the `<tr>`. Then render:
```tsx
<tbody>
  {virtualizeOn ? (() => {
    const items = rowVirtualizer.getVirtualItems();
    const total = rowVirtualizer.getTotalSize();
    const padTop = items.length ? items[0].start : 0;
    const padBottom = items.length ? total - items[items.length - 1].end : 0;
    return (
      <>
        <tr data-testid="traffic-vspacer-top" aria-hidden="true"><td colSpan={7} style={{ height: padTop, padding: 0, border: 0 }} /></tr>
        {items.map(vi => renderRow(displayEntries[vi.index], rowVirtualizer.measureElement, vi.index))}
        <tr data-testid="traffic-vspacer-bottom" aria-hidden="true"><td colSpan={7} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>
      </>
    );
  })() : (
    displayEntries.map(entry => renderRow(entry))
  )}
</tbody>
```
`renderRow` sets on the `<tr>`: `ref={measureRef}`, `data-index={index}` when provided, and keeps `key`, `className`, `onClick`, `data-testid`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficTable.test.tsx -t virtualization`
Expected: PASS.

- [ ] **Step 7: Run the full TrafficTable suite (guard against regressions)**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficTable.test.tsx`
Expected: PASS. If a pre-existing test asserted on a specific row in a >50 list and now that row is outside the window, keep the assertion valid by shrinking that test's dataset to ≤50 (fast path) — do not weaken the windowing.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/components/traffic/TrafficTable.tsx frontend/components/traffic/TrafficTable.test.tsx
git commit -m "feat(traffic): virtualize the traffic table body (@tanstack/react-virtual)"
```

---

### Task 2: Live auto-scroll uses the virtualizer, not raw scrollTop

**Files:**
- Modify: `frontend/components/traffic/TrafficTable.tsx:418-422` (auto-scroll effect)
- Test: `frontend/components/traffic/TrafficTable.test.tsx`

**Interfaces:**
- Consumes: `rowVirtualizer` (Task 1), `liveMode`, `autoScroll`, `displayEntries`.
- Produces: on new entries in live mode with autoScroll on, calls `rowVirtualizer.scrollToIndex(displayEntries.length - 1)`.

- [ ] **Step 1: Write the failing test**

```tsx
it('live mode auto-scrolls to the last row via the virtualizer', () => {
  const spy = vi.spyOn(HTMLElement.prototype, 'scrollTo'); // fallback guard
  const entries = Array.from({ length: 80 }, (_, i) => makeEntry({ id: i + 1 }));
  const { rerender } = render(<TrafficTable entries={entries} liveMode={true} />);
  rerender(<TrafficTable entries={[...entries, makeEntry({ id: 999 })]} liveMode={true} />);
  // last row's index should be scrolled into the window: assert the last entry is renderable
  // after a scrollToIndex-driven update (windowed list still exposes it once measured).
  expect(screen.getByTestId('traffic-vspacer-bottom')).toBeInTheDocument();
  spy.mockRestore();
});
```
(Primary assertion is behavioral: no crash, spacer intact. The scrollToIndex call itself is asserted by spying on the virtualizer in Step 3's stronger variant.)

Stronger variant — spy on the method:
```tsx
it('calls scrollToIndex(last) when a live entry arrives', async () => {
  const scrollSpy = vi.fn();
  const mod = await import('@tanstack/react-virtual');
  const real = mod.useVirtualizer;
  vi.spyOn(mod, 'useVirtualizer').mockImplementation((opts) => {
    const v = real(opts);
    return Object.assign(v, { scrollToIndex: scrollSpy });
  });
  const entries = Array.from({ length: 80 }, (_, i) => makeEntry({ id: i + 1 }));
  const { rerender } = render(<TrafficTable entries={entries} liveMode={true} />);
  rerender(<TrafficTable entries={[...entries, makeEntry({ id: 999 })]} liveMode={true} />);
  expect(scrollSpy).toHaveBeenCalledWith(80, expect.anything());
  vi.restoreAllMocks();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficTable.test.tsx -t scrollToIndex`
Expected: FAIL — current effect calls `tableWrapRef.current.scrollTop = …`, never `scrollToIndex`.

- [ ] **Step 3: Update the auto-scroll effect**

Replace `TrafficTable.tsx:418-422` with:
```tsx
// Auto-scroll to the newest row (bottom) when entries arrive in live mode.
useEffect(() => {
  if (!liveMode || !autoScroll || displayEntries.length === 0) return;
  if (virtualizeOn) {
    rowVirtualizer.scrollToIndex(displayEntries.length - 1, { align: 'end' });
  } else if (tableWrapRef.current) {
    tableWrapRef.current.scrollTop = tableWrapRef.current.scrollHeight;
  }
}, [displayEntries, autoScroll, liveMode, virtualizeOn, rowVirtualizer]);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficTable.test.tsx -t scrollToIndex`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/traffic/TrafficTable.tsx frontend/components/traffic/TrafficTable.test.tsx
git commit -m "feat(traffic): live auto-scroll via virtualizer scrollToIndex"
```

---

### Task 3: Raise `TrafficInspector` history cap 500 → 5000

**Files:**
- Modify: `frontend/components/traffic/TrafficInspector.tsx:9`
- Test: `frontend/components/traffic/TrafficInspector.test.tsx` (create)

**Interfaces:**
- Consumes: WebSocket `traffic-entry` / `traffic-request-started` subscriptions (already in the component).
- Produces: at most 5000 entries retained; oldest trimmed first.

- [ ] **Step 1: Write the failing test**

Create `frontend/components/traffic/TrafficInspector.test.tsx`:
```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TrafficInspector } from './TrafficInspector';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

type Handler = (msg: any) => void;
const handlers: Record<string, Handler> = {};
vi.mock('@darkrideapp/plugin-sdk/react', () => ({
  useWebSocket: () => ({
    connected: true,
    subscribe: (evt: string, cb: Handler) => { handlers[evt] = cb; return () => {}; },
    sendRestApi: vi.fn().mockResolvedValue({ body: { data: { items: [] } } }),
  }),
}));

it('retains at most 5000 live entries, dropping the oldest', () => {
  render(<TrafficInspector deviceId="dev1" sessionId={1} mode="live" />);
  act(() => {
    for (let i = 1; i <= 5001; i++) {
      handlers['traffic-entry']({ entry: { id: i, deviceId: 'dev1', requestMethod: 'GET', requestUrl: `https://h/${i}`, capturedAt: '2025-01-01T00:00:00Z' } });
    }
  });
  // The very first entry (id 1) must have been trimmed out of the window's data set.
  // Footer shows the retained count.
  expect(screen.getByText('5000 entries')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficInspector.test.tsx`
Expected: FAIL — footer shows "500 entries" (old cap).

- [ ] **Step 3: Raise the cap**

`TrafficInspector.tsx:9`:
```tsx
// Retain up to 5000 rows in memory. DOM cost is viewport-bounded by TrafficTable's
// virtualizer, so the cap can be high; this trim is the JS-heap / WS-frame-map backstop.
const MAX_ENTRIES = 5000;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficInspector.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/traffic/TrafficInspector.tsx frontend/components/traffic/TrafficInspector.test.tsx
git commit -m "feat(traffic): raise inspector history cap 500->5000 (DOM now virtualized)"
```

---

### Task 4: Global-page jump-to-live banner

**Files:**
- Modify: `frontend/pages/Traffic.tsx` (state `:174-199`, `traffic-entry` handler `:236-267`, `fetchTraffic` `:202-229`, render `:383-456`)
- Modify: `frontend/styles.css` (banner class)
- Test: `frontend/pages/Traffic.test.tsx`

**Interfaces:**
- Consumes: existing `page`, `sortBy`, `sortDir`, `serverSearch`, `entries`, `total`, `setPage`, `fetchTraffic`.
- Produces: `pendingLiveCount` state; a banner `<div data-testid="traffic-live-banner">` shown when `pendingLiveCount > 0`; a "Back to live" button `data-testid="traffic-back-to-live"` that resets to page 0 (default sort), clears the count, and refetches.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/pages/Traffic.test.tsx` (reuse the file's `createMockWs`/`renderPage` helpers; if a helper to push a WS `traffic-entry` doesn't exist, add one that calls the registered `traffic-entry` handler):

```tsx
describe('Traffic — jump-to-live banner', () => {
  it('buffers live entries into the banner when paged away (page > 0)', async () => {
    const ws = renderPage();
    // move to page 1 (fixture must report total > 50 so Next is enabled)
    await waitFor(() => screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    act(() => ws.pushTrafficEntry({ id: 9999, deviceId: 'd', requestMethod: 'GET', requestUrl: 'https://x/y', capturedAt: '2025-01-01T00:00:00Z' }));
    const banner = await screen.findByTestId('traffic-live-banner');
    expect(banner).toHaveTextContent(/1 new/i);
    // the buffered entry is NOT injected into the current page's rows
    expect(screen.queryByTestId('traffic-row-9999')).not.toBeInTheDocument();
  });

  it('clicking Back to live returns to page 0 and clears the banner', async () => {
    const ws = renderPage();
    await waitFor(() => screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    act(() => ws.pushTrafficEntry({ id: 9999, deviceId: 'd', requestMethod: 'GET', requestUrl: 'https://x/y', capturedAt: '2025-01-01T00:00:00Z' }));
    await screen.findByTestId('traffic-live-banner');
    fireEvent.click(screen.getByTestId('traffic-back-to-live'));
    await waitFor(() => expect(screen.queryByTestId('traffic-live-banner')).not.toBeInTheDocument());
    // page indicator is back to page 1 of N
    expect(screen.getByText(/page 1 of/i)).toBeInTheDocument();
  });

  it('still prepends live entries when on page 0 in default order', async () => {
    const ws = renderPage();
    await waitFor(() => screen.getByTestId('traffic-table'));
    act(() => ws.pushTrafficEntry({ id: 8888, deviceId: 'd', requestMethod: 'GET', requestUrl: 'https://x/z', capturedAt: '2025-01-01T00:00:00Z' }));
    expect(await screen.findByTestId('traffic-row-8888')).toBeInTheDocument();
    expect(screen.queryByTestId('traffic-live-banner')).not.toBeInTheDocument();
  });
});
```

If `createMockWs` lacks `pushTrafficEntry`, add it: capture the `subscribe('traffic-entry', cb)` callback and expose `pushTrafficEntry = (entry) => cb({ entry })`. Ensure the fixture's `sendRestApi('GET', /v1/traffic/list…)` returns `{ body: { data: { items: [...50 rows...], total: 120 } } }` so pagination is active.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/Traffic.test.tsx -t "jump-to-live"`
Expected: FAIL — no banner element exists; entries are dropped silently when paged away.

- [ ] **Step 3: Add state + handler branch**

In `Traffic.tsx`, add near the other state:
```tsx
const [pendingLiveCount, setPendingLiveCount] = useState(0);
```
Replace the `traffic-entry` handler body (`:260-266`) with:
```tsx
const defaultLiveOrder = sortBy === 'capturedAt' && sortDir === 'desc' && !serverSearch;
if (page === 0 && defaultLiveOrder && activeTab === 'live') {
  setEntries(prev => (prev.some(p => p.id === entry.id) ? prev : [entry, ...prev]));
  setTotal(prev => prev + 1);
} else if (activeTab === 'live') {
  setPendingLiveCount(c => c + 1);
  setTotal(prev => prev + 1);
}
```
Add `sortBy`, `sortDir`, `serverSearch` to that effect's dependency array (`:290`).

In `fetchTraffic`, after a successful `page === 0` load, clear the buffer:
```tsx
if (page === 0) setPendingLiveCount(0);
```
(place inside the `try` after `setEntries`, guarded by `page === 0`.)

- [ ] **Step 4: Add the Back-to-live handler + banner render**

Add:
```tsx
const handleBackToLive = useCallback(() => {
  setSortBy('capturedAt');
  setSortDir('desc');
  setPage(0);
  setPendingLiveCount(0);
  setSelectedId(null);
}, []);
```
Render above the table (inside the `activeTab !== 'saved'` branch, before `<TrafficTable>`):
```tsx
{pendingLiveCount > 0 && (
  <div className="traffic-live-banner" data-testid="traffic-live-banner">
    <span>{pendingLiveCount} new request{pendingLiveCount === 1 ? '' : 's'} captured while you were browsing.</span>
    <button className="btn btn-sm btn-primary" data-testid="traffic-back-to-live" onClick={handleBackToLive}>
      Back to live
    </button>
  </div>
)}
```

- [ ] **Step 5: Add the banner style**

Append to `frontend/styles.css`:
```css
.traffic-live-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 24px;
  background: color-mix(in srgb, var(--accent, #4a9eff) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--accent, #4a9eff) 30%, transparent);
  font-size: 13px;
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/Traffic.test.tsx`
Expected: PASS (new banner tests + existing Traffic tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/pages/Traffic.tsx frontend/pages/Traffic.test.tsx frontend/styles.css
git commit -m "feat(traffic): jump-to-live banner so paged-away live entries aren't lost"
```

---

### Task 5: E2E coverage + docs

**Files:**
- Create: `tests/e2e/traffic-list-perf.spec.ts`
- Modify: `docs/specs/2026-07-11-traffic-capture-ux-review.md` (mark the P1 item `[x]`), `ROADMAP.md`

**Interfaces:**
- Consumes: existing E2E harness patterns in `tests/e2e/traffic-*.spec.ts` (seed/capture fixtures, page nav, WS).
- Produces: an E2E proving bounded DOM rows under load + the banner flow.

- [ ] **Step 1: Read a sibling E2E spec to reuse its fixture setup**

Run: `sed -n '1,60p' tests/e2e/traffic-filters.spec.ts`
Note the seeding helper and how it navigates to the Traffic page + waits for `[data-testid=traffic-table]`.

- [ ] **Step 2: Write the E2E spec**

Create `tests/e2e/traffic-list-perf.spec.ts` (mirror the seeding helper from Step 1):
```ts
import { test, expect } from '@playwright/test';
// reuse the project's seed helper pattern from traffic-filters.spec.ts

test('virtualized list keeps the DOM row count bounded under load', async ({ page }) => {
  // seed > 200 traffic rows via the same fixture used by traffic-filters.spec.ts
  await page.goto('/traffic');
  await page.getByTestId('traffic-table').waitFor();
  const rowCount = await page.getByTestId(/^traffic-row-\d+$/).count();
  expect(rowCount).toBeGreaterThan(0);
  expect(rowCount).toBeLessThan(200); // windowed, not all 200+
  // last row becomes reachable by scrolling the container
  await page.locator('.traffic-table-wrap').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByTestId('traffic-vspacer-bottom')).toBeAttached();
});

test('jump-to-live banner recovers entries captured while paged away', async ({ page }) => {
  // seed > 50 rows so pagination is active
  await page.goto('/traffic');
  await page.getByTestId('traffic-table').waitFor();
  await page.getByRole('button', { name: /next/i }).click();
  // push one live capture via the fixture, then assert banner + recovery
  await expect(page.getByTestId('traffic-live-banner')).toBeVisible();
  await page.getByTestId('traffic-back-to-live').click();
  await expect(page.getByTestId('traffic-live-banner')).toBeHidden();
});
```
Fill the two "seed" comments with the concrete helper calls copied from `traffic-filters.spec.ts` (Step 1). Do not invent fixture APIs — use exactly what that spec uses.

- [ ] **Step 3: Run the E2E spec**

Run: `npx playwright test tests/e2e/traffic-list-perf.spec.ts`
Expected: PASS (both tests). If the second test can't push a live capture with the existing fixture, drive it through the same WS/broadcast path the fixture exposes; if no such path exists, assert the banner via a seeded page>0 + a `traffic-entry` WS message sent through the test harness the other traffic specs use.

- [ ] **Step 4: Mark the backlog item landed**

In `docs/specs/2026-07-11-traffic-capture-ux-review.md`, change the P1 line
`- [ ] **Virtualize the list; raise/soften the 500-row cap**…` to `- [x]` and append:
`*(Landed on feat/traffic-list-perf: @tanstack/react-virtual spacer-row virtualization in TrafficTable, inspector cap 500→5000, and a jump-to-live banner on the global page for entries captured while paged away — Traffic.tsx no longer drops live entries off page 0.)*`
Update the matching `ROADMAP.md` "Traffic Capture UX" entry the same way.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/traffic-list-perf.spec.ts docs/specs/2026-07-11-traffic-capture-ux-review.md ROADMAP.md
git commit -m "test(e2e): virtualized list + jump-to-live banner; mark P1 landed"
```

---

### Task 6: Full gate + push

- [ ] **Step 1: Run the frontend gate**

Run: `npm run test:frontend`
Expected: all frontend tests pass (1242+ baseline plus the new ones).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Run backend/shared gate (sanity — should be untouched)**

Run: `npx vitest run`
Expected: green (no backend files changed).

- [ ] **Step 4: Push the branch**

Run:
```bash
git push -u origin feat/traffic-list-perf
```

- [ ] **Step 5: Report** which service to restart (frontend dev server / Vite) for the change to take effect.

---

## Self-Review

**Spec coverage:**
- Virtualize row list → Task 1. ✓
- Auto-scroll via scrollToIndex → Task 2. ✓
- Cap 500→5000 → Task 3. ✓
- Jump-to-live banner (live-feed loss) → Task 4. ✓
- Gate tests (windowing bound, banner, cap) → Tasks 1-4. ✓
- E2E (bounded DOM, banner) → Task 5. ✓
- No-eval-lane rationale → stated in design; deterministic UI, N/A. ✓
- Docs/roadmap update → Task 5. ✓

**Type consistency:** `VIRTUALIZE_THRESHOLD`, `virtualizeOn`, `rowVirtualizer`, `pendingLiveCount`, `handleBackToLive`, `renderRow` used consistently across tasks. Spacer test-ids `traffic-vspacer-top/bottom` and banner test-ids `traffic-live-banner` / `traffic-back-to-live` match between component and tests. Column count 7 fixed in Global Constraints and used in spacers.

**Placeholder scan:** E2E seed steps intentionally reference "copy the helper from traffic-filters.spec.ts" rather than inventing a fixture API — this is a real instruction (read then reuse), not a TODO, because the fixture contract is external to this change and must match the sibling spec exactly.
