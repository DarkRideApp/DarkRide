---
name: authoring-darkride-plugins
description: Use when authoring, scaffolding, or publishing a DarkRide plugin — covers the `darkride plugin` CLI, the @darkrideapp/plugin-sdk surface, register/start/stop lifecycle, migrations, testing, and the gotchas (multi-statement SQL, frontend tarball contents) that are easy to hit.
---

# Authoring DarkRide Plugins

A DarkRide plugin is a TypeScript package keyed `darkride-plugin` in `keywords`, exporting a `definePlugin({...})` default. It runs inside the host server, registers UI/data/services through the `ctx` surface, and is auto-discovered at boot. Plugins live either **in-tree** under `plugins/` (workspace plugin, hot-reload during dev) or **standalone** as an npm package shipped via the marketplace and installed under the host's managed prefix.

The host's authoritative reference docs live at `docs/plugins/{README,lifecycle,backend,ui,frontend,testing}.md`. This skill is the discovery surface that points at them and captures the patterns + gotchas.

## When to Use

- Creating a new plugin
- Adding a feature (route, table, tool, job, setting, hook) to an existing plugin
- Promoting an in-tree plugin to a standalone published package
- Diagnosing why a plugin fails to load, ships without its UI, or silently skips a migration

## Start with the CLI

```sh
darkride plugin create          # interactive scaffold under plugins/<slug>/
darkride plugin dev             # start dev server with HMR
darkride plugin add-migration <plugin> <name>
darkride plugin test <plugin>
darkride plugin list            # what's installed
darkride plugin sign            # sign a registry file (publishing only)
```

The scaffolder emits the canonical layout, scoped package name, `darkride-plugin` keyword, and a working entry point. **Use it for new plugins** — it eliminates the most common setup mistakes.

The `add-migration` command resolves the next `idx` and writes the SQL skeleton; **always use it instead of hand-creating migration files** so the file naming and any tooling-side bookkeeping stay correct.

## Two authoring paths

