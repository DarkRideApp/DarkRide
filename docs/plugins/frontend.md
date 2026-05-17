# Plugin Frontend Wiring

`frontend/plugin.ts` is the entry point Vite picks up for every plugin (both in-tree workspace plugins and managed installs). Inside it, you call methods on `pluginRegistry` to declaratively contribute to the host UI: pages, nav items, a settings page, commands, decoders, and contributions to slots opened by the host or other plugins.

`pluginRegistry` lives at `@darkrideapp/plugin-sdk/react`:

```typescript
import { lazy } from 'react';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';
```

## Settings: backend vs. frontend

**`ctx.settingsDefs(...)` and `pluginRegistry.registerSettings(...)` are two different APIs.** Most plugins need both.

| | `ctx.settingsDefs(defs)` (backend) | `pluginRegistry.registerSettings(name, opts)` (frontend) |
|---|---|---|
| Where | `darkride-plugin.ts` `register(ctx)` | `frontend/plugin.ts` |
| What it does | Adds keys to the host's `PUT /v1/settings/:key` allow-list, declares type + default + secret flag | Registers a React component as the plugin's settings page, mounted by the host at `/ui/settings/plugins/<name>/settings` |
| Without it | API rejects writes with `Unknown setting key`; no defaults applied | **No settings UI exists for this plugin** — the keys are reachable only via the REST API |
| Auto-generated form? | No — `settingsDefs` does not render anything | The component you provide IS the page |

If you only call `settingsDefs`, the plugin's settings are still writable via `curl PUT /v1/settings/<key>` (and readable via `GET /v1/settings/list`), but no page appears anywhere in the host. Conversely, if you only call `registerSettings` without `settingsDefs`, any `PUT` from your component will be rejected by the host's allow-list.

## registerPages

Routes mounted under `/ui/`. The component is lazy-loaded so the host's bundle stays small.

```typescript
pluginRegistry.registerPages('my-plugin', [
  { path: '/my-plugin', component: lazy(() => import('./pages/Main').then(m => ({ default: m.default }))) },
  { path: '/my-plugin/:id', component: lazy(() => import('./pages/Detail')) },
]);
```

Paths are relative to `/ui/`. Use React Router's `useParams()` for path params inside the component.

## registerNav

Side-nav items grouped under one of the host's groups (`Tools`, `Devices`, `Sessions`, etc.). The icon string resolves through `resolveIcon` to a Lucide icon.

```typescript
pluginRegistry.registerNav('my-plugin', [
  { group: 'Tools', label: 'My Plugin', path: '/my-plugin', icon: 'box' },
]);
```

## registerSettings

The plugin's settings page. Mounted at `/ui/settings/plugins/<plugin-name>/settings`, listed in the Settings sidebar by `label`, optionally ordered with `order` (lower first).

```typescript
pluginRegistry.registerSettings('my-plugin', {
  label: 'My Plugin',
  component: lazy(() => import('./pages/Settings').then(m => ({ default: m.default }))),
  // order: 10,  // optional — lower numbers appear earlier in the sidebar
});
```

A typical settings page reads/writes via the WebSocket REST bridge:

```tsx
import { useWebSocket, PageHeader, Card } from '@darkrideapp/plugin-sdk/react';

export default function Settings() {
  const ws = useWebSocket();
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    ws.sendRestApi('GET', '/v1/settings/my_plugin_api_key').then(res => {
      if (res.body?.success) setApiKey(res.body.data.value);
    });
  }, [ws]);

  const save = async () => {
    await ws.sendRestApi('PUT', '/v1/settings/my_plugin_api_key', { value: apiKey });
  };

  return (
    <>
      <PageHeader title="My Plugin" />
      <Card>
        <input value={apiKey} onChange={e => setApiKey(e.target.value)} />
        <button onClick={save}>Save</button>
      </Card>
    </>
  );
}
```

