# Plugin Lifecycle and Context

## Plugin Structure

A plugin is a directory under `plugins/` with this layout:

```
plugins/my-plugin/
  package.json              # name, version, "darkride-plugin" keyword
  darkride-plugin.ts        # entry point — registers all contributions
  backend/
    schema.ts               # Drizzle table definitions (optional)
    routes.ts               # API endpoint handlers (optional)
    tools.ts                # Unified AI tools (optional)
    services/               # Business logic (optional)
  frontend/
    plugin.ts               # Frontend registry — lazy-loaded pages + nav
    pages/                  # React page components
    components/             # Shared UI components
```

### package.json

The `darkride-plugin` keyword is required for automatic discovery:

```json
{
  "name": "@my-org/plugin-example",
  "version": "1.0.0",
  "private": true,
  "keywords": ["darkride-plugin"],
  "description": "What this plugin does"
}
```

## Plugin Definition

The `darkride-plugin.ts` file is the entry point. It uses `definePlugin()` to declare the plugin and register contributions:

```typescript
import { definePlugin } from '@darkrideapp/plugin-sdk';
import * as schema from './backend/schema';

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  // dependencies: ['other-plugin'],  // optional — declare required plugins

  register(ctx) {
    // Register contributions using ctx methods (see Extension Points below)
    ctx.dbTables(schema);
    ctx.nav([{ group: 'Tools', label: 'My Plugin', path: '/my-plugin', icon: 'box' }]);
    ctx.pages([{ path: '/my-plugin' }]);
  },
});
```

## Plugin Lifecycle

Every plugin has three lifecycle phases: `register`, `start`, and `stop`.

### register(ctx)

Called once on startup, **before** any plugin's `start()`. `register` must **complete synchronously** — the function body runs to completion before the next plugin's `register` fires, so any `await`s or pending Promises will not block the rest of discovery. Use it to declare contributions: nav entries, pages, settings, DB tables, tools, notification events, UI slots, and so on.

**Constraints in `register`:** you must not perform I/O, build services, or call `ctx.peer()`. Even though the TypeScript signature accepts `async`, treat the function as sync — the DB and peer registry aren't wired yet, and anything you `await` won't be observable to other plugins' `register` calls. Save async work for `start()`.

### start(ctx)

Called **after all plugins' `register()` have run**, in topological dependency order. If plugin B depends on plugin A, A's `start()` completes before B's begins.

Use `start()` for:
- Constructing services (DB queries, network clients, caches)
- Reading initial configuration from the DB
- Calling `ctx.peer<T>('other-plugin')` to get peer services
- Registering routes or jobs that depend on constructed services
- Calling `ctx.exposeService(impl)` to publish this plugin's service to peers

If `start()` throws, the server aborts boot with a structured error message. The same happens if `start()` does not resolve within `startTimeoutMs` (default 30 s; override per plugin).

### stop(ctx)

Called in **reverse** dependency order during graceful shutdown. Failures are logged but do not halt the shutdown sequence — all plugins get a chance to clean up.

### Example: a plugin with full lifecycle

```typescript
/** Module-level ref set in start(), cleared in stop(). */
let scheduler: MyScheduler | null = null;

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  dependencies: ['other-plugin'],   // other-plugin's start() runs before ours

  register(ctx) {
    ctx.nav([{ group: 'Tools', label: 'My Plugin', path: '/my-plugin', icon: 'box' }]);
    ctx.pages([{ path: '/my-plugin' }]);
    ctx.settingsDefs([{ key: 'my_plugin_api_key', label: 'API Key', type: 'string', secret: true }]);
  },

  async start(ctx) {
    // Core deps live on ctx — no wiring.ts indirection.
    const db = ctx.db(schema);
    const notify = ctx.notify.bind(ctx);

    // Peer service exposed by other-plugin's start()
    const otherService = ctx.peer<OtherService>('other-plugin');

    scheduler = new MyScheduler({ db, notify, otherService });

    ctx.jobs([{
      id: 'my-plugin-daily',
      name: 'My Plugin daily run',
      category: 'sync',
      defaultSchedule: '0 7 * * *',
      canRunManually: true,
      run: () => scheduler!.runOnce(),
    }]);
  },

  async stop(_ctx) {
    await scheduler?.stop();
    scheduler = null;
  },
});
```

### Service registry: exposeService / peer / hasPeer

Plugins communicate through a typed service registry wired between `register()` and `start()`.

**Publishing a service** (in `start()`):

```typescript
// my-plugin/api.ts — the exported type that consumers import
export interface MyPluginService {
  getItems(): Item[];
}

// darkride-plugin.ts
async start(ctx) {
  const items = loadItems();
  ctx.exposeService<MyPluginService>({ getItems: () => items });
}
```

**Consuming a required service** (in a dependent plugin's `start()`):

```typescript
import type { MyPluginService } from '../my-plugin/api';

// dependencies: ['my-plugin'] must be declared in definePlugin(...)
async start(ctx) {
  const myPlugin = ctx.peer<MyPluginService>('my-plugin');
  const items = myPlugin.getItems();
}
```

`ctx.peer()` throws if the named plugin is not loaded or did not call `exposeService`. Declare the dependency in `dependencies` to ensure load order; peers are guaranteed to have completed their `start()` before yours runs.

**Consuming an optional service:**

```typescript
// optionalDependencies: ['my-plugin'] in definePlugin(...)
async start(ctx) {
  if (ctx.hasPeer('my-plugin')) {
    const myPlugin = ctx.peer<MyPluginService>('my-plugin');
    // use myPlugin
  }
}
```

### Core dependencies on `ctx`

Plugins access the core's services directly through `ctx`. There is no per-plugin wiring file; everything is injected by the plugin manager when the plugin loads.

| Need | Use |
|---|---|
| Database (your schema) | `ctx.db(schema)` — Drizzle DB scoped to your tables |
| Notifications | `ctx.notify({ type, title, body, ... })` |
| Settings (KV) | `ctx.settings.get/set/getJson/setJson/delete/list` (async) |
| Cloud blob storage | `ctx.cloudStorage` — typed as `CloudStorageService` |
| Raw file storage | `ctx.fileSync` — typed as `FileStorageService` (rare; prefer `ctx.files()`) |
| Plugin-scoped storage | `ctx.files()` — namespaced; created on demand |
| Automation runner | `ctx.runner` — typed as `AutomationRunner` (only if the plugin scripts triggers) |
| AI agents | `ctx.ai.agent({ tier })` |
| Hooks | `ctx.hooks.on(name, handler)` / `ctx.hooks.emit(name, payload)` |
| Plugin logging | `ctx.logger()` or `ctx.logger('subsystem')` |
| WebSocket | `ctx.websocket.registerChannel(name)` / `ctx.websocket.broadcast(msg)` |

The host service shapes (`CloudStorageService`, `FileStorageService`, `AutomationRunner`) are exported as types from `@darkrideapp/plugin-sdk` — `import type { CloudStorageService } from '@darkrideapp/plugin-sdk'` if you need to refer to them in your own type signatures.

The `plugins/kitchen-sink/` plugin is the in-tree reference that exercises every extension point — see its `darkride-plugin.ts` and `frontend/plugin.ts`.
