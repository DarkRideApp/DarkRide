# Plugins workspace: design

Date: 2026-10-09
Status: **Decided and built.** The structure (option A below) was chosen by Cube; the row, drawer and flow details were settled during the build and are recorded here.

## The problem

Managing plugins was split across two pages that looked and behaved differently:

| Surface | Route | Did |
|---|---|---|
| Marketplace | `/ui/marketplace` (Tools nav) | Browse the registry, install |
| Plugin Manager | `/ui/settings/plugins` (Settings sidebar) | Enable, disable, update, uninstall, approve AI permissions |

Symptoms, all from reading the code:

- The nav badge on Marketplace counted available updates, but updates could only be applied on the other page.
- An install was not one flow: install dialog, then a "restart" toast, then a trip to Settings for the AI-permissions banner, Review, Enable.
- The two pages shared nothing: different headings (one page had two), card versus grid, a `Manage installed` button on one and `Browse Marketplace` on the other.
- The installed card showed the raw runtime name and the raw `installedVia` string, and a button that read "Enabled" but meant "click to disable".
- Two restart prompts on the Settings page (the layout's `RestartBanner` and a local button); one on Marketplace.

The user's description: "I want to update a plugin, go to marketplace, not there. It's in manage plugins? Why are these not just the same thing?"

## Options considered

- **A. One Plugins workspace** (chosen). One top-level page with Installed and Discover tabs, one row component, one detail drawer, one restart banner. Same shape as the Network workspace (`docs/specs/2026-07-19-unify-network-surfaces-design.md`).
- **B. One flat catalog.** No tabs; every plugin has a state and filter chips pick it. Smallest surface, but your own plugins get buried as the registry grows.
- **C. Two pages, shared shell.** Cheapest, but "which page is it on" stays.

The Marketplace was moved out of Settings on 2026-05-14 because browsing is a frequent action and Settings is the wrong shelf. The workspace stays top-level for the same reason.

## Shape

- **Route:** `/ui/plugins`, nav item `Plugins` (Tools group), gated by `core.plugins:manage`, with the update-count badge.
- **State in the URL:** `tab` (`installed` | `discover`), `q`, `filter` (Installed: `updates` | `disabled` | `errors`), `category` (Discover), `plugin` (open drawer). Every view is linkable. Opening the drawer from the list pushes a history entry, so Back closes it; a deep link just drops the param.
- **Landing tab:** with no `?tab=`, Installed if anything is installed, else Discover. Decided once after the first load, so uninstalling your last plugin does not bounce you to Discover.
- **Redirects** (query string and hash carried across, the route's tab wins over a stray `?tab=`): `/ui/marketplace`, `/ui/settings/marketplace` and `/ui/settings/plugins/marketplace` go to Discover; `/ui/settings/plugins` goes to Installed.
- **Settings keeps what is config.** Each plugin's own settings page stays at `/ui/settings/plugins/:name/settings`. The sidebar's old `Installed` item became `Manage plugins`, a link to the workspace.

## Data model (`frontend/pages/plugins/catalog.ts`)

Registry records (`GET /v1/plugins/marketplace`) and installed records (`GET /v1/plugins/installed`) join into one `PluginEntry`:

- **Join key:** `npmPackage`, else `name`. The backend already matches by `npmPackage` for update detection; matching by name alone misses plugins whose registry name differs from their runtime name (a git source lists the fixture plugin as `test`, which runs as `test-plugin`).
- **Status** (one value drives the pill and the filters): `missing` > `error` (host recorded `lastError`) > `disabled` > `update` > `needs-restart` (enabled but not loaded) > `installed`; `available` when not installed.
- **`updateAvailable` is its own flag**, not part of `status`, so a disabled plugin can still be updated and the Updates filter is exact.
- **Installed shows what you have** (including workspace plugins the registry does not know). **Discover shows the whole registry** with installed plugins marked, so an Update button is on the row wherever you land.
- The two lists load independently: a marketplace outage never hides installed plugins.

## Row, drawer, visual language

- One `PluginRow` for both tabs: name (opens the drawer), version (`v1.0.0 → v2.0.0` when an update exists), trust icon, `Local` tag for workspace/manual plugins, status pill (only when the state needs a call-out), description, author and category, a one-line host error, unmet dependencies.
- **One lead action per row**, by precedence: Install / Reinstall, Review permissions, Update. Enable/disable is a real switch (`role="switch"`, fixed name, state in `aria-checked`).
- **Detail drawer** (`role="dialog"`, focus moves in and returns, Escape closes): About, Trust, Requires, Provides (tool/page/setting counts, only while loaded), AI permissions, the full host error, Open settings, Uninstall. A beside-the-list column on wide screens, an overlay under 1100px.
- Styles are `plugins-*` classes on the shared tokens (dark and light). The header reuses `.page-header`. `.btn-warning`, which was used but never defined, now exists.

## Flows

- **Install:** POST install; `confirmRequired` raises the unverified-plugin dialog; the progress dialog stays until the server reports done; success reloads the list and the row reads `Restart to activate`. Failures (blocked, name collision, content mismatch, generic) toast and close the progress dialog. One install at a time.
- **Update:** per row, or `Update all` in the strip above Installed (sequential, because concurrent npm installs into one managed root are unsafe). Partial failures are reported as `Updated 1 of 2 plugins. 1 failed.`
- **Enable:** a plugin whose AI permissions were never approved (or widened since) opens the consent dialog instead of enabling.
- **Restart:** every mutation sets the backend's restart flag, so one `RestartBanner` replaces the local restart button.
- **Sources:** the dialog stays open across edits. Any source change triggers a cache-busting refresh, because the server caches the marketplace for an hour and `add()` does not clear it.
- **Refresh:** `Updated 5m ago` label; 60 s cooldown after a successful refresh; a failed refresh re-enables the button.

## Backend

No endpoint or payload changed.

## Tests

- Gate (vitest, frontend lane): `catalog` (join, status, filters), `usePluginCatalog`, `PluginRow`, `PluginDrawer`, `PluginsWorkspace` (every flow above against a mock websocket that follows the real envelope and payload shapes), `LegacyPluginsRedirect`, nav and sidebar.
- E2E (Playwright): `plugin-management.spec.ts` (shared server: nav, every redirect, list, search, drawer and Back, toggle with restart banner, sources dialog) and `plugins-install-ui.spec.ts` (own backend and Vite: add a source, install through the unverified warning, joined row, uninstall).

## Follow-ups, not in this change

- `scope-status` is still one request per loaded plugin; a batch endpoint would remove the N+1.
- `PluginSourceManager.add()` should clear its own cache so the server is correct without the client busting it.
- Removed scopes (the old drift banner listed them) are not shown; the consent dialog lists everything the plugin now asks for.
