# Kitchen Sink Plugin

The kitchen-sink plugin exercises every DarkRide extension point in one place. It is the canonical reference for plugin authors — if an extension point exists, kitchen-sink uses it.

## Extension points exercised

- Nav items (sidebar)
- Frontend pages and routes
- Backend API routes
- Database tables and migrations
- Unified tools and tool contexts
- Scheduled jobs
- Settings keys (plain and secret)
- Command palette commands
- Notification event types
- Hook bus (define + subscribe)
- Protocol decoders
- File storage (`ctx.files()`)
- UI slots (declare + contribute) — see below

## UI Slots

Kitchen-sink demonstrates both sides of the slot API in a single plugin:

### Declaring a slot

```ts
ctx.uiSlots([
  {
    id: 'kitchen-sink:demo:extra',
    kind: 'container',
    description: 'Demo slot rendered on the kitchen-sink page.',
  },
]);
```

### Contributing into a slot

```ts
ctx.uiContributions([
  { slot: 'kitchen-sink:demo:extra', id: 'kitchen-sink:demo-extra', component: 'DemoExtra' },
]);
```

And on the frontend:

```ts
pluginRegistry.registerContributionComponents('kitchen-sink', {
  DemoExtra: () => <div>...</div>,
});
```

### Rendering the slot

```tsx
import { ExtensionSlot } from '@darkrideapp/plugin-sdk/react';
// ...
<ExtensionSlot id="kitchen-sink:demo:extra" />
```

The rendered output appears at the bottom of the kitchen-sink demo page. Any other plugin can contribute into `kitchen-sink:demo:extra` using the same `ctx.uiContributions` + `pluginRegistry.registerContributionComponents` pattern.

For the full pattern, see `docs/plugins/ui.md` § UI Slots.