Pair every form field with a matching `settingsDefs` entry in the backend so the `PUT` succeeds — see the [Settings: backend vs. frontend](#settings-backend-vs-frontend) callout.

## registerCommands

Command palette entries (`Cmd/Ctrl+K`). `action` is called when the user picks the entry.

```typescript
pluginRegistry.registerCommands('my-plugin', [
  {
    id: 'my-plugin:refresh',
    label: 'My Plugin: Refresh data',
    keywords: ['refresh', 'reload'],
    icon: 'refresh-cw',
    action: () => { window.location.href = '/ui/my-plugin'; },
  },
]);
```

## registerDecoders

Traffic decoders contribute to the Traffic / Capture inspectors. Each decoder declares which raw protocols it can decode and provides a `decode(frame)` implementation. See `packages/plugin-sdk/src/react/plugin-registry/decoder-types.ts` for the full type surface.

```typescript
pluginRegistry.registerDecoders('my-plugin', [
  {
    id: 'my-binary-protocol',
    label: 'My Binary Protocol',
    accepts: (frame) => frame.payload[0] === 0x4d && frame.payload[1] === 0x59,
    decode: (frame) => ({ type: 'mybin', fields: { … } }),
  },
]);
```

## UI slot contributions

The host (and other plugins) open extension points called **slots**. Contributions are typed — there's a registry path for each shape so the host can render them without dynamic component lookup.

### Button list slots — `registerButtonContribution`

For slots like `device-viewer:overflow-actions` (button menus). The host renders a `ButtonList` and your contribution shows up as a row.

```typescript
pluginRegistry.registerButtonContribution('my-plugin', {
  slot: 'device-viewer:overflow-actions',
  id: 'my-plugin:dump',
  label: 'Dump state',
  icon: 'download',
  priority: 5,           // lower first
  onClick: (ctx) => { /* receives slot-specific context, e.g. { deviceId } */ },
});
```

### Nav-item list slots — `registerNavItemContribution`

For slots like `settings:plugins-nav` (groups of nav links). Same pattern, different shape.

```typescript
pluginRegistry.registerNavItemContribution('my-plugin', {
  slot: 'settings:plugins-nav',
  id: 'my-plugin:advanced',
  label: 'Advanced',
  path: '/ui/settings/plugins/my-plugin/advanced',
  priority: 10,
});
```

### Generic typed contributions — `registerUiContributions` + `registerContributionComponents`

For slots that render arbitrary React components rather than a typed list shape. Two-step: declare the contribution (data) and register the component (code) keyed by name.

```typescript
pluginRegistry.registerUiContributions('my-plugin', [
  { slot: 'dashboard:widgets', id: 'my-widget', component: 'MyWidget', priority: 0 },
]);

pluginRegistry.registerContributionComponents('my-plugin', {
  MyWidget: lazy(() => import('./components/MyWidget')),
});
```

If the contribution names a `component` that isn't in the registered map, the host logs a warning and skips that contribution.

### Opening your own slots — `registerUiSlots`

A plugin that wants to expose its own extension point to other plugins declares it:

```typescript
pluginRegistry.registerUiSlots('my-plugin', [
  { id: 'my-plugin:detail-panel', kind: 'container', label: 'Detail panel' },
]);
```

Then renders contributions for that slot via the host's `<SlotHost slot="my-plugin:detail-panel" />` (or the resolved-contribution helpers). See [`ui.md`](./ui.md) for the full slot model — `UiSlotKind` (`container` / `button-list` / `nav-item-list`), priority resolution, and the host-side rendering APIs.

## Auto-discovery

Plugins are auto-discovered. The host's `frontend/plugins.ts` uses Vite's `import.meta.glob` to find every `plugins/*/frontend/plugin.ts` file (in-tree) and every `data/installed-plugins/node_modules/@*/plugin-*/frontend/plugin.ts` (managed installs), and imports them eagerly. Drop a plugin into either location and it's picked up on the next Vite start — no manual manifest editing.

If the tarball didn't ship `frontend/` (i.e. missing from `package.json#files`), the registry calls never fire and the plugin loads with no UI. `npm pack --dry-run` is the fastest way to verify.

## See also

- [`ui.md`](./ui.md) — slot kinds, contribution resolution, host-side rendering
- [`lifecycle.md`](./lifecycle.md) — when `register` / `start` / `stop` run and what's allowed in each
- [`backend.md`](./backend.md) — `ctx.settingsDefs`, `ctx.api`, `ctx.tools`, and the rest of the server-side surface
