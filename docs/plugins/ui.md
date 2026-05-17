# Plugin UI: Navigation, Pages, Slots, and Typed Primitives

## Navigation

Add items to the sidebar:

```typescript
ctx.nav([
  { group: 'Tools', label: 'My Feature', path: '/my-feature', icon: 'box', priority: 50 },
]);
```

Icons use [Lucide](https://lucide.dev) icon names (lowercase, hyphenated).

## Pages

Register React page routes:

```typescript
ctx.pages([
  { path: '/my-feature' },
  { path: '/my-feature/:id' },
]);
```

Pages are registered in the backend definition but rendered by the frontend plugin entry (see [Frontend wiring](frontend.md)).

## UI Slots

UI slots let one plugin declare named extension points inside its own pages and let other plugins contribute content into those points. The declaring plugin (the "host") owns the slot position; any number of other plugins (contributors) can inject UI there without the host needing to know about them in advance.

A typical use case: an "inspector" plugin builds on top of a "data-sync" plugin and only makes sense in that context — a top-level nav entry for the inspector would be confusing because it has no meaning without a sync target. Instead, the data-sync plugin declares a slot below its target list and the inspector contributes a card into it, giving users one place to see everything happening with a target.

### Declaring a slot (host plugin — backend)

Declaring a slot is a two-call pattern (mirroring how `nav` and `pages` work): the backend call is captured into the plugin's metadata and made available to server-side tooling; the frontend call is what the render-time `<ExtensionSlot>` component actually looks up.

**Backend** — in the host plugin's `darkride-plugin.ts`, inside `register(ctx)`:

```typescript
ctx.uiSlots([
  {
    id: 'data-sync:dashboard:footer',
    kind: 'container',
    description: 'Rendered below the target list on the data-sync dashboard.',
  },
]);
```

**Frontend** — in the host plugin's `frontend/plugin.ts`, mirror the declaration so the slot is known to the frontend registry (this is what enables typo-warnings in `<ExtensionSlot>`):

```typescript
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';

pluginRegistry.registerUiSlots('data-sync', [
  {
    id: 'data-sync:dashboard:footer',
    kind: 'container',
    description: 'Rendered below the target list on the data-sync dashboard.',
  },
]);
```

Slot ids are fully-qualified strings, typically `<pluginName>:<surface>:<position>`. The `description` is shown in dev tooling and docs.

### Mounting the slot (host plugin — frontend)

In the host plugin's page component, import `ExtensionSlot` and place it at the position where contributions should render:

```tsx
import { ExtensionSlot } from '../../../../frontend/components/ExtensionSlot';

// Inside the host's JSX:
<ExtensionSlot
  id="data-sync:dashboard:footer"
  props={{ targetId }}
  emptyFallback={<span>No contributions</span>}
/>
```

`props` are scoped data forwarded to every contribution's component as regular React props. `emptyFallback` renders when no contributions are registered for the slot; if omitted and the slot is empty, nothing renders.

### Contributing into a slot (contributor plugin)

Like slot declarations, contributions have a two-call pattern — backend for metadata, frontend for render-time dispatch.

**Backend** — in the contributor's `darkride-plugin.ts`:

```typescript
ctx.uiContributions([
  {
    slot: 'data-sync:dashboard:footer',
    id: 'inspector:dashboard-card',
    component: 'InspectorDashboardCard',  // string key, resolved on the frontend
    // priority: 10,                      // optional — lower renders first (default 0)
  },
]);
```

**Frontend** — in the contributor's `frontend/plugin.ts`, register both the contribution and the actual React component:

```typescript
import { InspectorDashboardCard } from './components/InspectorDashboardCard';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';

pluginRegistry.registerContributionComponents('inspector', {
  InspectorDashboardCard,
});

pluginRegistry.registerUiContributions('inspector', [
  {
    slot: 'data-sync:dashboard:footer',
    id: 'inspector:dashboard-card',
    component: 'InspectorDashboardCard',
  },
]);
```

The `component` string in both the backend and frontend registration is a key name, not a module path. It must match a key passed to `registerContributionComponents` for the same plugin.

Routes inside contribution components should use the app's `/ui/...` prefix (the same as top-level plugin pages), e.g. `<Link to="/ui/inspector">`.

### Scoped props

Hosts can pass slot-local data down to all contributions via the `props` attribute on `<ExtensionSlot>`. Contributors receive this as regular React props:

```tsx
// Host declares the slot with a scoped prop:
<ExtensionSlot id="data-sync:dashboard:footer" props={{ targetId }} />

// Contributor's component receives it:
export function InspectorDashboardCard({ targetId }: { targetId: string }) { ... }
```

Shared TypeScript types for scoped props should live in the host plugin's package; contributors can import them for IDE support. The runtime contract is plain React props — if the host stops passing a prop, the contributor's component gets `undefined`, the same as any absent React prop.

### React context and providers

Contributions render inside the host plugin's React tree, so host-provided contexts (theme, router, auth) are automatically available. Contributions that need their own providers must wrap themselves:

```tsx
export function MyContribution() {
  return (
    <MyProvider>
      <MyContributionInner />
    </MyProvider>
  );
}
```

### Load order

Plugins load in dependency order. If a contributor plugin targets a slot whose host is not installed, the contribution sits in the registry and silently does nothing. The `<ExtensionSlot>` component fires a `console.warn` in dev mode the first time it renders with an id that no plugin has declared via `ctx.uiSlots()` — this catches slot id typos early.

If the host plugin is later uninstalled or the slot id changes, contributors targeting the old id silently stop rendering with no crash or warning in production. Document the slot id and its expected scoped props in the host plugin's README so contributors know the contract.

### Worked example

`plugins/kitchen-sink/` is a self-referential example: it declares a slot `kitchen-sink:demo:extra` and contributes into it from the same plugin, proving the single-plugin case works and showing the full registration cycle in one place. Read it end-to-end for a complete reference.

### Non-goals / future

The v1 slot kind is `'container'` — a generic region that renders contribution components in order. Typed kinds (`'button-list'`, `'nav-menu'`, `'tile-grid'`) are deferred until real usage reveals the right shape. A "Show all UI slots" dev inspector, cross-plugin type safety for scoped props, and slot authorization are also deferred.

## Typed UI primitives

`<ButtonList>` and `<NavItemList>` are shared React primitives used throughout the app for rows of action buttons and navigation tab strips. Both render a consistent default item style and accept an optional slot `id` that causes them to merge in plugin contributions at render time. Any surface that already uses one of these primitives is automatically extensible — the plugin author just registers a contribution object; no host-side change is required.

### When to use a typed primitive vs a container slot

Use a typed primitive when you are contributing **structured data** — a button (label, icon, onClick) or a nav item (label, icon, to). The primitive enforces a consistent visual style across contributors.

Use `<ExtensionSlot>` (kind `'container'`) when you need to inject a **freeform React subtree** — a card, a chart, a multi-row form, or any layout that doesn't fit a flat list of uniformly-styled items.

### Declaring a slot

Register the slot in the host's `frontend/plugin.ts` so the dev inspector can find it:

```typescript
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';

pluginRegistry.registerUiSlots('my-plugin', [
  {
    id: 'my-plugin:toolbar:actions',
    kind: 'button-list',          // or 'nav-item-list'
    description: 'Action buttons shown in the My Plugin toolbar.',
  },
]);
```

Slot declarations are optional at runtime — a `<ButtonList>` will merge contributions for any slot id whether or not the slot was declared. Declaring the slot enables the dev inspector outline and badge, and surfaces the description in tooling.

### Mounting a ButtonList or NavItemList with plugin injection

In the host component, pass the slot id:

```tsx
import { ButtonList } from '../../../../frontend/components/common/ButtonList';
import type { ButtonListItem } from '@darkrideapp/plugin-sdk/react';

const BUILT_IN_ACTIONS: ButtonListItem[] = [
  { id: 'my-plugin:refresh', label: 'Refresh', icon: 'refresh-cw', onClick: handleRefresh },
];

// Inside JSX:
<ButtonList
  id="my-plugin:toolbar:actions"
  buttons={BUILT_IN_ACTIONS}
  className="button-list-vertical"   // optional modifier
/>
```

`<NavItemList>` follows the same pattern with `items` instead of `buttons`.

### Contributing into a button-list slot

In the contributor's `frontend/plugin.ts`:

```typescript
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';

pluginRegistry.registerButtonContribution('my-plugin', {
  slot: 'device-viewer:overflow-actions',
  id: 'my-plugin:export',
  label: 'Export via My Plugin',
  icon: 'download',
  onClick: () => { /* real handler — no action-key indirection */ },
  priority: 20,           // optional — lower renders first (default 0)
  requiredScope: 'my-plugin.export:write',  // optional
});
```

Fields mirror `ButtonListItem`: `id`, `label`, `icon`, `onClick`, `disabled`, `priority`, `requiredScope`. All are plain values — no string action keys, no registry indirection.

### Contributing into a nav-item-list slot

```typescript
pluginRegistry.registerNavItemContribution('my-plugin', {
  slot: 'core:settings:tabs',
  id: 'my-plugin:settings-tab',
  label: 'My Plugin',
  to: '/settings/my-plugin',   // without the /ui prefix — NavItemList adds it
  icon: 'box',
  priority: 50,
});
```

Fields mirror `NavItemListItem`: `id`, `label`, `to`, `icon`, `badge`, `end`, `priority`, `requiredScope`.

### ItemComponent escape hatch

When a specific surface needs non-standard button chrome (e.g. a confirmation dialog before firing `onClick`, or extra metadata beside the label), the host passes a custom `ItemComponent`:

```tsx
import type { ButtonListItemProps } from '../../../../frontend/components/common/ButtonList';

function ConfirmItem({ item }: ButtonListItemProps) {
  const handleClick = () => {
    if (window.confirm(`Run "${item.label}"?`)) item.onClick();
  };
  return <button onClick={handleClick}>{item.label}</button>;
}

<ButtonList id="..." buttons={[...]} ItemComponent={ConfirmItem} />
```

Plugin contributions flow through the same `ItemComponent`, so visual consistency is enforced per surface regardless of which plugin contributed the item.

### Canonical examples in the repo

- **DeviceViewer overflow** (`frontend/components/devices/DeviceViewer.tsx`) uses `<ButtonList id="device-viewer:overflow-actions">`. The kitchen-sink plugin contributes a "Kitchen Sink: Say Hello" button to this slot — see `plugins/kitchen-sink/frontend/plugin.ts`.
- **Settings tab strip** (`frontend/components/common/SettingsNav.tsx`) uses `<NavItemList id="core:settings:tabs">`. The slot is reserved for future plugins that add settings pages.

