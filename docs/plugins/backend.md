# Plugin Backend: APIs, Database, Tools, Jobs, Settings, Hooks

## API Endpoints

The canonical way to expose REST endpoints from a plugin is `ctx.api()`. It receives a per-plugin `api` object with `get`/`post`/`put`/`delete`/`patch` methods that register each endpoint in **both** the Express HTTP router and the WebSocket-REST routing table, so clients can reach them over either transport.

Call `ctx.api()` from `start()` after your services are constructed — the handler closures capture the service instances:

```typescript
async start(ctx) {
  const service = new MyService(ctx.db(schema));
  ctx.api((api) => {
    api.get('/v1/myplugin/items', (req, res) => {
      res.json({ success: true, data: service.list() });
    });
    api.post('/v1/myplugin/items', (req, res) => {
      const item = service.create(req.body);
      res.json({ success: true, data: item });
    }, { requires: ['core.myplugin:write'] });
  });
}
```

The optional third argument `{ requires: string[] }` enforces scope checks — requests lacking any of the listed scopes receive a 403 response automatically.

## Routes (full Express Router — HTTP only)

For cases that need full Express Router features (middleware, `router.use()`, route grouping, or streaming responses) use `ctx.routes()`. Note that endpoints registered this way are **not** reachable over the WebSocket-REST transport — they are HTTP only.

```typescript
ctx.routes((router) => {
  router.get('/v1/my-plugin/items', (req, res) => {
    res.json({ success: true, data: [] });
  });
});
```

Use `ctx.api()` for typical REST endpoints. Reach for `ctx.routes()` only when you specifically need raw Express Router capabilities.

## Database Tables

Define Drizzle ORM tables in `backend/schema.ts` and register them:

```typescript
// backend/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const items = sqliteTable('plugin_my_plugin__items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

```typescript
// darkride-plugin.ts
import * as schema from './backend/schema';
ctx.dbTables(schema);
```

**Table naming:** New plugin tables must use the prefix `plugin_{name}__` (double underscore) to avoid collisions. A handful of legacy plugins extracted out of the core retain their original table names for backwards compatibility.

## Adding a migration

```bash
darkride plugin add-migration my-plugin add_user_settings
```

This creates `plugins/my-plugin/migrations/0000_add_user_settings.sql` and appends a journal entry with a monotonic timestamp. Edit the SQL file, then start (or restart) the server to apply on next boot.

For multi-statement migrations, separate statements with `--> statement-breakpoint` (better-sqlite3 rejects multi-statement SQL otherwise).

The command resolves the next `idx` as `max(existing idx) + 1` and ensures the `when` timestamp is strictly greater than every prior entry — this prevents Drizzle from silently skipping migrations on existing databases.

## Unified Tools

Tools registered once, available to AI chat, MCP server, REST API, SKILL.md, and automation scripts.

> **Deprecated:** An older `ctx.aiTools()` / `ctx.aiContexts()` API still exists for backward compatibility, but new plugins should use `ctx.tools()` / `ctx.toolContexts()` (shown below). The unified tools API supersedes the AI-only path.

```typescript
ctx.tools([
  {
    name: 'my_plugin_list_items',
    description: 'List all items.',
    inputSchema: { type: 'object', properties: {} },
    contexts: ['my-plugin'],
    async execute() {
      return db.select().from(schema.items).all();
    },
  },
]);
```

## Tool Contexts

Group tools by feature area. Optionally include a URL pattern so the AI chat automatically activates the right tools on the matching page:

```typescript
ctx.toolContexts([
  {
    id: 'my-plugin',
    label: 'My Plugin',
    tools: ['my_plugin_list_items'],
    urlPattern: '/my-feature/:id',    // optional
    contextIdParam: 'id',             // optional — which URL param is the context ID
  },
]);
```

## Jobs

Register scheduled background tasks:

```typescript
ctx.jobs([
  {
    id: 'my-plugin-sync',
    name: 'My Plugin Sync',
    description: 'Sync data from external source',
    category: 'sync',
    defaultSchedule: '0 */6 * * *',   // cron expression
    canRunManually: true,
    run: async () => { /* sync logic */ },
  },
]);
```

Jobs run in the plugin's normal Node context — `ctx.db()`, `ctx.settings`, `ctx.peer<T>('other-plugin')`, `ctx.logger()`, `ctx.notify(...)` all work inside `run()` exactly as they do in `start()`. `canRunManually: true` adds a manual-trigger button on `/ui/settings/jobs` alongside the schedule. Override the schedule per install via the same page (the `defaultSchedule` is the seed, not a lock).

### When to use `ctx.jobs` vs. automations

Both are ways to "do something on a schedule," but they're different primitives and easy to confuse. Pick by what the script needs, not by what you tried first:

| | `ctx.jobs` | Automations |
|---|---|---|
| Runs in | Plugin's normal Node context (full `ctx`) | isolated-vm script sandbox |
| Code body | TS function in your plugin source | TS script edited in the host's Monaco editor at runtime |
| Schedule | Declared in `defaultSchedule`, overridable in UI | Set per-install in the host's automation UI |
| Manual trigger | Yes — `canRunManually: true` adds a button on `/ui/settings/jobs` | Yes — "Run now" button on `/ui/automations` |
| Visible run history | Job-run log on `/ui/settings/jobs` | Full session history on `/ui/sessions` (one row per run) |
| Cross-plugin calls | `ctx.peer<T>('plugin')` — direct method call, no serialisation | `tools.*` over the V8 boundary — serialisation per call |
| Device API (`device.*`, `setProxy`, etc.) | No — automation-sandbox primitives only | Yes |
| Plugin ships the script | Yes — bundled in source | No — script lives in the user's DB, not in the plugin tarball |

**Default to `ctx.jobs`** for any periodic plugin work whose body is your code and doesn't need the automation sandbox. It keeps the plugin self-contained (one repo, one release), avoids serialisation overhead on cross-plugin calls, and doesn't flood the user's session history with per-minute runs.

**Use an automation** when the script needs `device.*` / `setProxy` / the automation sandbox's host bindings, OR when the user is expected to edit the script body live in Monaco (the editor is the product). High-frequency automations (per-minute or faster) are an anti-pattern — they're built around user-visible run history with manual triggers, and at that cadence the history becomes noise.

### When to use `ctx.managedAutomations`

Sometimes you want both: the **sandbox + device + sessions** of an automation, but with the **script + schedule shipped by your plugin** instead of hand-pasted by the operator. That's what `ctx.managedAutomations` is for.

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';

ctx.managedAutomations([
  {
    key: 'example-poller',                     // immutable identity within the plugin
    name: 'Example poller',
    description: 'Polls the example API and writes to the document store.',
    code: readFileSync(join(ctx.pluginDir, 'scripts/poller.js'), 'utf-8'),
    defaultSchedule: JSON.stringify({ type: 'interval', intervalMs: 5 * 60_000 }),
    enabledByDefault: true,
    requiresDevice: false,
    allowUserOverride: true,
    emitFailureNotification: false,
  },
]);
```

