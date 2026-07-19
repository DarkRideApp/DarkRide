# Unify the Network/Traffic Surfaces — Design (DECISION NEEDED)

Date: 2026-07-19
Backlog: P1 "Unify the surface" in `docs/specs/2026-07-11-traffic-capture-ux-review.md`
Status: **Design-only. Architectural fork — needs Cube's decision before any build.** No code written.

## The problem

One reverse-engineering workflow ("capture a device's traffic, inspect it, intercept/edit a request,
replay it, catalogue the endpoint") is spread across five nav entries plus a per-device tab:

| Surface | Route | Does |
|---|---|---|
| Per-device **Capture** tab | `/ui/devices/:id/capture` | Start/stop capture; live traffic for ONE device (`TrafficInspector`) |
| **Traffic** | `/ui/traffic` | Aggregate captured traffic (table + tree + intercept panel + replay drawer + saved) |
| **HTTP Requests** | `/ui/proxied-requests` | List of active/outgoing server-side proxied requests |
| **Request Builder** | `/ui/request-builder` | Manual request construction + replay (partly superseded by the in-place ReplayDrawer) |
| **API Catalogue** | `/ui/api-catalogue` | Endpoints grouped by host/path pattern, documentation |

Interception isn't its own nav entry — it already lives on the Traffic page (`InterceptHoldPanel` /
`InterceptArmControl`). The friction: to go capture → inspect → intercept → replay → catalogue you
hop pages and lose context (which device, which session, which request) at each hop.

## What "unified" should mean (proposed requirements)

1. **One workspace** for the whole flow, reachable from one nav entry.
2. **A scope selector** at the top: All devices / a specific device / a specific capture session.
   Everything below reacts to it (table, tree, intercept arming, replay target).
3. **Replay and interception happen in place** (already true on Traffic via ReplayDrawer + hold
   panel) — extend that so they work from any pane without a page change.
4. The per-device Capture tab keeps the **start/stop control** (it's device hardware control) but its
   live view becomes "open in the workspace, scoped to this device" instead of a parallel surface.
5. No loss of current capability (filters, tree, timing, saved, presets, catalogue grouping).

## Three architectures

### Option A — One "Network" workspace with a scope selector + panes (RECOMMENDED)

New route `/ui/network` (Traffic redirects in). A **scope bar** (All / device / session) sits above a
set of panes/tabs:
- **Traffic** — today's Traffic table + host/path tree, scoped by the bar.
- **Intercept** — the breakpoints/hold UI as a first-class pane (arm rules, held-flow editor) instead
  of a modal bolted onto Traffic.
- **Repeater** — the Request Builder + the proxied-requests history merged (send a request, see the
  in-flight/served list, diff), reachable by "Repeat" from any Traffic/Intercept row.
- **Catalogue** — the API Catalogue grouping, scoped by the bar.

Nav collapses from 4 Network entries to 1. The device Capture tab's live view becomes a deep link:
`/ui/network?scope=device:<id>`.

- **Pros:** matches the mental model (one workflow, one place); scope selected once; in-place replay/
  intercept; biggest friction win; each pane stays a focused component (lazy-loaded).
- **Cons:** largest change; must preserve deep links + scopes from six existing routes; risk of a
  mega-page if panes aren't cleanly split. Mitigate by keeping each pane its own lazy component behind
  a shared `NetworkScopeContext`.
- **Effort:** multi-PR (see phasing).

### Option B — Everything device-scoped; "All devices" is a pseudo-device

Collapse to the per-device model: the workspace always has a device scope, and cross-device analysis
is a synthetic "All devices" device.
- **Pros:** one consistent scoping primitive; the per-device Capture tab becomes the natural home.
- **Cons:** forces a device frame onto inherently cross-device views (aggregate Traffic, API
  Catalogue don't belong to a device); awkward for saved traffic and catalogue. Fights the data model.
- **Verdict:** rejected — the scope is sometimes "no device," which B can't express cleanly.

### Option C — Keep the pages, add a shared scope/action bar + cross-links

Don't merge routes. Add a persistent scope+actions bar across the Network pages and cross-link them
(Traffic row → Repeater prefilled, Catalogue endpoint → Traffic filtered).
- **Pros:** low risk, incremental, no route churn.
- **Cons:** doesn't actually reduce the five entries or the page hops — treats the symptom. The spec's
  stated root cause ("five nav entries for one workflow") remains.
- **Verdict:** fallback if we want value without committing to the restructure.

## Recommendation

**Option A, phased**, so each phase ships value and is independently reviewable:

- **Phase 1 — Workspace shell + scope bar + Traffic pane.** New `/ui/network` with the scope selector
  (All / device / session) wrapping today's Traffic table+tree (the `hostname`/`sessionId`/`deviceId`
  params already exist on `/list` and `/tree`). Traffic route redirects in. Nav: "Traffic" → "Network".
- **Phase 2 — Intercept pane.** Promote `InterceptHoldPanel`/`ArmControl` from a Traffic modal to a
  pane; arm scoped by the bar.
- **Phase 3 — Repeater pane.** Merge Request Builder + HTTP Requests (proxied-requests) into one pane;
  "Repeat" from any row opens it in place (extends the existing ReplayDrawer). Retire the two nav
  entries.
- **Phase 4 — Catalogue pane + device-tab deep link.** Fold API Catalogue in; reduce the per-device
  Capture tab's live view to "open in workspace, scoped to this device."

Each phase is its own spec → plan → PR. Phase 1 alone removes the Traffic/Capture split and lands the
scope selector the whole thing hinges on.

## Open questions for Cube (blocking)

1. **Go with Option A (phased)?** Or C (cheaper, keeps pages) if you'd rather not restructure routing.
2. **Route name:** `/ui/network` (new) vs repurpose `/ui/traffic`? Any external deep links / plugins
   that hardcode these routes I should preserve? (Plugins can contribute nav — need to check impact.)
3. **Scope model:** is "capture session" a scope users think in, or just device + "all"? (Affects the
   selector's shape.)
4. **Phase 1 scope:** ship just the shell + scope bar + Traffic pane first, and iterate — yes?

## Not started

No code. Awaiting the decision above. Phase 1 gets its own plan once you pick a direction.
