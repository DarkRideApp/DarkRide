# Traffic P3 Polish Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five P3 traffic-capture polish items: honest "Clear view", a visible/removable blocklist, a UI "Save request" action, honest TLS-pill copy, and show/hide column customization.

**Architecture:** Mostly frontend, following existing TrafficTable/Traffic patterns, plus one new backend endpoint (`POST /v1/traffic/saved`) that copies a captured row into the existing SavedTrafficStore. A `COLUMNS` descriptor array drives both header and body so column visibility can't drift. Items share `TrafficTable.tsx`/`Traffic.tsx`, so execute sequentially (no parallel worktrees).

**Tech Stack:** React 19 + TypeScript, Vitest + RTL (jsdom), supertest for the endpoint, Playwright, better-sqlite3/Drizzle.

## Global Constraints

- Frontend gate: `npx vitest run --config vitest.config.frontend.ts <path>`; full: `npm run test:frontend`.
- Backend gate: `npx vitest run <path>`.
- TDD mandatory: failing test first, confirm fail, implement. No em dashes / AI-vocab in copy or comments.
- Branch `feat/traffic-p3-polish` is stacked on `feat/traffic-list-perf` — TrafficTable already virtualized; the columns work must keep the spacer-row `colSpan` correct (now dynamic).
- localStorage key for column prefs: `darkride:traffic-columns`. Filter-preset persistence in `trafficUtils.ts` is the pattern to mirror.

---

### Task 1: Backend — `POST /v1/traffic/saved`

**Files:**
- Modify: `backend/api/saved-traffic.ts` (add endpoint; extend `registerSavedTrafficEndpoints` to also take `db`)
- Modify: `backend/index.ts` (pass `db` to `registerSavedTrafficEndpoints` — find the existing call)
- Test: `backend/api/saved-traffic.test.ts` (create)

**Interfaces:**
- Consumes: `SavedTrafficStore.save(entry: SavedTrafficEntry)`; `capturedTraffic` table (`db.select().from(capturedTraffic).where(eq(capturedTraffic.id, id))`).
- Produces: `POST /v1/traffic/saved` body `{ id: number }` → `{ success: true, data: { saved: true } }`; 400 on bad/missing id; 404 if the captured row is absent; `requires: ['core.traffic:manage']`.

- [ ] **Step 1: Write the failing test**

Create `backend/api/saved-traffic.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerSavedTrafficEndpoints } from './saved-traffic';
import { SavedTrafficStore } from '../services/saved-traffic-store';
import { createTestDb } from '../test-utils/create-test-db';

const { capturedTraffic } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerSavedTrafficEndpoints(new SavedTrafficStore(db as any), db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('POST /v1/traffic/saved', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;
  beforeEach(() => { db = createTestDb(); app = createApp(db); });

  function seedCaptured(): number {
    const row = db.insert(capturedTraffic).values({
      requestMethod: 'GET', requestUrl: 'https://api.test/x', requestHeaders: '{}',
      requestBody: null, responseStatus: 200, responseHeaders: '{}', responseBody: '{"ok":true}',
      type: 'http', capturedAt: new Date().toISOString(),
    } as any).returning({ id: capturedTraffic.id }).all()[0];
    return row.id;
  }

  it('persists a captured row into saved traffic', async () => {
    const id = seedCaptured();
    const res = await request(app).post('/v1/traffic/saved').send({ id });
    expect(res.status).toBe(200);
    expect(res.body.data.saved).toBe(true);
    const saved = await request(app).get('/v1/traffic/saved');
    expect(saved.body.data.some((s: any) => s.url === 'https://api.test/x')).toBe(true);
  });

  it('404s for an unknown captured id', async () => {
    const res = await request(app).post('/v1/traffic/saved').send({ id: 99999 });
    expect(res.status).toBe(404);
  });

  it('400s when id is missing', async () => {
    const res = await request(app).post('/v1/traffic/saved').send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/api/saved-traffic.test.ts`
Expected: FAIL — `registerSavedTrafficEndpoints` takes one arg / route missing (404 for the POST route itself, or a signature type error).