Lifecycle:

- **First load** — host inserts a row stamped `managed_by = <plugin>` / `managed_key = 'example-poller'`, runs it on the declared schedule, sessions go to history under `managed = 1` (hidden by default; surfaced behind the "Show managed (N)" toggle).
- **Plugin update with a new `code`** — silently adopted unless the operator has overridden it.
- **Operator opens `<ManagedAutomationScriptIDE>` and edits** — fork point recorded as `base_default_code`; subsequent plugin updates of `code` no longer overwrite, and if the new default differs from the fork point a drift banner with **Keep mine** / **Reset to default** appears with a 3-way diff.
- **Plugin uninstalled** — overridden rows are orphaned (`managed_*` nulled, `enabled = 0`) so the operator's edits survive as ordinary disabled automations; never-overridden rows are deleted outright.

Operator vs plugin ownership:

| Field | Owner |
|---|---|
| `code` | 3-way: starts as plugin's `code`; operator may fork, host tracks the merge ancestor. |
| `currentDefaultCode` (refreshed every load) | Plugin |
| `defaultSchedule` / `enabledByDefault` / `defaultDeviceFilter` | **Seeds only** — operator-owned after insert. The plugin owns the logic; the operator owns the cadence. Renaming these doesn't re-touch existing rows. |
| `name` / `description` / `requiresDevice` / `timeoutMs` / `allowUserOverride` | Plugin (refreshed every load). |
| `emitFailureNotification` | Plugin. Default `false` — managed runs DON'T fire the standard `automation:failure` notification (most plugins surface health in their own UI by reading session rows). Set to `true` to opt back into the standard pipeline. |

**`key` is immutable.** Renaming it is a `delete + insert`, which loses the operator's override silently. If you need to evolve, use a versioned key (`example-poller@v2`) so the old row gets cleanly orphaned and the new one starts fresh. The host emits a warn log on every load where keys disappear AND new keys appear in the same plugin, as a heuristic for "did the author mean to rename?" — read it.

Embed the IDE on your plugin page:

```tsx
import { ManagedAutomationScriptIDE } from '@darkrideapp/plugin-sdk/react';

<ManagedAutomationScriptIDE pluginKey="my-plugin" scriptKey="example-poller" />
```

The component handles loading, drift detection, the override / reset / keep-mine actions, and the 3-way diff. Use the `editor` render prop if you want Monaco or CodeMirror instead of the bundled textarea — the SDK keeps the default light to avoid pulling Monaco into every plugin's bundle.

Note on the **asset convention**: ship `code` as a string asset read from `ctx.pluginDir`, not inlined into TypeScript. Easier to lint, diff, and review.

## Settings