| | In-tree (workspace) | Standalone (published) |
|---|---|---|
| Location | `plugins/<slug>/` inside this repo | Own repository, published as npm package |
| Discovery | Vite glob (`plugins/*/frontend/plugin.ts`) + workspace package | Installed under managed prefix, scanned by the host loader |
| When to use | Default. Fastest dev loop. | When you want a release cadence independent of the host, or to ship outside the host repo |
| Imports | `'@darkrideapp/plugin-sdk'` for SDK; `'./backend/...'` etc. for plugin-internal | Same |
| Frontend host components | `'@darkrideapp/plugin-sdk/react'` | Same |
| `package.json#private` | `true` | Must be absent (else `npm publish` refuses) |
| Tests | `createPluginTestHarness` (full lifecycle, real DB) | `:memory:` SQLite + `SettingsApi` stub (host paths don't resolve) |

## Directory layout

```
plugins/my-plugin/                  # or own repo for standalone
  package.json                      # darkride-plugin keyword + @darkrideapp/plugin-sdk peer dep
  darkride-plugin.ts                # default export of definePlugin({...})
  api.ts                            # cross-plugin types (optional)
  backend/
    schema.ts                       # Drizzle table defs (table names: plugin_<slug>__<name>)
    routes.ts                       # endpoint handlers
    services/...
    settings.ts                     # PluginSetting[] for ctx.settingsDefs
    tools.ts                        # PluginTool[] for ctx.tools
  frontend/
    plugin.ts                       # registers components/pages with pluginRegistry
    pages/...
    components/...
  migrations/
    0000_init.sql
    meta/_journal.json              # written by the CLI; for tooling compat
  __tests__/
```

For **standalone** plugins add: `tsconfig.json`, `scripts/copy-plugin-assets.js` (to copy `*.sql` + `*.json` into `dist/`), and an explicit `files` array in `package.json` listing every directory the runtime needs (`dist/`, `frontend/`, `migrations/`, plus any `sidecar/`).

The asset copier should **skip any directory that's already shipped as-is via `package.json#files`**. If a plugin ships a `sidecar/` (or similar) directory full of binaries and large data files via the `files` array, recursing into it and copying its `*.json` into `dist/sidecar/` doubles the tarball — once via `files: ["sidecar/", ...]`, once via `dist/sidecar/`. Add the directory's name to the `SKIP_DIRS` set in `copy-plugin-assets.js`.

## definePlugin: register vs start vs stop

```ts
import { definePlugin } from '@darkrideapp/plugin-sdk';
import * as schema from './backend/schema';

let scheduler: Scheduler | null = null;

export default definePlugin({
  name: 'my-plugin',
  // No version field — the host reads package.json#version. See "Version" below.
  dependencies: ['other-plugin'],          // load order; ctx.peer<T>('other-plugin') guaranteed available in start()
  optionalDependencies: ['nice-to-have'],  // ctx.hasPeer('nice-to-have') gates use
  startTimeoutMs: 30_000,                   // default; raise if start() does heavy work

  register(ctx) {
    // SYNCHRONOUS, declarative metadata only.
    ctx.dbTables(schema);
    ctx.nav([{ group: 'Tools', label: 'My', path: '/my', icon: 'box' }]);
    ctx.pages([{ path: '/my' }]);
    ctx.settingsDefs([{ key: 'my_api_key', label: 'API key', type: 'string', secret: true }]);
    ctx.scopes([{ key: 'plugin.my:read', label: 'Read my', description: '...', category: 'My' }]);
    ctx.notificationEvents([{ type: 'my:done', label: 'My done', description: '...' }]);
    ctx.hooks.define('my:item-created', { id: 'number' });
  },

  async start(ctx) {
    // ASYNC runtime setup. Construct services here.
    const db = ctx.db(schema);
    const log = ctx.logger();
    scheduler = new Scheduler({ db, log });

    ctx.api((api) => {
      api.get('/v1/my/items', (_req, res) => res.json({ data: scheduler!.list() }), { requires: ['plugin.my:read'] });
    });

    ctx.jobs([{ id: 'my-sync', name: 'My sync', category: 'sync', defaultSchedule: '0 */6 * * *', canRunManually: true, run: () => scheduler!.runOnce() }]);

    ctx.exposeService<MyApi>(scheduler);    // expose BEFORE awaiting hooks peers may trigger
  },

  async stop(_ctx) {
    try { await scheduler?.stop(); } catch { /* ignore */ }
    scheduler = null;
  },
});
```

**Constraints in `register`:** no I/O, no async, no `ctx.peer`, no `ctx.db()` — none of those are wired yet. Only declarative metadata.

**`start` ordering:** topological by `dependencies`. Required peers' `start()` has completed before yours runs. Optional peers may or may not be present — gate with `ctx.hasPeer(name)`.

**`stop` is best-effort:** failures are logged but don't halt the shutdown loop. Wrap each cleanup in `try { ... } catch { /* ignore */ }`.

## Version

The plugin's version comes from `package.json#version` and only `package.json#version`. The host reads it during discovery and uses it for `pluginState.version`, marketplace "update available" comparisons, and the Plugin Manager UI.

`definition.version` (the string in `definePlugin({ version: '...' })`) is **deprecated** and now optional in the SDK. New plugins should omit it. Older plugins that still set it are tolerated — the host ignores it whenever a `package.json#version` is present — but leaving it in is just clutter that drifts behind release tags. Drop it the next time you touch the file.

## ctx surface

| Method | Phase | Purpose |
|---|---|---|
| `ctx.pluginDir` | always | Absolute path to this plugin's package root. Use it to resolve assets bundled with the plugin (sidecars, templates, data files) without making CWD-relative assumptions |
| `ctx.dbTables(schema)` | register | Declare which tables this plugin owns |
| `ctx.db(schema)` | start+ | Typed Drizzle DB (your tables only) |
| `ctx.nav([...])` / `ctx.pages([...])` | register | Frontend nav + routes |
| `ctx.settingsDefs([...])` | register | Declare setting keys + type + secret flag. **Backend-only** — adds keys to the `PUT /v1/settings/:key` allow-list. Does **not** render any UI; pair with `pluginRegistry.registerSettings()` in `frontend/plugin.ts` for a settings page. See [`docs/plugins/frontend.md`](../../docs/plugins/frontend.md#settings-backend-vs-frontend) |
| `ctx.settings.get/set/getJson/setJson/delete/list` | start+ | Async key/value persistence on the host's settings table |
| `ctx.scopes([...])` | register | OAuth-style scopes for endpoint authorization |
| `ctx.commands([...])` | register | Command palette entries |
| `ctx.notificationEvents([...])` | register | Notification taxonomy users can subscribe to |
| `ctx.tools([...])` / `ctx.toolContexts([...])` | start (tools) / register (contexts) | Unified tool surface (AI chat + MCP + REST + automation) |
| `ctx.api(api => ...)` | start | Register HTTP **and** WS-REST endpoints in one call |
| `ctx.routes(router => ...)` | start | Full Express Router escape hatch (HTTP only, no WS-REST) — for middleware, `router.use()`, streaming responses |
| `ctx.jobs([...])` | start | Cron-scheduled background work, runs in the plugin's normal Node context with full `ctx`. `canRunManually: true` exposes a manual-trigger button on `/ui/settings/jobs`. **Default choice for periodic plugin work** — see [`docs/plugins/backend.md`](../../docs/plugins/backend.md#when-to-use-ctxjobs-vs-automations) for the jobs-vs-automations decision rule |
| `ctx.exposeService<T>(impl)` / `ctx.peer<T>(name)` / `ctx.hasPeer(name)` | start | Cross-plugin RPC |
| `ctx.hooks.define / on / emit` | define in register; on/emit in start+ | Pub/sub between plugins. Core hooks: `app:startup`, `app:shutdown`, `device:connected`, `device:disconnected`, `session:created`, `automation:started`, `automation:completed`, `apk:detected-app`, `apk:analyzed` |
| `ctx.websocket.registerChannel(name)` / `broadcast(msg)` | start | Filtered WS channels — bandwidth wins for clients on unrelated pages |
| `ctx.logger(scope?)` / `ctx.notify(event)` | runtime | Scoped logging + user-visible notifications |
| `ctx.files()` | start+ | Plugin-scoped file storage namespace |
| `ctx.cloudStorage` / `ctx.fileSync` / `ctx.paths.fileStorage(rel)` | start+ | Cloud blobs, raw file storage, absolute path resolution |
| `ctx.runner` | start+ | Automation runner (rare — only plugins that script automation flows) |
| `ctx.ai.agent({ tier })` | start+ | Spawn AI agents |

`ctx.settings` is **async** — every read/write returns a Promise. Constructors that need a setting on init should defer to first-use or expose an `async init()` the plugin's `start` awaits.

## Resolving paths to your own assets

When a plugin needs to find a file or directory that ships in its own tarball — a Go sidecar source, a template directory, a binary, a JSON manifest — it must resolve that path **relative to the plugin's own package root**, not relative to the host's CWD or to `__dirname`.

The wrong way (works in workspace dev, breaks under marketplace install):
```ts
const sidecarSrc = resolve('plugins/my-plugin/sidecar');   // relative to host CWD — only correct for in-tree
```

The right way:
```ts
async start(ctx) {
  const sidecarSrc = path.join(ctx.pluginDir, 'sidecar');
  // ...
}
```

`ctx.pluginDir` is an absolute path that the host populates from discovery — `<host>/plugins/<slug>/` for workspace plugins, `<host>/data/installed-plugins/node_modules/@<scope>/<pkg>/` for managed installs. Same plugin source works in both layouts.

The `__dirname`/`import.meta.url` route also works (TypeScript files have `__dirname` under CJS output) but is more fragile — `__dirname` shifts depending on whether tsc emitted to `dist/backend/services/` or the file is loaded directly from `backend/services/` via tsx in dev. Walking up to the nearest `package.json` works around that, but `ctx.pluginDir` is shorter and more obvious.

## Database tables

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const items = sqliteTable('plugin_my_plugin__items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
});
```

**Naming convention:** `plugin_<slug>__<table>` (double underscore). Required — the host's table-name validator rejects plugins that don't comply.

## Migrations

Drizzle-style `.sql` files under `migrations/`, applied at server boot in lexicographic filename order. The plugin migrator tracks applied filenames in the host's `plugin_migrations` table (per-plugin). It does not read `meta/_journal.json` at runtime — that file is kept around so Drizzle Studio / drizzle-kit work against your plugin, and the CLI maintains it for you.

Use the CLI to add migrations:

```sh
darkride plugin add-migration my-plugin add_user_settings
```

Creates `migrations/<idx>_add_user_settings.sql` with the right naming. Edit the SQL, restart the server to apply.

**One gotcha that still bites:** multi-statement SQL files MUST use `--> statement-breakpoint` between statements:

```sql
CREATE TABLE foo (id INTEGER PRIMARY KEY);
--> statement-breakpoint
CREATE INDEX idx_foo_id ON foo(id);
```

Without breakpoints, `better-sqlite3.prepare()` rejects the file with "contains more than one statement" — silent on Linux with `exec()`, crashes on Windows.

For standalone plugins: `migrations/` MUST be in `package.json#files` — otherwise the tarball ships without them and the plugin's tables never get created on install.

## Frontend

All host UI components, hooks, and the registry come from `@darkrideapp/plugin-sdk/react`:

```ts
import { PageHeader, Card, Modal, StatusBadge, useWebSocket, useDocumentTitle, pluginRegistry } from '@darkrideapp/plugin-sdk/react';
```

`frontend/plugin.ts` is the entry the host's Vite glob picks up. The host scans both `<host>/plugins/*/frontend/plugin.ts` (in-tree) and `<host>/data/installed-plugins/node_modules/@*/plugin-*/frontend/plugin.ts` (managed installs). For standalone plugins: if the tarball didn't ship `frontend/`, the UI never reaches the registry.

### pluginRegistry surface

| Method | Mounts |
|---|---|
| `pluginRegistry.registerPages(name, [{ path, component }])` | Routes under `/ui/<path>`. Lazy-load components |
| `pluginRegistry.registerNav(name, [{ group, label, path, icon }])` | Side-nav items grouped under host groups (`Tools`, `Devices`, …) |
| `pluginRegistry.registerSettings(name, { label, component, order? })` | **The plugin's settings page** at `/ui/settings/plugins/<name>/settings`. Required for any UI — `ctx.settingsDefs()` alone produces no page |
| `pluginRegistry.registerCommands(name, [{ id, label, keywords, icon, action }])` | Command palette entries (Cmd/Ctrl+K) |
| `pluginRegistry.registerDecoders(name, [...])` | Traffic decoders for the Traffic / Capture inspectors |
| `pluginRegistry.registerButtonContribution(name, c)` | Add a button to a `button-list` slot (e.g. `device-viewer:overflow-actions`) |
| `pluginRegistry.registerNavItemContribution(name, c)` | Add a nav item to a `nav-item-list` slot |
| `pluginRegistry.registerUiContributions(name, [...])` + `registerContributionComponents(name, map)` | Generic typed contributions to `container` slots — data + component map |
| `pluginRegistry.registerUiSlots(name, [{ id, kind, label }])` | Open your own extension point for other plugins to contribute to |

Full examples (every method, with a settings-page reference implementation) live in [`docs/plugins/frontend.md`](../../docs/plugins/frontend.md). The slot model — kinds, priority resolution, host-side rendering — is in [`docs/plugins/ui.md`](../../docs/plugins/ui.md).

CJS-only deps used by a standalone plugin's frontend (e.g. `leaflet`) need to be added to the **host's** `vite.config.ts` `optimizeDeps.include`. Standalone installs live under the host's managed prefix, outside Vite's root, so its scanner doesn't find their imports automatically. In-tree workspace plugins don't need this — Vite picks up their imports directly.

## Testing

### In-tree plugins → `createPluginTestHarness`

```ts
import { createPluginTestHarness } from '../../../backend/test-utils/plugin-harness';
import request from 'supertest';

const harness = await createPluginTestHarness({ pluginDir: 'plugins/my-plugin', start: true });
const res = await request(harness.app).get('/v1/my-plugin/items');
expect(res.status).toBe(200);
await harness.cleanup();
```

The harness spins up an in-memory SQLite DB with all core + plugin migrations applied, runs `register()` → `start()`, and wires a full Express app. Use `start: false` if you only need to test `register()` output. Pass `additionalPlugins` to test cross-plugin dependencies. Pass `seed` for direct SQL setup.

`__tests__/plugin-load.test.ts` is the standard "this plugin loads" smoke test (the scaffolder emits one).

### Standalone plugins → `:memory:` + stubs

Standalone plugins can't reach into the host repo. Instantiate services directly with stubbed dependencies:

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { SettingsApi } from '@darkrideapp/plugin-sdk';

const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE plugin_my__items (...)`);  // mirror migrations/0000_init.sql
const db = drizzle(sqlite, { schema });

const settings: SettingsApi = makeSettingsStub(); // in-memory Map<string,string>
const service = new MyService({ db, settings });
```

Mirror the SQL from your migration file directly into `sqlite.exec(...)` rather than running migrations — that avoids pulling in plugin schema that may not be installed. The vitest config should `exclude: ['node_modules', 'dist', '.worktrees']` (worktree paths cause duplicate-test failures that look like real regressions).

## Promoting an in-tree plugin to standalone

When a plugin needs an independent release cadence:

1. Move the plugin's source out of `plugins/<slug>/` into its own repo.
2. Add `tsconfig.json`, `scripts/copy-plugin-assets.js`, `.npmrc` for your registry, a CI workflow, `.gitignore`.
3. Rewrite `package.json`: scoped name, `version: '1.0.0'`, `files` array (`dist/`, `frontend/`, `migrations/`), `exports` map, `peerDependencies` for the SDK, drop `private: true`, add `"prepublishOnly": "npm run build"`.
4. Validate: `npm install` succeeds, `npm run build` emits expected files, `npm test` passes, `npm pack --dry-run` lists every directory the runtime needs.
5. Tag and publish.

The plugin's source code does not need to change — the import paths (`'@darkrideapp/plugin-sdk'`, `'@darkrideapp/plugin-sdk/react'`, plugin-internal relative imports) are the same in-tree and standalone.

## Publishing (standalone plugins)

`package.json` essentials:

```json
{
  "name": "@your-scope/plugin-my-plugin",
  "version": "1.0.0",
  "main": "./dist/darkride-plugin.js",
  "exports": { ".": "./dist/darkride-plugin.js", "./types": { "types": "./dist/api.d.ts" } },
  "files": ["README.md", "dist/", "frontend/", "migrations/"],
  "keywords": ["darkride-plugin"],
  "scripts": { "build": "tsc && node scripts/copy-plugin-assets.js", "prepublishOnly": "npm run build" },
  "peerDependencies": { "@darkrideapp/plugin-sdk": "^1.1.0" },
  "devDependencies": { "@darkrideapp/plugin-sdk": "^1.1.0", "typescript": "^5.0.0", "vitest": "^3.2.0" }
}
```

`npm pack --dry-run` is the single best pre-publish check — verifies every directory the runtime needs is in the tarball, AND surfaces accidental duplicates (e.g. `sidecar/` content being copied into `dist/sidecar/` by an over-greedy asset copier). Forgetting `frontend/` ships a plugin with no UI; forgetting `migrations/` ships one whose tables are never created. Always check the `package size` and `total files` lines and eyeball the listing.

Publishing destination is up to you — npmjs.com, GitHub Packages, a private registry — wire it via `.npmrc` and `package.json#publishConfig`. The host's marketplace flow does `npm install <pkg>@latest --prefix=<managedRoot>` — it pulls whatever the configured registry serves as `latest`.

**Optional: ship a one-line shim at the package root** for compatibility with older host versions that don't honour `package.json#main`. Cost: nothing.

```js
// darkride-plugin.js (at package root)
module.exports = require('./dist/darkride-plugin');
```

Add `darkride-plugin.js` to the `files` array. Newer hosts use `package.json#main` directly and ignore the shim; older hosts that look for `darkride-plugin.{js,ts,tsx}` at the root find it. Useful when shipping to users who haven't upgraded their host yet.

After publish, the **marketplace registry's `latestVersion` must be bumped** so the host UI offers the new version. If you maintain a private registry repo (e.g. `darkride-plugin-registry`), run its bump script (`npm run bump -- @your-scope/plugin-foo`) which calls `npm view <pkg> version`, updates `registry.json`, re-signs, and prints a diff to commit. Just publishing the tarball is not enough — without the registry bump, users stay on the prior version forever.

If you run your own marketplace registry, the `darkride plugin sign` and `darkride plugin trust-key` commands generate Ed25519 keypairs, sign a `registry.json`, and add publisher public keys to a host's trusted-keys list. Run `darkride --help` for usage.

## Common Mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| `frontend/` missing from `package.json#files` | Standalone plugin installs but no UI appears | Add to `files`; verify with `npm pack --dry-run` |
| Called `ctx.settingsDefs(...)` and expected a settings page to appear | Keys are reachable via `PUT /v1/settings/:key` but no page exists at `/ui/settings/plugins/<name>/settings` | `settingsDefs` is backend-only. Also call `pluginRegistry.registerSettings(name, { label, component })` in `frontend/plugin.ts` and ship a React page that reads/writes the keys via `useWebSocket().sendRestApi(...)` |
| Used an automation to run periodic plugin work (especially high-frequency, e.g. per-minute) | Session history spammed with plugin-internal runs; schedule lives outside the plugin (per-install setup); cross-plugin calls go over the V8 sandbox boundary with serialisation overhead | Use `ctx.jobs([{ id, defaultSchedule, canRunManually: true, run }])` instead. Runs in the plugin's normal Node context with full `ctx.peer<T>(...)` access, manual-trigger button on `/ui/settings/jobs`, schedule baked into the plugin source. Reach for an automation only when you need `device.*` / `setProxy` / the script sandbox, or when the user is expected to live-edit the script in Monaco |
| Multi-statement migration without `--> statement-breakpoint` | "contains more than one statement" or silent failure on Windows | Add breakpoints |
| Hand-creating migration files instead of using the CLI | Wrong filename ordering, missing journal entry, drift between tooling | Use `darkride plugin add-migration` |
| Table name without `plugin_<slug>__` prefix | Validator rejects plugin at boot | Rename the table |
| `private: true` left in package.json of a standalone plugin | `npm publish` refuses | Remove the field |
| `definition.version` set in `definePlugin({ version: '...' })` | Easy to leave stale and divergent from `package.json#version` | Don't set it — it's deprecated. The host derives version from `package.json#version` |
| Resolving plugin assets via `resolve('plugins/<slug>/foo')` or any path relative to host CWD | Works in workspace dev, fails under marketplace install with "directory missing" errors | Use `path.join(ctx.pluginDir, 'foo')` — works in both layouts |
| Asset copier recursing into `sidecar/` (or any dir already in `files`) | Tarball ships duplicates; pack size doubles | Add the dir to `SKIP_DIRS` in `copy-plugin-assets.js` |
| Tarball published but registry's `latestVersion` not bumped | Users never see the new version offered for install/update | Run the registry bump script after every publish |
| `ctx.exposeService` after `await`-ing a startup hook peers may have triggered | Peers see "service not yet exposed" | Construct services first, expose synchronously inside `start()`, then do async work |
| Sync code path expecting `ctx.settings.get` to return a value | TypeError or `undefined` instead of the stored value | It's async — `await` it |
| Stale `dist/` published | Tarball ships old code | Add `prepublishOnly: "npm run build"` |
| `vitest` config without `.worktrees` exclude | Duplicate-test failures look like regressions | `exclude: ['node_modules', 'dist', '.worktrees']` |
| `await import(...)` of plugin-internal modules at the top of `register()` | Async leak — `register` must be synchronous | Move to `start()` |
| `hooks.define` called from `start()` | Other plugins' `register` ran before yours, can't subscribe before define | Always `define` in `register` |

## Reference

The canonical in-tree reference plugin is **`plugins/kitchen-sink/`** — it exercises every extension point (nav, pages, slots, tools, jobs, settings, hooks, scopes, WebSocket channels, file storage). Read its `darkride-plugin.ts` and `frontend/plugin.ts` to see the full pattern. The deeper docs at `docs/plugins/{lifecycle,backend,ui,frontend,testing}.md` are authoritative for the API surface.

## Red Flags

- About to commit a standalone plugin without running `npm pack --dry-run` → STOP, run it, eyeball the listing for missing or duplicated dirs
- About to hand-create a migration file → STOP, use `darkride plugin add-migration`
- About to mock the host's `PluginManager` in a standalone plugin's tests → STOP, use `:memory:` + stubs instead
- About to call `ctx.settings.get(...)` without `await` → it's async; await it
- About to publish a standalone plugin without bumping `version` → npm will reject the duplicate
- About to set `version: '...'` in `definePlugin({...})` → STOP, that field is deprecated; let `package.json#version` be the only source
- About to tell a user to visit `/ui/settings/plugins/<name>/settings` based only on the plugin calling `ctx.settingsDefs(...)` → STOP, that route only exists if `frontend/plugin.ts` also calls `pluginRegistry.registerSettings(name, { label, component })`. `settingsDefs` is backend-only
- About to instruct the user to create a host-side automation as scaffolding for periodic plugin work → STOP, default to `ctx.jobs(...)` in the plugin instead. Automations are for scripts that need the automation sandbox (device API, Monaco-live-edited bodies); for plain "run this code every N minutes" the job system is self-contained, schedule-in-source, and doesn't spam the session history. See [`docs/plugins/backend.md`](../../docs/plugins/backend.md#when-to-use-ctxjobs-vs-automations)
- About to write `resolve('plugins/<slug>/something')` or any host-CWD-relative path to a plugin asset → STOP, use `path.join(ctx.pluginDir, 'something')`
- About to add a table without the `plugin_<slug>__` prefix → STOP, the validator will reject the plugin at boot
- About to push a publish tag without then bumping the registry's `latestVersion` → users won't see the update; run the registry bump script straight after CI publishes