- [ ] **Step 3: Implement the endpoint**

In `backend/api/saved-traffic.ts`, change the import + signature and add the route:
```ts
import { registerEndpoint } from './api-service';
import type { SavedTrafficStore } from '../services/saved-traffic-store';
import type { AppDatabase } from '../db';
import { capturedTraffic } from '../db/schema';
import { eq } from 'drizzle-orm';

export function registerSavedTrafficEndpoints(store: SavedTrafficStore, db: AppDatabase): void {
```
(Keep the existing GET/DELETE routes unchanged.) Add before the closing brace:
```ts
  // POST /v1/traffic/saved — persist a captured entry (by id) into saved traffic.
  registerEndpoint('POST', '/v1/traffic/saved', (req, res) => {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'id is required' });
      return;
    }
    const entry = db.select().from(capturedTraffic).where(eq(capturedTraffic.id, id)).all()[0];
    if (!entry) {
      res.status(404).json({ success: false, error: 'Captured traffic not found' });
      return;
    }
    store.save({
      url: entry.requestUrl,
      method: entry.requestMethod,
      requestHeaders: entry.requestHeaders ?? null,
      requestBody: entry.requestBody ?? null,
      responseStatus: entry.responseStatus ?? null,
      responseHeaders: entry.responseHeaders ?? null,
      responseBody: entry.responseBody ?? null,
      deviceId: entry.deviceId ?? null,
    });
    res.json({ success: true, data: { saved: true } });
  }, { requires: ['core.traffic:manage'] });
```
Import path note: confirm `AppDatabase` type export location (grep `export type AppDatabase` / `export interface AppDatabase`) and match the existing import used by `traffic.ts`.

- [ ] **Step 4: Update the call site**

In `backend/index.ts`, find `registerSavedTrafficEndpoints(` and pass the db instance already in scope (the same `db` passed to `registerTrafficEndpoints`).

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run backend/api/saved-traffic.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/api/saved-traffic.ts backend/api/saved-traffic.test.ts backend/index.ts
git commit -m "feat(traffic): POST /v1/traffic/saved to persist a captured entry from the UI"
```

---

### Task 2: Save action in the detail panel

**Files:**
- Modify: `frontend/components/traffic/TrafficDetailPanel.tsx` (add Save `ActionButton` + `onSave` prop)
- Modify: `frontend/components/traffic/TrafficTable.tsx` (thread `onSave` prop to the panel)
- Modify: `frontend/pages/Traffic.tsx`, `frontend/components/traffic/TrafficInspector.tsx` (provide `handleSave` → POST)
- Test: `frontend/components/traffic/TrafficDetailPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 endpoint `POST /v1/traffic/saved { id }`.
- Produces: `TrafficDetailPanel` prop `onSave?: (entry: TrafficEntry) => void`; `TrafficTable` prop `onSave?: (entry: TrafficEntry) => void`.

- [ ] **Step 1: Write the failing test**