Two backend surfaces. A third (the rendered settings page) lives on the frontend — see [`frontend.md`](./frontend.md#settings-backend-vs-frontend).

**Key declarations** — register in `register()`. Adds keys to the host's `PUT /v1/settings/:key` allow-list with type, default, and secret flag. **Does not render any UI on its own.** Pair with `pluginRegistry.registerSettings()` in `frontend/plugin.ts` if you want a settings page.

```typescript
ctx.settingsDefs([
  { key: 'my_plugin_api_key', label: 'API Key', type: 'string', secret: true },
  { key: 'my_plugin_enabled', label: 'Enabled', type: 'boolean' },
]);
```

**Runtime read/write** — `ctx.settings` is a `SettingsApi` available from `start()` onwards:

```typescript
const apiKey = await ctx.settings.get('my_plugin_api_key');         // string | null
await ctx.settings.set('my_plugin_enabled', 'true');
const cfg = await ctx.settings.getJson<MyConfig>('my_plugin_cfg');  // typed JSON
await ctx.settings.delete('my_plugin_api_key');
```

Every read/write returns a Promise — propagate `async`/`await` through your service code. Don't reach into the host's `settings` Drizzle table directly; the `SettingsApi` is the supported access path and is the same surface plugins use whether they're in-tree or installed via the marketplace.

## Outbound HTTP via Proxy (`ctx.dispatcher`)

`ctx.dispatcher(spec)` returns a pooled [undici `Dispatcher`](https://undici.nodejs.org/) you can pass to `fetch()`. The host owns the Agent lifecycle: two calls with structurally-equal specs return the **same instance**, so dispatchers are shared across plugins that route to the same upstream — which keeps the TCP connection rate under commercial proxy throttle thresholds.

Most plugins do **not** need this. Use it only when you need to route outbound traffic through a SOCKS5 proxy (e.g., for geo-locked APIs where the consistent egress IP matters). For direct outbound HTTP, just call `fetch` with no dispatcher.

```typescript
import { fetch } from 'undici';

async start(ctx) {
  const dispatcher = ctx.dispatcher({
    type: 'socks5',
    host: 'us.socks.nordhold.net',
    port: 1080,
    auth: { username: await ctx.settings.get('proxy_user') ?? '', password: await ctx.settings.get('proxy_pass') ?? '' },
    // connections defaults to 8 — tune lower if your upstream throttles aggressively.
  });

  ctx.api(api => {
    api.get('/v1/my-plugin/lookup', async (req, res) => {
      const upstream = await fetch('https://geo-locked.example.com/data', { dispatcher });
      res.json({ data: await upstream.json() });
    });
  });
}
```

The dispatcher is destroyed automatically at server shutdown after `stop()` runs. You don't need to call `dispatcher.destroy()` yourself.

**Only SOCKS5 is supported today.** HTTP / HTTPS / PAC proxy variants are not implemented; if you need one, file an issue.

## Commands

Register command palette commands:

```typescript
ctx.commands([
  { id: 'my-plugin:refresh', label: 'Refresh My Plugin Data', keywords: ['sync', 'update'], icon: 'refresh-cw' },
]);
```

## Notification Events

Declare notification event types that users can subscribe to:

```typescript
ctx.notificationEvents([
  { type: 'my-plugin:sync-complete', label: 'Sync complete', description: 'When data sync finishes' },
  { type: 'my-plugin:error', label: 'Sync error', description: 'When sync fails', critical: true },
]);
```

## Hooks

Subscribe to core events and define your own:

```typescript
// Subscribe to core hooks
ctx.hooks.on('app:startup', () => { console.log('Plugin loaded!'); });
ctx.hooks.on('device:connected', ({ id, platform }) => {
  console.log(`${platform} device ${id} online`);
});
ctx.hooks.on('automation:completed', ({ sessionId, success, error }) => {
  if (!success) console.error(`automation ${sessionId} failed: ${error}`);
});

// Define your own hooks (other plugins can subscribe)
ctx.hooks.define('my-plugin:item-created', { id: 'number', title: 'string' });
```

**Available core hooks:** `app:startup`, `app:shutdown`, `device:connected`, `device:disconnected`, `session:created`, `automation:started`, `automation:completed`, `apk:detected-app`, `apk:analyzed`

Low-level network traffic events (per-packet, per-request) are not on the lifecycle hook bus — they're routed through a separate, host-internal `TrafficHookRegistry` that today is only reachable from plugins that ship in-tree with the host repo. If your standalone plugin needs to inspect captured traffic, [open an issue](https://github.com/DarkRideApp/DarkRide/issues) describing the use case so the right surface can be added to `ctx`.

## File Storage

Access a namespaced file storage area (local-first with optional cloud sync):

```typescript
const files = ctx.files();
await files.write('data/export.json', Buffer.from(json));
const url = files.url('data/export.json');
const content = await files.read('data/export.json');
```