Add to `TrafficDetailPanel.test.tsx` (mirror the file's existing entry factory + render helper):
```tsx
it('calls onSave with the entry when Save is clicked', () => {
  const onSave = vi.fn();
  const entry = makeEntry({ id: 7, requestUrl: 'https://api.test/x' });
  renderPanel({ entry, onSave });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
});
```
(If the file has no `renderPanel`/`makeEntry`, add minimal ones matching `TrafficDetailPanelProps`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficDetailPanel.test.tsx -t onSave`
Expected: FAIL — no Save button.

- [ ] **Step 3: Implement**

In `TrafficDetailPanel.tsx`: add `onSave?: (entry: TrafficEntry) => void;` to props, destructure it, and add near the Repeat action (uses the existing `ActionButton` with copy-style feedback, importing `Save` from lucide-react):
```tsx
{onSave && (
  <ActionButton icon={<Save size={12} />} label="Save" activeLabel="Saved" onClick={() => onSave(entry)} />
)}
```
(Match `ActionButton`'s real prop names — check its signature at the top of the file; if it takes `label`/`onClick` only, wrap feedback like the other buttons do.)
In `TrafficTable.tsx`: add `onSave?` to props and pass `onSave={onSave}` where `<TrafficDetailPanel` is rendered.

- [ ] **Step 4: Wire the handler**

In `Traffic.tsx` and `TrafficInspector.tsx` add:
```tsx
const handleSave = useCallback((entry: TrafficEntry) => {
  ws.sendRestApi('POST', '/v1/traffic/saved', { id: entry.id }).catch(() => {});
}, [ws]);
```
and pass `onSave={handleSave}` to `<TrafficTable>`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficDetailPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/components/traffic/TrafficDetailPanel.tsx frontend/components/traffic/TrafficTable.tsx frontend/pages/Traffic.tsx frontend/components/traffic/TrafficInspector.tsx frontend/components/traffic/TrafficDetailPanel.test.tsx
git commit -m "feat(traffic): Save action in the detail panel (persists via POST /v1/traffic/saved)"
```

---

### Task 3: Blocklist panel

**Files:**
- Create: `frontend/components/traffic/BlocklistPanel.tsx`
- Modify: `frontend/pages/Traffic.tsx` (Blocked button + panel)
- Modify: `frontend/styles.css`
- Test: `frontend/components/traffic/BlocklistPanel.test.tsx`

**Interfaces:**
- Consumes: `GET /v1/blocklist/list` → `{ data: Array<{ id:number, domain:string }> }`; `DELETE /v1/blocklist/remove/:id`.
- Produces: `BlocklistPanel({ ws, onClose })`.

- [ ] **Step 1: Write the failing test**

Create `BlocklistPanel.test.tsx`:
```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BlocklistPanel } from './BlocklistPanel';

function mockWs(domains: Array<{ id: number; domain: string }>) {
  const remove = vi.fn().mockResolvedValue({ body: { success: true } });
  const sendRestApi = vi.fn().mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === '/v1/blocklist/list') return Promise.resolve({ body: { data: domains } });
    if (method === 'DELETE') { remove(path); return Promise.resolve({ body: { success: true } }); }
    return Promise.resolve({ body: {} });
  });
  return { sendRestApi, remove };
}

it('lists blocked domains and unblocks one', async () => {
  const ws = mockWs([{ id: 1, domain: 'ads.example.com' }]);
  render(<BlocklistPanel ws={ws as any} onClose={() => {}} />);
  expect(await screen.findByText('ads.example.com')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /unblock ads.example.com/i }));
  await waitFor(() => expect(ws.remove).toHaveBeenCalledWith('/v1/blocklist/remove/1'));
});

it('shows an empty state when nothing is blocked', async () => {
  const ws = mockWs([]);
  render(<BlocklistPanel ws={ws as any} onClose={() => {}} />);
  expect(await screen.findByText(/no blocked/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/BlocklistPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `BlocklistPanel.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface Blocked { id: number; domain: string }
interface Props { ws: { sendRestApi: (m: string, p: string) => Promise<any> }; onClose: () => void }

export function BlocklistPanel({ ws, onClose }: Props) {
  const [items, setItems] = useState<Blocked[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    ws.sendRestApi('GET', '/v1/blocklist/list')
      .then(res => setItems(res.body?.data ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [ws]);
  useEffect(() => { load(); }, [load]);
  const unblock = useCallback((id: number) => {
    ws.sendRestApi('DELETE', `/v1/blocklist/remove/${id}`).then(load).catch(() => {});
  }, [ws, load]);

  return (
    <div className="blocklist-panel" data-testid="blocklist-panel">
      <div className="blocklist-panel-head">
        <span>Blocked hostnames</span>
        <button className="traffic-detail-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      {loading ? <div className="blocklist-empty">Loading…</div>
        : items.length === 0 ? <div className="blocklist-empty">No blocked hostnames</div>
        : (
          <ul className="blocklist-list">
            {items.map(b => (
              <li key={b.id}>
                <span className="blocklist-domain">{b.domain}</span>
                <button className="btn btn-sm" aria-label={`Unblock ${b.domain}`} onClick={() => unblock(b.id)}>Unblock</button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/BlocklistPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the Blocked button into `Traffic.tsx`**

Add state `const [showBlocklist, setShowBlocklist] = useState(false);` and a button in `.traffic-subheader-actions` (before Clear):
```tsx
<button className="traffic-action-btn" data-testid="traffic-blocked-btn" onClick={() => setShowBlocklist(v => !v)}>
  <ShieldBan size={14} /> Blocked
</button>
{showBlocklist && <BlocklistPanel ws={ws} onClose={() => setShowBlocklist(false)} />}
```
(Import `ShieldBan` from lucide-react and `BlocklistPanel`.)

- [ ] **Step 6: Add styles + commit**

Append `.blocklist-panel`/`-head`/`-list`/`-empty`/`-domain` styles to `frontend/styles.css` (absolute-positioned popover, `var(--bg-secondary)` bg, border, small shadow). Then:
```bash
git add frontend/components/traffic/BlocklistPanel.tsx frontend/components/traffic/BlocklistPanel.test.tsx frontend/pages/Traffic.tsx frontend/styles.css
git commit -m "feat(traffic): surface the blocklist with an inline unblock panel"
```

---

### Task 4: Honest "Clear view" label + TLS-pill copy

**Files:**
- Modify: `frontend/pages/Traffic.tsx` (Clear button text/title; TLS pill text/title)
- Modify: `frontend/components/traffic/TrafficTable.tsx` (live-mode clear control label, if present)
- Test: `frontend/pages/Traffic.test.tsx`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

Add to `Traffic.test.tsx`:
```tsx
it('labels the view-only clear button "Clear view"', async () => {
  renderPage();
  await waitFor(() => screen.getByTestId('traffic-table'));
  expect(screen.getByRole('button', { name: /clear view/i })).toBeInTheDocument();
});

it('describes the TLS pill as per-device, not a global setting', async () => {
  renderPage();
  await waitFor(() => screen.getByTestId('traffic-tls-pill'));
  expect(screen.getByTestId('traffic-tls-pill')).toHaveTextContent(/per device/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/Traffic.test.tsx -t "Clear view|per-device|per device"`
Expected: FAIL — button reads "Clear", pill reads "TLS fingerprint spoofing".

- [ ] **Step 3: Implement**

In `Traffic.tsx`, change the Clear button:
```tsx
<button className="traffic-action-btn" onClick={handleClear} title="Clears the current view only. Captured traffic stays in the database.">
  <Trash2 size={14} />
  Clear view
</button>
```
Change the TLS pill text to `TLS spoofing · per device` and its `title` to `Each device can pose as Chrome 120 Android, OkHttp, or stock. Set the profile on that device's Capture tab.`
If `TrafficTable` renders a live-mode "Clear" control (grep `onClear`), relabel it "Clear view" with the same title.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/Traffic.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Traffic.tsx frontend/components/traffic/TrafficTable.tsx frontend/pages/Traffic.test.tsx
git commit -m "fix(traffic): honest 'Clear view' label + per-device TLS-pill copy"
```

---

### Task 5: Column show/hide customization

**Files:**
- Modify: `frontend/components/traffic/trafficUtils.ts` (`COLUMNS`, `loadColumnPrefs`, `saveColumnPrefs`)
- Modify: `frontend/components/traffic/TrafficTable.tsx` (Columns menu; conditional header + body cells; dynamic spacer colSpan)
- Test: `frontend/components/traffic/trafficUtils.test.ts`, `frontend/components/traffic/TrafficTable.test.tsx`

**Interfaces:**
- Produces: `COLUMNS: Array<{ key: ColumnKey; label: string; alwaysOn?: boolean }>` where `ColumnKey = 'method'|'path'|'status'|'type'|'size'|'duration'|'time'`; `loadColumnPrefs(): Set<ColumnKey>` (defaults to all visible); `saveColumnPrefs(set: Set<ColumnKey>): void`. `path` is `alwaysOn`.

- [ ] **Step 1: Write the failing prefs test**

Add to `trafficUtils.test.ts`:
```ts
import { COLUMNS, loadColumnPrefs, saveColumnPrefs } from './trafficUtils';

describe('column prefs', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to all columns visible', () => {
    expect(loadColumnPrefs().size).toBe(COLUMNS.length);
  });
  it('round-trips a saved set, always keeping the always-on column', () => {
    saveColumnPrefs(new Set(['path', 'status']));
    const got = loadColumnPrefs();
    expect(got.has('status')).toBe(true);
    expect(got.has('size')).toBe(false);
    expect(got.has('path')).toBe(true); // always-on
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/trafficUtils.test.ts -t "column prefs"`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement prefs in `trafficUtils.ts`**

```ts
export type ColumnKey = 'method' | 'path' | 'status' | 'type' | 'size' | 'duration' | 'time';
export const COLUMNS: Array<{ key: ColumnKey; label: string; alwaysOn?: boolean }> = [
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Host / Path', alwaysOn: true },
  { key: 'status', label: 'Status' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size' },
  { key: 'duration', label: 'Duration' },
  { key: 'time', label: 'Time' },
];
const COLUMN_PREFS_KEY = 'darkride:traffic-columns';
export function loadColumnPrefs(): Set<ColumnKey> {
  const all = new Set<ColumnKey>(COLUMNS.map(c => c.key));
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_KEY);
    if (!raw) return all;
    const keys = JSON.parse(raw) as ColumnKey[];
    const set = new Set(keys.filter(k => COLUMNS.some(c => c.key === k)));
    COLUMNS.filter(c => c.alwaysOn).forEach(c => set.add(c.key));
    return set.size ? set : all;
  } catch { return all; }
}
export function saveColumnPrefs(set: Set<ColumnKey>): void {
  const withAlways = new Set(set);
  COLUMNS.filter(c => c.alwaysOn).forEach(c => withAlways.add(c.key));
  try { localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify([...withAlways])); } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run the prefs test to pass**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/trafficUtils.test.ts -t "column prefs"`
Expected: PASS.

- [ ] **Step 5: Write the failing TrafficTable column test**

Add to `TrafficTable.test.tsx`:
```tsx
it('hides a column via the Columns menu', async () => {
  localStorage.clear();
  render(<TrafficTable entries={[makeEntry({ id: 1 })]} showFilterBar={true} />);
  // Size header present by default
  expect(screen.getByRole('columnheader', { name: /size/i })).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('traffic-columns-btn'));
  fireEvent.click(screen.getByTestId('traffic-column-toggle-size'));
  expect(screen.queryByRole('columnheader', { name: /size/i })).not.toBeInTheDocument();
});

it('does not allow hiding the Host/Path column', async () => {
  render(<TrafficTable entries={[makeEntry({ id: 1 })]} showFilterBar={true} />);
  fireEvent.click(screen.getByTestId('traffic-columns-btn'));
  expect(screen.getByTestId('traffic-column-toggle-path')).toBeDisabled();
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficTable.test.tsx -t "column"`
Expected: FAIL — no Columns menu.

- [ ] **Step 7: Implement the Columns menu + conditional rendering**

In `TrafficTable.tsx`:
- Add state: `const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() => loadColumnPrefs());` and a `toggleColumn(key)` that flips the key (ignoring always-on), calls `saveColumnPrefs`, and setState.
- Add a "Columns" button (`data-testid="traffic-columns-btn"`) in the filter bar's live-controls area that opens a dropdown; each row is a `<label><input type="checkbox" data-testid={`traffic-column-toggle-${c.key}`} checked={visibleColumns.has(c.key)} disabled={c.alwaysOn} onChange={() => toggleColumn(c.key)} /> {c.label}</label>`.
- Header: wrap each `<th>` in `{visibleColumns.has('<key>') && (...)}` for both the sortable and non-sortable branches.
- Body `renderRow`: wrap each `<td>` in `{visibleColumns.has('<key>') && (...)}`.
- Virtualized spacer rows: replace `colSpan={7}` with `colSpan={visibleColumns.size}`.

- [ ] **Step 8: Run to verify it passes + full suite**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/components/traffic/TrafficTable.test.tsx frontend/components/traffic/trafficUtils.test.ts`
Expected: PASS (including the earlier virtualization tests — spacer colSpan now dynamic).

- [ ] **Step 9: Commit**

```bash
git add frontend/components/traffic/trafficUtils.ts frontend/components/traffic/TrafficTable.tsx frontend/components/traffic/trafficUtils.test.ts frontend/components/traffic/TrafficTable.test.tsx frontend/styles.css
git commit -m "feat(traffic): show/hide column customization (persisted, Host/Path always on)"
```

---

### Task 6: E2E + docs + full gate

**Files:**
- Create: `tests/e2e/traffic-p3.spec.ts`
- Modify: `docs/specs/2026-07-11-traffic-capture-ux-review.md`, `ROADMAP.md`

- [ ] **Step 1: Write the E2E spec** (reuse the ingest/login helpers from `tests/e2e/traffic-filters.spec.ts`)

`tests/e2e/traffic-p3.spec.ts`:
```ts
import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';
// getCsrfToken + ingest copied from traffic-filters.spec.ts

test('save a request, then see it under the Saved tab', async ({ page }) => {
  // login, ingest 1 unique row, goto /ui/traffic, filter by run host,
  // click the row, click Save, switch to Saved tab, assert the url appears.
});

test('block a host, see it in the Blocked panel, then unblock it', async ({ page }) => {
  // login, goto, click a row's Block action, open Blocked panel,
  // assert host present, click Unblock, assert gone.
});

test('hiding the Size column persists across reload', async ({ page }) => {
  // login, goto, open Columns menu, uncheck Size, reload, assert Size header absent.
});
```
Fill each body with concrete calls copied from the sibling spec (no invented fixture APIs).

- [ ] **Step 2: Run the E2E**

Run: `npx playwright test tests/e2e/traffic-p3.spec.ts`
Expected: PASS.

- [ ] **Step 3: Mark P3 items landed**

In `docs/specs/2026-07-11-traffic-capture-ux-review.md`, flip the five P3 `[ ]` items to `[x]` with a one-line landed note each (or `[~]` for the two intentionally-partial ones: "Clear" relabel-only and TLS copy-only). Update `ROADMAP.md`'s P3 line.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/traffic-p3.spec.ts docs/specs/2026-07-11-traffic-capture-ux-review.md ROADMAP.md
git commit -m "test(e2e): P3 save/blocklist/columns; mark P3 items landed"
```

- [ ] **Step 5: Full gate + push**

Run: `npm run test:frontend` (all pass), `npm run typecheck` (clean), `npx vitest run backend/api/saved-traffic.test.ts` (pass).
Then `git push -u origin feat/traffic-p3-polish` and open a PR based on `feat/traffic-list-perf`.

---

## Self-Review

**Spec coverage:** Clear honesty → Task 4. Blocklist surface → Task 3. Save action → Tasks 1+2. TLS copy → Task 4. Columns → Task 5. E2E + docs → Task 6. ✓ (all five items + the two review flags carried as intentional-partial notes.)

**Type consistency:** `ColumnKey`, `COLUMNS`, `loadColumnPrefs`/`saveColumnPrefs`, `visibleColumns`, `toggleColumn`, `onSave`, `registerSavedTrafficEndpoints(store, db)` used consistently. Test-ids `traffic-columns-btn`, `traffic-column-toggle-<key>`, `traffic-blocked-btn`, `blocklist-panel`, `traffic-tls-pill` match between component and tests. Dynamic `colSpan={visibleColumns.size}` replaces the Task-in-#37 hardcoded 7.

**Placeholder note:** Task 6 E2E bodies say "copy from the sibling spec" — a real reuse instruction (the fixture contract is external and must match), not a TODO.
